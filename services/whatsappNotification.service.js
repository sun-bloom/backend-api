// services/whatsappNotification.service.js
// Sunbloom Adorn WhatsApp Notification Service for Order Delivery & Tracking

const https = require('https');
const http = require('http');

/**
 * Formats the official Sunbloom Adorn Out-for-Delivery WhatsApp message.
 * @param {Object} params
 * @param {string} params.orderNumber
 * @param {string} params.customerName
 * @param {string} params.trackingUrl
 * @returns {string} Formatted WhatsApp message text
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

/**
 * Validates whether a tracking URL is a valid HTTP/HTTPS URL.
 * @param {string} urlString
 * @returns {boolean}
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
 * Sends or prepares a WhatsApp notification for an out-for-delivery order.
 * 
 * Rules:
 * 1. If real provider credentials exist (e.g. Meta Cloud API or custom webhook), dispatches HTTP request.
 * 2. If provider is not configured, logs clearly and returns status without faking API success.
 * 
 * @param {Object} order
 * @param {string} trackingUrl
 * @returns {Promise<{ success: boolean, sent: boolean, reason?: string, message: string }>}
 */
async function sendOutForDeliveryNotification(order, trackingUrl) {
  const cleanPhone = String(order.whatsappNumber || order.customer?.whatsappNumber || order.customerPhone || order.customer?.phone || '')
    .replace(/\D/g, '')
    .slice(-10);

  if (!cleanPhone || cleanPhone.length !== 10) {
    console.warn(`[WhatsApp Notification] Order #${order.orderNumber}: No valid 10-digit WhatsApp number found.`);
    return {
      success: false,
      sent: false,
      reason: 'INVALID_PHONE',
      message: 'No valid 10-digit Indian WhatsApp number associated with this order.',
    };
  }

  const customerName = order.customerName || order.customer?.name || '';
  const messageText = formatOutForDeliveryMessage({
    orderNumber: order.orderNumber,
    customerName,
    trackingUrl,
  });

  const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
  const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

  // Check if Meta WhatsApp Cloud API or custom provider is configured
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
        console.log(`[WhatsApp Notification] Successfully sent to +91${cleanPhone} for Order #${order.orderNumber}`);
        return {
          success: true,
          sent: true,
          message: messageText,
        };
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
      return {
        success: false,
        sent: false,
        reason: 'NETWORK_ERROR',
        message: messageText,
      };
    }
  }

  // Provider not configured in environment
  console.log(
    `[WhatsApp Notification] Provider not configured in .env (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).\n` +
    `Notification prepared for Order #${order.orderNumber} to +91${cleanPhone}:\n` +
    `"${messageText.replace(/\n/g, ' ')}"`
  );

  return {
    success: true,
    sent: false,
    reason: 'PROVIDER_NOT_CONFIGURED',
    message: messageText,
  };
}

module.exports = {
  formatOutForDeliveryMessage,
  isValidTrackingUrl,
  sendOutForDeliveryNotification,
};
