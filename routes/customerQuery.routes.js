// routes/customerQuery.routes.js
// Customer Query & Support System routes for Customer and Admin portals
// Built with full PostgreSQL Prisma support and persistent fallback storage

const express = require('express');
const fs = require('fs');
const path = require('path');
const { sendSupportQueryReplyEmail } = require('../services/emailNotification.service');
const { sendSupportQueryReplyWhatsApp } = require('../services/whatsappNotification.service');

const VALID_CATEGORIES = ['Order', 'Payment', 'Delivery', 'Product', 'Return / Refund', 'Other'];
const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

const DATA_DIR = path.join(__dirname, '../data');
const QUERIES_FILE = path.join(DATA_DIR, 'customer_queries.json');

/**
 * Ensure storage directory and file exist
 */
function ensureStorage() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(QUERIES_FILE)) {
      fs.writeFileSync(QUERIES_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
  } catch (err) {
    console.warn('[Customer Query] Storage initialization warning:', err.message);
  }
}

/**
 * Load queries from persistent JSON file
 */
function loadQueriesFromFile() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(QUERIES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[Customer Query] File read warning, returning empty array:', err.message);
    return [];
  }
}

/**
 * Save queries to persistent JSON file
 */
function saveQueriesToFile(queries) {
  ensureStorage();
  try {
    fs.writeFileSync(QUERIES_FILE, JSON.stringify(queries, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Customer Query] File write error:', err.message);
  }
}

/**
 * Generates the next sequential human-readable ticket number (e.g., Q-1001)
 */
async function getNextQueryNumber(prisma) {
  let nextSeq = 1001;

  if (prisma) {
    try {
      const lastQuery = await prisma.customerQuery.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { queryNumber: true },
      });

      if (lastQuery && lastQuery.queryNumber) {
        const match = lastQuery.queryNumber.match(/^Q-(\d+)$/);
        if (match) {
          nextSeq = parseInt(match[1], 10) + 1;
        }
      }

      let candidate = `Q-${nextSeq}`;
      let exists = await prisma.customerQuery.findUnique({ where: { queryNumber: candidate } });
      while (exists) {
        nextSeq += 1;
        candidate = `Q-${nextSeq}`;
        exists = await prisma.customerQuery.findUnique({ where: { queryNumber: candidate } });
      }

      return candidate;
    } catch (err) {
      console.warn('[Customer Query] DB query number generation fallback to file store:', err.message);
    }
  }

  // Fallback using persistent file store
  const fileQueries = loadQueriesFromFile();
  for (const q of fileQueries) {
    if (q.queryNumber) {
      const match = q.queryNumber.match(/^Q-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= nextSeq) {
          nextSeq = num + 1;
        }
      }
    }
  }

  return `Q-${nextSeq}`;
}

// =========================================================================
// CUSTOMER ENDPOINTS (Mount at /api/customer/queries)
// All endpoints require authenticateCustomer (attaches req.customer)
// =========================================================================

const customerRouter = express.Router();

// 1. POST /api/customer/queries - Create a new query
customerRouter.post('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const customer = req.customer || {};
  const customerId = customer.id || `cust_${Date.now()}`;

  try {
    const { category, subject, message, description, orderId, priority } = req.body || {};
    const contentMessage = (message || description || '').trim();

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'INVALID_CATEGORY',
        message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}`,
      });
    }

    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({
        error: 'INVALID_SUBJECT',
        message: 'Subject is required.',
      });
    }

    if (!contentMessage) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'Message is required.',
      });
    }

    let validOrderId = null;
    if (orderId && typeof orderId === 'string' && orderId.trim()) {
      validOrderId = orderId.trim();
    }

    const queryPriority = priority && VALID_PRIORITIES.includes(priority) ? priority : 'NORMAL';
    const queryNumber = await getNextQueryNumber(prisma);

    let createdQuery = null;

    // Attempt database creation if Prisma is connected
    if (prisma) {
      try {
        // Ensure customer record exists in DB to satisfy foreign key constraint
        let dbCustomer = await prisma.customer.findFirst({
          where: {
            OR: [
              { id: customerId },
              ...(customer.firebaseUid ? [{ firebaseUid: customer.firebaseUid }] : []),
              ...(customer.email ? [{ email: customer.email }] : []),
            ],
          },
        });

        if (!dbCustomer && customer.firebaseUid) {
          dbCustomer = await prisma.customer.create({
            data: {
              firebaseUid: customer.firebaseUid,
              name: customer.name || 'Customer',
              email: customer.email || `${customer.firebaseUid}@sunbloomadorn.local`,
              phone: customer.phone || null,
            },
          });
        }

        const effectiveCustomerId = dbCustomer ? dbCustomer.id : customerId;

        // If orderId is provided, verify it belongs to customer
        let dbOrderId = null;
        if (validOrderId) {
          const order = await prisma.order.findFirst({
            where: { id: validOrderId, customerId: effectiveCustomerId },
          });
          if (order) dbOrderId = order.id;
        }

        createdQuery = await prisma.customerQuery.create({
          data: {
            queryNumber,
            customerId: effectiveCustomerId,
            orderId: dbOrderId,
            category,
            subject: subject.trim(),
            status: 'OPEN',
            priority: queryPriority,
            messages: {
              create: {
                senderType: 'CUSTOMER',
                senderId: effectiveCustomerId,
                senderName: customer.name || 'Customer',
                message: contentMessage,
                isInternal: false,
              },
            },
          },
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                status: true,
                totalAmount: true,
              },
            },
            messages: {
              where: { isInternal: false },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      } catch (dbErr) {
        console.warn('[Customer Query] Prisma create failed, using persistent storage fallback:', dbErr.message);
      }
    }

    // If database was offline or threw an error, save to persistent storage
    if (!createdQuery) {
      const newQueryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString();

      createdQuery = {
        id: newQueryId,
        queryNumber,
        customerId,
        orderId: validOrderId,
        category,
        subject: subject.trim(),
        status: 'OPEN',
        priority: queryPriority,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        customer: {
          id: customerId,
          name: customer.name || 'Customer',
          email: customer.email || '',
          phone: customer.phone || null,
          firebaseUid: customer.firebaseUid || null,
        },
        order: validOrderId ? { id: validOrderId, orderNumber: validOrderId, status: 'CONFIRMED', totalAmount: 0 } : null,
        messages: [
          {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            queryId: newQueryId,
            senderType: 'CUSTOMER',
            senderId: customerId,
            senderName: customer.name || 'Customer',
            message: contentMessage,
            attachment: null,
            isInternal: false,
            createdAt: now,
          },
        ],
        _count: { messages: 1 },
      };

      const fileQueries = loadQueriesFromFile();
      fileQueries.unshift(createdQuery);
      saveQueriesToFile(fileQueries);
    }

    res.status(201).json({
      success: true,
      query: createdQuery,
      message: `Query ${queryNumber} submitted successfully. Our concierge team will review it shortly.`,
    });
  } catch (err) {
    console.error('[Customer Query] Create error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to create customer query.' });
  }
});

// 2. GET /api/customer/queries - List authenticated customer's queries
customerRouter.get('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const customer = req.customer || {};
  const customerId = customer.id;

  try {
    if (prisma) {
      try {
        const queries = await prisma.customerQuery.findMany({
          where: {
            OR: [
              ...(customerId ? [{ customerId }] : []),
              ...(customer.firebaseUid ? [{ customer: { firebaseUid: customer.firebaseUid } }] : []),
              ...(customer.email ? [{ customer: { email: customer.email } }] : []),
            ],
          },
          orderBy: { updatedAt: 'desc' },
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                status: true,
                totalAmount: true,
              },
            },
            _count: {
              select: {
                messages: {
                  where: { isInternal: false },
                },
              },
            },
          },
        });

        return res.json({ queries });
      } catch (dbErr) {
        console.warn('[Customer Query] DB fetch failed, reading from persistent fallback store:', dbErr.message);
      }
    }

    // Fallback: Read from persistent JSON file
    const fileQueries = loadQueriesFromFile();
    const customerQueries = fileQueries.filter((q) => {
      if (q.customerId === customerId) return true;
      if (customer.firebaseUid && q.customer?.firebaseUid === customer.firebaseUid) return true;
      if (customer.email && q.customer?.email && q.customer.email.toLowerCase() === customer.email.toLowerCase()) return true;
      return false;
    });

    res.json({ queries: customerQueries });
  } catch (err) {
    console.error('[Customer Query] List error:', err);
    res.json({ queries: [] });
  }
});

// 3. GET /api/customer/queries/:id - Get single query detail
customerRouter.get('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const customer = req.customer || {};
  const customerId = customer.id;
  const queryId = req.params.id;

  try {
    if (prisma) {
      try {
        const query = await prisma.customerQuery.findFirst({
          where: {
            id: queryId,
            OR: [
              ...(customerId ? [{ customerId }] : []),
              ...(customer.firebaseUid ? [{ customer: { firebaseUid: customer.firebaseUid } }] : []),
              ...(customer.email ? [{ customer: { email: customer.email } }] : []),
            ],
          },
          include: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                status: true,
                totalAmount: true,
                createdAt: true,
              },
            },
            messages: {
              where: { isInternal: false },
              orderBy: { createdAt: 'asc' },
            },
          },
        });

        if (query) {
          return res.json({ query });
        }
      } catch (dbErr) {
        console.warn('[Customer Query] DB detail fetch failed, reading from file store:', dbErr.message);
      }
    }

    // Fallback: search in file store
    const fileQueries = loadQueriesFromFile();
    const query = fileQueries.find((q) => q.id === queryId || q.queryNumber === queryId);

    if (!query) {
      return res.status(404).json({
        error: 'QUERY_NOT_FOUND',
        message: 'Query not found or you do not have permission to view it.',
      });
    }

    res.json({ query });
  } catch (err) {
    console.error('[Customer Query] Get detail error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to retrieve query details.' });
  }
});

// 4. POST /api/customer/queries/:id/messages - Customer reply to an open query
customerRouter.post('/:id/messages', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const customer = req.customer || {};
  const customerId = customer.id;
  const queryId = req.params.id;

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'Message cannot be empty.',
      });
    }

    let createdMessage = null;
    let nextStatus = 'IN_PROGRESS';

    if (prisma) {
      try {
        const query = await prisma.customerQuery.findFirst({
          where: {
            id: queryId,
            OR: [
              ...(customerId ? [{ customerId }] : []),
              ...(customer.firebaseUid ? [{ customer: { firebaseUid: customer.firebaseUid } }] : []),
              ...(customer.email ? [{ customer: { email: customer.email } }] : []),
            ],
          },
        });

        if (query) {
          if (query.status === 'CLOSED') {
            return res.status(400).json({
              error: 'QUERY_CLOSED',
              message: 'This query is closed. Please submit a new query if you require further assistance.',
            });
          }

          createdMessage = await prisma.customerQueryMessage.create({
            data: {
              queryId: query.id,
              senderType: 'CUSTOMER',
              senderId: customerId,
              senderName: customer.name || 'Customer',
              message: message.trim(),
              isInternal: false,
            },
          });

          nextStatus = ['WAITING_FOR_CUSTOMER', 'RESOLVED'].includes(query.status) ? 'IN_PROGRESS' : query.status;

          await prisma.customerQuery.update({
            where: { id: query.id },
            data: {
              status: nextStatus,
              updatedAt: new Date(),
            },
          });

          return res.status(201).json({
            success: true,
            message: createdMessage,
            queryStatus: nextStatus,
          });
        }
      } catch (dbErr) {
        console.warn('[Customer Query] DB reply failed, using file store fallback:', dbErr.message);
      }
    }

    // Fallback: update in file store
    const fileQueries = loadQueriesFromFile();
    const query = fileQueries.find((q) => q.id === queryId || q.queryNumber === queryId);

    if (!query) {
      return res.status(404).json({
        error: 'QUERY_NOT_FOUND',
        message: 'Query not found or you do not have permission to access it.',
      });
    }

    if (query.status === 'CLOSED') {
      return res.status(400).json({
        error: 'QUERY_CLOSED',
        message: 'This query is closed. Please submit a new query if you require further assistance.',
      });
    }

    const now = new Date().toISOString();
    createdMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      queryId: query.id,
      senderType: 'CUSTOMER',
      senderId: customerId,
      senderName: customer.name || 'Customer',
      message: message.trim(),
      attachment: null,
      isInternal: false,
      createdAt: now,
    };

    if (!Array.isArray(query.messages)) {
      query.messages = [];
    }
    query.messages.push(createdMessage);
    nextStatus = ['WAITING_FOR_CUSTOMER', 'RESOLVED'].includes(query.status) ? 'IN_PROGRESS' : query.status;
    query.status = nextStatus;
    query.updatedAt = now;

    saveQueriesToFile(fileQueries);

    res.status(201).json({
      success: true,
      message: createdMessage,
      queryStatus: nextStatus,
    });
  } catch (err) {
    console.error('[Customer Query] Customer reply error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to send reply.' });
  }
});

// =========================================================================
// ADMIN ENDPOINTS (Mount at /api/admin/customer-queries)
// All endpoints require authenticateAdmin (attaches req.adminUser)
// =========================================================================

const adminRouter = express.Router();

// 1. GET /api/admin/customer-queries/stats - Stats summary
adminRouter.get('/stats', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    if (prisma) {
      try {
        const [total, open, inProgress, waitingForCustomer, resolved, closed] = await Promise.all([
          prisma.customerQuery.count(),
          prisma.customerQuery.count({ where: { status: 'OPEN' } }),
          prisma.customerQuery.count({ where: { status: 'IN_PROGRESS' } }),
          prisma.customerQuery.count({ where: { status: 'WAITING_FOR_CUSTOMER' } }),
          prisma.customerQuery.count({ where: { status: 'RESOLVED' } }),
          prisma.customerQuery.count({ where: { status: 'CLOSED' } }),
        ]);

        return res.json({
          stats: {
            total,
            open,
            inProgress,
            waitingForCustomer,
            resolved,
            closed,
            active: open + inProgress + waitingForCustomer,
          },
        });
      } catch (dbErr) {
        console.warn('[Admin Query] DB stats failed, computing from file store:', dbErr.message);
      }
    }

    const fileQueries = loadQueriesFromFile();
    const open = fileQueries.filter((q) => q.status === 'OPEN').length;
    const inProgress = fileQueries.filter((q) => q.status === 'IN_PROGRESS').length;
    const waitingForCustomer = fileQueries.filter((q) => q.status === 'WAITING_FOR_CUSTOMER').length;
    const resolved = fileQueries.filter((q) => q.status === 'RESOLVED').length;
    const closed = fileQueries.filter((q) => q.status === 'CLOSED').length;
    const total = fileQueries.length;

    res.json({
      stats: {
        total,
        open,
        inProgress,
        waitingForCustomer,
        resolved,
        closed,
        active: open + inProgress + waitingForCustomer,
      },
    });
  } catch (err) {
    console.error('[Admin Query] Stats error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to fetch query statistics.' });
  }
});

// 2. GET /api/admin/customer-queries - List all queries with filters & search
adminRouter.get('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { category, status, priority, search, page = 1, limit = 50 } = req.query;

  try {
    if (prisma) {
      try {
        const where = {};

        if (category && category !== 'ALL' && VALID_CATEGORIES.includes(category)) {
          where.category = category;
        }

        if (status && status !== 'ALL' && VALID_STATUSES.includes(status)) {
          where.status = status;
        }

        if (priority && priority !== 'ALL' && VALID_PRIORITIES.includes(priority)) {
          where.priority = priority;
        }

        if (search && typeof search === 'string' && search.trim()) {
          const q = search.trim();
          where.OR = [
            { queryNumber: { contains: q, mode: 'insensitive' } },
            { subject: { contains: q, mode: 'insensitive' } },
            { customer: { name: { contains: q, mode: 'insensitive' } } },
            { customer: { email: { contains: q, mode: 'insensitive' } } },
            { customer: { phone: { contains: q } } },
            { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
          ];
        }

        const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
        const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * take;

        const [total, queries] = await Promise.all([
          prisma.customerQuery.count({ where }),
          prisma.customerQuery.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            skip,
            take,
            include: {
              customer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                  whatsappNumber: true,
                },
              },
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  status: true,
                  totalAmount: true,
                },
              },
              messages: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  senderType: true,
                  senderName: true,
                  message: true,
                  isInternal: true,
                  createdAt: true,
                },
              },
              _count: {
                select: {
                  messages: true,
                },
              },
            },
          }),
        ]);

        return res.json({
          queries,
          pagination: {
            total,
            page: parseInt(page, 10) || 1,
            limit: take,
            pages: Math.ceil(total / take),
          },
        });
      } catch (dbErr) {
        console.warn('[Admin Query] DB list failed, reading from file store:', dbErr.message);
      }
    }

    // Fallback: list from file store
    let filtered = loadQueriesFromFile();

    if (category && category !== 'ALL') {
      filtered = filtered.filter((q) => q.category === category);
    }
    if (status && status !== 'ALL') {
      filtered = filtered.filter((q) => q.status === status);
    }
    if (priority && priority !== 'ALL') {
      filtered = filtered.filter((q) => q.priority === priority);
    }
    if (search && typeof search === 'string' && search.trim()) {
      const s = search.trim().toLowerCase();
      filtered = filtered.filter(
        (q) =>
          (q.queryNumber && q.queryNumber.toLowerCase().includes(s)) ||
          (q.subject && q.subject.toLowerCase().includes(s)) ||
          (q.customer?.name && q.customer.name.toLowerCase().includes(s)) ||
          (q.customer?.email && q.customer.email.toLowerCase().includes(s)) ||
          (q.customer?.phone && q.customer.phone.includes(s))
      );
    }

    const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * take;
    const paginated = filtered.slice(skip, skip + take);

    res.json({
      queries: paginated,
      pagination: {
        total: filtered.length,
        page: parseInt(page, 10) || 1,
        limit: take,
        pages: Math.ceil(filtered.length / take),
      },
    });
  } catch (err) {
    console.error('[Admin Query] List error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to fetch customer queries.' });
  }
});

// 3. GET /api/admin/customer-queries/:id - Full detail view with conversation & notes
adminRouter.get('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const queryId = req.params.id;

  try {
    if (prisma) {
      try {
        const query = await prisma.customerQuery.findUnique({
          where: { id: queryId },
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                whatsappNumber: true,
                address: true,
                city: true,
                state: true,
                pincode: true,
              },
            },
            order: {
              include: {
                items: {
                  include: {
                    variant: {
                      include: {
                        product: {
                          select: {
                            name: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            messages: {
              orderBy: { createdAt: 'asc' },
            },
          },
        });

        if (query) {
          return res.json({ query });
        }
      } catch (dbErr) {
        console.warn('[Admin Query] DB detail failed, reading from file store:', dbErr.message);
      }
    }

    const fileQueries = loadQueriesFromFile();
    const query = fileQueries.find((q) => q.id === queryId || q.queryNumber === queryId);

    if (!query) {
      return res.status(404).json({
        error: 'QUERY_NOT_FOUND',
        message: 'Query not found.',
      });
    }

    res.json({ query });
  } catch (err) {
    console.error('[Admin Query] Detail error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to fetch query details.' });
  }
});

// 4. POST /api/admin/customer-queries/:id/messages - Reply to customer OR add internal note
adminRouter.post('/:id/messages', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const adminUser = req.adminUser || {};
  const queryId = req.params.id;

  try {
    const { message, isInternal = false, status } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'Message content is required.',
      });
    }

    const isNote = Boolean(isInternal);

    if (prisma) {
      try {
        const query = await prisma.customerQuery.findUnique({
          where: { id: queryId },
          include: { customer: true },
        });

        if (query) {
          const createdMessage = await prisma.customerQueryMessage.create({
            data: {
              queryId: query.id,
              senderType: 'ADMIN',
              senderId: adminUser.id || 'admin',
              senderName: adminUser.username || 'Sunbloom Concierge',
              message: message.trim(),
              isInternal: isNote,
            },
          });

          let nextStatus = query.status;
          let resolvedAt = query.resolvedAt;

          if (status && VALID_STATUSES.includes(status)) {
            nextStatus = status;
            if (status === 'RESOLVED') {
              resolvedAt = new Date();
            } else if (status === 'OPEN' || status === 'IN_PROGRESS') {
              resolvedAt = null;
            }
          } else if (!isNote) {
            if (query.status === 'OPEN' || query.status === 'IN_PROGRESS') {
              nextStatus = 'WAITING_FOR_CUSTOMER';
            }
          }

          const updatedQuery = await prisma.customerQuery.update({
            where: { id: query.id },
            data: {
              status: nextStatus,
              resolvedAt,
              updatedAt: new Date(),
            },
          });

          // If not an internal note, dispatch notifications to customer
          if (!isNote) {
            const queryRecipient = {
              name: query.customer?.name || query.name,
              email: query.customer?.email || query.email,
              phone: query.customer?.phone || query.customer?.whatsappNumber || query.phone,
              ticketId: query.queryNumber || query.id,
              subject: query.subject,
            };
            sendSupportQueryReplyEmail(queryRecipient, message.trim()).catch((e) => console.warn('[Query Reply Email Error]:', e.message));
            sendSupportQueryReplyWhatsApp(queryRecipient, message.trim()).catch((e) => console.warn('[Query Reply WA Error]:', e.message));
          }

          return res.status(201).json({
            success: true,
            message: createdMessage,
            query: updatedQuery,
          });
        }
      } catch (dbErr) {
        console.warn('[Admin Query] DB post message failed, using file store fallback:', dbErr.message);
      }
    }

    // Fallback: update in file store
    const fileQueries = loadQueriesFromFile();
    const query = fileQueries.find((q) => q.id === queryId || q.queryNumber === queryId);

    if (!query) {
      return res.status(404).json({
        error: 'QUERY_NOT_FOUND',
        message: 'Query not found.',
      });
    }

    const now = new Date().toISOString();
    const createdMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      queryId: query.id,
      senderType: 'ADMIN',
      senderId: adminUser.id || 'admin',
      senderName: adminUser.username || 'Sunbloom Concierge',
      message: message.trim(),
      attachment: null,
      isInternal: isNote,
      createdAt: now,
    };

    if (!Array.isArray(query.messages)) {
      query.messages = [];
    }
    query.messages.push(createdMessage);

    let nextStatus = query.status;
    let resolvedAt = query.resolvedAt;

    if (status && VALID_STATUSES.includes(status)) {
      nextStatus = status;
      if (status === 'RESOLVED') {
        resolvedAt = now;
      } else if (status === 'OPEN' || status === 'IN_PROGRESS') {
        resolvedAt = null;
      }
    } else if (!isNote) {
      if (query.status === 'OPEN' || query.status === 'IN_PROGRESS') {
        nextStatus = 'WAITING_FOR_CUSTOMER';
      }
    }

    query.status = nextStatus;
    query.resolvedAt = resolvedAt;
    query.updatedAt = now;

    saveQueriesToFile(fileQueries);

    res.status(201).json({
      success: true,
      message: createdMessage,
      query,
    });
  } catch (err) {
    console.error('[Admin Query] Message post error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to post message/note.' });
  }
});

// 5. PATCH / PUT /api/admin/customer-queries/:id - Update status and/or priority
const handleAdminQueryUpdate = async (req, res) => {
  const prisma = req.app.locals.prisma;
  const queryId = req.params.id;

  try {
    const { status, priority } = req.body || {};

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: 'INVALID_STATUS',
        message: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({
        error: 'INVALID_PRIORITY',
        message: `Priority must be one of: ${VALID_PRIORITIES.join(', ')}`,
      });
    }

    if (prisma) {
      try {
        const data = { updatedAt: new Date() };
        if (status) {
          data.status = status;
          if (status === 'RESOLVED') {
            data.resolvedAt = new Date();
          } else if (['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'].includes(status)) {
            data.resolvedAt = null;
          }
        }
        if (priority) {
          data.priority = priority;
        }

        const updatedQuery = await prisma.customerQuery.update({
          where: { id: queryId },
          data,
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            },
          },
        });

        return res.json({
          success: true,
          query: updatedQuery,
        });
      } catch (dbErr) {
        console.warn('[Admin Query] DB patch failed, using file store fallback:', dbErr.message);
      }
    }

    // Fallback: update in file store
    const fileQueries = loadQueriesFromFile();
    const query = fileQueries.find((q) => q.id === queryId || q.queryNumber === queryId);

    if (!query) {
      return res.status(404).json({
        error: 'QUERY_NOT_FOUND',
        message: 'Query not found.',
      });
    }

    const now = new Date().toISOString();
    if (status) {
      query.status = status;
      if (status === 'RESOLVED') {
        query.resolvedAt = now;
      } else if (['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'].includes(status)) {
        query.resolvedAt = null;
      }
    }
    if (priority) {
      query.priority = priority;
    }
    query.updatedAt = now;

    saveQueriesToFile(fileQueries);

    res.json({
      success: true,
      query,
    });
  } catch (err) {
    console.error('[Admin Query] Update error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to update query status/priority.' });
  }
};

adminRouter.patch('/:id', handleAdminQueryUpdate);
adminRouter.put('/:id', handleAdminQueryUpdate);

module.exports = {
  customerRouter,
  adminRouter,
};
