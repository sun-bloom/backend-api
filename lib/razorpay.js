// lib/razorpay.js
// Modular Razorpay service helper for Sunbloom Adorn backend

const Razorpay = require('razorpay');
const crypto = require('crypto');

/**
 * Validates whether Razorpay credentials are present in the environment.
 * @returns {boolean}
 */
function isRazorpayConfigured() {
  return Boolean(
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_ID.trim() &&
    process.env.RAZORPAY_KEY_SECRET &&
    process.env.RAZORPAY_KEY_SECRET.trim()
  );
}

/**
 * Returns a configured Razorpay instance.
 * @returns {Razorpay | null}
 */
function getRazorpayInstance() {
  if (!isRazorpayConfigured()) {
    console.warn('[Razorpay] RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not configured.');
    return null;
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID.trim(),
    key_secret: process.env.RAZORPAY_KEY_SECRET.trim(),
  });
}

/**
 * Verifies Razorpay checkout payment signature.
 * @param {Object} params
 * @param {string} params.orderId - Razorpay order ID (e.g. order_...)
 * @param {string} params.paymentId - Razorpay payment ID (e.g. pay_...)
 * @param {string} params.signature - HMAC SHA256 signature from client
 * @returns {boolean}
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  if (!process.env.RAZORPAY_KEY_SECRET) return false;

  const generatedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET.trim())
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return generatedSignature === signature;
}

/**
 * Verifies Razorpay webhook event signature.
 * @param {string|Buffer} rawBody - Raw webhook request body
 * @param {string} webhookSignature - 'x-razorpay-signature' header
 * @param {string} [webhookSecret] - Webhook secret (defaults to RAZORPAY_WEBHOOK_SECRET or RAZORPAY_KEY_SECRET)
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, webhookSignature, webhookSecret) {
  const secret = webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!rawBody || !webhookSignature || !secret) return false;

  const expectedSignature = crypto
    .createHmac('sha256', secret.trim())
    .update(rawBody)
    .digest('hex');

  return expectedSignature === webhookSignature;
}

module.exports = {
  getRazorpayInstance,
  isRazorpayConfigured,
  verifyPaymentSignature,
  verifyWebhookSignature,
};
