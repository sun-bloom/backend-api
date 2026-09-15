// routes/razorpay.routes.js
// Razorpay payment gateway routes
// Mounted in server.js at: /api/payments/razorpay

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const Razorpay = require('razorpay');
const { matchDeliveryRegion, calculateShipping } = require('../lib/deliveryMatcher');

// ── Razorpay config ────────────────────────────────────────────────────────
const rzpKeyId     = process.env.RAZORPAY_KEY_ID;
const rzpKeySecret = process.env.RAZORPAY_KEY_SECRET;

const getRazorpay = () => {
  if (!rzpKeyId || !rzpKeySecret) {
    throw new Error('Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }
  return new Razorpay({ key_id: rzpKeyId, key_secret: rzpKeySecret });
};

// ── Helper: Atomically and idempotently confirm payment and update inventory ──
async function confirmOrderPayment(prisma, razorpayOrderId) {
  if (!razorpayOrderId) return { success: false, error: 'MISSING_ORDER_ID' };

  const existingOrder = await prisma.order.findFirst({
    where: { upiTransactionId: razorpayOrderId },
    include: { items: { include: { variant: true } } },
  });

  if (!existingOrder) return { success: false, error: 'ORDER_NOT_FOUND' };

  // Idempotent: if already paid, return success without re-processing
  if (existingOrder.paymentStatus === 'PAID') {
    return { success: true, order: existingOrder, alreadyProcessed: true };
  }

  // Atomic transaction: update order + decrement stock
  const confirmedOrder = await prisma.$transaction(async (tx) => {
    for (const item of existingOrder.items) {
      if (!item.variant) continue;
      await tx.variant.update({
        where: { id: item.variantId },
        data:  { stock: { decrement: item.quantity } },
      });
    }
    return tx.order.update({
      where: { id: existingOrder.id },
      data:  { status: 'CONFIRMED', paymentStatus: 'PAID', paymentMethod: 'razorpay' },
    });
  });

  return { success: true, order: confirmedOrder, alreadyProcessed: false };
}

// ── POST /api/payments/razorpay/create-order ───────────────────────────────
// 1. Validates & sanitizes input (customer, phone, cartItems)
// 2. Re-computes prices server-side
// 3. Validates stock availability
// 4. Validates delivery region by pincode (pincode-primary)
// 5. Creates a pending order in DB
// 6. Creates Razorpay order
// 7. Returns Razorpay order_id + key_id to frontend
router.post('/create-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { currency = 'INR', customer, cartItems } = req.body;

    if (!customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ message: 'Customer name, email, and phone number are required.' });
    }

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ message: 'Cart cannot be empty.' });
    }

    if (customer.addressConfirmed !== true) {
      return res.status(400).json({ message: 'Please confirm that the delivery address is correct before proceeding.' });
    }

    const cleanAddress  = String(customer.address  || '').trim();
    const cleanCity     = String(customer.city     || '').trim();
    const cleanState    = String(customer.state    || '').trim();
    const cleanPincode  = String(customer.pincode  || '').trim();

    if (!cleanAddress || !cleanCity || !cleanState || !/^\d{6}$/.test(cleanPincode)) {
      return res.status(400).json({ message: 'Complete delivery address and a valid 6-digit pincode are required.' });
    }

    // Phone validation
    const cleanPhone    = String(customer.phone || '').replace(/\D/g, '').slice(-10);
    const cleanWhatsapp = String(customer.whatsappNumber || customer.phone || '').replace(/\D/g, '').slice(-10);

    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number.' });
    }

    // ── Step 1: Validate stock & compute server-side prices ──────────────
    const variantIds = [...new Set(cartItems.map((i) => i.variantId).filter(Boolean))];
    const variants = await prisma.variant.findMany({
      where:  { id: { in: variantIds } },
      select: {
        id: true, stock: true, isAvailable: true, color: true,
        additionalPrice: true,
        product: { select: { id: true, name: true, basePrice: true } },
      },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const stockErrors = [];
    let serverSubtotal = 0;

    for (const item of cartItems) {
      const variant = variantById.get(item.variantId);
      if (!variant) {
        stockErrors.push({ productName: item.productName || 'Item', reason: 'Product variant not found' });
        continue;
      }
      if (!variant.isAvailable || variant.stock <= 0) {
        stockErrors.push({ productName: variant.product?.name || item.productName || 'Item', reason: 'Out of stock' });
        continue;
      }
      if (item.quantity > variant.stock) {
        stockErrors.push({
          productName: variant.product?.name || item.productName || 'Item',
          reason:      `Only ${variant.stock} left in stock`,
          available:   variant.stock,
        });
      }
      const unitPrice = (variant.product?.basePrice || 0) + (variant.additionalPrice || 0);
      serverSubtotal += unitPrice * (item.quantity || 1);
    }

    if (stockErrors.length > 0) {
      return res.status(409).json({
        message: 'Some items in your cart are no longer available in the requested quantity.',
        stockErrors,
      });
    }

    // ── Step 2: Validate delivery region (pincode-primary) ───────────────
    const deliverySettings = await prisma.deliverySettings.findFirst({ include: { regions: true } });
    const matchedRegion    = matchDeliveryRegion(deliverySettings?.regions || [], cleanPincode);

    if (!matchedRegion) {
      return res.status(400).json({
        message: `Delivery is currently unavailable for pincode ${cleanPincode}. Please enter a supported delivery pincode.`,
        deliveryUnavailable: true,
      });
    }

    // ── Step 3: Authoritative shipping calculation ───────────────────────
    const { shippingCharge: resolvedShipping } = calculateShipping(serverSubtotal, deliverySettings, matchedRegion);
    const orderTotal = serverSubtotal + resolvedShipping;

    // ── Step 4: Create pending order in DB ───────────────────────────────
    const orderNumber   = `ORD-${Date.now()}`;
    const rzpOrderToken = `RZP_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    // Find or create customer
    let existingCustomer = await prisma.customer.findFirst({
      where: { OR: [{ phone: cleanPhone }, { email: customer.email.trim().toLowerCase() }] },
    });

    if (existingCustomer) {
      existingCustomer = await prisma.customer.update({
        where: { id: existingCustomer.id },
        data: {
          name:           customer.name.trim(),
          whatsappNumber: cleanWhatsapp || existingCustomer.whatsappNumber || null,
          address:        cleanAddress,
          city:           cleanCity,
          state:          cleanState,
          pincode:        cleanPincode,
        },
      });
    } else {
      existingCustomer = await prisma.customer.create({
        data: {
          name:           customer.name.trim(),
          email:          customer.email.trim().toLowerCase(),
          phone:          cleanPhone,
          whatsappNumber: cleanWhatsapp || null,
          address:        cleanAddress,
          city:           cleanCity,
          state:          cleanState,
          pincode:        cleanPincode,
        },
      });
    }

    const pendingOrder = await prisma.order.create({
      data: {
        orderNumber,
        totalAmount:       orderTotal,
        subtotal:          serverSubtotal,
        deliveryCharge:    resolvedShipping,
        deliveryAddress:   cleanAddress,
        city:              cleanCity,
        state:             cleanState,
        pincode:           cleanPincode,
        deliveryRegion:    { connect: { id: matchedRegion.id } },
        paymentMethod:     'razorpay',
        paymentStatus:     'PENDING',
        upiTransactionId:  rzpOrderToken, // will be updated with actual Razorpay order_id
        status:            'PENDING',
        trackingRequested: Boolean(customer.trackingRequested),
        whatsappNumber:    cleanWhatsapp || null,
        customer:          { connect: { id: existingCustomer.id } },
        items: {
          create: cartItems.map((item) => {
            const variant  = variantById.get(item.variantId);
            const unitPrice = variant
              ? (variant.product?.basePrice || 0) + (variant.additionalPrice || 0)
              : (item.unitPrice || 0);
            return { quantity: item.quantity, price: unitPrice, variant: { connect: { id: item.variantId } } };
          }),
        },
      },
    });

    console.log('[Razorpay] Pending order created:', pendingOrder.orderNumber);

    // ── Step 5: Create Razorpay order ─────────────────────────────────
    const razorpay = getRazorpay();
    const rzpOrder = await razorpay.orders.create({
      amount:   Math.round(orderTotal * 100), // in paise
      currency,
      receipt:  orderNumber,
      notes:    {
        orderNumber,
        customer: customer.name.trim(),
        pincode:  cleanPincode,
      },
    });

    // Update order with actual Razorpay order_id
    await prisma.order.update({
      where: { id: pendingOrder.id },
      data:  { upiTransactionId: rzpOrder.id },
    });

    console.log('[Razorpay] Order created:', rzpOrder.id, 'amount:', orderTotal);

    res.json({
      razorpayOrderId: rzpOrder.id,
      orderNumber:     pendingOrder.orderNumber,
      amount:          orderTotal,
      currency,
      keyId:           rzpKeyId,
      environment:     process.env.RAZORPAY_ENV === 'production' ? 'production' : 'test',
      prefill: {
        name:    customer.name.trim(),
        email:   customer.email.trim(),
        contact: cleanPhone,
      },
    });

  } catch (err) {
    const errorDetail = err?.error?.description || err?.message || 'Payment initiation failed';
    console.error('[Razorpay] create-order error:', err?.error || err.message);
    res.status(500).json({ message: errorDetail });
  }
});

// ── POST /api/payments/razorpay/verify-payment ─────────────────────────────
// Called after Razorpay payment completion to verify signature & confirm order
router.post('/verify-payment', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.' });
    }

    // Verify HMAC signature
    const expectedSignature = crypto
      .createHmac('sha256', rzpKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.warn('[Razorpay] Signature mismatch for order:', razorpay_order_id);
      return res.status(400).json({ message: 'Payment signature verification failed. Please contact support.' });
    }

    console.log('[Razorpay] Signature verified for order:', razorpay_order_id);

    // Confirm and atomically update order + decrement stock
    const confirmation = await confirmOrderPayment(prisma, razorpay_order_id);

    if (!confirmation.success) {
      if (confirmation.error === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ message: 'Order not found. Please contact support with your payment ID.' });
      }
      return res.status(500).json({ message: 'Failed to confirm order payment.' });
    }

    res.json({
      success:          true,
      orderNumber:      confirmation.order.orderNumber,
      orderId:          confirmation.order.id,
      alreadyProcessed: confirmation.alreadyProcessed,
      status:           'PAID',
    });

  } catch (err) {
    console.error('[Razorpay] verify-payment error:', err.message);
    res.status(500).json({ message: 'Failed to verify payment' });
  }
});

// ── GET /api/payments/razorpay/status/:orderId ────────────────────────────
// Polled by frontend to check payment status by Razorpay order_id
router.get('/status/:orderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    // First check our DB
    const order = await prisma.order.findFirst({
      where: { upiTransactionId: orderId },
      select: { orderNumber: true, paymentStatus: true, status: true },
    });

    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.paymentStatus === 'PAID') {
      return res.json({ status: 'PAID', orderNumber: order.orderNumber });
    }

    if (order.paymentStatus === 'FAILED' || order.status === 'CANCELLED') {
      return res.json({ status: 'FAILED', reason: 'Payment was not completed' });
    }

    // Check Razorpay directly
    try {
      const razorpay  = getRazorpay();
      const rzpOrder  = await razorpay.orders.fetch(orderId);
      const rzpStatus = rzpOrder?.status;

      if (rzpStatus === 'paid') {
        // Try to confirm
        const confirmation = await confirmOrderPayment(prisma, orderId);
        return res.json({ status: 'PAID', orderNumber: confirmation.order?.orderNumber });
      }

      if (rzpStatus === 'created' || rzpStatus === 'attempted') {
        return res.json({ status: 'ACTIVE' });
      }
    } catch (rzpErr) {
      console.warn('[Razorpay] status fetch failed:', rzpErr.message);
    }

    return res.json({ status: 'PENDING' });

  } catch (err) {
    console.error('[Razorpay] status check error:', err.message);
    res.status(500).json({ message: 'Failed to check status' });
  }
});

// ── GET /api/payments/razorpay/order-by-rzp-id/:rzpOrderId ────────────────
router.get('/order-by-rzp-id/:rzpOrderId', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { rzpOrderId } = req.params;
    if (!rzpOrderId) return res.status(400).json({ message: 'rzpOrderId is required' });

    const order = await prisma.order.findFirst({
      where:  { upiTransactionId: rzpOrderId },
      select: { id: true, orderNumber: true, paymentStatus: true, status: true },
    });

    if (!order) return res.status(404).json({ message: 'Order not found for this payment' });

    res.json({ orderNumber: order.orderNumber, orderId: order.id, paymentStatus: order.paymentStatus, status: order.status });
  } catch (err) {
    console.error('[Razorpay] order-by-rzp-id error:', err.message);
    res.status(500).json({ message: 'Failed to find order' });
  }
});

module.exports = { router, confirmOrderPayment };
