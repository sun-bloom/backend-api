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
// 1. Validates stock availability
// 2. Creates a pending order in DB
// 3. Creates Cashfree order
// 4. Returns QR details — only if all above succeed
router.post('/create-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { amount, currency = 'INR', customer, cartItems, shippingCharge, subtotal, totalAmount } = req.body;

    if (!amount || !customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (!cartItems?.length) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    // ── Step 1: Validate stock BEFORE doing anything else ─────────────
    const variantIds = [...new Set(cartItems.map((i) => i.variantId))];
    const variants   = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, stock: true, isAvailable: true, color: true, pattern: true,
                product: { select: { name: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const stockErrors = [];
    for (const item of cartItems) {
      const variant = variantById.get(item.variantId);
      if (!variant) {
        stockErrors.push({ productName: item.productName, reason: 'Product variant not found' });
        continue;
      }
      if (!variant.isAvailable || variant.stock <= 0) {
        stockErrors.push({ productName: item.productName, reason: 'Out of stock' });
        continue;
      }
      if (item.quantity > variant.stock) {
        stockErrors.push({
          productName: item.productName,
          reason: `Only ${variant.stock} left in stock`,
          available: variant.stock,
        });
      }
    }

    // Return all stock errors at once so customer knows everything upfront
    if (stockErrors.length > 0) {
      return res.status(409).json({
        message: 'Some items are unavailable',
        stockErrors,
      });
    }

    // ── Step 2: Create pending order in DB ────────────────────────────
    const orderNumber = `ORD-${Date.now()}`;
    const cfOrderId   = `CF_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    // Find existing customer by phone OR email to avoid unique constraint errors
    let existingCustomer = await prisma.customer.findFirst({
      where: {
        OR: [
          { phone: customer.phone },
          { email: customer.email },
        ],
      },
    });

    // If found, update their details with latest info
    if (existingCustomer) {
      existingCustomer = await prisma.customer.update({
        where: { id: existingCustomer.id },
        data: {
          name:    customer.name,
          address: customer.address || existingCustomer.address || '',
          city:    customer.city    || existingCustomer.city    || '',
          state:   customer.state   || existingCustomer.state   || '',
          pincode: customer.pincode || existingCustomer.pincode || '',
        },
      });
    } else {
      // New customer — create fresh
      existingCustomer = await prisma.customer.create({
        data: {
          name:    customer.name,
          email:   customer.email,
          phone:   customer.phone,
          address: customer.address || '',
          city:    customer.city    || '',
          state:   customer.state   || '',
          pincode: customer.pincode || '',
        },
      });
    }

    const pendingOrder = await prisma.order.create({
      data: {
        orderNumber,
        totalAmount:      totalAmount || amount,
        paymentMethod:    'upi',
        paymentStatus:    'PENDING',
        upiTransactionId: cfOrderId,
        status:           'PENDING',
        customer: {
          connect: { id: existingCustomer.id },
        },
        items: {
          create: cartItems.map((item) => ({
            quantity: item.quantity,
            price:    item.unitPrice,
            variant:  { connect: { id: item.variantId } },
          })),
        },
      },
    });

    console.log('[Cashfree] Pending order created:', pendingOrder.orderNumber);

    // ── Step 3: Create Cashfree payment order ─────────────────────────
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
        return_url: `${process.env.FRONTEND_URL}/order/pending?cf_order_id=${cfOrderId}`, // redirect to success page in frontend 
        notify_url: `${process.env.SITE_URL}/api/payments/cashfree/webhook`, // update the status to db
        payment_methods: "cc,dc,upi"
      },
      order_note: `Fashion Store — ${cartItems.length} item(s)`,
    };

    const { data } = await cf.post('/orders', payload);
    console.log('[Cashfree] Cashfree order created:', data.order_id, '| session:', data.payment_session_id);

    // ── Step 4: Read UPI details for QR ──────────────────────────────
    const settings = await prisma.settings.findFirst();
    const upiVpa   = settings?.upiId   || process.env.UPI_VPA  || '';
    const upiName  = settings?.upiName || process.env.UPI_NAME || 'Fashion Store';

    res.json({
      orderId:          data.order_id,
      orderNumber:      pendingOrder.orderNumber,  // DB order number
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
// Called by frontend after polling detects PAID.
// Order already exists in DB (created in create-order).
// This just verifies payment with Cashfree and updates the order status to PAID.
router.post('/confirm-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { cashfreeOrderId } = req.body;

    if (!cashfreeOrderId) {
      return res.status(400).json({ message: 'cashfreeOrderId is required' });
    }

    // ── Step 1: Verify payment with Cashfree ──────────────────────────
    let cfStatus = 'UNKNOWN';
    try {
      const { data: orderData } = await cf.get(`/orders/${cashfreeOrderId}`);
      cfStatus = orderData.order_status;

      // If still ACTIVE, check payment attempts for a SUCCESS
      if (cfStatus === 'ACTIVE') {
        try {
          const { data: paymentsData } = await cf.get(`/orders/${cashfreeOrderId}/payments`);
          const payments = Array.isArray(paymentsData) ? paymentsData : [];
          const latest   = payments[0];
          if (latest?.payment_status === 'SUCCESS') cfStatus = 'PAID';
        } catch (e) { /* no payments yet */ }
      }
    } catch (e) {
      console.warn('[Cashfree] verify failed:', e?.response?.data?.message);
    }

    if (cfStatus !== 'PAID') {
      return res.status(400).json({
        message: `Payment not confirmed by Cashfree (status: ${cfStatus}). Please try again.`,
      });
    }

    // ── Step 2: Find the pending order created during create-order ────
    const existingOrder = await prisma.order.findFirst({
      where: { upiTransactionId: cashfreeOrderId },
    });

    if (!existingOrder) {
      console.error('[Cashfree] confirm-order: no order found for', cashfreeOrderId);
      return res.status(404).json({ message: 'Order not found. Please contact support.' });
    }

    // ── Step 3: Update order status to PAID + CONFIRMED ───────────────
    const updatedOrder = await prisma.order.update({
      where: { id: existingOrder.id },
      data: {
        paymentStatus: 'PAID',
        status:        'CONFIRMED',
        paidAt:        new Date(),
      },
    });

    console.log('[Cashfree] Order confirmed:', updatedOrder.orderNumber);
    res.json({ orderNumber: updatedOrder.orderNumber, orderId: updatedOrder.id });

  } catch (err) {
    console.error('[Cashfree] confirm-order error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to confirm order' });
  }
});

// ── GET /api/payments/cashfree/status/:orderId ────────────────────────────
// Polled by frontend every 5s to check if payment is PAID / FAILED / ACTIVE
// GET /api/payments/cashfree/status/:orderId
router.get('/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    // Check order status first
    const { data: orderData } = await cf.get(`/orders/${orderId}`);
    const orderStatus = orderData.order_status;

    // If PAID or EXPIRED/CANCELLED — return directly
    if (orderStatus === 'PAID')      return res.json({ status: 'PAID' });
    if (orderStatus === 'EXPIRED')   return res.json({ status: 'EXPIRED' });
    if (orderStatus === 'CANCELLED') return res.json({ status: 'CANCELLED' });

    // If ACTIVE — check individual payment attempts
    if (orderStatus === 'ACTIVE') {
      try {
        const { data: paymentsData } = await cf.get(`/orders/${orderId}/payments`);
        const payments = paymentsData || [];

        // Find the latest payment attempt
        const latest = payments[0];
        console.log(latest);
        
        if (latest?.payment_status === 'FAILED') {
          return res.json({ status: 'FAILED', reason: latest.error_details?.error_description || 'Payment failed' });
        }
        if (latest?.payment_status === 'SUCCESS') {
          return res.json({ status: 'PAID' });
        }
      } catch (e) {
        // No payments yet — still waiting
      }

      return res.json({ status: 'ACTIVE' });
    }
    res.json({ status: orderStatus });
  } catch (err) {
    console.error('[Cashfree] status check error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to check status' });
  }
});


// ── POST /api/payments/cashfree/cancel-order/:orderId ────────────────────
// Called when customer clicks "Cancel Order" on the payment page.
// 1. Cancels the Cashfree order (prevents further payment)
// 2. Updates the DB order status to CANCELLED
router.post('/cancel-order/:orderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    // ── Step 1: Cancel on Cashfree ────────────────────────────────────
    let cashfreeCancelled = false;
    try {
      // Cashfree uses PATCH with order_status: TERMINATED to cancel
      await cf.patch(`/orders/${orderId}`, { order_status: 'TERMINATED' });
      cashfreeCancelled = true;
      console.log(`[Cashfree] Order ${orderId} terminated on Cashfree`);
    } catch (err) {
      // Cashfree may reject if order is already PAID/EXPIRED — that's ok
      // We still update DB below
      const cfErr = err?.response?.data;
      console.warn(`[Cashfree] Could not terminate order ${orderId}:`, cfErr?.message || err.message);

      // If order is already PAID, don't allow cancellation
      if (cfErr?.code === 'order_already_paid' || cfErr?.message?.includes('paid')) {
        return res.status(409).json({
          message: 'Order has already been paid and cannot be cancelled.',
        });
      }
    }

    // ── Step 2: Update DB order to CANCELLED ──────────────────────────
    const updated = await prisma.order.updateMany({
      where: {
        upiTransactionId: orderId,
        // Only cancel if still PENDING — don't cancel a PAID order
        paymentStatus: 'PENDING',
      },
      data: {
        status:        'CANCELLED',
        paymentStatus: 'FAILED',
      },
    });

    if (updated.count === 0) {
      // Either order doesn't exist or it's already paid
      console.warn(`[Cashfree] No pending order found to cancel for ${orderId}`);
      return res.json({
        status:  'not_found',
        message: 'No pending order found — it may have already been paid or cancelled.',
      });
    }

    console.log(`[Cashfree] Order ${orderId} cancelled in DB (${updated.count} row(s))`);
    res.json({
      status:             'cancelled',
      orderId,
      cashfreeCancelled,
    });

  } catch (err) {
    console.error('[Cashfree] cancel-order error:', err?.response?.data || err.message);
    // Return 200 so frontend still redirects to cart even on unexpected errors
    res.status(200).json({ status: 'cancel_attempted', message: 'Cancel attempted' });
  }
});

// ── GET /api/payments/cashfree/order-by-cf-id/:cfOrderId ─────────────────
// Used by /order/pending page to find the DB order linked to a Cashfree order.
// Returns orderNumber so frontend can redirect to /order/[orderNumber].
router.get('/order-by-cf-id/:cfOrderId', async (req, res) => {
  const prisma = req.app.locals.prisma;
 
  try {
    const { cfOrderId } = req.params;
    if (!cfOrderId) return res.status(400).json({ message: 'cfOrderId is required' });
 
    const order = await prisma.order.findFirst({
      where: { upiTransactionId: cfOrderId },
      select: {
        id:          true,
        orderNumber: true,
        paymentStatus: true,
        status:      true,
      },
    });
 
    if (!order) {
      return res.status(404).json({ message: 'Order not found for this payment' });
    }
 
    res.json({
      orderNumber:   order.orderNumber,
      orderId:       order.id,
      paymentStatus: order.paymentStatus,
      status:        order.status,
    });
  } catch (err) {
    console.error('[Cashfree] order-by-cf-id error:', err.message);
    res.status(500).json({ message: 'Failed to find order' });
  }
})
// NOTE: Webhook is handled directly in server.js (not here)
// This keeps the raw body parsing clean and avoids router path issues.

module.exports = router;