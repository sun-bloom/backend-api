// services/whatsappNotification.service.js
// Sunbloom Adorn WhatsApp Notification Service for Orders, Delivery Enquiries & Customer Support

const https = require('https');
const http = require('http');

const SITE_URL = process.env.SITE_URL || process.env.FRONTEND_URL || 'https://sunbloomadorn.com';

/**
 * Validates whether a tracking URL is a valid HTTP/HTTPS URL.
 */
function isValidTrackingUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  const trimmed = urlString.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalizes phone numbers to standard 10-digit Indian mobile.
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-10);
}

/**
 * Helper to dispatch message via Meta WhatsApp Cloud API or custom Webhook.
 */
async function dispatchWhatsAppMessage(cleanPhone, messageText) {
  if (!cleanPhone || cleanPhone.length !== 10) {
    return {
      success: false,
      sent: false,
      reason: 'INVALID_PHONE',
      message: 'No valid 10-digit phone number provided.',
    };
  }

  const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
  const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (WHATSAPP_API_URL || (WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID)) {
    try {
      const endpoint =
        WHATSAPP_API_URL ||
        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

      const payload = JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: `91${cleanPhone}`,
        type: 'text',
        text: { preview_url: true, body: messageText },
      });

      const urlObj = new URL(endpoint);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const responseData = await new Promise((resolve, reject) => {
        const req = client.request(
          endpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode, data }));
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (responseData.statusCode >= 200 && responseData.statusCode < 300) {
        console.log(`[WhatsApp Notification] Successfully sent to +91${cleanPhone}`);
        return { success: true, sent: true, message: messageText };
      } else {
        console.error(`[WhatsApp Notification] Provider error (Status ${responseData.statusCode}):`, responseData.data);
        return {
          success: false,
          sent: false,
          reason: `PROVIDER_ERROR_STATUS_${responseData.statusCode}`,
          message: messageText,
        };
      }
    } catch (err) {
      console.error('[WhatsApp Notification] Request failed:', err.message);
      return { success: false, sent: false, reason: 'NETWORK_ERROR', message: messageText };
    }
  }

  // Fallback when credentials are not yet entered into .env
  console.log(
    `[WhatsApp Notification] (Provider not set in .env). Prepared message for +91${cleanPhone}:\n` +
    `"${messageText.replace(/\n/g, ' ')}"`
  );

  return {
    success: true,
    sent: false,
    reason: 'PROVIDER_NOT_CONFIGURED',
    message: messageText,
    whatsappUrl: `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(messageText)}`,
  };
}

/**
 * 1. Order Placed WhatsApp Notification
 */
async function sendOrderConfirmationWhatsApp(order) {
  const cleanPhone = cleanPhoneNumber(
    order.whatsappNumber || order.customer?.whatsappNumber || order.customerPhone || order.customer?.phone
  );
  const customerName = order.customerName || order.customer?.name || 'Valued Collector';
  const orderNumber = order.orderNumber;
  const total = Number(order.totalAmount || 0).toLocaleString('en-IN');

  const messageText =
    `✨ *Sunbloom Adorn — Order Confirmed!*\n\n` +
    `Dear ${customerName},\n` +
    `Thank you for your order! Your handcrafted jewellery order *#${orderNumber}* is confirmed.\n\n` +
    `💎 *Total Paid*: ₹${total}\n` +
    `📦 *Status*: In Preparation\n\n` +
    `Our artisans are preparing your creations in luxury tamper-evident packaging.\n\n` +
    `🔗 *View Order*: ${SITE_URL}/order-history\n\n` +
    `Thank you for choosing Sunbloom Adorn Haute Jewellery.`;

  return await dispatchWhatsAppMessage(cleanPhone, messageText);
}

/**
 * 2. Delivery Enquiry Response WhatsApp Notification
 */
async function sendDeliveryEnquiryResponseWhatsApp(enquiry) {
  const cleanPhone = cleanPhoneNumber(enquiry.phone || enquiry.customer?.phone || enquiry.customer?.whatsappNumber);
  const customerName = enquiry.name || enquiry.customer?.name || 'Valued Collector';
  const isAvailable = enquiry.status === 'DELIVERY_AVAILABLE';
  const city = enquiry.city || 'your city';
  const pincode = enquiry.pincode || '';

  let messageText = '';
  if (isAvailable) {
    messageText =
      `✨ *Sunbloom Adorn — Delivery Verified!*\n\n` +
      `Dear ${customerName},\n` +
      `Great news! Our logistics atelier has verified delivery availability for *${city} (PIN: ${pincode})*! 🚚✨\n\n` +
      `You can now complete your order directly through checkout:\n` +
      `👉 *Proceed to Checkout*: ${SITE_URL}/cart\n\n` +
      (enquiry.adminNotes ? `📝 *Note*: ${enquiry.adminNotes}\n\n` : '') +
      `We look forward to delivering our handcrafted creations to you.`;
  } else {
    messageText =
      `✨ *Sunbloom Adorn — Delivery Location Update*\n\n` +
      `Dear ${customerName},\n` +
      `Regarding your delivery enquiry for *${city} (PIN: ${pincode})*:\n` +
      `Courier partner coverage is currently not available for this postal code.\n\n` +
      (enquiry.adminNotes ? `📝 *Note*: ${enquiry.adminNotes}\n\n` : '') +
      `Our concierge team is happy to assist if you have an alternative address:\n` +
      `👉 *Contact Concierge*: ${SITE_URL}/support`;
  }

  return await dispatchWhatsAppMessage(cleanPhone, messageText);
}

/**
 * 3. Support Query / Ticket Reply WhatsApp Notification
 */
async function sendSupportQueryReplyWhatsApp(query, replyMessage) {
  const cleanPhone = cleanPhoneNumber(query.phone || query.customer?.phone || query.customer?.whatsappNumber);
  const customerName = query.name || query.customer?.name || 'Valued Collector';
  const ticketId = query.ticketId || query.id;

  const messageText =
    `✨ *Sunbloom Adorn — Concierge Reply*\n\n` +
    `Dear ${customerName},\n` +
    `Our concierge atelier has replied to your support request *#${ticketId}*:\n\n` +
    `"${replyMessage.length > 200 ? replyMessage.slice(0, 197) + '...' : replyMessage}"\n\n` +
    `👉 *View & Reply*: ${SITE_URL}/support\n\n` +
    `We remain at your service.`;

  return await dispatchWhatsAppMessage(cleanPhone, messageText);
}

/**
 * 4. Out-For-Delivery Notification
 */
function formatOutForDeliveryMessage({ orderNumber, customerName, trackingUrl }) {
  const greeting = customerName ? `Dear ${customerName},` : 'Hello,';
  return (
    `✨ *Sunbloom Adorn — Haute Jewellery Atelier*\n\n` +
    `${greeting}\n` +
    `Your order *#${orderNumber}* is now *OUT FOR DELIVERY*! 🚚✨\n\n` +
    `Your handcrafted creations are on their way to you in tamper-evident luxury packaging.\n\n` +
    `🔗 *Track Shipment*: ${trackingUrl}\n\n` +
    `For any assistance, reply directly to this message or contact our atelier concierge.\n` +
    `Thank you for choosing Sunbloom Adorn.`
  );
}

async function sendOutForDeliveryNotification(order, trackingUrl) {
  const cleanPhone = cleanPhoneNumber(
    order.whatsappNumber || order.customer?.whatsappNumber || order.customerPhone || order.customer?.phone
  );
  const customerName = order.customerName || order.customer?.name || '';
  const messageText = formatOutForDeliveryMessage({
    orderNumber: order.orderNumber,
    customerName,
    trackingUrl,
  });

  return await dispatchWhatsAppMessage(cleanPhone, messageText);
}

/**
 * 5. Order Delivered WhatsApp Notification
 */
async function sendOrderDeliveredWhatsApp(order) {
  const cleanPhone = cleanPhoneNumber(
    order.whatsappNumber || order.customer?.whatsappNumber || order.customerPhone || order.customer?.phone
  );
  const customerName = order.customerName || order.customer?.name || 'Valued Collector';
  const orderNumber = order.orderNumber;

  const messageText =
    `✨ *Sunbloom Adorn — Order Delivered!*\n\n` +
    `Dear ${customerName},\n` +
    `Your order *#${orderNumber}* has been successfully delivered! 🎁✨\n\n` +
    `We hope your new jewellery brings timeless elegance and joy.\n\n` +
    `Share your thoughts with us or explore new artisan arrivals at:\n` +
    `👉 ${SITE_URL}\n\n` +
    `Thank you for being part of the Sunbloom Adorn story.`;

  return await dispatchWhatsAppMessage(cleanPhone, messageText);
}

module.exports = {
  isValidTrackingUrl,
  cleanPhoneNumber,
  dispatchWhatsAppMessage,
  sendOrderConfirmationWhatsApp,
  sendDeliveryEnquiryResponseWhatsApp,
  sendSupportQueryReplyWhatsApp,
  sendOutForDeliveryNotification,
  sendOrderDeliveredWhatsApp,
};
