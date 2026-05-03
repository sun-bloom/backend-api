/**
 * Lightweight logging boundaries.
 * - Structured log lines with optional correlation ID
 * - Preserves DEBUG_AUTH behaviour from server.js
 * - Safe defaults for production (no console.debug in prod)
 */

const AUTH_DEBUG = process.env.DEBUG_AUTH === '1';

/**
 * Generate a short correlation ID for request tracing.
 * Uses crypto.randomUUID when available (Node 19+), falls back to a hex timestamp.
 */
function generateCorrelationId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older Node: hex timestamp + random
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Create a logger bound to a correlation ID.
 * Returns { debug, info, warn, error } methods.
 */
function createLogger(correlationId = null) {
  const ctx = correlationId ? { correlationId } : {};

  const serialize = (level, msg, meta = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...ctx,
      ...meta,
    };
    return JSON.stringify(entry);
  };

  return {
    debug: (msg, meta) => {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(serialize('DEBUG', msg, meta));
      }
    },
    info: (msg, meta) => {
      console.info(serialize('INFO', msg, meta));
    },
    warn: (msg, meta) => {
      console.warn(serialize('WARN', msg, meta));
    },
    error: (msg, meta) => {
      console.error(serialize('ERROR', msg, meta));
    },
    // Auth-specific logger that respects DEBUG_AUTH
    auth: (msg, meta) => {
      if (AUTH_DEBUG) {
        console.debug(serialize('AUTH', msg, meta));
      }
    },
  };
}

// Default logger (no correlation ID — use for app-level logs)
const logger = createLogger();

module.exports = {
  createLogger,
  generateCorrelationId,
  logger,
  AUTH_DEBUG,
};
