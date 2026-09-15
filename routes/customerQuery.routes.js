// routes/customerQuery.routes.js
// Customer Query & Support System routes for Customer and Admin portals

const express = require('express');
const router = express.Router();

const VALID_CATEGORIES = ['Order', 'Payment', 'Delivery', 'Product', 'Return / Refund', 'Other'];
const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/**
 * Generates the next sequential human-readable ticket number (e.g., Q-1001)
 */
async function getNextQueryNumber(prisma) {
  const lastQuery = await prisma.customerQuery.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { queryNumber: true },
  });

  let nextSeq = 1001;
  if (lastQuery && lastQuery.queryNumber) {
    const match = lastQuery.queryNumber.match(/^Q-(\d+)$/);
    if (match) {
      nextSeq = parseInt(match[1], 10) + 1;
    }
  }

  // Ensure uniqueness in case of concurrent creations
  let candidate = `Q-${nextSeq}`;
  let exists = await prisma.customerQuery.findUnique({ where: { queryNumber: candidate } });
  while (exists) {
    nextSeq += 1;
    candidate = `Q-${nextSeq}`;
    exists = await prisma.customerQuery.findUnique({ where: { queryNumber: candidate } });
  }

  return candidate;
}

// =========================================================================
// CUSTOMER ENDPOINTS (Mount at /api/customer/queries)
// All endpoints require authenticateCustomer (attaches req.customer)
// =========================================================================

const customerRouter = express.Router();

// 1. POST /api/customer/queries - Create a new query
customerRouter.post('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const customerId = req.customer.id;

  try {
    const { category, subject, message, orderId, priority } = req.body || {};

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

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'Message is required.',
      });
    }

    // If orderId is supplied, strictly verify ownership
    let validOrderId = null;
    if (orderId && typeof orderId === 'string' && orderId.trim()) {
      const order = await prisma.order.findFirst({
        where: { id: orderId.trim(), customerId },
      });

      if (!order) {
        return res.status(400).json({
          error: 'INVALID_ORDER',
          message: 'The selected order was not found or does not belong to your account.',
        });
      }
      validOrderId = order.id;
    }

    const queryPriority = priority && VALID_PRIORITIES.includes(priority) ? priority : 'NORMAL';
    const queryNumber = await getNextQueryNumber(prisma);

    const newQuery = await prisma.customerQuery.create({
      data: {
        queryNumber,
        customerId,
        orderId: validOrderId,
        category,
        subject: subject.trim(),
        status: 'OPEN',
        priority: queryPriority,
        messages: {
          create: {
            senderType: 'CUSTOMER',
            senderId: customerId,
            senderName: req.customer.name || 'Customer',
            message: message.trim(),
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

    res.status(201).json({
      success: true,
      query: newQuery,
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
  const customerId = req.customer.id;

  try {
    const queries = await prisma.customerQuery.findMany({
      where: { customerId },
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

    res.json({ queries });
  } catch (err) {
    console.error('[Customer Query] List error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to fetch customer queries.' });
  }
});

// 3. GET /api/customer/queries/:id - Get single query detail
customerRouter.get('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const customerId = req.customer.id;

  try {
    const query = await prisma.customerQuery.findFirst({
      where: {
        id: req.params.id,
        customerId, // Strict ownership check!
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
        // STRICT RULE: Only messages where isInternal === false
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

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
  const customerId = req.customer.id;

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'Message cannot be empty.',
      });
    }

    const query = await prisma.customerQuery.findFirst({
      where: {
        id: req.params.id,
        customerId, // Strict ownership check!
      },
    });

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

    // Create customer reply message
    const newMessage = await prisma.customerQueryMessage.create({
      data: {
        queryId: query.id,
        senderType: 'CUSTOMER',
        senderId: customerId,
        senderName: req.customer.name || 'Customer',
        message: message.trim(),
        isInternal: false,
      },
    });

    // If query was WAITING_FOR_CUSTOMER or RESOLVED, customer reply reopens it to IN_PROGRESS
    const nextStatus = ['WAITING_FOR_CUSTOMER', 'RESOLVED'].includes(query.status)
      ? 'IN_PROGRESS'
      : query.status;

    await prisma.customerQuery.update({
      where: { id: query.id },
      data: {
        status: nextStatus,
        updatedAt: new Date(),
      },
    });

    res.status(201).json({
      success: true,
      message: newMessage,
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
    const [total, open, inProgress, waitingForCustomer, resolved, closed] = await Promise.all([
      prisma.customerQuery.count(),
      prisma.customerQuery.count({ where: { status: 'OPEN' } }),
      prisma.customerQuery.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.customerQuery.count({ where: { status: 'WAITING_FOR_CUSTOMER' } }),
      prisma.customerQuery.count({ where: { status: 'RESOLVED' } }),
      prisma.customerQuery.count({ where: { status: 'CLOSED' } }),
    ]);

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

  try {
    const { category, status, priority, search, page = 1, limit = 50 } = req.query;

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

    res.json({
      queries,
      pagination: {
        total,
        page: parseInt(page, 10) || 1,
        limit: take,
        pages: Math.ceil(total / take),
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

  try {
    const query = await prisma.customerQuery.findUnique({
      where: { id: req.params.id },
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
  const adminUser = req.adminUser;

  try {
    const { message, isInternal = false, status } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'INVALID_MESSAGE',
        message: 'Message content is required.',
      });
    }

    const query = await prisma.customerQuery.findUnique({
      where: { id: req.params.id },
    });

    if (!query) {
      return res.status(404).json({
        error: 'QUERY_NOT_FOUND',
        message: 'Query not found.',
      });
    }

    const isNote = Boolean(isInternal);

    // Create the message / internal note
    const createdMessage = await prisma.customerQueryMessage.create({
      data: {
        queryId: query.id,
        senderType: 'ADMIN',
        senderId: adminUser.id,
        senderName: adminUser.username || 'Sunbloom Concierge',
        message: message.trim(),
        isInternal: isNote,
      },
    });

    // Determine query status update
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
      // Default behavior when sending a public reply to customer:
      // If query was OPEN or IN_PROGRESS, move to WAITING_FOR_CUSTOMER
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

    res.status(201).json({
      success: true,
      message: createdMessage,
      query: updatedQuery,
    });
  } catch (err) {
    console.error('[Admin Query] Message post error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to post message/note.' });
  }
});

// 5. PATCH /api/admin/customer-queries/:id - Update status and/or priority
adminRouter.patch('/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { status, priority } = req.body || {};

    const data = { updatedAt: new Date() };

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'INVALID_STATUS',
          message: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }
      data.status = status;
      if (status === 'RESOLVED') {
        data.resolvedAt = new Date();
      } else if (['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'].includes(status)) {
        data.resolvedAt = null;
      }
    }

    if (priority) {
      if (!VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({
          error: 'INVALID_PRIORITY',
          message: `Priority must be one of: ${VALID_PRIORITIES.join(', ')}`,
        });
      }
      data.priority = priority;
    }

    const updatedQuery = await prisma.customerQuery.update({
      where: { id: req.params.id },
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

    res.json({
      success: true,
      query: updatedQuery,
    });
  } catch (err) {
    console.error('[Admin Query] Update error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to update query status/priority.' });
  }
});

module.exports = {
  customerRouter,
  adminRouter,
};
