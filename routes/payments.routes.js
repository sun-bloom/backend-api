const express = require('express');
const router  = express.Router();
const { matchDeliveryRegion, calculateShipping } = require('../lib/deliveryMatcher');
const { generatePaymentHash, generateReverseHash, verifyPayUTransaction, PAYU_KEY, PAYU_PAYMENT_URL } = require('../services/payu/payu.service');
const { getAuth } = require('../lib/firebase-admin');

// ── POST /api/payments/create-order ───────────────────────────────
router.post('/create-order', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { currency = 'INR', customer, cartItems } = req.body;

    // 1. Authoritative Email Resolution from Authenticated Session
    let authEmail = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const auth = getAuth();
        if (auth) {
          const decoded = await auth.verifyIdToken(token);
          if (decoded && decoded.email) {
            authEmail = decoded.email.trim().toLowerCase();
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
      return res.status(400).json({ message: 'A valid authenticated email is required for checkout.' });
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
    const orderNumber = `ORD-${Date.now()}`;
    let orderId = `ord_${Date.now()}`;

    if (dbAvailable) {
      try {
        // Find or create customer
        let existingCustomer = await prisma.customer.findFirst({
          where: { OR: [{ phone: cleanPhone }, { email: customerEmail }] },
        });

        if (existingCustomer) {
          existingCustomer = await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: {
              name:           customer.name.trim(),
              email:          customerEmail,
              phone:          cleanPhone,
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
              email:          customerEmail,
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
        console.warn('[Payments] DB save deferred for order creation:', orderDbErr.message);
      }
    }

    // ── Step 5: Generate PayU payload ───────────────
    const txnid = orderNumber;
    
    // Fallback URL if env is not defined
    const siteUrl = process.env.SITE_URL || 'http://localhost:3001';
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
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4321';

  try {
    const payuData = req.body;
    const { txnid, status, hash, amount } = payuData;

    // 1. Locate order
    const order = await prisma.order.findFirst({ where: { upiTransactionId: txnid } });
    if (!order) {
      console.error(`[PayU] Order not found for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}&error=not_found`);
    }

    // 2. Validate amount
    if (parseFloat(amount) !== parseFloat(order.totalAmount.toFixed(2))) {
      console.error(`[PayU] Amount mismatch for txnid: ${txnid}. Expected: ${order.totalAmount}, Got: ${amount}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}&error=amount_mismatch`);
    }

    // 3. Validate Reverse Hash
    const generatedHash = generateReverseHash(payuData);
    if (generatedHash !== hash) {
      console.error(`[PayU] Hash mismatch for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}&error=hash_mismatch`);
    }

    // 4. Validate Status
    if (status !== 'success') {
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}`);
    }

    // 5. Server-side Verify Payment
    const verifyData = await verifyPayUTransaction(txnid);
    if (!verifyData || verifyData.status !== 1 || !verifyData.transaction_details || !verifyData.transaction_details[txnid]) {
       console.error(`[PayU] Server verification failed for txnid: ${txnid}`);
       return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}&error=verification_failed`);
    }
    
    const transactionDetails = verifyData.transaction_details[txnid];
    if (transactionDetails.status !== 'success' && transactionDetails.status !== 'Captured') {
      console.error(`[PayU] Server verification status not success for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}&error=verification_failed`);
    }

    // 6. Idempotent Payment Confirmation & Inventory Decrement
    if (order.paymentStatus !== 'PAID') {
      await prisma.$transaction(async (tx) => {
        // Mark as paid
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: 'PAID',
            status: 'CONFIRMED'
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

    // Redirect to success
    return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}`);

  } catch (error) {
    console.error('[PayU] Success callback error:', error);
    return res.redirect(`${frontendUrl}/payment/pending?error=server_error`);
  }
});

// ── POST /api/payments/payu/failure ─────────────────────────────
router.post('/payu/failure', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4321';

  try {
    const payuData = req.body;
    const { txnid } = payuData;

    if (txnid) {
      await prisma.order.updateMany({
        where: { upiTransactionId: txnid, paymentStatus: 'PENDING' },
        data: { paymentStatus: 'FAILED', status: 'CANCELLED' }
      });
    }

    return res.redirect(`${frontendUrl}/payment/pending?order_id=${txnid}`);
  } catch (error) {
    console.error('[PayU] Failure callback error:', error);
    return res.redirect(`${frontendUrl}/payment/pending?error=server_error`);
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
              data: { paymentStatus: 'PAID', status: 'CONFIRMED' }
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
router.get('/status/:orderId', async (req, res) => {
  const prisma = req.app.locals.prisma;

  try {
    const { orderId } = req.params;
    if (!orderId) return res.status(400).json({ message: 'orderId is required' });

    // First check our DB
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { orderNumber: true, paymentStatus: true, status: true },
    });

    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.paymentStatus === 'PAID') {
      return res.json({ status: 'PAID', orderNumber: order.orderNumber });
    }

    if (order.paymentStatus === 'FAILED' || order.status === 'CANCELLED') {
      return res.json({ status: 'FAILED', reason: 'Payment was not completed' });
    }

    return res.json({ status: 'PENDING' });
  } catch (err) {
    console.error('[Payments] status check error:', err.message);
    res.status(500).json({ message: 'Failed to check status' });
  }
});

module.exports = { router };
