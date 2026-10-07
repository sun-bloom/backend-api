// services/emailNotification.service.js
// Sunbloom Adorn Haute Jewellery Luxury Email Notification Service

const nodemailer = require('nodemailer');

let transporter = null;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmailAddress(value) {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim());
}

function logEmailFailure(type, recipient, reason, orderNumber) {
  const safeRecipient = isValidEmailAddress(recipient) ? recipient.trim().toLowerCase() : 'none';
  const safeReason = String(reason || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const orderPart = orderNumber ? ` orderNumber=${String(orderNumber)}` : '';
  console.error(`EMAIL_SEND_FAILED type=${type}${orderPart} recipient=${safeRecipient} reason=${safeReason}`);
}

function getTransporter() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS ? process.env.EMAIL_PASS.replace(/\s+/g, '') : null;

  if (!user || !pass) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,           // ✅ Port 587 (STARTTLS) — works on Render (IPv4 compatible)
      secure: false,       // false = STARTTLS upgrade after connect
      // ✅ Pool: reuse connection instead of new TLS handshake per email
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
      auth: {
        user,
        pass,
      },
      tls: {
        rejectUnauthorized: true,
      },
      connectionTimeout: 15000,
      socketTimeout: 20000,
      greetingTimeout: 10000,
    });

    // Warm up the pool connection immediately so first email is fast
    transporter.verify((err) => {
      if (err) {
        console.warn('[Email] SMTP pool verify warning:', err.message);
      } else {
        console.log('[Email] ✅ SMTP pool ready — connection warm (port 587)');
      }
    });
  }

  return transporter;
}

/**
 * Fire-and-forget email helper — call this from API routes so the
 * HTTP response is NOT delayed by email sending.
 * Usage: sendEmailAsync(() => sendOrderConfirmationEmail(order))
 */
function sendEmailAsync(emailFn) {
  Promise.resolve()
    .then(() => emailFn())
    .then((result) => {
      if (result && result.success === false) {
        logEmailFailure(result.type || 'background', result.recipient, result.reason || result.error);
      }
      return result;
    })
    .catch((err) => logEmailFailure('background', null, err?.message));
}


const BRAND_NAME = 'Sunbloom Adorn';
const SITE_URL = process.env.SITE_URL || process.env.FRONTEND_URL || 'https://sunbloomadorn.com';

/**
 * Base email layout wrapper with Sunbloom Adorn luxury aesthetic
 */
function wrapEmailTemplate(title, preheader, bodyContent) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #FAF6F0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #2A1C19;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: #FAF6F0;
      padding: 30px 10px;
    }
    .main {
      background-color: #ffffff;
      margin: 0 auto;
      max-width: 600px;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #E8DCCF;
      box-shadow: 0 4px 20px rgba(122, 34, 59, 0.04);
    }
    .header {
      background: linear-gradient(135deg, #7A223B 0%, #4A1222 100%);
      padding: 36px 30px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      color: #F7E7CE;
      font-size: 24px;
      letter-spacing: 3px;
      text-transform: uppercase;
      font-weight: 300;
    }
    .header p {
      margin: 6px 0 0;
      color: #E2B784;
      font-size: 11px;
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    .content {
      padding: 36px 30px;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #7A223B 0%, #5E172B 100%);
      color: #ffffff !important;
      text-decoration: none;
      padding: 14px 32px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin: 20px 0;
    }
    .footer {
      background-color: #FAF6F0;
      padding: 24px 30px;
      text-align: center;
      border-top: 1px solid #E8DCCF;
      font-size: 12px;
      color: #7D6460;
    }
    .footer a {
      color: #7A223B;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <span style="display:none;font-size:1px;color:#FAF6F0;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${preheader}
  </span>
  <div class="wrapper">
    <div class="main">
      <div class="header">
        <h1>Sunbloom Adorn</h1>
        <p>Haute Jewellery Atelier</p>
      </div>
      <div class="content">
        ${bodyContent}
      </div>
      <div class="footer">
        <p style="margin: 0 0 8px;">✨ Crafted with distinction &amp; enduring artistry.</p>
        <p style="margin: 0 0 8px;">Need assistance? Contact our concierge at <a href="mailto:${process.env.EMAIL_USER}">${process.env.EMAIL_USER}</a></p>
        <p style="margin: 0; color: #A8928D; font-size: 11px;">&copy; ${new Date().getFullYear()} Sunbloom Adorn. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * 1. Send Order Confirmation Email
 */
async function sendOrderConfirmationEmail(order) {
  const t = getTransporter();
  const customerEmail = String(order.customerEmail || order.customer?.email || '').trim().toLowerCase();
  if (!t || !isValidEmailAddress(customerEmail)) {
    logEmailFailure(
      'order_confirmation',
      customerEmail,
      !t ? 'EMAIL_PROVIDER_NOT_CONFIGURED' : 'INVALID_OR_MISSING_RECIPIENT',
      order.orderNumber
    );
    return { success: false, reason: !t ? 'EMAIL_PROVIDER_NOT_CONFIGURED' : 'INVALID_OR_MISSING_RECIPIENT' };
  }

  const customerName = order.customerName || order.customer?.name || 'Valued Collector';
  const orderNumber = order.orderNumber;
  const items = Array.isArray(order.items) ? order.items : [];
  const total = Number(order.totalAmount || 0).toLocaleString('en-IN');
  const subtotal = Number(order.subtotal || 0).toLocaleString('en-IN');
  const shippingCharge = order.deliveryCharge ?? order.shippingCharge ?? 0;
  const shipping = Number(shippingCharge) === 0 ? 'FREE' : `₹${Number(shippingCharge).toLocaleString('en-IN')}`;
  const deliveryAddr = order.deliveryAddress || order.shippingAddress || order.customer?.address || '';
  const city = order.city || order.customer?.city || '';
  const state = order.state || order.customer?.state || '';
  const pincode = order.pincode || order.postalCode || order.customer?.pincode || '';

  const itemsHtml = items.map(item => {
    const name = item.productName || item.variant?.product?.name || item.product?.name || 'Handcrafted Jewellery';
    const variantTitle = item.variantTitle || item.variant?.title || '';
    const qty = item.quantity || 1;
    const price = Number(item.price || item.unitPrice || 0);
    return `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #F0E6D8;">
        <div style="font-weight: 600; color: #2A1C19; font-size: 14px;">${name}</div>
        ${variantTitle ? `<div style="font-size: 12px; color: #7D6460;">${variantTitle}</div>` : ''}
        <div style="font-size: 12px; color: #A8928D;">Qty: ${qty}</div>
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #F0E6D8; text-align: right; font-weight: 600; color: #7A223B; font-size: 14px;">
        ₹${(price * qty).toLocaleString('en-IN')}
      </td>
    </tr>
    `;
  }).join('');

  const bodyContent = `
    <h2 style="color: #7A223B; font-size: 20px; margin-top: 0; font-weight: 600;">Order Confirmed &amp; In Preparation</h2>
    <p style="font-size: 14px; line-height: 1.6; color: #5C4540;">
      Dear ${customerName},<br><br>
      Thank you for acquiring handcrafted elegance from Sunbloom Adorn. Your order <strong>#${orderNumber}</strong> has been successfully placed and paid. Our artisans are now preparing your creations in luxury tamper-evident packaging.
    </p>

    <div style="background-color: #FAF6F0; border-radius: 12px; padding: 20px; margin: 24px 0; border: 1px solid #E8DCCF;">
      <h3 style="margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #7A223B;">Order Summary (#${orderNumber})</h3>
      <table style="width: 100%; border-collapse: collapse;">
        ${itemsHtml}
        <tr>
          <td style="padding-top: 14px; font-size: 13px; color: #7D6460;">Subtotal</td>
          <td style="padding-top: 14px; text-align: right; font-size: 13px; color: #2A1C19;">₹${subtotal}</td>
        </tr>
        <tr>
          <td style="padding-top: 6px; font-size: 13px; color: #7D6460;">Luxury Insured Delivery</td>
          <td style="padding-top: 6px; text-align: right; font-size: 13px; color: #2A1C19;">${shipping}</td>
        </tr>
        <tr>
          <td style="padding-top: 10px; font-size: 16px; font-weight: 700; color: #7A223B;">Total Paid</td>
          <td style="padding-top: 10px; text-align: right; font-size: 18px; font-weight: 700; color: #7A223B;">₹${total}</td>
        </tr>
      </table>
    </div>

    ${deliveryAddr ? `
      <div style="margin: 20px 0; font-size: 13px; color: #5C4540; line-height: 1.5;">
        <strong style="color: #2A1C19;">Delivery Destination:</strong><br>
        ${deliveryAddr}<br>
        ${city ? `${city}, ` : ''}${state ? `${state} ` : ''}${pincode ? `PIN: ${pincode}` : ''}
      </div>
    ` : ''}

    <div style="text-align: center; margin-top: 30px;">
      <a href="${SITE_URL}/orders" class="btn">View Order Details</a>
    </div>
  `;

  const html = wrapEmailTemplate(
    `Order Confirmed #${orderNumber} | Sunbloom Adorn`,
    `Your order #${orderNumber} is confirmed! Our artisans are preparing your creations.`,
    bodyContent
  );

  try {
    const info = await t.sendMail({
      from: `"Sunbloom Adorn Concierge" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: `✨ Order Confirmed: #${orderNumber} — Sunbloom Adorn`,
      html,
    });
    console.log(`[Email Notification] Order confirmation sent to ${customerEmail} (MessageId: ${info.messageId})`);
    return { success: true, messageId: info.messageId, type: 'order_confirmation', recipient: customerEmail };
  } catch (error) {
    logEmailFailure('order_confirmation', customerEmail, error.message, order.orderNumber);
    return { success: false, error: error.message, type: 'order_confirmation', recipient: customerEmail };
  }
}

/**
 * 2. Send Delivery Location Enquiry Response Email
 */
async function sendDeliveryEnquiryResponseEmail(enquiry) {
  const t = getTransporter();
  const customerEmail = enquiry.email || enquiry.customer?.email;
  if (!t || !customerEmail) return { success: false, reason: 'NO_EMAIL_CONFIG_OR_RECIPIENT' };

  const customerName = enquiry.name || enquiry.customer?.name || 'Valued Collector';
  const isAvailable = enquiry.status === 'DELIVERY_AVAILABLE';
  const city = enquiry.city || 'your city';
  const pincode = enquiry.pincode || '';

  const bodyContent = `
    <h2 style="color: ${isAvailable ? '#15803d' : '#991b1b'}; font-size: 20px; margin-top: 0; font-weight: 600;">
      ${isAvailable ? '✨ Delivery Verified for Your Destination' : 'Delivery Service Update'}
    </h2>
    <p style="font-size: 14px; line-height: 1.6; color: #5C4540;">
      Dear ${customerName},<br><br>
      Thank you for your enquiry regarding delivery to <strong>${city} (PIN: ${pincode})</strong>.
    </p>

    <div style="background-color: ${isAvailable ? '#F0FDF4' : '#FEF2F2'}; border-radius: 12px; padding: 20px; margin: 20px 0; border: 1px solid ${isAvailable ? '#BBF7D0' : '#FECACA'};">
      <p style="margin: 0; font-size: 14px; color: ${isAvailable ? '#166534' : '#991b1b'}; line-height: 1.5;">
        ${isAvailable
          ? `<strong>Courier Partner Verified:</strong> Our logistics atelier has confirmed secure, insured courier coverage to your address (${city}, PIN: ${pincode}). You may now complete your order directly.`
          : `<strong>Coverage Notice:</strong> Courier partner coverage is currently not available for PIN: ${pincode}. Our concierge team is happy to assist if you have an alternate delivery address.`
        }
      </p>
      ${enquiry.adminNotes ? `
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed ${isAvailable ? '#86EFAC' : '#FCA5A5'}; font-size: 13px; color: #5C4540;">
          <strong>Concierge Note:</strong> ${enquiry.adminNotes}
        </div>
      ` : ''}
    </div>

    ${isAvailable ? `
      <div style="text-align: center; margin-top: 24px;">
        <a href="${SITE_URL}/cart" class="btn">Proceed to Checkout</a>
      </div>
    ` : `
      <div style="text-align: center; margin-top: 24px;">
        <a href="${SITE_URL}/support" class="btn">Contact Concierge Support</a>
      </div>
    `}
  `;

  const html = wrapEmailTemplate(
    `Delivery Enquiry Update: ${city} (${pincode}) | Sunbloom Adorn`,
    `Update on your delivery enquiry for ${city}, PIN: ${pincode}.`,
    bodyContent
  );

  try {
    const info = await t.sendMail({
      from: `"Sunbloom Adorn Concierge" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: `✨ Delivery Service Update for PIN: ${pincode} — Sunbloom Adorn`,
      html,
    });
    console.log(`[Email Notification] Delivery enquiry response sent to ${customerEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Email Notification] Failed to send enquiry email:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 3. Send Support Query / Ticket Reply Email
 */
async function sendSupportQueryReplyEmail(query, replyMessage) {
  const t = getTransporter();
  const customerEmail = query.email || query.customer?.email;
  if (!t || !customerEmail) return { success: false, reason: 'NO_EMAIL_CONFIG_OR_RECIPIENT' };

  const customerName = query.name || query.customer?.name || 'Valued Collector';
  const ticketId = query.ticketId || query.id;

  const bodyContent = `
    <h2 style="color: #7A223B; font-size: 20px; margin-top: 0; font-weight: 600;">Response to Your Support Request</h2>
    <p style="font-size: 14px; line-height: 1.6; color: #5C4540;">
      Dear ${customerName},<br><br>
      Our concierge team has replied to your query regarding <strong>"${query.subject || 'Customer Enquiry'}"</strong> (Ticket #${ticketId}).
    </p>

    <div style="background-color: #FAF6F0; border-radius: 12px; padding: 20px; margin: 20px 0; border: 1px solid #E8DCCF;">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #7A223B; margin-bottom: 8px; font-weight: 600;">
        Concierge Response:
      </div>
      <p style="margin: 0; font-size: 14px; color: #2A1C19; line-height: 1.6; white-space: pre-line;">
        ${replyMessage}
      </p>
    </div>

    <div style="text-align: center; margin-top: 24px;">
      <a href="${SITE_URL}/support" class="btn">View &amp; Reply Online</a>
    </div>
  `;

  const html = wrapEmailTemplate(
    `Response to Ticket #${ticketId} | Sunbloom Adorn Concierge`,
    `A new reply has been posted to your support query #${ticketId}.`,
    bodyContent
  );

  try {
    const info = await t.sendMail({
      from: `"Sunbloom Adorn Concierge" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: `💬 New Reply on Ticket #${ticketId} — Sunbloom Adorn Concierge`,
      html,
    });
    console.log(`[Email Notification] Support query reply sent to ${customerEmail}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Email Notification] Failed to send query reply email:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 4. Send Order Status Updates (Shipped / Out for Delivery / Delivered)
 */
async function sendOrderStatusEmail(order, status, trackingUrl) {
  const t = getTransporter();
  const customerEmail = String(order.customerEmail || order.customer?.email || '').trim().toLowerCase();
  if (!t || !isValidEmailAddress(customerEmail)) {
    logEmailFailure(
      `order_status_${String(status || '').toLowerCase()}`,
      customerEmail,
      !t ? 'EMAIL_PROVIDER_NOT_CONFIGURED' : 'INVALID_OR_MISSING_RECIPIENT',
      order.orderNumber
    );
    return { success: false, reason: !t ? 'EMAIL_PROVIDER_NOT_CONFIGURED' : 'INVALID_OR_MISSING_RECIPIENT' };
  }

  const customerName = order.customerName || order.customer?.name || 'Valued Collector';
  const orderNumber = order.orderNumber;

  let title = '';
  let statusText = '';
  let ctaText = 'Track Your Shipment';
  let ctaUrl = trackingUrl || `${SITE_URL}/orders`;

  if (status === 'OUT_FOR_DELIVERY') {
    title = '🚚 Your Order is Out for Delivery!';
    statusText = `Your handcrafted creations (Order #${orderNumber}) are out for delivery today with our trusted courier partner.`;
  } else if (status === 'SHIPPED') {
    title = '📦 Your Order Has Been Dispatched';
    statusText = `Your order #${orderNumber} has been safely dispatched from our atelier.`;
  } else if (status === 'DELIVERED') {
    title = '✨ Your Order Has Been Delivered';
    statusText = `Your order #${orderNumber} has been delivered. We hope you cherish your new Sunbloom Adorn creations!`;
    ctaText = 'Visit Sunbloom Adorn';
    ctaUrl = SITE_URL;
  }

  const bodyContent = `
    <h2 style="color: #7A223B; font-size: 20px; margin-top: 0; font-weight: 600;">${title}</h2>
    <p style="font-size: 14px; line-height: 1.6; color: #5C4540;">
      Dear ${customerName},<br><br>
      ${statusText}
    </p>

    ${trackingUrl ? `
      <div style="background-color: #FAF6F0; border-radius: 12px; padding: 18px; margin: 20px 0; border: 1px solid #E8DCCF; font-size: 13px;">
        <strong style="color: #7A223B;">Live Tracking Link:</strong><br>
        <a href="${trackingUrl}" style="color: #7A223B; word-break: break-all;">${trackingUrl}</a>
      </div>
    ` : ''}

    <div style="text-align: center; margin-top: 24px;">
      <a href="${ctaUrl}" class="btn">${ctaText}</a>
    </div>
  `;

  const html = wrapEmailTemplate(
    `${title} | Sunbloom Adorn`,
    statusText,
    bodyContent
  );

  try {
    const info = await t.sendMail({
      from: `"Sunbloom Adorn Concierge" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: `${title} (#${orderNumber}) — Sunbloom Adorn`,
      html,
    });
    return { success: true, messageId: info.messageId, type: `order_status_${String(status || '').toLowerCase()}`, recipient: customerEmail };
  } catch (error) {
    logEmailFailure(`order_status_${String(status || '').toLowerCase()}`, customerEmail, error.message, order.orderNumber);
    return { success: false, error: error.message, type: `order_status_${String(status || '').toLowerCase()}`, recipient: customerEmail };
  }
}

/**
 * Send a new-product announcement to one existing customer.
 * The caller is responsible for selecting existing customers and invoking this
 * only after a successful Product.create operation.
 */
async function sendNewProductAnnouncementEmail(product, customer) {
  const t = getTransporter();
  const customerEmail = String(customer?.email || '').trim().toLowerCase();
  if (!t || !isValidEmailAddress(customerEmail)) {
    logEmailFailure(
      'new_product',
      customerEmail,
      !t ? 'EMAIL_PROVIDER_NOT_CONFIGURED' : 'INVALID_OR_MISSING_RECIPIENT'
    );
    return { success: false, reason: !t ? 'EMAIL_PROVIDER_NOT_CONFIGURED' : 'INVALID_OR_MISSING_RECIPIENT' };
  }

  const productName = product.name || 'New Jewellery Creation';
  const productUrl = `${SITE_URL}/products/${encodeURIComponent(product.slug || product.id)}`;
  const imageUrl = Array.isArray(product.images) && /^https?:\/\//i.test(product.images[0] || '')
    ? product.images[0]
    : null;
  const imageHtml = imageUrl
    ? `<img src="${imageUrl}" alt="${productName}" style="display:block;width:100%;max-width:260px;height:auto;border-radius:12px;margin:0 auto 20px;" />`
    : '';
  const bodyContent = `
    <h2 style="color: #7A223B; font-size: 20px; margin-top: 0; font-weight: 600;">New jewellery has arrived at Sunbloom Adorn.</h2>
    <p style="font-size: 14px; line-height: 1.6; color: #5C4540;">Dear ${customer.name || 'Valued Collector'},<br><br>
      We are delighted to introduce a new addition to our collection.</p>
    ${imageHtml}
    <div style="background-color: #FAF6F0; border-radius: 12px; padding: 20px; margin: 20px 0; border: 1px solid #E8DCCF;">
      <h3 style="margin: 0 0 8px; font-size: 17px; color: #2A1C19;">${productName}</h3>
      ${product.description ? `<p style="margin: 0 0 10px; font-size: 13px; line-height: 1.5; color: #7D6460;">${product.description}</p>` : ''}
      ${Number.isFinite(Number(product.basePrice)) ? `<p style="margin: 0; font-size: 15px; font-weight: 700; color: #7A223B;">₹${Number(product.basePrice).toLocaleString('en-IN')}</p>` : ''}
    </div>
    <div style="text-align: center; margin-top: 24px;"><a href="${productUrl}" class="btn">View the New Collection Piece</a></div>
  `;
  const html = wrapEmailTemplate(
    `New Arrival: ${productName} | Sunbloom Adorn`,
    `Discover the latest jewellery addition from Sunbloom Adorn: ${productName}.`,
    bodyContent
  );

  try {
    const info = await t.sendMail({
      from: `"Sunbloom Adorn Concierge" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: `New Jewellery Has Arrived: ${productName} — Sunbloom Adorn`,
      html,
    });
    return { success: true, messageId: info.messageId, type: 'new_product', recipient: customerEmail };
  } catch (error) {
    logEmailFailure('new_product', customerEmail, error.message);
    return { success: false, error: error.message, type: 'new_product', recipient: customerEmail };
  }
}

async function sendNewProductAnnouncementEmails(product, customers) {
  const results = [];
  for (const customer of customers || []) {
    results.push(await sendNewProductAnnouncementEmail(product, customer));
  }
  return results;
}

module.exports = {
  getTransporter,
  sendEmailAsync,
  sendOrderConfirmationEmail,
  sendDeliveryEnquiryResponseEmail,
  sendSupportQueryReplyEmail,
  sendOrderStatusEmail,
  sendNewProductAnnouncementEmail,
  sendNewProductAnnouncementEmails,
  isValidEmailAddress,
};

