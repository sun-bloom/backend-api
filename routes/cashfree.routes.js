// routes/cashfree.routes.js
// Mounted in server.js at: /api/payments/cashfree

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const router  = express.Router();

// ── Cashfree config ────────────────────────────────────────────────────────
const CF_BASE_URL = process.env.CASHFREE_ENV === 'production'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

const CF_APP_ID  = process.env.CASHFREE_APP_ID;
const CF_SECRET  = process.env.CASHFREE_SECRET_KEY;
const CF_API_VER = '2023-08-01';

const cf = axios.create({
  baseURL: CF_BASE_URL,
  headers: {
    'x-api-version':   CF_API_VER,
    'x-client-id':     CF_APP_ID,
    'x-client-secret': CF_SECRET,
    'Content-Type':    'application/json',
  },
});

// ── POST /api/payments/cashfree/create-order ───────────────────────────────
// Creates a Cashfree order and returns orderId + UPI details for QR rendering.
router.post('/create-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { amount, currency = 'INR', customer, cartItems, shippingCharge } = req.body;

    if (!amount || !customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Unique Cashfree order ID (max 50 chars)
    const cfOrderId = `CF_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    const payload = {
      order_id:       cfOrderId,
      order_amount:   amount,
      order_currency: currency,
      customer_details: {
        customer_id:    customer.phone,
        customer_name:  customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone,
      },
      order_meta: {
        return_url: `${process.env.SITE_URL}/order/pending?cf_order_id=${cfOrderId}`,
        notify_url: `${process.env.SITE_URL}/api/payments/cashfree/webhook`,
      },
      order_note: `Fashion Store — ${cartItems?.length || 0} item(s)`,
    };

    const { data } = await cf.post('/orders', payload);
      console.log('[Cashfree] payment_session_id:', data.payment_session_id);
    // Read UPI details from DB settings
    const settings   = await prisma.settings.findFirst();
    const upiVpa     = settings?.upiId   || process.env.UPI_VPA  || '';
    const upiName    = settings?.upiName || process.env.UPI_NAME || 'Fashion Store';

    res.json({
      orderId:          data.order_id,
      paymentSessionId: data.payment_session_id,
      upiVpa,
      upiName,
    });
  } catch (err) {
    console.error('[Cashfree] create-order error:', err?.response?.data || err.message);
    res.status(500).json({ message: err?.response?.data?.message || 'Payment initiation failed' });
  }
});

// ── POST /api/payments/cashfree/confirm-order ──────────────────────────────
// Called by frontend after user pays. Verifies with Cashfree then saves order.
router.post('/confirm-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const {
      cashfreeOrderId,
      customer,
      cartItems,
      subtotal,
      shippingCharge,
      totalAmount,
    } = req.body;

    if (!cashfreeOrderId || !customer || !cartItems?.length) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // ── Verify order status with Cashfree ────────────────────────────
    let cfStatus = 'UNKNOWN';
    try {
      const { data } = await cf.get(`/orders/${cashfreeOrderId}`);
      cfStatus = data.order_status; // PAID | ACTIVE | EXPIRED
    } catch (e) {
      console.warn('[Cashfree] status check failed:', e?.response?.data?.message);
    }

    // Accept PAID (webhook confirmed) or ACTIVE (user just paid, webhook pending)
    if (!['PAID', 'ACTIVE'].includes(cfStatus)) {
      return res.status(400).json({
        message: `Payment not confirmed by Cashfree (status: ${cfStatus}). Please try again.`,
      });
    }

    // ── Validate stock ────────────────────────────────────────────────
    const variantIds = [...new Set(cartItems.map((i) => i.variantId))];
    const variants   = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, stock: true, isAvailable: true },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    for (const item of cartItems) {
      const variant = variantById.get(item.variantId);
      if (!variant || !variant.isAvailable || variant.stock <= 0) {
        return res.status(409).json({ message: `Item is no longer available: ${item.productName}` });
      }
      if (item.quantity > variant.stock) {
        return res.status(409).json({
          message: `Only ${variant.stock} left for ${item.productName}`,
        });
      }
    }

    // ── Save order using existing Prisma schema ───────────────────────
    const orderNumber = `ORD-${Date.now()}`;

    const order = await prisma.order.create({
      data: {
        orderNumber,
        totalAmount,
        paymentMethod:   'upi',
        paymentStatus:   cfStatus === 'PAID' ? 'PAID' : 'PENDING',
        upiTransactionId: cashfreeOrderId,
        status:          'PENDING',
        customer: {
          connectOrCreate: {
            where: { phone: customer.phone },
            create: {
              name:    customer.name,
              email:   customer.email,
              phone:   customer.phone,
              address: customer.address || '',
              city:    customer.city    || '',
              state:   customer.state   || '',
              pincode: customer.pincode || '',
            },
          },
        },
        items: {
          create: cartItems.map((item) => ({
            quantity: item.quantity,
            price:    item.unitPrice,
            variant:  { connect: { id: item.variantId } },
          })),
        },
      },
      include: {
        customer: true,
        items: { include: { variant: { include: { product: true } } } },
      },
    });

    res.json({ orderNumber: order.orderNumber, orderId: order.id });
  } catch (err) {
    console.error('[Cashfree] confirm-order error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to confirm order' });
  }
});

// ── POST /api/payments/cashfree/webhook ───────────────────────────────────
// Cashfree calls this when payment status changes. Register in Cashfree Dashboard.
// Uses express.raw() — must be mounted BEFORE express.json() in server.js.
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const timestamp = req.headers['x-webhook-timestamp'];
    const signature = req.headers['x-webhook-signature'];
    const rawBody   = req.body?.toString('utf8') || '';

    // Cashfree test ping — no signature headers, just acknowledge
    if (!timestamp || !signature) {
      console.log('[Cashfree] Webhook test ping received');
      return res.status(200).json({ status: 'ok' });
    }

    // Verify Cashfree HMAC-SHA256 signature
    const expected = crypto
      .createHmac('sha256', CF_SECRET)
      .update(`${timestamp}${rawBody}`)
      .digest('base64');

    if (expected !== signature) {
      console.warn('[Cashfree] Webhook signature mismatch');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody);
    const { type, data } = event;
    const cfOrderId = data?.order?.order_id;

    console.log(`[Cashfree] Webhook: ${type} — order ${cfOrderId}`);

    if (type === 'PAYMENT_SUCCESS_WEBHOOK' && cfOrderId) {
      await prisma.order.updateMany({
        where: { upiTransactionId: cfOrderId },
        data:  { paymentStatus: 'PAID', status: 'CONFIRMED' },
      });
    }

    if (type === 'PAYMENT_FAILED_WEBHOOK' && cfOrderId) {
      await prisma.order.updateMany({
        where: { upiTransactionId: cfOrderId },
        data:  { paymentStatus: 'FAILED' },
      });
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[Cashfree] Webhook error:', err);
    res.status(500).json({ message: 'Webhook error' });
  }
});

module.exports = router;