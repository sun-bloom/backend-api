const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { PrismaClient } = require('@prisma/client');
const { PrismaNeon } = require('@prisma/adapter-neon');
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaNeon({ connectionString });
const prisma = new PrismaClient({ adapter });
const app = express();
app.locals.prisma = prisma; // shared with route files
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const AUTH_DEBUG = process.env.DEBUG_AUTH === '1';
const PUBLIC_DOCS = process.env.PUBLIC_DOCS === '1';

if (!JWT_SECRET) {
  console.error('ERROR: JWT_SECRET environment variable is required');
  process.exit(1);
}

const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: { error: 'Too many tracking attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // limit each IP to 5 orders per minute
  message: { error: 'Too many orders placed, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Prevent conditional GET (304 Not Modified) behavior caused by ETags.
app.set('etag', false);

const corsOriginAllowlist = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:4321')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
);

const isCorsOriginAllowed = (origin) => {
  // Allow non-browser requests (no Origin header) like curl/health checks.
  if (!origin) return true;
  try {
    const url = new URL(origin);
    // Always allow localhost in development.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    return corsOriginAllowlist.has(origin);
  } catch {
    return false;
  }
};

const corsOptions = {
  origin: (origin, callback) => callback(null, isCorsOriginAllowed(origin)),
  credentials: false,
  optionsSuccessStatus: 204,
};

// ── Cashfree: webhook must be mounted BEFORE express.json() (needs raw body) ──
const cashfreeRoutes = require('./routes/cashfree.routes');
// ── Cashfree Webhook — handled directly (raw body needed, no router) ────────
const crypto = require('crypto');

// POST: actual payment webhook
app.post('/api/payments/cashfree/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];
    const rawBody   = req.body?.toString('utf8') || '';

    console.log('[Cashfree] Webhook POST received, timestamp:', timestamp);


    // Verify HMAC-SHA256 signature
    const expected = crypto
      .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
      .update(`${timestamp}${rawBody}`)
      .digest('base64');

    if (expected !== signature) {
      console.warn('[Cashfree] Signature mismatch');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const event     = JSON.parse(rawBody);
    const { type, data } = event;
    const cfOrderId = data?.order?.order_id;

    console.log(`[Cashfree] Event: ${type} — order: ${cfOrderId}`);

    if (type === 'PAYMENT_SUCCESS_WEBHOOK' && cfOrderId) {
      await prisma.order.updateMany({
        where: { upiTransactionId: cfOrderId },
        data:  { paymentStatus: 'PAID', status: 'CONFIRMED' },
      });
      console.log(`[Cashfree] Order ${cfOrderId} marked PAID`);
    }

    if (type === 'PAYMENT_FAILED_WEBHOOK' && cfOrderId) {
      await prisma.order.updateMany({
        where: { upiTransactionId: cfOrderId },
        data:  { paymentStatus: 'FAILED' },
      });
      console.log(`[Cashfree] Order ${cfOrderId} marked FAILED`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[Cashfree] Webhook error:', err);
    res.status(200).json({ status: 'ok' }); // always 200 so Cashfree doesn't retry
  }
});

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Cashfree: remaining routes (create-order, confirm-order) use JSON body ──
app.use('/api/payments/cashfree', cashfreeRoutes);
// Express 5 + path-to-regexp does not accept "*" as a path pattern here.
// Use a regex to enable CORS preflight handling for all routes.
app.options(/.*/, cors(corsOptions));

const toIsoString = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const mapOrderStatus = (status) => {
  const normalized = String(status || '').toUpperCase();
  switch (normalized) {
    case 'PENDING':
      return 'pending';
    case 'CONFIRMED':
      return 'confirmed';
    case 'PROCESSING':
      return 'confirmed';
    case 'SHIPPED':
      return 'shipped';
    case 'DELIVERED':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'REFUNDED':
      return 'cancelled';
    default:
      return 'pending';
  }
};

const mapPaymentStatus = (status) => {
  const normalized = String(status || '').toUpperCase();
  switch (normalized) {
    case 'PAID':
      return 'paid';
    case 'FAILED':
      return 'failed';
    case 'REFUNDED':
      return 'failed';
    case 'PENDING':
    default:
      return 'pending';
  }
};

const toSlug = (value) => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const mapOrderForFrontend = (order) => {
  if (!order) return order;
  const customer = order.customer || {};
  const items = (order.items || []).map((item) => {
    const variant = item.variant || {};
    const product = variant.product || {};
    const unitPrice =
      typeof item.price === 'number'
        ? item.price
        : typeof product.basePrice === 'number'
        ? product.basePrice + (variant.additionalPrice || 0)
        : 0;
    const totalPrice = unitPrice * (item.quantity || 0);
    const image = Array.isArray(product.images) ? product.images[0] : '';
    return {
      productId: variant.productId || product.id || '',
      variantId: item.variantId || variant.id || '',
      productName: product.name || '',
      color: variant.color,
      pattern: variant.pattern,
      quantity: item.quantity || 0,
      unitPrice,
      totalPrice,
      image,
      variant:
        variant.color && variant.pattern ? `${variant.color} / ${variant.pattern}` : variant.color || variant.pattern,
    };
  });
  const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const totalAmount = typeof order.totalAmount === 'number' ? order.totalAmount : 0;
  const shippingCharge = Math.max(0, totalAmount - subtotal);

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerName: customer.name || '',
    customerPhone: customer.phone || '',
    customerEmail: customer.email || '',
    deliveryAddress: customer.address || '',
    city: customer.city || '',
    state: customer.state || '',
    pincode: customer.pincode || '',
    items,
    subtotal,
    shippingCharge,
    totalAmount,
    paymentMethod: order.paymentMethod || '',
    paymentStatus: mapPaymentStatus(order.paymentStatus),
    paymentScreenshot: order.paymentScreenshot,
    upiTransactionId: order.upiTransactionId,
    paidAt: toIsoString(order.paidAt),
    orderStatus: mapOrderStatus(order.status || order.orderStatus),
    trackingCarrier: order.trackingCarrier,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    shippedAt: toIsoString(order.shippedAt),
    deliveredAt: toIsoString(order.deliveredAt),
    notes: order.notes,
    createdAt: toIsoString(order.createdAt),
    updatedAt: toIsoString(order.updatedAt),
  };
};

const emptySettings = {
  site: {
    name: '',
    tagline: '',
    contactEmail: '',
    contactPhone: '',
    whatsappNumber: '',
    address: '',
  },
  upi: {
    vpa: '',
    name: '',
    qrCode: '',
  },
  social: {
    instagram: '',
    facebook: '',
    whatsapp: '',
  },
  policies: {
    returnDays: 0,
    replacementDays: 0,
    minOrderAmount: 0,
    freeShippingAbove: 0,
  },
};

const mapSettingsForFrontend = (settings) => {
  if (!settings) return emptySettings;
  return {
    ...emptySettings,
    site: {
      ...emptySettings.site,
      name: settings.storeName || '',
    },
    upi: {
      ...emptySettings.upi,
      vpa: settings.upiId || '',
      name: settings.upiName || '',
    },
  };
};

const normalizeSettingsInput = (body, existing) => {
  const normalized = {
    storeName: existing?.storeName ?? '',
    upiId: existing?.upiId ?? '',
    upiName: existing?.upiName ?? '',
    currency: existing?.currency ?? 'INR',
  };

  if (!body || typeof body !== 'object') return normalized;

  if (body.storeName != null) normalized.storeName = body.storeName;
  if (body.upiId != null) normalized.upiId = body.upiId;
  if (body.upiName != null) normalized.upiName = body.upiName;
  if (body.currency != null) normalized.currency = body.currency;

  if (body.site?.name != null) normalized.storeName = body.site.name;
  if (body.site?.currency != null) normalized.currency = body.site.currency;
  if (body.upi?.vpa != null) normalized.upiId = body.upi.vpa;
  if (body.upi?.name != null) normalized.upiName = body.upi.name;

  return normalized;
};

const mapDeliverySettingsForFrontend = (settings) => {
  const updatedAt = toIsoString(settings?.updatedAt) || toIsoString(new Date());
  const regions = (settings?.regions || []).map((region) => {
    const regionName =
      region.city && region.state
        ? `${region.city}, ${region.state}`
        : region.city || region.state || region.pincode || '';
    return {
      id: region.id,
      regionName,
      pincodeStart: region.pincode,
      pincodeEnd: region.pincode,
      isEnabled: region.isActive,
      deliveryCharge: region.shippingCharge,
      estimatedDays: 3,
      codAvailable: true,
      createdAt: updatedAt,
      updatedAt,
    };
  });

  return { regions };
};

const parseRegionName = (regionName) => {
  if (!regionName || typeof regionName !== 'string') return { city: '', state: '' };
  const parts = regionName.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return { city: '', state: '' };
  if (parts.length === 1) return { city: parts[0], state: '' };
  return { city: parts[0], state: parts.slice(1).join(', ') };
};

const normalizeDeliveryInput = (body, existing) => {
  const base = {
    freeShippingThreshold: existing?.freeShippingThreshold ?? 999,
    defaultShippingCharge: existing?.defaultShippingCharge ?? 50,
  };

  if (!body || typeof body !== 'object') {
    return { ...base, regions: [] };
  }

  const regionsInput = Array.isArray(body.regions) ? body.regions : [];
  const regions = regionsInput
    .map((region) => {
      const { city, state } = parseRegionName(region.regionName);
      const pincode = String(region.pincodeStart || region.pincode || '').trim();
      if (!pincode) return null;
      return {
        pincode,
        city: region.city || city || '',
        state: region.state || state || '',
        shippingCharge: Number(region.deliveryCharge ?? region.shippingCharge ?? base.defaultShippingCharge ?? 0),
        isActive: region.isEnabled ?? region.isActive ?? true,
      };
    })
    .filter(Boolean);

  return { ...base, regions };
};

const normalizeAdminRole = (role) => {
  const value = String(role || '').toLowerCase();
  if (value.includes('super')) return 'super_admin';
  if (value.includes('manager')) return 'manager';
  return 'admin';
};

const buildPermissions = (role) => {
  if (role === 'super_admin') {
    return {
      products: { create: true, read: true, update: true, delete: true },
      orders: { create: true, read: true, update: true, delete: true },
      customers: { create: true, read: true, update: true, delete: true },
      settings: { update: true },
    };
  }

  if (role === 'manager') {
    return {
      products: { create: false, read: true, update: true, delete: false },
      orders: { create: false, read: true, update: true, delete: false },
      customers: { create: false, read: true, update: false, delete: false },
      settings: { update: false },
    };
  }

  return {
    products: { create: true, read: true, update: true, delete: true },
    orders: { create: true, read: true, update: true, delete: true },
    customers: { create: true, read: true, update: true, delete: true },
    settings: { update: true },
  };
};

const mapAdminUserForFrontend = (user) => {
  if (!user) return user;
  const role = normalizeAdminRole(user.role);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    passwordHash: '',
    role,
    permissions: buildPermissions(role),
    isActive: user.isActive ?? true,
    lastLogin: toIsoString(user.lastLogin),
    createdAt: toIsoString(user.createdAt) || toIsoString(new Date()),
    updatedAt: toIsoString(user.updatedAt),
  };
};

// Ensure auth responses are never cached (prevents stale/304 behavior).
app.use('/api/auth', (req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Expires: '0',
  });
  next();
});

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'JSON Fashion Admin API',
      version: '1.0.0',
      description: 'Admin API for products, orders, customers, settings, and auth.',
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Local development',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
    tags: [
      { name: 'Auth' },
      { name: 'Categories' },
      { name: 'Subcategories' },
      { name: 'Products' },
      { name: 'Orders' },
      { name: 'Customers' },
      { name: 'Settings' },
      { name: 'Delivery' },
    ],
    paths: {
      '/api/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login and get a JWT',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string' },
                  },
                  required: ['email', 'password'],
                },
              },
            },
          },
          responses: {
            200: { description: 'Login successful' },
            401: { description: 'Invalid credentials' },
          },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current admin user',
          responses: {
            200: {
              description: 'Current user',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      user: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          username: { type: 'string' },
                          email: { type: 'string', format: 'email' },
                          role: { type: 'string' },
                          isActive: { type: 'boolean' },
                          lastLogin: { type: 'string', nullable: true },
                        },
                      },
                    },
                    required: ['user'],
                  },
                },
              },
            },
            401: { description: 'Unauthorized' },
            403: { description: 'Invalid token' },
          },
        },
      },
      '/api/categories': {
        get: {
          tags: ['Categories'],
          summary: 'List categories',
          security: [],
          responses: { 200: { description: 'Categories list' } },
        },
        post: {
          tags: ['Categories'],
          summary: 'Create category',
          responses: { 200: { description: 'Created category' } },
        },
      },
      '/api/categories/{id}': {
        put: {
          tags: ['Categories'],
          summary: 'Update category',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Updated category' } },
        },
        delete: {
          tags: ['Categories'],
          summary: 'Delete category',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted category' } },
        },
      },
      '/api/subcategories': {
        get: {
          tags: ['Subcategories'],
          summary: 'List subcategories',
          security: [],
          parameters: [
            { name: 'categoryId', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'categorySlug', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'Subcategories list' },
          },
        },
        post: {
          tags: ['Subcategories'],
          summary: 'Create subcategory',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    slug: { type: 'string', nullable: true, description: 'Optional; derived from name when omitted' },
                    categoryId: { type: 'string' },
                  },
                  required: ['name', 'categoryId'],
                },
                example: {
                  name: 'Summer Collection',
                  slug: 'summer-collection',
                  categoryId: 'ckxyz123',
                },
              },
            },
          },
          responses: {
            200: { description: 'Created subcategory' },
            400: { description: 'Validation error' },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/subcategories/{id}': {
        get: {
          tags: ['Subcategories'],
          summary: 'Get subcategory by id',
          security: [],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Subcategory' },
            404: { description: 'Not found' },
          },
        },
        put: {
          tags: ['Subcategories'],
          summary: 'Update subcategory',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', nullable: true },
                    slug: { type: 'string', nullable: true },
                    categoryId: { type: 'string', nullable: true },
                  },
                },
                example: {
                  name: 'Summer 2026',
                },
              },
            },
          },
          responses: {
            200: { description: 'Updated subcategory' },
            401: { description: 'Unauthorized' },
            404: { description: 'Not found' },
          },
        },
        delete: {
          tags: ['Subcategories'],
          summary: 'Delete subcategory',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Deleted subcategory' },
            401: { description: 'Unauthorized' },
            404: { description: 'Not found' },
          },
        },
      },
      '/api/products': {
        get: {
          tags: ['Products'],
          summary: 'List products',
          security: [],
          responses: { 200: { description: 'Products list' } },
        },
        post: {
          tags: ['Products'],
          summary: 'Create product',
          responses: { 200: { description: 'Created product' } },
        },
      },
      '/api/products/{id}': {
        get: {
          tags: ['Products'],
          summary: 'Get product by id',
          security: [],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Product' }, 404: { description: 'Not found' } },
        },
        put: {
          tags: ['Products'],
          summary: 'Update product',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Updated product' } },
        },
        delete: {
          tags: ['Products'],
          summary: 'Delete product',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Deleted product' } },
        },
      },
      '/api/orders': {
        get: {
          tags: ['Orders'],
          summary: 'List orders',
          responses: { 200: { description: 'Orders list' } },
        },
        post: {
          tags: ['Orders'],
          summary: 'Create order',
          security: [],
          responses: { 200: { description: 'Created order' } },
        },
      },
      '/api/orders/{id}': {
        put: {
          tags: ['Orders'],
          summary: 'Update order',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Updated order' } },
        },
      },
      '/api/customers': {
        get: {
          tags: ['Customers'],
          summary: 'List customers',
          responses: { 200: { description: 'Customers list' } },
        },
      },
      '/api/settings': {
        get: {
          tags: ['Settings'],
          summary: 'Get settings',
          security: [],
          responses: { 200: { description: 'Settings' } },
        },
        put: {
          tags: ['Settings'],
          summary: 'Update settings',
          responses: { 200: { description: 'Updated settings' } },
        },
      },
      '/api/delivery': {
        get: {
          tags: ['Delivery'],
          summary: 'Get delivery settings',
          security: [],
          responses: { 200: { description: 'Delivery settings' } },
        },
        put: {
          tags: ['Delivery'],
          summary: 'Update delivery settings',
          responses: { 200: { description: 'Updated delivery settings' } },
        },
      },
      '/api/routes': {
        get: {
          tags: ['Meta'],
          summary: 'List available routes',
          security: [],
          responses: { 200: { description: 'Routes list' } },
        },
      },
    },
  },
  apis: [],
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

if (PUBLIC_DOCS) {
  console.log('[DOCS] PUBLIC_DOCS=1: exposing /api/docs and /api/openapi.json without auth (local only).');
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api/openapi.json', (req, res) => {
    res.json(swaggerSpec);
  });
} else {
  app.use('/api/docs', authenticateToken, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api/openapi.json', authenticateToken, (req, res) => {
    res.json(swaggerSpec);
  });
}

app.get('/api/categories', async (req, res) => {
  try {
    console.log('[API] Fetching categories from database...');
    const categories = await prisma.category.findMany({
      include: {
        products: true,
        subcategories: { orderBy: { name: 'asc' } },
      }
    });
    console.log('[API] Categories found:', categories.length);
    res.json({ categories, products: categories.flatMap(c => c.products) });
  } catch (error) {
    console.error('[API] Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories', details: error.message });
  }
});

app.get('/api/subcategories', async (req, res) => {
  try {
    const { categoryId, categorySlug } = req.query;
    const where = {};
    if (categoryId) where.categoryId = String(categoryId);
    if (categorySlug) where.category = { slug: String(categorySlug) };

    const subcategories = await prisma.subcategory.findMany({
      where,
      include: { category: true },
      orderBy: { name: 'asc' },
    });

    res.json({ subcategories });
  } catch (error) {
    console.error('[API] Error fetching subcategories:', error);
    res.status(500).json({ error: 'Failed to fetch subcategories', details: error.message });
  }
});

app.get('/api/subcategories/:id', async (req, res) => {
  try {
    const subcategory = await prisma.subcategory.findUnique({
      where: { id: req.params.id },
      include: { category: true },
    });
    if (!subcategory) return res.status(404).json({ error: 'Subcategory not found' });
    res.json(subcategory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch subcategory' });
  }
});

app.post('/api/subcategories', authenticateToken, async (req, res) => {
  try {
    const { name, slug, categoryId } = req.body || {};
    if (!name || !categoryId) {
      return res.status(400).json({ error: 'name and categoryId are required' });
    }

    const subcategory = await prisma.subcategory.create({
      data: {
        name: String(name),
        slug: String(slug || toSlug(name)),
        categoryId: String(categoryId),
      },
    });
    res.json(subcategory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create subcategory', details: error.message });
  }
});

app.put('/api/subcategories/:id', authenticateToken, async (req, res) => {
  try {
    const { name, slug, categoryId } = req.body || {};
    const data = {};
    if (name != null) data.name = String(name);
    if (slug != null) data.slug = String(slug);
    if (categoryId != null) data.categoryId = String(categoryId);

    const subcategory = await prisma.subcategory.update({
      where: { id: req.params.id },
      data,
    });
    res.json(subcategory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update subcategory', details: error.message });
  }
});

app.delete('/api/subcategories/:id', authenticateToken, async (req, res) => {
  try {
    const subcategoryId = String(req.params.id);

    const existingSubcategory = await prisma.subcategory.findUnique({
      where: { id: subcategoryId },
    });

    if (!existingSubcategory) {
      return res.status(404).json({ error: 'Subcategory not found' });
    }

    await prisma.$transaction([
      prisma.product.updateMany({
        where: { subcategoryId },
        data: { subcategoryId: null },
      }),
      prisma.subcategory.delete({
        where: { id: subcategoryId },
      }),
    ]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete subcategory', details: error.message });
  }
});

app.post('/api/categories', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.category.create({
      data: req.body
    });
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.put('/api/categories/:id', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.delete('/api/categories/:id', authenticateToken, async (req, res) => {
  try {
    const categoryId = String(req.params.id);

    const existingCategory = await prisma.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });

    if (!existingCategory) {
      return res.status(404).json({ error: 'Category not found' });
    }

    await prisma.$transaction([
      prisma.product.deleteMany({
        where: { categoryId },
      }),
      prisma.subcategory.deleteMany({
        where: { categoryId },
      }),
      prisma.category.delete({
        where: { id: categoryId },
      }),
    ]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete category', details: error.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { categoryId, categorySlug, subcategoryId, subcategorySlug } = req.query;
    const where = {};
    if (categoryId) where.categoryId = String(categoryId);
    if (categorySlug) where.category = { slug: String(categorySlug) };
    if (subcategoryId) where.subcategoryId = String(subcategoryId);
    if (subcategorySlug) where.subcategory = { slug: String(subcategorySlug) };

    const products = await prisma.product.findMany({
      where,
      include: {
        category: true,
        subcategory: true,
        variants: true
      }
    });
    res.json({ products: products.map(serializeProduct) });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products', details: error.message });
  }
});

app.get('/api/products/slug/:slug', async (req, res) => {
  try {
    const product = await prisma.product.findFirst({
      where: { slug: req.params.slug },
      include: {
        category: true,
        subcategory: true,
        variants: true
      }
    });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(serializeProduct(product));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        category: true,
        subcategory: true,
        variants: true
      }
    });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(serializeProduct(product));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

app.post('/api/products', authenticateToken, async (req, res) => {
  try {
    const { variants, category, categoryId, subcategory, subcategoryId, ...productData } = req.body;
    const product = await prisma.product.create({
      data: {
        ...productData,
        categoryId: categoryId || category,
        ...(subcategoryId || subcategory ? { subcategoryId: subcategoryId || subcategory } : {}),
        variants: {
          create: variants || []
        }
      },
      include: {
        category: true,
        subcategory: true,
        variants: true
      }
    });
    res.json(serializeProduct(product));
  } catch (error) {
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { variants, category, categoryId, subcategory, subcategoryId, ...productData } = req.body;
    
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...productData,
        ...(categoryId || category ? { categoryId: categoryId || category } : {}),
        ...(subcategoryId !== undefined || subcategory !== undefined
          ? { subcategoryId: subcategoryId ?? subcategory ?? null }
          : {}),
        variants: variants ? {
          deleteMany: {},
          create: variants
        } : undefined
      },
      include: {
        category: true,
        subcategory: true,
        variants: true
      }
    });
    res.json(serializeProduct(product));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    await prisma.product.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const mappedOrders = orders.map((order) => mapOrderForFrontend(order));
    res.json({ orders: mappedOrders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Track order by phone + order number (public)
app.get('/api/orders/track', trackingLimiter, async (req, res) => {
  try {
    const { phone, orderNumber } = req.query;

    if (!phone || !orderNumber) {
      return res.status(400).json({ error: 'Phone and order number are required' });
    }

    const order = await prisma.order.findFirst({
      where: {
        orderNumber: orderNumber,
        customer: {
          phone: phone
        }
      },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(mapOrderForFrontend(order));
  } catch (error) {
    console.error('Track order error:', error);
    res.status(500).json({ error: 'Failed to track order' });
  }
});

// Get single order by order number (public — no auth needed)
app.get('/api/orders/by-number/:orderNumber', trackingLimiter, async (req, res) => {
  try {
    const { orderNumber } = req.params;

    if (!orderNumber) {
      return res.status(400).json({ error: 'Order number is required' });
    }

    const order = await prisma.order.findFirst({
      where: { orderNumber },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: { product: true }
            }
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(mapOrderForFrontend(order));
  } catch (error) {
    console.error('Fetch order by number error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Get orders by phone (public)
app.get('/api/orders/by-phone', trackingLimiter, async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const customer = await prisma.customer.findUnique({
      where: { phone },
      include: {
        orders: {
          include: {
            items: {
              include: {
                variant: {
                  include: {
                    product: true
                  }
                }
              }
            }
          },
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });

    if (!customer) {
      return res.json({ orders: [] });
    }

    const mappedOrders = customer.orders.map((order) => mapOrderForFrontend(order));
    res.json({ orders: mappedOrders });
  } catch (error) {
    console.error('Fetch orders by phone error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get single order by ID (requires auth)
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(mapOrderForFrontend(order));
  } catch (error) {
    console.error('Failed to fetch order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const { customer, items, ...orderData } = req.body;

    // Validate required fields
    if (!customer || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Customer and items are required' });
    }

    // Validate customer fields
    if (!customer.name || !customer.email || !customer.phone) {
      return res.status(400).json({ error: 'Customer name, email, and phone are required' });
    }

    // Validate phone number (10 digits)
    if (!/^\d{10}$/.test(customer.phone)) {
      return res.status(400).json({ error: 'Phone number must be exactly 10 digits' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customer.email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate items
    for (const item of items) {
      if (!item.variantId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: 'Each item must have variantId and quantity >= 1' });
      }
    }

    // Validate stock / availability
    const variantIds = [...new Set(items.map((i) => i.variantId))];
    const variants = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, stock: true, isAvailable: true },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));
    for (const item of items) {
      const variant = variantById.get(item.variantId);
      if (!variant) {
        return res.status(409).json({ error: 'Variant not found', variantId: item.variantId });
      }
      if (!variant.isAvailable || variant.stock <= 0) {
        return res.status(409).json({ error: 'Variant is not available', variantId: item.variantId });
      }
      if (item.quantity > variant.stock) {
        return res.status(409).json({
          error: 'Insufficient stock',
          variantId: item.variantId,
          available: variant.stock,
          requested: item.quantity,
        });
      }
    }

    const orderNumber = `ORD-${Date.now()}`;

    // Convert enum values to uppercase
    const normalizedOrderData = {
      ...orderData,
      status: orderData.status?.toUpperCase() || 'PENDING',
      paymentStatus: orderData.paymentStatus?.toUpperCase() || 'PENDING',
    };

    const order = await prisma.order.create({
      data: {
        ...normalizedOrderData,
        orderNumber,
        customer: {
          connectOrCreate: {
            where: { phone: customer.phone },
            create: {
              name: customer.name,
              email: customer.email,
              phone: customer.phone,
              address: customer.address || '',
              city: customer.city || '',
              state: customer.state || '',
              pincode: customer.pincode || ''
            }
          }
        },
        items: {
          create: items.map(item => ({
            quantity: item.quantity,
            price: item.price,
            variant: {
              connect: { id: item.variantId }
            }
          }))
        }
      },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        }
      }
    });

    res.json(mapOrderForFrontend(order));
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

app.put('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const updateData = { ...req.body };
    
    // Map frontend field names to database field names
    if (updateData.orderStatus) {
      updateData.status = updateData.orderStatus.toUpperCase();
      delete updateData.orderStatus;
    } else if (updateData.status) {
      updateData.status = updateData.status.toUpperCase();
    }
    
    if (updateData.paymentStatus) {
      updateData.paymentStatus = updateData.paymentStatus.toUpperCase();
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: {
                product: true
              }
            }
          }
        }
      }
    });
    res.json(mapOrderForFrontend(order));
  } catch (error) {
    console.error('Failed to update order:', error);
    res.status(500).json({ error: 'Failed to update order', details: error.message });
  }
});

app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      include: {
        orders: true
      }
    });
    const mappedCustomers = customers.map((customer) => {
      const orders = customer.orders || [];
      const totalOrders = orders.length;
      const totalSpent = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
      const lastOrderDate = orders.reduce((latest, order) => {
        const date = order.createdAt ? new Date(order.createdAt) : null;
        if (!date || Number.isNaN(date.getTime())) return latest;
        if (!latest) return date;
        return date > latest ? date : latest;
      }, null);

      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
        city: customer.city,
        pincode: customer.pincode,
        totalOrders,
        totalSpent,
        lastOrderDate: toIsoString(lastOrderDate),
        createdAt: toIsoString(customer.createdAt),
        updatedAt: toIsoString(customer.updatedAt),
      };
    });
    res.json({ customers: mappedCustomers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const settings = await prisma.settings.findFirst();
    res.json(mapSettingsForFrontend(settings));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.get('/api/public/settings', async (req, res) => {
  try {
    const settings = await prisma.settings.findFirst();
    res.json(mapSettingsForFrontend(settings));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.settings.findFirst();
    let settings;
    const normalized = normalizeSettingsInput(req.body, existing);
    
    if (existing) {
      settings = await prisma.settings.update({
        where: { id: existing.id },
        data: normalized
      });
    } else {
      settings = await prisma.settings.create({
        data: normalized
      });
    }
    
    const mapped = mapSettingsForFrontend(settings);
    if (req.body?.site) return res.json(mapped.site);
    if (req.body?.upi) return res.json(mapped.upi);
    if (req.body?.social) return res.json(mapped.social);
    if (req.body?.policies) return res.json(mapped.policies);
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

app.get('/api/delivery', authenticateToken, async (req, res) => {
  try {
    const settings = await prisma.deliverySettings.findFirst({
      include: { regions: true }
    });
    res.json(mapDeliverySettingsForFrontend(settings));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch delivery settings' });
  }
});

app.put('/api/delivery', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.deliverySettings.findFirst();
    let settings;
    const normalized = normalizeDeliveryInput(req.body, existing);
    
    if (existing) {
      settings = await prisma.deliverySettings.update({
        where: { id: existing.id },
        data: {
          freeShippingThreshold: normalized.freeShippingThreshold,
          defaultShippingCharge: normalized.defaultShippingCharge,
          regions: {
            deleteMany: {},
            create: normalized.regions,
          },
        },
        include: { regions: true },
      });
    } else {
      settings = await prisma.deliverySettings.create({
        data: {
          freeShippingThreshold: normalized.freeShippingThreshold,
          defaultShippingCharge: normalized.defaultShippingCharge,
          regions: {
            create: normalized.regions,
          },
        },
        include: { regions: true },
      });
    }
    
    res.json(mapDeliverySettingsForFrontend(settings));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update delivery settings' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (AUTH_DEBUG) console.log('[AUTH] Login attempt for:', email);
    
    const user = await prisma.adminUser.findUnique({
      where: { email }
    });
    
    if (AUTH_DEBUG) {
      console.log('[AUTH] User lookup result:', user ? { id: user.id, isActive: user.isActive } : null);
    }

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    let isValidPassword = false;
    try {
      isValidPassword = await bcrypt.compare(password, user.passwordHash);
    } catch (err) {
      console.error('[AUTH] bcrypt.compare failed:', err);
      return res.status(500).json({ error: 'Login failed' });
    }
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({
      token,
      user: mapAdminUserForFrontend(user)
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.adminUser.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true
      }
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ user: mapAdminUserForFrontend(user) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

const listRoutes = () => {
  const routes = []
  const stack = app._router?.stack || []
  for (const layer of stack) {
    if (!layer.route) continue
    const path = layer.route.path
    const methods = Object.keys(layer.route.methods || {})
      .filter((m) => layer.route.methods[m])
      .map((m) => m.toUpperCase())
    routes.push({ methods, path })
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path))
}

const serializeProduct = (product) => {
  if (!product) return product
  const { category, subcategory, ...rest } = product
  return {
    ...rest,
    // Preserve the old contract expected by customer-web: `category` is a string.
    // Use category slug when available, otherwise fall back to `categoryId`.
    category: category?.slug || rest.categoryId,
    // Keep full category details for admin-web/other clients.
    categoryDetails: category || null,
    subcategory: subcategory?.slug || rest.subcategoryId || null,
    subcategoryDetails: subcategory || null,
  }
}

app.get('/api/routes', authenticateToken, (req, res) => {
  res.json({ routes: listRoutes() })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});