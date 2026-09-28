// services/sms/sms.service.js
// External India-compatible SMS OTP Provider Adapter
// Supports Fast2SMS, MSG91, 2Factor, and Twilio with security safeguards:
// - Cryptographic OTP generation
// - SHA-256 hashed storage (never stores or logs raw OTPs)
// - Expiry (5 minutes)
// - Resend throttling (60 seconds)
// - Maximum 3 verification attempts per session
// - Rate limiting per phone number

const crypto = require('crypto');

// In-memory OTP session cache: Map<phone, SessionData>
// SessionData: { hash, expiresAt, attempts, lastSentAt, requestCount, windowStart }
const otpSessions = new Map();

// Periodic cleanup of expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of otpSessions.entries()) {
    if (session.expiresAt < now && (!session.windowStart || now - session.windowStart > 3600000)) {
      otpSessions.delete(phone);
    }
  }
}, 600000);

/**
 * Hash phone + OTP combination with a server salt for secure verification
 */
function hashOtp(phone, otp) {
  const salt = process.env.OTP_SECRET || process.env.JWT_SECRET || 'sunbloom-otp-security-salt';
  return crypto.createHash('sha256').update(`${phone}:${otp}:${salt}`).digest('hex');
}

/**
 * Get active SMS provider configuration
 */
function getProviderConfig() {
  const provider = (process.env.SMS_PROVIDER || '').toLowerCase().trim();

  if (provider === 'fast2sms' || process.env.FAST2SMS_API_KEY) {
    return {
      provider: 'fast2sms',
      apiKey: process.env.FAST2SMS_API_KEY,
    };
  }

  if (provider === 'msg91' || process.env.MSG91_AUTH_KEY) {
    return {
      provider: 'msg91',
      authKey: process.env.MSG91_AUTH_KEY,
      templateId: process.env.MSG91_TEMPLATE_ID,
    };
  }

  if (provider === '2factor' || process.env.TWOFACTOR_API_KEY) {
    return {
      provider: '2factor',
      apiKey: process.env.TWOFACTOR_API_KEY,
    };
  }

  if (provider === 'twilio' || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)) {
    return {
      provider: 'twilio',
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      fromNumber: process.env.TWILIO_PHONE_NUMBER,
    };
  }

  return {
    provider: 'none',
  };
}

/**
 * Dispatch SMS via external provider
 */
async function dispatchSms(phone, otp) {
  const config = getProviderConfig();

  if (config.provider === 'none') {
    // If running in development and explicit test mode is enabled
    if (process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_OTP === 'true') {
      return {
        sent: true,
        mode: 'dev',
        provider: 'dev-mode',
        message: 'Development testing mode active.',
      };
    }

    const err = new Error('SMS service is not configured on the server. Required environment variables: FAST2SMS_API_KEY or MSG91_AUTH_KEY or TWOFACTOR_API_KEY.');
    err.code = 'SMS_PROVIDER_NOT_CONFIGURED';
    throw err;
  }

  const messageText = `Your Sunbloom Adorn verification code is ${otp}. Valid for 5 minutes. Do not share this code with anyone.`;

  switch (config.provider) {
    case 'fast2sms': {
      // Fast2SMS OTP route
      const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          'authorization': config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          route: 'otp',
          variables_values: otp,
          numbers: phone,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.return === false) {
        throw new Error(data.message || 'Fast2SMS dispatch failed');
      }
      return { sent: true, provider: 'fast2sms' };
    }

    case 'msg91': {
      // MSG91 OTP route
      const url = `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(config.templateId || '')}&mobile=91${phone}&otp=${otp}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'authkey': config.authKey,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.type === 'error') {
        throw new Error(data.message || 'MSG91 dispatch failed');
      }
      return { sent: true, provider: 'msg91' };
    }

    case '2factor': {
      // 2Factor OTP route
      const url = `https://2factor.in/API/V1/${encodeURIComponent(config.apiKey)}/SMS/${phone}/${otp}/OTP1`;
      const response = await fetch(url, { method: 'GET' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.Status !== 'Success') {
        throw new Error(data.Details || '2Factor dispatch failed');
      }
      return { sent: true, provider: '2factor' };
    }

    case 'twilio': {
      // Twilio Messages API
      const authHeader = 'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
      const params = new URLSearchParams({
        To: `+91${phone}`,
        From: config.fromNumber,
        Body: messageText,
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        }
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error_code) {
        throw new Error(data.message || 'Twilio dispatch failed');
      }
      return { sent: true, provider: 'twilio' };
    }

    default: {
      const err = new Error('Unknown SMS provider.');
      err.code = 'SMS_PROVIDER_NOT_CONFIGURED';
      throw err;
    }
  }
}

/**
 * Generate and send OTP to Indian 10-digit mobile number
 * @param {string} cleanPhone - 10 digit phone number (e.g. 9876543210)
 */
async function sendOtp(cleanPhone) {
  if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    const err = new Error('Please enter a valid 10-digit Indian mobile number starting with 6-9.');
    err.statusCode = 400;
    throw err;
  }

  const now = Date.now();
  const existing = otpSessions.get(cleanPhone);

  // 1. Hourly rate limit check (max 5 OTP requests per hour per phone)
  if (existing) {
    if (existing.windowStart && now - existing.windowStart < 3600000) {
      if (existing.requestCount >= 5) {
        const remainingMinutes = Math.ceil((3600000 - (now - existing.windowStart)) / 60000);
        const err = new Error(`Too many OTP requests. Please try again after ${remainingMinutes} minutes.`);
        err.statusCode = 429;
        throw err;
      }
    } else {
      existing.windowStart = now;
      existing.requestCount = 0;
    }

    // 2. Resend cooldown (minimum 60 seconds)
    if (existing.lastSentAt && now - existing.lastSentAt < 60000) {
      const waitSeconds = Math.ceil((60000 - (now - existing.lastSentAt)) / 1000);
      const err = new Error(`Please wait ${waitSeconds} seconds before requesting another OTP.`);
      err.statusCode = 429;
      err.retryAfter = waitSeconds;
      throw err;
    }
  }

  // 3. Cryptographically secure 6-digit OTP
  const otpNumber = crypto.randomInt(100000, 1000000);
  const otp = String(otpNumber);
  const hashed = hashOtp(cleanPhone, otp);
  const expiresAt = now + 5 * 60 * 1000; // 5 minutes

  // 4. Dispatch via SMS provider (OTP is never logged)
  const result = await dispatchSms(cleanPhone, otp);

  // 5. Update session in cache
  otpSessions.set(cleanPhone, {
    hash: hashed,
    expiresAt,
    attempts: 0,
    lastSentAt: now,
    windowStart: existing?.windowStart || now,
    requestCount: (existing?.requestCount || 0) + 1,
    // Store devOtp only if dev mode is explicitly active and in development environment
    ...(result.mode === 'dev' && { devOtp: otp }),
  });

  return {
    success: true,
    message: `Verification code sent to +91 ${cleanPhone.slice(0, 2)}******${cleanPhone.slice(-2)}`,
    resendCooldown: 60,
    expiresIn: 300,
    provider: result.provider,
    ...(result.mode === 'dev' && { devNote: 'Dev mode OTP active' }),
  };
}

/**
 * Verify submitted OTP for phone number
 * @param {string} cleanPhone - 10 digit phone number
 * @param {string} inputOtp - 6-digit OTP code submitted by user
 */
function verifyOtp(cleanPhone, inputOtp) {
  if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    const err = new Error('Invalid mobile number.');
    err.statusCode = 400;
    throw err;
  }

  const cleanInput = String(inputOtp || '').replace(/\D/g, '').slice(0, 6);
  if (cleanInput.length !== 6) {
    const err = new Error('Please enter the complete 6-digit verification code.');
    err.statusCode = 400;
    throw err;
  }

  const session = otpSessions.get(cleanPhone);
  const now = Date.now();

  if (!session || !session.hash) {
    const err = new Error('No active verification session found. Please request a new OTP.');
    err.statusCode = 400;
    throw err;
  }

  if (session.expiresAt < now) {
    otpSessions.delete(cleanPhone);
    const err = new Error('Verification code has expired. Please request a new OTP.');
    err.statusCode = 400;
    throw err;
  }

  if (session.attempts >= 3) {
    otpSessions.delete(cleanPhone);
    const err = new Error('Maximum verification attempts exceeded. Please request a new OTP.');
    err.statusCode = 429;
    throw err;
  }

  const inputHash = hashOtp(cleanPhone, cleanInput);

  // Timing-safe comparison to prevent timing attacks
  const expectedBuffer = Buffer.from(session.hash, 'hex');
  const actualBuffer = Buffer.from(inputHash, 'hex');

  let matches = false;
  if (expectedBuffer.length === actualBuffer.length) {
    matches = crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  if (!matches) {
    session.attempts += 1;
    const remainingAttempts = 3 - session.attempts;
    if (remainingAttempts <= 0) {
      otpSessions.delete(cleanPhone);
      const err = new Error('Incorrect verification code. Session invalidated. Please request a new OTP.');
      err.statusCode = 400;
      throw err;
    }
    const err = new Error(`Incorrect verification code. ${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.`);
    err.statusCode = 400;
    err.remainingAttempts = remainingAttempts;
    throw err;
  }

  // Verification succeeded - delete the OTP from session to prevent replay
  session.hash = null;
  session.expiresAt = 0;
  if (session.devOtp) delete session.devOtp;

  return {
    verified: true,
    phone: cleanPhone,
  };
}

module.exports = {
  sendOtp,
  verifyOtp,
  getProviderConfig,
};
