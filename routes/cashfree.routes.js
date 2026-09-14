
// routes/cashfree.routes.js
// Mounted in server.js at: /api/payments/cashfree

const express = require('express');
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

// ── Helper: Atomically and idempotently confirm payment and update inventory ──
async function confirmOrderPayment(prisma, cashfreeOrderId) {
  if (!cashfreeOrderId) {
    return { success: false, error: 'MISSING_ORDER_ID' };
  }

  // 1. Fast-path lookup: find order by upiTransactionId with items & variants
  const existingOrder = await prisma.order.findFirst({
    where: { upiTransactionId: cashfreeOrderId },
    include: {
      items: {
        include: {
          variant: true,
        },
      },
    },
  });

  if (!existingOrder) {
    return { success: false, error: 'ORDER_NOT_FOUND' };
  }

  // 2. Fast-path exit: if already marked PAID, return without touching stock
  if (existingOrder.paymentStatus === 'PAID') {
    return {
      success: true,
      order: existingOrder,
      alreadyProcessed: true,
    };
  }

  // 3. Database-level atomic CAS transaction
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomic Compare-And-Swap: only transition if paymentStatus is STILL 'PENDING'
      const updateResult = await tx.order.updateMany({
        where: {
          id:            existingOrder.id,
          paymentStatus: 'PENDING',
        },
        data: {
          paymentStatus: 'PAID',
          status:        'CONFIRMED',
        },
      });

      // If count is 0, another concurrent request (e.g. Webhook) won the race and updated the Order
      if (updateResult.count === 0) {
        const latestOrder = await tx.order.findUnique({
          where: { id: existingOrder.id },
          include: { items: true },
        });
        return {
          order: latestOrder || existingOrder,
          alreadyProcessed: true,
        };
      }

      // 4. Decrement inventory atomically via CAS conditional update:
      // Guarantees concurrent transactions for DIFFERENT orders purchasing the SAME variant
      // cannot oversell stock. PostgreSQL row-locks the variant and evaluates `stock >= quantity`.
      for (const item of existingOrder.items) {
        if (!item.variantId || !item.quantity) continue;

        const variantUpdate = await tx.variant.updateMany({
          where: {
            id:    item.variantId,
            stock: { gte: item.quantity },
          },
          data: {
            stock: { decrement: item.quantity },
          },
        });

        // If count === 0, another concurrent transaction claimed the stock or stock is insufficient
        if (variantUpdate.count === 0) {
          throw new Error(
            `INSUFFICIENT_STOCK: Variant ${item.variantId} does not have sufficient stock to fulfill quantity ${item.quantity}.`
          );
        }

        // Keep isAvailable in sync if stock reaches 0
        await tx.variant.updateMany({
          where: {
            id:    item.variantId,
            stock: { lte: 0 },
          },
          data: {
            isAvailable: false,
          },
        });
      }

      const freshOrder = await tx.order.findUnique({
        where: { id: existingOrder.id },
        include: { items: true },
      });

      return {
        order: freshOrder || existingOrder,
        alreadyProcessed: false,
      };
    });

    console.log(`[Cashfree] Order ${result.order.orderNumber} (${cashfreeOrderId}) confirmed. Already processed: ${result.alreadyProcessed}`);
    return {
      success:          true,
      order:            result.order,
      alreadyProcessed: result.alreadyProcessed,
    };
  } catch (err) {
    console.error('[Cashfree] confirmOrderPayment transaction error:', err.message);
    throw err;
  }
}

// ── POST /api/payments/cashfree/create-order ───────────────────────────────
// 1. Validates & sanitizes input (customer, phone, cartItems)
// 2. Re-computes prices server-side
// 3. Validates stock availability
// 4. Creates a pending order in DB
// 5. Creates Cashfree order session
// 6. Returns session ID + active environment mode
router.post('/create-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { amount, currency = 'INR', customer, cartItems, shippingCharge, totalAmount } = req.body;

    if (!customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({ message: 'Customer name, email, and phone number are required.' });
    }

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ message: 'Cart cannot be empty.' });
    }

    if (customer.addressConfirmed !== true) {
      return res.status(400).json({ message: 'Please confirm that the delivery address is correct before proceeding.' });
    }

    const cleanAddress = String(customer.address || '').trim();
    const cleanCity = String(customer.city || '').trim();
    const cleanState = String(customer.state || '').trim();
    const cleanPincode = String(customer.pincode || '').trim();
    if (!cleanAddress || !cleanCity || !cleanState || !/^\d{6}$/.test(cleanPincode)) {
      return res.status(400).json({ message: 'Complete delivery address and a valid 6-digit pincode are required.' });
    }

    // Phone validation & normalization (Indian 10-digit standard)
    const rawPhone = String(customer.phone || '').trim();
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    if (!/^\d{10}$/.test(cleanPhone)) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number.' });
    }

    // ── Step 1: Validate stock & fetch server prices ──────────────────
    const variantIds = [...new Set(cartItems.map((i) => i.variantId).filter(Boolean))];
    const variants = await prisma.variant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        stock: true,
        isAvailable: true,
        color: true,
        pattern: true,
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
          reason: `Only ${variant.stock} left in stock`,
          available: variant.stock,
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

    const deliverySettings = await prisma.deliverySettings.findFirst({ include: { regions: true } });
    const activeRegions = (deliverySettings?.regions || []).filter((region) => region.isActive);
    const numericPincode = Number(cleanPincode);
    const matchedRegion = activeRegions.find((region) => {
      const start = Number(region.pincodeStart || region.pincode || 0);
      const end = Number(region.pincodeEnd || region.pincodeStart || region.pincode || 0);
      return (start && end && numericPincode >= start && numericPincode <= end) || (region.city && region.city.toLowerCase() === cleanCity.toLowerCase());
    });
    if (!matchedRegion) {
      return res.status(400).json({ message: `Delivery is currently unavailable for ${cleanCity}.`, deliveryUnavailable: true });
    }

    // Delivery charge and total are resolved from server configuration and prices.
    const freeShippingThreshold = 1500;
    const resolvedShipping = serverSubtotal >= freeShippingThreshold
      ? 0
      : Number(matchedRegion.shippingCharge || 0);
    const finalCalculatedTotal = serverSubtotal + resolvedShipping;
    const orderTotal = finalCalculatedTotal;

    // ── Step 2: Create pending order in DB ────────────────────────────
    const orderNumber = `ORD-${Date.now()}`;
    const cfOrderId   = `CF_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    // Find or create customer
    let existingCustomer = await prisma.customer.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { email: customer.email.trim().toLowerCase() },
        ],
      },
    });

    if (existingCustomer) {
      existingCustomer = await prisma.customer.update({
        where: { id: existingCustomer.id },
        data: {
          name:           customer.name.trim(),
          whatsappNumber: customer.whatsappNumber ? String(customer.whatsappNumber).trim() : existingCustomer.whatsappNumber || null,
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
          whatsappNumber: customer.whatsappNumber ? String(customer.whatsappNumber).trim() : null,
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
        city:               cleanCity,
        state:              cleanState,
        pincode:            cleanPincode,
        deliveryRegion:     { connect: { id: matchedRegion.id } },
        paymentMethod:     'upi',
        paymentStatus:     'PENDING',
        upiTransactionId:  cfOrderId,
        status:            'PENDING',
        trackingRequested: Boolean(customer.trackingRequested),
        whatsappNumber:    customer.whatsappNumber ? String(customer.whatsappNumber).trim() : null,
        customer: {
          connect: { id: existingCustomer.id },
        },
        items: {
          create: cartItems.map((item) => {
            const variant = variantById.get(item.variantId);
            const unitPrice = variant
              ? (variant.product?.basePrice || 0) + (variant.additionalPrice || 0)
              : (item.unitPrice || 0);
            return {
              quantity: item.quantity,
              price:    unitPrice,
              variant:  { connect: { id: item.variantId } },
            };
          }),
        },
      },
    });

    console.log('[Cashfree] Pending order created:', pendingOrder.orderNumber, 'for CF order:', cfOrderId);

    // ── Step 3: Resolve URLs for Cashfree ──────────────────────────────
    const isProd = process.env.NODE_ENV === 'production';
    let frontendBase = process.env.FRONTEND_URL;
    let siteBase = process.env.SITE_URL;

    if (!frontendBase) {
      if (isProd) {
        console.error('[Cashfree] ERROR: FRONTEND_URL environment variable is required in production.');
        return res.status(500).json({ message: 'Server configuration error: FRONTEND_URL is missing.' });
      }
      frontendBase = 'http://localhost:4321';
    }

    if (!siteBase) {
      if (isProd) {
        console.error('[Cashfree] ERROR: SITE_URL environment variable is required in production.');
        return res.status(500).json({ message: 'Server configuration error: SITE_URL is missing.' });
      }
      siteBase = `http://localhost:${process.env.PORT || 3001}`;
    }

    const returnUrl = `${frontendBase.replace(/\/$/, '')}/order/pending?cf_order_id=${encodeURIComponent(cfOrderId)}`;
    const notifyUrl = `${siteBase.replace(/\/$/, '')}/api/payments/cashfree/webhook`;

    // ── Step 4: Create Cashfree Payment Order ─────────────────────────
    const customerId = `CUST_${existingCustomer.id.replace(/[^a-zA-Z0-9_-]/g, '')}`.slice(0, 45);

    const payload = {
      order_id:       cfOrderId,
      order_amount:   orderTotal,
      order_currency: currency,
      customer_details: {
        customer_id:    customerId,
        customer_name:  customer.name.trim(),
        customer_email: customer.email.trim(),
        customer_phone: cleanPhone,
      },
      order_meta: {
        return_url:      returnUrl,
        notify_url:      notifyUrl,
        payment_methods: "cc,dc,upi,netbanking"
      },
      order_note: `Sunbloom Adorn — Order ${orderNumber} (${cartItems.length} item(s))`,
    };

    const { data } = await cf.post('/orders', payload);
    console.log('[Cashfree] Cashfree order session created successfully:', data.order_id);

    const settings = await prisma.settings.findFirst();
    const upiVpa   = settings?.upiId   || process.env.UPI_VPA  || '';
    const upiName  = settings?.upiName || process.env.UPI_NAME || 'Sunbloom Adorn';
    const activeEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';

    res.json({
      orderId:          data.order_id,
      orderNumber:      pendingOrder.orderNumber,
      paymentSessionId: data.payment_session_id,
      environment:      activeEnv,
      upiVpa,
      upiName,
    });
  } catch (err) {
    const errorDetail = err?.response?.data?.message || err?.message || 'Payment initiation failed';
    console.error('[Cashfree] create-order error:', err?.response?.data || err.message);
    res.status(500).json({ message: errorDetail });
  }
});

// ── POST /api/payments/cashfree/confirm-order ──────────────────────────────
// Authoritatively verifies payment with Cashfree and commits order status & stock atomically.
router.post('/confirm-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { cashfreeOrderId } = req.body;

    if (!cashfreeOrderId) {
      return res.status(400).json({ message: 'cashfreeOrderId is required' });
    }

    // ── Step 1: Verify payment with Cashfree directly ─────────────────
    let cfStatus = 'UNKNOWN';
    try {
      const { data: orderData } = await cf.get(`/orders/${encodeURIComponent(cashfreeOrderId)}`);
      cfStatus = orderData.order_status;

      // If still ACTIVE, search all payment attempts for an authoritative SUCCESS
      if (cfStatus === 'ACTIVE') {
        try {
          const { data: paymentsData } = await cf.get(`/orders/${encodeURIComponent(cashfreeOrderId)}/payments`);
          const payments = Array.isArray(paymentsData) ? paymentsData : [];
          const hasSuccessfulPayment = payments.some((p) => p?.payment_status === 'SUCCESS');
          if (hasSuccessfulPayment) cfStatus = 'PAID';
        } catch (e) { /* no payments yet */ }
      }
    } catch (e) {
      console.warn('[Cashfree] verify check failed:', e?.response?.data?.message || e.message);
    }

    if (cfStatus !== 'PAID') {
      return res.status(400).json({
        message: `Payment not confirmed by Cashfree (status: ${cfStatus}). Please wait or try again.`,
        status: cfStatus,
      });
    }

    // ── Step 2: Atomic confirmation & stock decrement ─────────────────
    const confirmation = await confirmOrderPayment(prisma, cashfreeOrderId);

    if (!confirmation.success) {
      if (confirmation.error === 'ORDER_NOT_FOUND') {
        return res.status(404).json({ message: 'Order not found. Please contact support with Cashfree order ID.' });
      }
      return res.status(500).json({ message: 'Failed to confirm order payment.' });
    }

    res.json({
      orderNumber:      confirmation.order.orderNumber,
      orderId:          confirmation.order.id,
      alreadyProcessed: confirmation.alreadyProcessed,
      status:           'PAID',
    });

  } catch (err) {
    console.error('[Cashfree] confirm-order error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to confirm order' });
  }
});

// ── GET /api/payments/cashfree/status/:orderId ────────────────────────────
// Polled by frontend to check authoritative status and commit state if PAID
router.get('/status/:orderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    // Check Cashfree order status
    const { data: orderData } = await cf.get(`/orders/${encodeURIComponent(orderId)}`);
    const orderStatus = orderData.order_status;

    if (orderStatus === 'PAID') {
      const confirmation = await confirmOrderPayment(prisma, orderId);
      return res.json({
        status:      'PAID',
        orderNumber: confirmation.order?.orderNumber,
      });
    }

    if (orderStatus === 'EXPIRED') {
      await prisma.order.updateMany({
        where: { upiTransactionId: orderId, paymentStatus: 'PENDING' },
        data:  { status: 'CANCELLED', paymentStatus: 'FAILED' },
      });
      return res.json({ status: 'EXPIRED' });
    }

    if (orderStatus === 'CANCELLED') {
      await prisma.order.updateMany({
        where: { upiTransactionId: orderId, paymentStatus: 'PENDING' },
        data:  { status: 'CANCELLED', paymentStatus: 'FAILED' },
      });
      return res.json({ status: 'CANCELLED' });
    }

    // If ACTIVE — search all payment attempts
    if (orderStatus === 'ACTIVE') {
      try {
        const { data: paymentsData } = await cf.get(`/orders/${encodeURIComponent(orderId)}/payments`);
        const payments = Array.isArray(paymentsData) ? paymentsData : [];

        // Check if ANY attempt succeeded
        const successfulPayment = payments.find((p) => p?.payment_status === 'SUCCESS');
        if (successfulPayment) {
          const confirmation = await confirmOrderPayment(prisma, orderId);
          return res.json({
            status:      'PAID',
            orderNumber: confirmation.order?.orderNumber,
          });
        }

        // If no attempt succeeded and all completed attempts failed
        const hasPending = payments.some((p) => p?.payment_status === 'PENDING');
        const latestFailed = payments.find((p) => p?.payment_status === 'FAILED');
        if (!hasPending && latestFailed) {
          return res.json({
            status: 'FAILED',
            reason: latestFailed.error_details?.error_description || 'Payment failed at bank gateway',
          });
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
// Called when customer cancels order before payment
router.post('/cancel-order/:orderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    let cashfreeCancelled = false;
    try {
      await cf.patch(`/orders/${encodeURIComponent(orderId)}`, { order_status: 'TERMINATED' });
      cashfreeCancelled = true;
      console.log(`[Cashfree] Order ${orderId} terminated on Cashfree`);
    } catch (err) {
      const cfErr = err?.response?.data;
      if (cfErr?.code === 'order_already_paid' || cfErr?.message?.includes('paid')) {
        return res.status(409).json({
          message: 'Order has already been paid and cannot be cancelled.',
        });
      }
    }

    const updated = await prisma.order.updateMany({
      where: {
        upiTransactionId: orderId,
        paymentStatus:    'PENDING',
      },
      data: {
        status:        'CANCELLED',
        paymentStatus: 'FAILED',
      },
    });

    res.json({
      status:            'cancelled',
      orderId,
      cashfreeCancelled,
      updatedCount:      updated.count,
    });
  } catch (err) {
    console.error('[Cashfree] cancel-order error:', err?.response?.data || err.message);
    res.status(200).json({ status: 'cancel_attempted', message: 'Cancel attempted' });
  }
});

// ── GET /api/payments/cashfree/order-by-cf-id/:cfOrderId ─────────────────
router.get('/order-by-cf-id/:cfOrderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { cfOrderId } = req.params;
    if (!cfOrderId) return res.status(400).json({ message: 'cfOrderId is required' });

    const order = await prisma.order.findFirst({
      where: { upiTransactionId: cfOrderId },
      select: {
        id:            true,
        orderNumber:   true,
        paymentStatus: true,
        status:        true,
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
});

module.exports = {
  router,
  confirmOrderPayment,
};