// ╔══════════════════════════════════════════════════════════════════════╗
// ║  TEST FLAGS — backend-api/config/testFlags.js                       ║
// ║                                                                     ║
// ║  TEMPORARY TESTING OVERRIDES ONLY.                                  ║
// ║  These flags exist solely to enable end-to-end payment testing.     ║
// ║  They must NEVER be set to true in production.                      ║
// ║                                                                     ║
// ║  TO RE-ENABLE THE ₹200 MINIMUM:                                     ║
// ║    Set ENFORCE_MIN_PAYMENT_LIMIT = true  (or delete this file)      ║
// ╚══════════════════════════════════════════════════════════════════════╝

/**
 * ENFORCE_MIN_PAYMENT_LIMIT
 *
 * When TRUE (production default):
 *   - Backend rejects orders below ₹200 with HTTP 400
 *   - The ₹200 check in /api/payments/create-order and /api/customer/orders runs normally
 *
 * When FALSE (temporary testing only):
 *   - The ₹200 minimum check is bypassed — orders of any amount (₹1, ₹10, etc.) proceed
 *   - ALL other payment protections remain fully active:
 *       ✓ PayU hash generation & verification
 *       ✓ Amount consistency check (backend vs PayU callback)
 *       ✓ Reverse hash verification
 *       ✓ PayU verify_payment server-side check
 *       ✓ Order creation required before PayU payload
 *       ✓ paymentStatus / orderStatus transitions
 *       ✓ Inventory decrement
 *       ✓ Duplicate callback protection
 *       ✓ gatewayReference / mihpayid storage
 *       ✓ Delivery region validation
 *       ✓ Authentication / authorization
 *
 * ── TO RE-ENABLE ₹200 MINIMUM ─────────────────────────────────────────
 *   Change the line below to:  ENFORCE_MIN_PAYMENT_LIMIT: true,
 *   OR set env var:            ENFORCE_MIN_PAYMENT_LIMIT=true
 */
const ENFORCE_MIN_PAYMENT_LIMIT =
  process.env.ENFORCE_MIN_PAYMENT_LIMIT !== undefined
    ? process.env.ENFORCE_MIN_PAYMENT_LIMIT === 'true'
    : false; // ← SET TO true TO RE-ENABLE ₹200 MINIMUM

module.exports = {
  ENFORCE_MIN_PAYMENT_LIMIT,
};
