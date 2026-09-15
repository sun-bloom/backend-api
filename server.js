const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { PrismaClient, Prisma } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const app = express();
const { matchDeliveryRegion, calculateShipping } = require('./lib/deliveryMatcher');
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

const configuredOrigins = [
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : []),
  process.env.FRONTEND_URL,
  process.env.ADMIN_FRONTEND_URL,
  'http://localhost:4321',
  'http://localhost:3000',
  'http://localhost:5173',
]
  .filter(Boolean)
  .map((o) => o.trim().replace(/\/$/, ''));

const corsOriginAllowlist = new Set(configuredOrigins);

const isCorsOriginAllowed = (origin) => {
  // Allow non-browser requests (no Origin header) like curl/health checks.
  if (!origin) return true;
  try {
    const url = new URL(origin);
    // Always allow localhost in development.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    // Allow Cloudflare Pages deployments (*.pages.dev) and production domains
    if (
      url.hostname.endsWith('.pages.dev') ||
      url.hostname === 'sunbloomadorn.com' ||
      url.hostname.endsWith('.sunbloomadorn.com')
    ) {
      return true;
    }
    return corsOriginAllowlist.has(origin);
  } catch {
    return false;
  }
};

const corsOptions = {
  origin: (origin, callback) => callback(null, isCorsOriginAllowed(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 204,
};

// ── Health Endpoint (Render & Uptime Monitoring) ───────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
});

// ── Razorpay: webhook must be mounted BEFORE express.json() (needs raw body) ──
const { router: razorpayRoutes, confirmOrderPayment } = require('./routes/razorpay.routes');
const crypto = require('crypto');

// POST: Razorpay payment webhook
app.post('/api/payments/razorpay/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = req.body?.toString('utf8') || '';

    if (!process.env.RAZORPAY_KEY_SECRET) {
      console.error('[Razorpay Webhook] RAZORPAY_KEY_SECRET not configured on server.');
      return res.status(500).json({ message: 'Server configuration error' });
    }

    if (!signature) {
      console.warn('[Razorpay Webhook] Missing signature header');
      return res.status(401).json({ message: 'Missing signature' });
    }

    // Verify HMAC-SHA256 signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(rawBody)
      .digest('hex');

    if (expected !== signature) {
      console.warn('[Razorpay Webhook] Signature mismatch');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    let event;
    try { event = JSON.parse(rawBody); }
    catch { return res.status(400).json({ message: 'Invalid payload' }); }

    const { event: eventType, payload } = event;
    const rzpOrderId = payload?.payment?.entity?.order_id;

    console.log(`[Razorpay Webhook] Event: ${eventType} — order: ${rzpOrderId}`);

    if (eventType === 'payment.captured' && rzpOrderId) {
      const confirmation = await confirmOrderPayment(prisma, rzpOrderId);
      console.log(`[Razorpay Webhook] Order ${rzpOrderId} confirmed. Already processed: ${confirmation.alreadyProcessed}`);
    }

    if (eventType === 'payment.failed' && rzpOrderId) {
      await prisma.order.updateMany({
        where: { upiTransactionId: rzpOrderId, paymentStatus: 'PENDING' },
        data:  { paymentStatus: 'FAILED', status: 'CANCELLED' },
      });
      console.log(`[Razorpay Webhook] Order ${rzpOrderId} marked FAILED`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[Razorpay Webhook] Webhook error:', err?.message || err);
    res.status(200).json({ status: 'ok' }); // always 200 so Razorpay doesn't retry
  }
});

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Razorpay routes (create-order, verify-payment, status) ──────────────────
app.use('/api/payments/razorpay', razorpayRoutes);
// Preflight CORS
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

const CATEGORY_NUMBER_RE = /^\d{3}$/;
const PRODUCT_NUMBER_RE = /^(\d{3})-(\d{2})$/;
const VARIANT_NUMBER_RE = /^\d{2}$/;

const validateCategoryNumber = (value) => {
  const normalized = String(value ?? '').trim();
  if (!CATEGORY_NUMBER_RE.test(normalized)) throw new Error('Category Number must be exactly 3 digits');
  return normalized;
};

const validateProductNumber = (value, categoryNumber) => {
  const normalized = String(value ?? '').trim();
  const match = PRODUCT_NUMBER_RE.exec(normalized);
  if (!match || match[1] !== categoryNumber || Number(match[2]) < 1 || Number(match[2]) > 99) {
    throw new Error('Product Number must match CATEGORY_NUMBER-01 through CATEGORY_NUMBER-99');
  }
  return normalized;
};

const validateVariantNumbers = (variants) => {
  const seen = new Set();
  return variants.map((variant, index) => {
    const number = String(variant.variantNumber || String(index + 1).padStart(2, '0')).trim();
    if (!VARIANT_NUMBER_RE.test(number) || Number(number) < 1 || Number(number) > 99) {
      throw new Error('Variant Number must be between 01 and 99');
    }
    if (seen.has(number)) throw new Error(`Duplicate Variant Number: ${number}`);
    seen.add(number);
    return number;
  });
};

const serializeCategory = (category) => ({
  id: category.id,
  name: category.name,
  slug: category.slug,
  description: category.description,
  image: category.image,
  subcategories: (category.subcategories || []).map(({ id, name, slug, categoryId }) => ({ id, name, slug, categoryId })),
});

const mapOrderForFrontend = (order, isAdmin = false) => {
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
    const image = (Array.isArray(variant.images) && variant.images[0]) || (Array.isArray(product.images) && product.images[0]) || '';
    
    const mappedItem = {
      productName: product.name || '',
      productSlug: product.slug || '',
      color: variant.color,
      pattern: variant.pattern,
      quantity: item.quantity || 0,
      unitPrice,
      totalPrice,
      image,
      variant:
        variant.color && variant.pattern ? `${variant.color} / ${variant.pattern}` : variant.color || variant.pattern,
    };

    if (isAdmin) {
      mappedItem.productId = variant.productId || product.id || '';
      mappedItem.variantId = item.variantId || variant.id || '';
      mappedItem.productNumber = product.productNumber || '';
      mappedItem.variantNumber = variant.variantNumber || '';
    }

    return mappedItem;
  });

  const calculatedSubtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const subtotal = typeof order.subtotal === 'number' ? order.subtotal : calculatedSubtotal;
  const totalAmount = typeof order.totalAmount === 'number' ? order.totalAmount : 0;
  const shippingCharge = typeof order.deliveryCharge === 'number' ? order.deliveryCharge : Math.max(0, totalAmount - subtotal);

  const mapped = {
    orderNumber: order.orderNumber,
    orderStatus: mapOrderStatus(order.status || order.orderStatus),
    paymentStatus: mapPaymentStatus(order.paymentStatus),
    paymentMethod: order.paymentMethod || '',
    items,
    subtotal,
    shippingCharge,
    totalAmount,
    customerName: customer.name || '',
    customerPhone: customer.phone || '',
    whatsappNumber: order.whatsappNumber || customer.whatsappNumber || '',
    deliveryAddress: order.deliveryAddress || customer.address || '',
    city: order.city || customer.city || '',
    state: order.state || customer.state || '',
    pincode: order.pincode || customer.pincode || '',
    trackingRequested: Boolean(order.trackingRequested),
    trackingCarrier: order.trackingCarrier || null,
    trackingNumber: order.trackingNumber || null,
    trackingUrl: order.trackingUrl || null,
    shippedAt: toIsoString(order.shippedAt),
    deliveredAt: toIsoString(order.deliveredAt),
    createdAt: toIsoString(order.createdAt),
    updatedAt: toIsoString(order.updatedAt),
  };

  if (isAdmin) {
    mapped.id = order.id;
    mapped.customerId = order.customerId;
    mapped.customerEmail = customer.email || '';
    mapped.paymentScreenshot = order.paymentScreenshot;
    mapped.upiTransactionId = order.upiTransactionId;
    mapped.paidAt = toIsoString(order.paidAt);
    mapped.notes = order.notes;
  }

  return mapped;
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
  const regions = (settings?.regions || []).map((region) => ({
    id: region.id,
    city: region.city || '',
    state: region.state || '',
    pincodeStart: region.pincodeStart || region.pincode || '',
    pincodeEnd: region.pincodeEnd || region.pincodeStart || region.pincode || '',
    isEnabled: Boolean(region.isActive),
    deliveryCharge: region.shippingCharge,
  }));

  return {
    freeShippingThreshold: settings?.freeShippingThreshold ?? 1500,
    defaultShippingCharge: settings?.defaultShippingCharge ?? 50,
    regions,
  };
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
    freeShippingThreshold: Number(body?.freeShippingThreshold ?? existing?.freeShippingThreshold ?? 9999),
    defaultShippingCharge: Number(body?.defaultShippingCharge ?? existing?.defaultShippingCharge ?? 100),
  };

  if (!body || typeof body !== 'object') {
    return { ...base, regions: [] };
  }

  const regionsInput = Array.isArray(body.regions) ? body.regions : [];
  const regions = regionsInput
    .map((region) => {
      const regionName = String(region.regionName || region.city || '').trim();
      if (!regionName) return null;
      const { city, state } = parseRegionName(regionName);
      const pincode = String(region.pincode || region.pincodeStart || '').trim();
      const pincodeStart = String(region.pincodeStart || pincode).trim() || null;
      const pincodeEnd = String(region.pincodeEnd || pincodeStart || '').trim() || null;
      const charge = Number(region.deliveryCharge ?? region.shippingCharge ?? base.defaultShippingCharge ?? 100);
      return {
        regionName,
        pincode: pincode || null,
        pincodeStart,
        pincodeEnd,
        city: region.city || city || regionName,
        state: region.state || state || null,
        shippingCharge: isNaN(charge) ? 100 : charge,
        isActive: region.isEnabled !== undefined ? Boolean(region.isEnabled) : region.isActive !== undefined ? Boolean(region.isActive) : true,
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

const {
  authenticateFirebaseToken,
  requireCustomer,
  requireAdmin,
} = require('./middleware/auth.middleware');

// Admin authentication middleware (Firebase Token + PostgreSQL Admin Role)
const authenticateAdmin = [authenticateFirebaseToken, requireAdmin];
// Customer authentication middleware (Firebase Token + Customer Record Sync)
const authenticateCustomer = [authenticateFirebaseToken, requireCustomer];

// Standard auth middleware for protected endpoints
const authenticateToken = authenticateFirebaseToken;

// Admin Media Routes (Cloudinary Image Upload & Management)
const mediaRoutes = require('./routes/media.routes');
app.use('/api/admin/media', authenticateAdmin, mediaRoutes);

// Customer Query & Support System Routes
const { customerRouter, adminRouter } = require('./routes/customerQuery.routes');
app.use('/api/customer/queries', authenticateCustomer, customerRouter);
app.use('/api/admin/customer-queries', authenticateAdmin, adminRouter);

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
      include: { subcategories: { orderBy: { name: 'asc' } } },
      orderBy: { categoryNumber: 'asc' },
    });
    console.log('[API] Categories found:', categories.length);
    res.json({ categories: categories.map(serializeCategory) });
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

    res.json({
      subcategories: subcategories.map(({ category, ...subcategory }) => ({
        ...subcategory,
        category: category ? serializeCategory(category) : undefined,
      })),
    });
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
    const { category, ...subcategoryData } = subcategory;
    res.json({ ...subcategoryData, category: category ? serializeCategory(category) : undefined });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch subcategory' });
  }
});

app.post('/api/subcategories', authenticateAdmin, async (req, res) => {
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

app.put('/api/subcategories/:id', authenticateAdmin, async (req, res) => {
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

app.delete('/api/subcategories/:id', authenticateAdmin, async (req, res) => {
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

app.post('/api/categories', authenticateAdmin, async (req, res) => {
  try {
    const { name, slug, description, image, categoryNumber } = req.body || {};
    const category = await prisma.category.create({
      data: { name, slug, description, image, categoryNumber: validateCategoryNumber(categoryNumber) }
    });
    res.json(category);
  } catch (error) {
    const status = error?.code === 'P2002' ? 409 : /Category Number/.test(error?.message || '') ? 400 : 500;
    res.status(status).json({ error: status === 409 ? 'Category Number or slug already exists' : error?.message || 'Failed to create category' });
  }
});

app.put('/api/categories/:id', authenticateAdmin, async (req, res) => {
  try {
    const { name, slug, description, image, categoryNumber } = req.body || {};
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: { name, slug, description, image, categoryNumber: validateCategoryNumber(categoryNumber) }
    });
    res.json(category);
  } catch (error) {
    const status = error?.code === 'P2002' ? 409 : /Category Number/.test(error?.message || '') ? 400 : 500;
    res.status(status).json({ error: status === 409 ? 'Category Number or slug already exists' : error?.message || 'Failed to update category' });
  }
});

app.delete('/api/categories/:id', authenticateAdmin, async (req, res) => {
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

// Admin-only: Returns full product data including productNumber (NOT exposed to customers)
app.get('/api/admin/products', authenticateAdmin, async (req, res) => {
  try {
    const { categoryId, categorySlug, subcategoryId, subcategorySlug, productNumber, q } = req.query;
    const where = {};
    if (categoryId) where.categoryId = String(categoryId);
    if (categorySlug) where.category = { slug: String(categorySlug) };
    if (subcategoryId) where.subcategoryId = String(subcategoryId);
    if (subcategorySlug) where.subcategory = { slug: String(subcategorySlug) };
    if (productNumber) where.productNumber = String(productNumber);
    if (q) {
      const query = String(q);
      where.OR = [
        { id: query },
        { productNumber: { contains: query, mode: 'insensitive' } },
        { slug: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
      ];
    }

    const products = await prisma.product.findMany({
      where,
      include: {
        category: true,
        subcategory: true,
        variants: true
      },
      orderBy: { productNumber: 'asc' }
    });

    // Admin sees full product data INCLUDING productNumber
    const adminProducts = products.map((product) => {
      const { category, subcategory, ...rest } = product;
      return {
        ...rest,
        category: category?.slug || rest.categoryId,
        categoryDetails: category || null,
        subcategory: subcategory?.slug || rest.subcategoryId || null,
        subcategoryDetails: subcategory || null,
        // productNumber is KEPT for admin — not stripped
      };
    });

    res.json({ products: adminProducts });
  } catch (error) {
    console.error('Error fetching admin products:', error);
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

app.post('/api/products', authenticateAdmin, async (req, res) => {
  try {
    const { variants, category, categoryId, subcategory, subcategoryId, productNumber: _ignoredProductNumber, ...productData } = req.body;
    const resolvedCategoryId = categoryId || category;
    const selectedCategory = await prisma.category.findUnique({ where: { id: resolvedCategoryId } });
    if (!selectedCategory) return res.status(400).json({ error: 'Invalid category' });
    const categoryNumber = validateCategoryNumber(selectedCategory.categoryNumber);
    const existingNumbers = await prisma.product.findMany({
      where: { categoryId: resolvedCategoryId, productNumber: { not: null } },
      select: { productNumber: true },
    });
    const used = new Set(existingNumbers.map((p) => p.productNumber));
    let sequence = 1;
    while (used.has(`${categoryNumber}-${String(sequence).padStart(2, '0')}`) && sequence <= 99) sequence += 1;
    if (sequence > 99) return res.status(409).json({ error: 'No Product Number available for this category' });
    productData.productNumber = `${categoryNumber}-${String(sequence).padStart(2, '0')}`;

    const variantNumbers = validateVariantNumbers(variants || []);
    const processedVariants = (variants || []).map((v, idx) => {
      const vNum = variantNumbers[idx];
      const sku = v.sku || `${productData.productNumber}-V${vNum}-${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      return {
        color: v.color || 'Standard',
        pattern: v.pattern || 'Classic',
        stock: Number(v.stock) || 0,
        additionalPrice: Number(v.additionalPrice) || 0,
        variantNumber: vNum,
        sku,
        images: Array.isArray(v.images) && v.images.length > 0 ? v.images : (Array.isArray(productData.images) && productData.images.length > 0 ? [productData.images[0]] : []),
        isAvailable: v.isAvailable !== false,
      };
    });

    const product = await prisma.product.create({
      data: {
        ...productData,
        categoryId: resolvedCategoryId,
        ...(subcategoryId || subcategory ? { subcategoryId: subcategoryId || subcategory } : {}),
        variants: {
          create: processedVariants
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
    console.error('Error creating product:', {
      message: error?.message,
      code: error?.code,
      meta: error?.meta,
    });

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return res.status(409).json({
          error: 'Unique constraint failed',
          fields: error?.meta?.target || null,
          details: 'A product slug or variant identifier already exists. Use a different value.'
        });
      }
      if (error.code === 'P2003') {
        return res.status(400).json({
          error: 'Invalid reference',
          details: 'categoryId (or other referenced id) is invalid.'
        });
      }
    }

    const status = error?.code === 'P2002' || /Product Number|Variant Number|Duplicate Variant/.test(error?.message || '') ? 400 : 500;
    res.status(status).json({ error: error?.message || 'Failed to create product' });
  }
});

app.put('/api/products/:id', authenticateAdmin, async (req, res) => {
  try {
    const { variants, category, categoryId, subcategory, subcategoryId, ...productData } = req.body;
    const productId = req.params.id;
    const existingProduct = await prisma.product.findUnique({ where: { id: productId } });
    if (!existingProduct) return res.status(404).json({ error: 'Product not found' });
    const resolvedCategoryId = categoryId || category || existingProduct.categoryId;
    const selectedCategory = await prisma.category.findUnique({ where: { id: resolvedCategoryId } });
    if (!selectedCategory) return res.status(400).json({ error: 'Invalid category' });
    const categoryNumber = validateCategoryNumber(selectedCategory.categoryNumber);
    if (productData.productNumber != null) productData.productNumber = validateProductNumber(productData.productNumber, categoryNumber);
    if (resolvedCategoryId !== existingProduct.categoryId && productData.productNumber == null) {
      return res.status(400).json({ error: 'Product Number must be supplied when changing category' });
    }

    if (Array.isArray(variants)) {
      const existingVariants = await prisma.variant.findMany({
        where: { productId }
      });
      const existingById = new Map(existingVariants.map(v => [v.id, v]));

      const variantNumbers = validateVariantNumbers(variants);
      const processedVariants = variants.map((v, idx) => {
        const existing = v.id ? existingById.get(v.id) : null;
        const vNum = variantNumbers[idx] || existing?.variantNumber || String(idx + 1).padStart(2, '0');
        const sku = v.sku || existing?.sku || `${productData.productNumber || 'P'}-V${vNum}-${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
        return {
          id: v.id || undefined,
          color: v.color || 'Standard',
          pattern: v.pattern || 'Classic',
          stock: Number(v.stock) || 0,
          additionalPrice: Number(v.additionalPrice) || 0,
          variantNumber: vNum,
          sku,
          images: Array.isArray(v.images) && v.images.length > 0 ? v.images : (existing?.images || []),
          isAvailable: v.isAvailable !== false,
        };
      });

      const incomingSkus = processedVariants.map((v) => v.sku);

      // Prevent SKU collisions across products (sku is globally unique in schema).
      const existingBySku = await prisma.variant.findMany({
        where: { sku: { in: incomingSkus } },
        select: { sku: true, productId: true },
      });
      const foreign = existingBySku.find((v) => v.productId !== productId);
      if (foreign) {
        return res
          .status(400)
          .json({ error: `Identifier collision across products` });
      }

      const [updatedProduct] = await prisma.$transaction([
        prisma.product.update({
          where: { id: productId },
          data: {
            ...productData,
            categoryId: resolvedCategoryId,
            ...(subcategoryId !== undefined || subcategory !== undefined
              ? { subcategoryId: subcategoryId ?? subcategory ?? null }
              : {}),
            variants: {
              upsert: processedVariants.map((v) => ({
                where: { sku: v.sku },
                update: {
                  color: v.color,
                  pattern: v.pattern,
                  stock: v.stock,
                  additionalPrice: v.additionalPrice,
                  variantNumber: v.variantNumber,
                  images: v.images,
                  isAvailable: v.isAvailable,
                },
                create: {
                  color: v.color,
                  pattern: v.pattern,
                  stock: v.stock,
                  additionalPrice: v.additionalPrice,
                  variantNumber: v.variantNumber,
                  sku: v.sku,
                  images: v.images,
                  isAvailable: v.isAvailable ?? true,
                },
              })),
            },
          },
          include: {
            category: true,
            subcategory: true,
            variants: true,
          },
        }),
        prisma.variant.updateMany({
          where: {
            productId,
            sku: { notIn: incomingSkus },
          },
          data: {
            isAvailable: false,
            stock: 0,
          },
        }),
      ]);

      return res.json(serializeProduct(updatedProduct));
    }

    // If variants are not part of this request, only update product fields.
    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        ...productData,
        categoryId: resolvedCategoryId,
        ...(subcategoryId !== undefined || subcategory !== undefined
          ? { subcategoryId: subcategoryId ?? subcategory ?? null }
          : {}),
      },
      include: {
        category: true,
        subcategory: true,
        variants: true,
      },
    })
    res.json(serializeProduct(product))
  } catch (error) {
    const status = error?.code === 'P2002' || /Product Number|Variant Number|Duplicate Variant/.test(error?.message || '') ? 400 : 500;
    res.status(status).json({ error: error?.message || 'Failed to update product' });
  }
});

app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
  try {
    await prisma.product.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/orders', authenticateAdmin, async (req, res) => {
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
    const mappedOrders = orders.map((order) => mapOrderForFrontend(order, true));
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

// Get single order by ID (Admin only)
app.get('/api/orders/:id', authenticateAdmin, async (req, res) => {
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

    res.json(mapOrderForFrontend(order, true));
  } catch (error) {
    console.error('Failed to fetch order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

app.post('/api/orders', orderLimiter, async (req, res) => {
  try {
    const { customer, items, ...orderData } = req.body;

    if (!customer || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Customer and items are required' });
    }

    if (!customer.name || !customer.email || !customer.phone) {
      return res.status(400).json({ error: 'Customer name, email, and phone are required' });
    }

    const cleanPhone = String(customer.phone).replace(/\D/g, '').slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Phone number must be exactly 10 digits' });
    }

    for (const item of items) {
      if (!item.variantId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: 'Each item must have variantId and quantity >= 1' });
      }
    }

    const variantIds = [...new Set(items.map((i) => i.variantId))];
    const variants = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      include: { product: true },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));
    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const variant = variantById.get(item.variantId);
      if (!variant || !variant.isAvailable || variant.stock < item.quantity) {
        return res.status(409).json({ error: 'Variant not available or insufficient stock' });
      }
      const unitPrice = (variant.product?.basePrice || 0) + (variant.additionalPrice || 0);
      subtotal += unitPrice * item.quantity;
      validatedItems.push({
        variantId: variant.id,
        quantity: item.quantity,
        price: unitPrice,
      });
    }

    const deliveryCharge = Number(orderData.deliveryCharge) >= 0 ? Number(orderData.deliveryCharge) : 100;
    const totalAmount = subtotal + deliveryCharge;
    const orderNumber = `ORD-${Date.now()}`;

    const order = await prisma.order.create({
      data: {
        orderNumber,
        status: orderData.status?.toUpperCase() || 'PENDING',
        paymentStatus: orderData.paymentStatus?.toUpperCase() || 'PENDING',
        paymentMethod: orderData.paymentMethod || 'PENDING',
        totalAmount,
        subtotal,
        deliveryCharge,
        deliveryAddress: customer.address || '',
        city: customer.city || '',
        state: customer.state || '',
        pincode: customer.pincode || '',
        whatsappNumber: customer.whatsappNumber ? String(customer.whatsappNumber).replace(/\D/g, '').slice(-10) : null,
        trackingRequested: Boolean(orderData.trackingRequested),
        customer: {
          connectOrCreate: {
            where: { phone: cleanPhone },
            create: {
              name: customer.name,
              email: customer.email,
              phone: cleanPhone,
              whatsappNumber: customer.whatsappNumber ? String(customer.whatsappNumber).replace(/\D/g, '').slice(-10) : null,
              address: customer.address || '',
              city: customer.city || '',
              state: customer.state || '',
              pincode: customer.pincode || '',
            }
          }
        },
        items: {
          create: validatedItems.map(item => ({
            quantity: item.quantity,
            price: item.price,
            variant: { connect: { id: item.variantId } }
          }))
        }
      },
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

    res.json(mapOrderForFrontend(order, false));
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

app.put('/api/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    const updateData = { ...req.body };
    
    if (updateData.orderStatus) {
      updateData.status = updateData.orderStatus.toUpperCase();
      delete updateData.orderStatus;
    } else if (updateData.status) {
      updateData.status = updateData.status.toUpperCase();
    }
    
    if (updateData.paymentStatus) {
      updateData.paymentStatus = updateData.paymentStatus.toUpperCase();
    }

    if (updateData.status === 'SHIPPED' && !updateData.shippedAt) {
      updateData.shippedAt = new Date();
    }
    if (updateData.status === 'DELIVERED' && !updateData.deliveredAt) {
      updateData.deliveredAt = new Date();
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: updateData,
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
    res.json(mapOrderForFrontend(order, true));
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

app.get('/api/delivery', async (req, res) => {
  try {
    const settings = await prisma.deliverySettings.findFirst({
      include: { regions: { orderBy: { regionName: 'asc' } } }
    });
    res.json(mapDeliverySettingsForFrontend(settings));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch delivery settings' });
  }
});

app.post('/api/delivery/calculate', async (req, res) => {
  try {
    const { subtotal = 0, pincode } = req.body || {};
    const cleanPin = String(pincode || '').trim().replace(/\D/g, '');

    if (cleanPin.length !== 6) {
      return res.status(400).json({
        isSupported: false,
        shippingCharge: 0,
        isFreeShipping: false,
        freeShippingThreshold: 1500,
        message: 'Please enter a valid 6-digit pincode.',
        matchedRegion: null,
      });
    }

    const deliverySettings = await prisma.deliverySettings.findFirst({ include: { regions: true } });
    const threshold = Number(deliverySettings?.freeShippingThreshold ?? 1500);
    // Pincode-primary matching — city/state NOT used for matching
    const matchedRegion = matchDeliveryRegion(deliverySettings?.regions || [], cleanPin);
    const result = calculateShipping(Number(subtotal), deliverySettings, matchedRegion);

    if (!result.isSupported) {
      return res.json({
        isSupported: false,
        shippingCharge: 0,
        isFreeShipping: false,
        freeShippingThreshold: threshold,
        message: `Delivery is currently unavailable for pincode ${cleanPin}.`,
        matchedRegion: null,
      });
    }

    return res.json({
      isSupported: true,
      shippingCharge: result.shippingCharge,
      isFreeShipping: result.isFreeShipping,
      freeShippingThreshold: threshold,
      matchedRegion: {
        city: matchedRegion.city,
        state: matchedRegion.state || '',
        pincodeStart: matchedRegion.pincodeStart,
        pincodeEnd: matchedRegion.pincodeEnd,
        shippingCharge: result.shippingCharge,
      },
    });
  } catch (error) {
    console.error('[Delivery Calculate] error:', error);
    res.status(500).json({ error: 'Failed to calculate delivery fee' });
  }
});

// Public endpoint: India state -> city list for admin/customer dropdowns
app.get('/api/delivery/geo', (req, res) => {
  try {
    const { INDIA_STATES, STATE_CITIES } = require('./lib/indiaGeoData');
    const { state } = req.query;
    if (state) {
      return res.json({ cities: STATE_CITIES[state] || [] });
    }
    return res.json({ states: INDIA_STATES });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load geo data' });
  }
});

app.put('/api/delivery', authenticateAdmin, async (req, res) => {
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

// ── Customer Auth Endpoints (Firebase Authenticated) ──────────────────────
app.post('/api/auth/sync-customer', authenticateCustomer, async (req, res) => {
  res.json({
    success: true,
    customer: req.customer,
  });
});

app.get('/api/auth/customer/me', authenticateCustomer, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.customer.id },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          include: {
            items: {
              include: {
                variant: {
                  include: {
                    product: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ customer });
  } catch (err) {
    console.error('[API] /api/auth/customer/me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch customer profile' });
  }
});

// Update Customer Profile (Firebase Authenticated)
app.put('/api/auth/customer/me', authenticateCustomer, async (req, res) => {
  try {
    const { name, phone, whatsappNumber, address, city, state, pincode } = req.body;
    const updated = await prisma.customer.update({
      where: { id: req.customer.id },
      data: {
        ...(name && { name: String(name).trim() }),
        ...(phone !== undefined && { phone: phone ? String(phone).trim() : null }),
        ...(whatsappNumber !== undefined && { whatsappNumber: whatsappNumber ? String(whatsappNumber).trim() : null }),
        ...(address !== undefined && { address: address ? String(address).trim() : null }),
        ...(city !== undefined && { city: city ? String(city).trim() : null }),
        ...(state !== undefined && { state: state ? String(state).trim() : null }),
        ...(pincode !== undefined && { pincode: pincode ? String(pincode).trim() : null }),
      },
    });
    res.json({ success: true, customer: updated });
  } catch (err) {
    console.error('[API] PUT /api/auth/customer/me error:', err.message);
    res.status(500).json({ error: 'Failed to update customer profile' });
  }
});

// Authenticated Customer Orders (Strict ownership enforcement)
app.get('/api/customer/orders', authenticateCustomer, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { customerId: req.customer.id },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            variant: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });
    res.json({ orders: orders.map((o) => mapOrderForFrontend(o, false)) });
  } catch (err) {
    console.error('[API] /api/customer/orders error:', err.message);
    res.status(500).json({ error: 'Failed to fetch customer orders' });
  }
});

app.get('/api/customer/orders/:id', authenticateCustomer, async (req, res) => {
  try {
    const lookup = req.params.id;
    const order = await prisma.order.findFirst({
      where: {
        customerId: req.customer.id,
        OR: [
          { id: lookup },
          { orderNumber: lookup }
        ],
      },
      include: {
        customer: true,
        items: {
          include: {
            variant: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found or unauthorized' });
    }

    res.json({ order: mapOrderForFrontend(order, false) });
  } catch (err) {
    console.error('[API] /api/customer/orders/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Create/Prepare Customer Order (Proceed to Pay flow - Payment Gateway Not Called)
app.post('/api/customer/orders', authenticateCustomer, orderLimiter, async (req, res) => {
  try {
    const {
      name,
      phone,
      whatsappNumber,
      address,
      city,
      state,
      pincode,
      addressConfirmed,
      deliveryRegionId,
      deliveryRegionName,
      trackingRequested,
      items: cartItems,
    } = req.body;

    // 1. Validate cart
    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: 'Shopping bag cannot be empty' });
    }

    // 2. Validate customer contact details
    const customerName = String(name || req.customer.name || '').trim();
    const rawPhone = String(phone || req.customer.phone || '').trim();
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const rawWhatsapp = String(whatsappNumber || req.customer.whatsappNumber || rawPhone).trim();
    const cleanWhatsapp = rawWhatsapp.replace(/\D/g, '').slice(-10);

    if (!customerName) {
      return res.status(400).json({ error: 'Customer name is required' });
    }
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'A valid 10-digit mobile number is required' });
    }
    if (cleanWhatsapp.length !== 10) {
      return res.status(400).json({ error: 'A valid 10-digit WhatsApp number is required' });
    }

    // 3. Validate delivery address
    const cleanAddress = String(address || '').trim();
    const cleanCity = String(city || '').trim();
    const cleanState = String(state || '').trim();
    const cleanPincode = String(pincode || '').trim();

    if (!cleanAddress || !cleanCity || !cleanState || !cleanPincode) {
      return res.status(400).json({ error: 'Please provide full address, city, state, and pincode' });
    }

    // 4. Validate explicit address confirmation
    if (addressConfirmed !== true) {
      return res.status(400).json({ error: 'Please confirm that the delivery address is correct before proceeding' });
    }

    // 5. Validate delivery region by pincode (pincode-primary, city NOT used for matching)
    const deliverySettings = await prisma.deliverySettings.findFirst({ include: { regions: true } });
    const matchedRegion = matchDeliveryRegion(deliverySettings?.regions || [], cleanPincode);

    if (!matchedRegion) {
      return res.status(400).json({
        error: `Delivery is currently unavailable for pincode ${cleanPincode}. Please enter a supported delivery pincode.`,
        deliveryUnavailable: true,
      });
    }

    // 6. Validate items & recalculate prices from DB
    const variantIds = [...new Set(cartItems.map((i) => i.variantId).filter(Boolean))];
    const variants = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      include: { product: true }
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const stockErrors = [];
    let serverSubtotal = 0;
    const validatedItems = [];

    for (const item of cartItems) {
      const variant = variantById.get(item.variantId);
      const qty = parseInt(item.quantity, 10) || 0;

      if (!variant) {
        stockErrors.push({ productName: item.productName || 'Item', reason: 'Product variant not found' });
        continue;
      }
      if (!variant.isAvailable || variant.stock <= 0) {
        stockErrors.push({ productName: variant.product?.name || 'Item', reason: 'Out of stock' });
        continue;
      }
      if (qty <= 0) {
        return res.status(400).json({ error: 'Item quantity must be greater than 0' });
      }
      if (qty > variant.stock) {
        stockErrors.push({
          productName: variant.product?.name || 'Item',
          reason: `Only ${variant.stock} available in stock`,
          available: variant.stock,
          requested: qty,
        });
        continue;
      }

      const unitPrice = (variant.product?.basePrice || 0) + (variant.additionalPrice || 0);
      serverSubtotal += unitPrice * qty;

      validatedItems.push({
        variantId: variant.id,
        quantity: qty,
        price: unitPrice,
      });
    }

    if (stockErrors.length > 0) {
      return res.status(409).json({
        error: 'Some items in your shopping bag are no longer available in the requested quantity.',
        stockErrors,
      });
    }

    const { shippingCharge: resolvedShippingCharge } = calculateShipping(
      serverSubtotal,
      deliverySettings,
      matchedRegion
    );
    const finalTotal = serverSubtotal + resolvedShippingCharge;
    const orderNumber = `ORD-${Date.now()}`;

    // 7. Update customer profile with newest address & contact
    await prisma.customer.update({
      where: { id: req.customer.id },
      data: {
        name: customerName,
        phone: cleanPhone,
        whatsappNumber: cleanWhatsapp,
        address: cleanAddress,
        city: cleanCity,
        state: cleanState,
        pincode: cleanPincode,
        deliveryRegionId: matchedRegion.id,
      }
    });

    // 8. Create Order in DB safely
    const order = await prisma.order.create({
      data: {
        orderNumber,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'PENDING',
        totalAmount: finalTotal,
        subtotal: serverSubtotal,
        deliveryCharge: resolvedShippingCharge,
        deliveryAddress: cleanAddress,
        city: cleanCity,
        state: cleanState,
        pincode: cleanPincode,
        whatsappNumber: cleanWhatsapp,
        trackingRequested: Boolean(trackingRequested),
        customerId: req.customer.id,
        items: {
          create: validatedItems.map((item) => ({
            quantity: item.quantity,
            price: item.price,
            variant: { connect: { id: item.variantId } },
          })),
        },
      },
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

    // 9. Decrement stock atomically
    for (const item of validatedItems) {
      await prisma.variant.update({
        where: { id: item.variantId },
        data: { stock: { decrement: item.quantity } }
      });
    }

    res.json({
      success: true,
      order: mapOrderForFrontend(order, false),
      message: 'Order created successfully. Proceed to payment.'
    });
  } catch (error) {
    console.error('[API] Customer order creation error:', error);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// Customer Support Query Submission
app.post('/api/customer/order-consultants', authenticateCustomer, async (req, res) => {
  try {
    const { name, phone, whatsappNumber, email, address, city, state, pincode, cartItems, subtotal, requestedRegion } = req.body || {};
    const cleanPhone = String(phone || req.customer.phone || '').replace(/\D/g, '').slice(-10);
    if (!name || !email || !address || !city || !state || !/^\d{6}$/.test(String(pincode)) || cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Complete customer and delivery details are required' });
    }
    const request = await prisma.orderConsultantRequest.create({
      data: {
        customerId: req.customer.id,
        name: String(name).trim(), phone: cleanPhone,
        whatsappNumber: whatsappNumber ? String(whatsappNumber).replace(/\D/g, '').slice(-10) : null,
        email: String(email).trim().toLowerCase(), address: String(address).trim(),
        city: String(city).trim(), state: String(state).trim(), pincode: String(pincode),
        cartItems: Array.isArray(cartItems) ? cartItems : undefined,
        subtotal: Number.isFinite(Number(subtotal)) ? Number(subtotal) : null,
        requestedRegion: requestedRegion ? String(requestedRegion).trim() : null,
      },
    });
    res.status(201).json({ success: true, requestId: request.id, message: 'Your delivery consultation request was sent to our team.' });
  } catch (error) { res.status(500).json({ error: 'Failed to submit consultant request' }); }
});

app.get('/api/admin/order-consultants/count', authenticateAdmin, async (req, res) => {
  res.json({ count: await prisma.orderConsultantRequest.count({ where: { status: 'NEW' } }) });
});

app.get('/api/admin/order-consultants', authenticateAdmin, async (req, res) => {
  const requests = await prisma.orderConsultantRequest.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ requests });
});

app.get('/api/admin/order-consultants/:id', authenticateAdmin, async (req, res) => {
  const request = await prisma.orderConsultantRequest.findUnique({ where: { id: req.params.id } });
  if (!request) return res.status(404).json({ error: 'Consultant request not found' });
  res.json({ request });
});

app.put('/api/admin/order-consultants/:id', authenticateAdmin, async (req, res) => {
  const allowed = ['NEW', 'CONTACTED', 'RESOLVED', 'CLOSED'];
  const status = String(req.body?.status || '').toUpperCase();
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid consultant request status' });
  const request = await prisma.orderConsultantRequest.update({ where: { id: req.params.id }, data: { status } });
  res.json({ request });
});

app.post('/api/customer/support', async (req, res) => {
  try {
    const { name, phone, whatsappNumber, email, queryType, description, customerId } = req.body;
    if (!name || !phone || !email || !queryType || !description) {
      return res.status(400).json({ error: 'Please provide all required fields (Name, Phone, Email, Query Category, Description)' });
    }

    const newQuery = await prisma.supportQuery.create({
      data: {
        name: String(name).trim(),
        phone: String(phone).trim(),
        whatsappNumber: whatsappNumber ? String(whatsappNumber).trim() : null,
        email: String(email).trim().toLowerCase(),
        queryType: String(queryType).trim(),
        description: String(description).trim(),
        status: 'OPEN',
        customerId: customerId || null,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Support query submitted successfully',
      query: {
        id: newQuery.id,
        name: newQuery.name,
        queryType: newQuery.queryType,
        status: newQuery.status,
        createdAt: newQuery.createdAt,
      },
    });
  } catch (err) {
    console.error('[API] /api/customer/support error:', err.message);
    res.status(500).json({ error: 'Failed to record support query' });
  }
});

// Featured Products: Recently Added
app.get('/api/products/featured/recent', async (req, res) => {
  try {
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit) || 6));
    const products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        category: true,
        subcategory: true,
        variants: true,
      },
    });
    res.json({ products: products.map(serializeProduct) });
  } catch (err) {
    console.error('[API] /api/products/featured/recent error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recently added products' });
  }
});

// Featured Products: Top Selling
app.get('/api/products/featured/top-selling', async (req, res) => {
  try {
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit) || 6));
    // Retrieve active products
    const products = await prisma.product.findMany({
      where: { isActive: true },
      take: limit,
      include: {
        category: true,
        subcategory: true,
        variants: true,
      },
    });
    res.json({ products: products.map(serializeProduct) });
  } catch (err) {
    console.error('[API] /api/products/featured/top-selling error:', err.message);
    res.status(500).json({ error: 'Failed to fetch top selling products' });
  }
});

// ── Admin Auth Endpoints (Firebase Authenticated + Admin Role Check) ──────
app.get('/api/auth/admin/me', authenticateAdmin, async (req, res) => {
  res.json({ user: mapAdminUserForFrontend(req.adminUser) });
});

app.get('/api/auth/me', authenticateAdmin, async (req, res) => {
  res.json({ user: mapAdminUserForFrontend(req.adminUser) });
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
  if (!product) return product;
  // Strip internal business productNumber and technical SKU so customer web NEVER receives them
  const { category, subcategory, productNumber, variants, ...rest } = product;
  return {
    ...rest,
    // Preserve the old contract expected by customer-web: `category` is a string.
    // Use category slug when available, otherwise fall back to `categoryId`.
    category: category?.slug || rest.categoryId,
    // Keep full category details for admin-web/other clients.
    categoryDetails: category || null,
    subcategory: subcategory?.slug || rest.subcategoryId || null,
    subcategoryDetails: subcategory || null,
    variants: (variants || []).map((v) => {
      const { sku, ...vRest } = v;
      return vRest;
    }),
  };
};

app.get('/api/routes', authenticateToken, (req, res) => {
  res.json({ routes: listRoutes() })
})

const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

app.get('/api/admin/categories', authenticateAdmin, async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      include: { subcategories: { orderBy: { name: 'asc' } } },
      orderBy: { categoryNumber: 'asc' },
    });
    res.json({ categories });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch admin categories', details: error.message });
  }
});

app.get('/api/admin/delivery/regions', authenticateAdmin, async (req, res) => {
  const settings = await prisma.deliverySettings.findFirst({ include: { regions: { orderBy: { regionName: 'asc' } } } });
  res.json(mapDeliverySettingsForFrontend(settings));
});

app.post('/api/admin/delivery/regions', authenticateAdmin, async (req, res) => {
  try {
    const { city, state, pincodeStart, pincodeEnd, deliveryCharge, isEnabled = true } = req.body || {};
    if (!city || !state) {
      return res.status(400).json({ error: 'City and state are required' });
    }
    if (!/^\d{6}$/.test(String(pincodeStart)) || !/^\d{6}$/.test(String(pincodeEnd))) {
      return res.status(400).json({ error: 'Valid 6-digit pincodeStart and pincodeEnd are required' });
    }
    if (parseInt(String(pincodeStart), 10) > parseInt(String(pincodeEnd), 10)) {
      return res.status(400).json({ error: 'Pincode start must be less than or equal to pincode end' });
    }
    if (isNaN(Number(deliveryCharge)) || Number(deliveryCharge) < 0) {
      return res.status(400).json({ error: 'Valid delivery charge is required' });
    }
    const settings = await prisma.deliverySettings.findFirst() ||
      await prisma.deliverySettings.create({ data: { freeShippingThreshold: 1500, defaultShippingCharge: 50 } });
    // Auto-generate regionName from city + state
    const regionName = `${String(city).trim()}, ${String(state).trim()}`;
    const region = await prisma.deliveryRegion.create({
      data: {
        regionName,
        city: String(city).trim(),
        state: String(state).trim(),
        pincode: String(pincodeStart),
        pincodeStart: String(pincodeStart),
        pincodeEnd: String(pincodeEnd),
        shippingCharge: Number(deliveryCharge),
        isActive: Boolean(isEnabled),
        deliverySettingsId: settings.id,
      },
    });
    res.status(201).json(region);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to create delivery region' });
  }
});

app.put('/api/admin/delivery/regions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { city, state, pincodeStart, pincodeEnd, deliveryCharge, isEnabled } = req.body || {};
    const data = {};
    if (city !== undefined) {
      data.city = String(city).trim();
      // Regenerate regionName if city or state changes
    }
    if (state !== undefined) data.state = String(state).trim();
    // Auto-regenerate regionName when city or state provided
    if (city !== undefined || state !== undefined) {
      const existing = await prisma.deliveryRegion.findUnique({ where: { id: req.params.id } });
      const newCity = (city !== undefined ? String(city).trim() : existing?.city) || '';
      const newState = (state !== undefined ? String(state).trim() : existing?.state) || '';
      data.regionName = newState ? `${newCity}, ${newState}` : newCity;
    }
    if (pincodeStart !== undefined) {
      if (!/^\d{6}$/.test(String(pincodeStart))) return res.status(400).json({ error: 'Invalid pincodeStart' });
      data.pincodeStart = String(pincodeStart);
      data.pincode = String(pincodeStart);
    }
    if (pincodeEnd !== undefined) {
      if (!/^\d{6}$/.test(String(pincodeEnd))) return res.status(400).json({ error: 'Invalid pincodeEnd' });
      data.pincodeEnd = String(pincodeEnd);
    }
    if (deliveryCharge !== undefined) {
      if (isNaN(Number(deliveryCharge)) || Number(deliveryCharge) < 0) return res.status(400).json({ error: 'Invalid delivery charge' });
      data.shippingCharge = Number(deliveryCharge);
    }
    if (isEnabled !== undefined) data.isActive = Boolean(isEnabled);
    // Handle toggle from the list (sent as isActive directly)
    if (req.body?.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    const region = await prisma.deliveryRegion.update({ where: { id: req.params.id }, data });
    res.json(region);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to update delivery region' });
  }
});

app.delete('/api/admin/delivery/regions/:id', authenticateAdmin, async (req, res) => {
  try {
    const linked = await prisma.order.count({ where: { deliveryRegionId: req.params.id } });
    if (linked > 0) return res.status(409).json({ error: 'Region is linked to existing orders; disable it instead' });
    await prisma.deliveryRegion.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) { res.status(400).json({ error: error.message || 'Failed to delete delivery region' }); }
});

// ── Admin: Payment Gateway Status (Safe Read-Only Dashboard Endpoint) ──
app.get('/api/admin/payment-gateway-status', authenticateAdmin, async (req, res) => {
  try {
    const hasKeyId     = Boolean(process.env.RAZORPAY_KEY_ID     && process.env.RAZORPAY_KEY_ID.trim());
    const hasKeySecret = Boolean(process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_SECRET.trim());
    const environment  = process.env.RAZORPAY_ENV === 'production' ? 'production' : 'test';
    const isConfigured = hasKeyId && hasKeySecret;

    res.json({
      gateway:             'Razorpay',
      environment,
      isConfigured,
      webhookConfigured:   hasKeySecret,
      supportedMethods:    [
        'UPI (Google Pay, PhonePe, Paytm, BHIM)',
        'Credit & Debit Cards (Visa, Mastercard, RuPay)',
        'Net Banking (50+ Indian Banks)',
        'EMI',
        'UPI QR Code',
      ],
      keyIdConfigured:     hasKeyId,
      keySecretConfigured: hasKeySecret,
      siteUrl:             process.env.SITE_URL || '',
      frontendUrl:         process.env.FRONTEND_URL || '',
      webhookUrl:          `${(process.env.SITE_URL || 'http://localhost:3001').replace(/\/$/, '')}/api/payments/razorpay/webhook`,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch payment gateway status', details: error.message });
  }
});