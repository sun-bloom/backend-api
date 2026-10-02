const express = require('express');
const router  = express.Router();
const { matchDeliveryRegion, calculateShipping } = require('../lib/deliveryMatcher');
const { generatePaymentHash, generateReverseHash, verifyPayUTransaction, PAYU_KEY, PAYU_PAYMENT_URL } = require('../services/payu/payu.service');
const { getAuth } = require('../lib/firebase-admin');
const { ENFORCE_MIN_PAYMENT_LIMIT } = require('../config/testFlags');

// ── Helper: Resolve safe frontend URL (never localhost in redirect) ────────
// PayU is an external server; it cannot reach localhost.
// Always use production domain when FRONTEND_URL is missing or localhost.
function resolveFrontendUrl(req) {
  const envUrl = process.env.FRONTEND_URL || '';
  const isLocalhost = !envUrl || envUrl.includes('localhost') || envUrl.includes('127.0.0.1');
  if (!isLocalhost) return envUrl.replace(/\/$/, '');
  // Infer from request Origin header if present
  const origin = req.get('origin') || '';
  if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    return origin.replace(/\/$/, '');
  }
  // Hard fallback to production domain
  return 'https://sunbloomadorn.com';
}

// ── Helper: Resolve safe backend SITE_URL (for surl/furl) ─────────────────
// surl/furl must be publicly reachable by PayU (not localhost).
// Production backend is on Render; use RENDER_EXTERNAL_URL if available.
function resolveSiteUrl(req) {
  const envUrl = process.env.SITE_URL || '';
  const isLocalhost = !envUrl || envUrl.includes('localhost') || envUrl.includes('127.0.0.1');
  if (!isLocalhost) return envUrl.replace(/\/$/, '');
  // Try RENDER_EXTERNAL_URL (auto-set by Render)
  const renderUrl = process.env.RENDER_EXTERNAL_URL || '';
  if (renderUrl) return renderUrl.replace(/\/$/, '');
  // Infer from request Host header
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host') || '';
  if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
    return `${protocol}://${host}`;
  }
  // Last resort fallback — must be updated if backend URL changes
  return 'https://backend-api-bonr.onrender.com';
}

// ── POST /api/payments/create-order ───────────────────────────────
router.post('/create-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { currency = 'INR', customer, cartItems } = req.body;

    // 1. Authoritative Email Resolution from Authenticated Session
    let authEmail = null;
    let authUid = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const auth = getAuth();
        if (auth) {
          const decoded = await auth.verifyIdToken(token);
          if (decoded) {
            authUid = decoded.uid;
            if (decoded.email) {
              authEmail = decoded.email.trim().toLowerCase();
            }
          }
        }
      } catch (tokenErr) {
        console.warn('[Payments] Auth token decode warning:', tokenErr.message);
      }
    }

    const customerEmail = authEmail || (customer?.email ? String(customer.email).trim().toLowerCase() : null);

    if (!customer?.name || !customerEmail || !customer?.phone) {
      return res.status(400).json({ message: 'Customer name, authenticated email, and mobile number are required.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return res.status(400).json({ message: 'A valid email is required for checkout.' });
    }

    // 2. Strict Indian Mobile & WhatsApp Number Validation (Exact 10 digits starting with 6-9)
    const rawPhone = String(customer.phone || '').trim();
    const rawWhatsapp = String(customer.whatsappNumber || customer.phone || '').trim();

    if (!/^[6-9]\d{9}$/.test(rawPhone)) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).' });
    }

    if (!/^[6-9]\d{9}$/.test(rawWhatsapp)) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit Indian WhatsApp number (e.g. 9876543210).' });
    }

    const cleanPhone = rawPhone;
    const cleanWhatsapp = rawWhatsapp;
    const cleanAddress = String(customer.address || '').trim();
    const cleanCity = String(customer.city || '').trim();
    const cleanState = String(customer.state || '').trim();
    const cleanPincode = String(customer.pincode || '').replace(/\D/g, '').slice(0, 6);

    // ── Step 1: Validate stock & compute server-side prices ──────────────
    const variantIds = [...new Set(cartItems.map((i) => i.variantId).filter(Boolean))];
    let variants = [];
    let dbAvailable = true;

    try {
      variants = await prisma.variant.findMany({
        where:  { id: { in: variantIds } },
        select: {
          id: true, stock: true, isAvailable: true, color: true,
          additionalPrice: true,
          product: { select: { id: true, name: true, basePrice: true } },
        },
      });
    } catch (dbErr) {
      dbAvailable = false;
      console.warn('[Payments] DB unavailable during variant lookup:', dbErr.message);
    }

    const variantById = new Map(variants.map((v) => [v.id, v]));
    const stockErrors = [];
    let serverSubtotal = 0;

    for (const item of cartItems) {
      const variant = variantById.get(item.variantId);
      if (dbAvailable && variant) {
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
      } else {
        // Fallback calculation using item's price
        const itemPrice = Number(item.price || item.unitPrice || 0);
        serverSubtotal += itemPrice * (item.quantity || 1);
      }
    }

    if (stockErrors.length > 0) {
      return res.status(409).json({
        message: 'Some items in your cart are no longer available in the requested quantity.',
        stockErrors,
      });
    }

    // ── Enforce Minimum Order Value (cartTotal >= 200, no maximum limit) ──
    // TEMPORARY TESTING: This check is gated by ENFORCE_MIN_PAYMENT_LIMIT in config/testFlags.js.
    // To re-enable the ₹200 minimum: set ENFORCE_MIN_PAYMENT_LIMIT = true in config/testFlags.js.
    const MINIMUM_ORDER_VALUE = 200;
    if (ENFORCE_MIN_PAYMENT_LIMIT && serverSubtotal < MINIMUM_ORDER_VALUE) {
      const remaining = Number((MINIMUM_ORDER_VALUE - serverSubtotal).toFixed(2));
      return res.status(400).json({
        error: 'MINIMUM_ORDER_VALUE_NOT_MET',
        message: `Add ₹${remaining} more to reach the minimum order value of ₹200.`,
        minimumOrderValue: MINIMUM_ORDER_VALUE,
        currentSubtotal: serverSubtotal,
        amountRemaining: remaining,
      });
    }

    // ── Step 2: Validate delivery region (pincode-primary) ───────────────
    let deliverySettings = null;
    let matchedRegion = null;
    try {
      deliverySettings = await prisma.deliverySettings.findFirst({ include: { regions: true } });
      matchedRegion    = matchDeliveryRegion(deliverySettings?.regions || [], cleanPincode);
    } catch (dbErr) {
      console.warn('[Payments] DB unavailable during delivery check:', dbErr.message);
      matchedRegion = matchDeliveryRegion([], cleanPincode);
    }

    // Require configured delivery region before creating pending order / PayU payment
    if (!matchedRegion) {
      return res.status(400).json({
        error: 'DELIVERY_UNAVAILABLE',
        message: 'Delivery availability needs to be confirmed for this location. Please submit a delivery enquiry.',
        requiresEnquiry: true,
      });
    }

    // ── Step 3: Authoritative shipping calculation ───────────────────────
    const threshold = Number(deliverySettings?.freeShippingThreshold ?? 1500);
    const resolvedShipping = serverSubtotal >= threshold ? 0 : (Number(matchedRegion.shippingCharge) || 50);
    const orderTotal = serverSubtotal + resolvedShipping;

    // ── Step 4: Create pending order in DB ───────────────────────────────
    // CRITICAL: We MUST create the order in the database BEFORE issuing the PayU payload.
    // If order creation fails, we MUST abort with an error. Never issue a PayU payload
    // for a non-existent database order — customer money would be collected with no order.
    const orderNumber = `ORD-${Date.now()}`;
    let orderId = null;

    if (dbAvailable) {
      // Find or create customer — Primary identity: authenticated Firebase UID
      let existingCustomer = null;
      if (authUid) {
        existingCustomer = await prisma.customer.findUnique({
          where: { firebaseUid: authUid },
        });
      }

      if (!existingCustomer) {
        // If not found by firebaseUid, look for an unlinked legacy customer record
        const candidates = await prisma.customer.findMany({
          where: {
            OR: [
              { phone: cleanPhone },
              ...(customerEmail ? [{ email: customerEmail }] : []),
            ],
          },
        });
        // Pick candidate that is either already linked to same UID or completely unlinked
        existingCustomer = candidates.find((c) => c.firebaseUid === authUid || !c.firebaseUid) || null;
      }

      if (existingCustomer) {
        try {
          existingCustomer = await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: {
              firebaseUid:    existingCustomer.firebaseUid || authUid || undefined,
              name:           customer.name.trim(),
              email:          customerEmail || existingCustomer.email || null,
              phone:          cleanPhone,
              whatsappNumber: cleanWhatsapp || existingCustomer.whatsappNumber || null,
              address:        cleanAddress,
              city:           cleanCity,
              state:          cleanState,
              pincode:        cleanPincode,
            },
          });
        } catch (updateErr) {
          // If update fails due to unique constraint (phone/email conflict),
          // keep using the existing customer record as-is.
          console.warn('[Payments] Customer update warning (using existing):', updateErr.message);
        }
      } else {
        try {
          existingCustomer = await prisma.customer.create({
            data: {
              firebaseUid:    authUid || null,
              name:           customer.name.trim(),
              email:          customerEmail,
              phone:          cleanPhone,
              whatsappNumber: cleanWhatsapp || null,
              address:        cleanAddress,
              city:           cleanCity,
              state:          cleanState,
              pincode:        cleanPincode,
            },
          });
        } catch (createErr) {
          // If create fails (e.g. race condition on phone/email unique), attempt lookup again
          console.warn('[Payments] Customer create fallback:', createErr.message);
          if (authUid) {
            existingCustomer = await prisma.customer.findUnique({ where: { firebaseUid: authUid } });
          }
          if (!existingCustomer && customerEmail) {
            existingCustomer = await prisma.customer.findFirst({ where: { email: customerEmail } });
          }
          if (!existingCustomer && cleanPhone) {
            existingCustomer = await prisma.customer.findFirst({ where: { phone: cleanPhone } });
          }
          if (!existingCustomer) {
            console.error('[Payments] CRITICAL: Cannot resolve customer — aborting order creation');
            return res.status(500).json({ message: 'Unable to resolve customer account. Please try again.' });
          }
        }
      }

      // Create pending order — MUST succeed before returning PayU payload
      let pendingOrder;
      try {
        pendingOrder = await prisma.order.create({
          data: {
            orderNumber,
            totalAmount:       orderTotal,
            subtotal:          serverSubtotal,
            deliveryCharge:    resolvedShipping,
            deliveryAddress:   cleanAddress,
            city:              cleanCity,
            state:             cleanState,
            pincode:           cleanPincode,
            deliveryRegionId:  matchedRegion.id !== 'standard-region' ? matchedRegion.id : null,
            paymentMethod:     'gateway',
            paymentStatus:     'PENDING',
            status:            'PENDING',
            trackingRequested: Boolean(customer.trackingRequested),
            whatsappNumber:    cleanWhatsapp || null,
            upiTransactionId:  orderNumber, // Using orderNumber as txnid
            customer:          { connect: { id: existingCustomer.id } },
            items: {
              create: cartItems.map((item) => {
                const variant  = variantById.get(item.variantId);
                const unitPrice = variant
                  ? (variant.product?.basePrice || 0) + (variant.additionalPrice || 0)
                  : (item.unitPrice || item.price || 0);
                return { quantity: item.quantity, price: unitPrice, variant: { connect: { id: item.variantId } } };
              }),
            },
          },
        });
        orderId = pendingOrder.id;
        console.log('[Payments] Pending order created:', pendingOrder.orderNumber);
      } catch (orderDbErr) {
        // CRITICAL: Order creation FAILED — do NOT issue PayU payload
        console.error('[Payments] CRITICAL: Order DB creation failed:', orderDbErr.message, orderDbErr.code);
        return res.status(500).json({
          message: 'Unable to create your order at this time. Please try again. If the problem persists, contact support.',
          code: orderDbErr.code || 'DB_ERROR',
        });
      }
    } else {
      // DB is unavailable — cannot create order, must not proceed to payment
      console.error('[Payments] CRITICAL: DB unavailable — cannot create order');
      return res.status(503).json({
        message: 'Payment system is temporarily unavailable. Please try again in a few minutes.',
      });
    }

    // ── Step 5: Generate PayU payload ───────────────
    const txnid = orderNumber;

    // Resolve publicly reachable backend URL for surl/furl
    const siteUrl = resolveSiteUrl(req);
    const customerFirstName = customer.name.trim().split(' ')[0] || 'Customer';

    const payuPayload = {
      key: PAYU_KEY,
      txnid: txnid,
      amount: orderTotal.toFixed(2),
      productinfo: 'Sunbloom Adorn Order',
      firstname: customerFirstName,
      email: customerEmail,
      phone: cleanPhone,
      surl: `${siteUrl}/api/payments/payu/success`,
      furl: `${siteUrl}/api/payments/payu/failure`
    };

    const hash = generatePaymentHash(payuPayload);
    payuPayload.hash = hash;

    res.json({
      orderId,
      orderNumber,
      amount: orderTotal,
      currency,
      payuPayload,
      payuUrl: PAYU_PAYMENT_URL
    });

  } catch (err) {
    console.error('[Payments] create-order error:', err.message);
    res.status(500).json({ message: 'Payment initiation failed' });
  }
});

// ── POST /api/payments/payu/success ─────────────────────────────
router.post('/payu/success', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const frontendUrl = resolveFrontendUrl(req);

  try {
    const payuData = req.body;
    const { txnid, status, hash, amount } = payuData;

    if (!txnid) {
      console.error('[PayU] Success callback missing txnid');
      return res.redirect(`${frontendUrl}/payment/pending?error=missing_txnid`);
    }

    // 1. Locate order — txnid = orderNumber = upiTransactionId
    const order = await prisma.order.findFirst({ where: { upiTransactionId: txnid } });
    if (!order) {
      console.error(`[PayU] Order not found for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${encodeURIComponent(txnid)}&error=not_found`);
    }

    // 2. Validate amount
    if (parseFloat(amount) !== parseFloat(order.totalAmount.toFixed(2))) {
      console.error(`[PayU] Amount mismatch for txnid: ${txnid}. Expected: ${order.totalAmount}, Got: ${amount}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${encodeURIComponent(txnid)}&error=amount_mismatch`);
    }

    // 3. Validate Reverse Hash
    const generatedHash = generateReverseHash(payuData);
    if (generatedHash !== hash) {
      console.error(`[PayU] Hash mismatch for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${encodeURIComponent(txnid)}&error=hash_mismatch`);
    }

    // 4. Validate Status
    if (status !== 'success') {
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${encodeURIComponent(txnid)}&error=payment_failed`);
    }

    // 5. Server-side Verify Payment
    const verifyData = await verifyPayUTransaction(txnid);
    if (!verifyData || verifyData.status !== 1 || !verifyData.transaction_details || !verifyData.transaction_details[txnid]) {
       console.error(`[PayU] Server verification failed for txnid: ${txnid}`);
       return res.redirect(`${frontendUrl}/payment/pending?order_id=${encodeURIComponent(txnid)}&error=verification_failed`);
    }

    const transactionDetails = verifyData.transaction_details[txnid];
    if (transactionDetails.status !== 'success' && transactionDetails.status !== 'Captured') {
      console.error(`[PayU] Server verification status not success for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${encodeURIComponent(txnid)}&error=verification_failed`);
    }

    // 6. Idempotent Payment Confirmation & Inventory Decrement
    if (order.paymentStatus !== 'PAID') {
      await prisma.$transaction(async (tx) => {
        // Mark as paid and store gateway reference
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus:    'PAID',
            status:           'CONFIRMED',
            gatewayReference: payuData.mihpayid || null,
          }
        });

        // Decrement inventory
        const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
        for (const item of orderItems) {
          await tx.variant.update({
            where: { id: item.variantId },
            data: { stock: { decrement: item.quantity } }
          });
        }
      });
      console.log(`[PayU] Successfully verified and confirmed order ${order.orderNumber}`);
    }

    // Redirect to /payment/success with the order's orderNumber
    return res.redirect(`${frontendUrl}/payment/success?order_id=${encodeURIComponent(order.orderNumber)}`);

  } catch (error) {
    console.error('[PayU] Success callback error:', error);
    return res.redirect(`${resolveFrontendUrl(req)}/payment/pending?error=server_error`);
  }
});

// ── POST /api/payments/payu/failure ─────────────────────────────
router.post('/payu/failure', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const frontendUrl = resolveFrontendUrl(req);

  try {
    const payuData = req.body;
    const { txnid } = payuData;

    if (txnid) {
      await prisma.order.updateMany({
        where: { upiTransactionId: txnid, paymentStatus: 'PENDING' },
        data: { paymentStatus: 'FAILED', status: 'CANCELLED' }
      });
      console.log(`[PayU] Payment failed/cancelled for txnid: ${txnid}`);
    }

    return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid ? encodeURIComponent(txnid) : ''}&error=payment_failed`);
  } catch (error) {
    console.error('[PayU] Failure callback error:', error);
    return res.redirect(`${resolveFrontendUrl(req)}/payment/pending?error=server_error`);
  }
});

// ── POST /api/payments/payu/webhook ─────────────────────────────
router.post('/payu/webhook', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const payuData = req.body;
    const { txnid, status, hash, amount } = payuData;

    if (!txnid) return res.status(400).send('No txnid');

    const order = await prisma.order.findFirst({ where: { upiTransactionId: txnid } });
    if (!order) return res.status(404).send('Order not found');

    if (status === 'success') {
      const verifyData = await verifyPayUTransaction(txnid);
      if (verifyData && verifyData.status === 1 && verifyData.transaction_details && verifyData.transaction_details[txnid]) {
        const transactionDetails = verifyData.transaction_details[txnid];

        if ((transactionDetails.status === 'success' || transactionDetails.status === 'Captured') && order.paymentStatus !== 'PAID') {
           await prisma.$transaction(async (tx) => {
            await tx.order.update({
              where: { id: order.id },
              data: {
                paymentStatus:    'PAID',
                status:           'CONFIRMED',
                gatewayReference: payuData.mihpayid || null,
              }
            });

            const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
            for (const item of orderItems) {
              await tx.variant.update({
                where: { id: item.variantId },
                data: { stock: { decrement: item.quantity } }
              });
            }
          });
          console.log(`[PayU] Webhook confirmed order ${order.orderNumber}`);
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[PayU] Webhook error:', error);
    res.status(500).send('Error');
  }
});

// ── GET /api/payments/status/:orderId ────────────────────────────
// Supports lookup by: DB cuid id, orderNumber (e.g. ORD-xxx), or upiTransactionId
router.get('/status/:orderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    // Multi-field lookup: id (cuid), orderNumber, or upiTransactionId
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          { id: orderId },
          { orderNumber: orderId },
          { upiTransactionId: orderId },
        ],
      },
      select: { id: true, orderNumber: true, paymentStatus: true, status: true, totalAmount: true },
    });

    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.paymentStatus === 'PAID') {
      return res.json({ status: 'PAID', orderNumber: order.orderNumber, totalAmount: order.totalAmount });
    }

    if (order.paymentStatus === 'FAILED' || order.status === 'CANCELLED') {
      return res.json({ status: 'FAILED', reason: 'Payment was not completed' });
    }

    return res.json({ status: 'PENDING', orderNumber: order.orderNumber });
  } catch (err) {
    console.error('[Payments] status check error:', err.message);
    res.status(500).json({ message: 'Failed to check status' });
  }
});

module.exports = { router };
