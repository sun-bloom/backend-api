// routes/otp.routes.js
// Dedicated external SMS OTP authentication routes issuing Firebase Custom Tokens
// Ensures existing customer identity and historical orders are preserved without duplicate records

const express = require('express');
const router = express.Router();
const { sendOtp, verifyOtp, getProviderConfig } = require('../services/sms/sms.service');
const { getAuth } = require('../lib/firebase-admin');

/**
 * POST /api/auth/otp/send
 * Initiates SMS OTP delivery to verified Indian mobile number
 */
router.post('/send', async (req, res) => {
  const { phone } = req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);

  if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    return res.status(400).json({
      error: 'INVALID_PHONE',
      message: 'Please enter a valid 10-digit Indian mobile number starting with 6-9.',
    });
  }

  try {
    const result = await sendOtp(cleanPhone);
    return res.json(result);
  } catch (err) {
    if (err.code === 'SMS_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'SMS_SERVICE_NOT_CONFIGURED',
        message: 'SMS verification is temporarily unavailable. The external SMS provider has not been configured in server environment variables.',
        details: 'Required credentials: FAST2SMS_API_KEY, MSG91_AUTH_KEY, or TWOFACTOR_API_KEY.',
      });
    }

    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
      error: 'OTP_SEND_FAILED',
      message: err.message || 'Failed to dispatch verification code.',
      ...(err.retryAfter && { retryAfter: err.retryAfter }),
    });
  }
});

/**
 * POST /api/auth/otp/verify
 * Validates OTP code, locates or initializes customer identity safely, and generates a Firebase Custom Token
 */
router.post('/verify', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { phone, otp, name } = req.body || {};
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  const cleanOtp = String(otp || '').replace(/\D/g, '').slice(0, 6);

  if (!cleanPhone || !/^[6-9]\d{9}$/.test(cleanPhone)) {
    return res.status(400).json({
      error: 'INVALID_PHONE',
      message: 'Please enter a valid 10-digit Indian mobile number starting with 6-9.',
    });
  }

  if (cleanOtp.length !== 6) {
    return res.status(400).json({
      error: 'INVALID_OTP',
      message: 'Please enter the 6-digit verification code.',
    });
  }

  // 1. Verify OTP with external provider adapter
  try {
    verifyOtp(cleanPhone, cleanOtp);
  } catch (verifyErr) {
    const statusCode = verifyErr.statusCode || 400;
    return res.status(statusCode).json({
      error: 'VERIFICATION_FAILED',
      message: verifyErr.message || 'Verification code is invalid or has expired.',
      ...(verifyErr.remainingAttempts !== undefined && { remainingAttempts: verifyErr.remainingAttempts }),
    });
  }

  // 2. Obtain Firebase Admin Auth instance
  const adminAuth = getAuth();
  if (!adminAuth) {
    console.error('[OTP Auth] Firebase Admin SDK is not initialized on the server.');
    return res.status(500).json({
      error: 'SERVER_CONFIG_ERROR',
      message: 'Firebase Admin authentication is not configured on the server.',
    });
  }

  try {
    // 3. Locate existing Customer in PostgreSQL by verified mobile number
    let existingCustomer = null;
    let candidates = [];
    if (prisma) {
      candidates = await prisma.customer.findMany({
        where: { phone: cleanPhone },
        include: {
          orders: {
            select: { id: true, orderNumber: true, totalAmount: true, createdAt: true },
            take: 5,
          },
        },
      });
    }

    if (candidates.length > 1) {
      console.warn(`[OTP Auth] Multiple customer records found for phone ${cleanPhone}. Selecting primary record.`);
      // Prefer candidate that already has a firebaseUid and orders
      existingCustomer = candidates.find((c) => c.firebaseUid && c.orders?.length > 0) ||
                         candidates.find((c) => c.firebaseUid) ||
                         candidates[0];
    } else if (candidates.length === 1) {
      existingCustomer = candidates[0];
    }

    let targetUid = null;

    if (existingCustomer && existingCustomer.firebaseUid) {
      // 4A. Existing customer already has a linked Firebase UID -> REUSE THE EXACT SAME UID
      // This preserves all historical orders and customer profile data!
      targetUid = existingCustomer.firebaseUid;

      // Verify that this UID exists in Firebase Admin, or ensure it is accessible
      try {
        await adminAuth.getUser(targetUid);
      } catch (fbGetErr) {
        if (fbGetErr.code === 'auth/user-not-found') {
          // Re-create the Firebase user with the existing UID to maintain link
          await adminAuth.createUser({
            uid: targetUid,
            phoneNumber: `+91${cleanPhone}`,
            displayName: existingCustomer.name || name || 'Customer',
          }).catch((err) => console.warn('[OTP Auth] Firebase user recreation note:', err.message));
        }
      }
    } else {
      // 4B. Check if Firebase already has a user for this phone number
      let fbUser = null;
      try {
        fbUser = await adminAuth.getUserByPhoneNumber(`+91${cleanPhone}`);
      } catch (phoneErr) {
        if (phoneErr.code !== 'auth/user-not-found') {
          console.warn('[OTP Auth] Firebase getUserByPhoneNumber check:', phoneErr.message);
        }
      }

      if (fbUser) {
        // Detect conflicts: check if this Firebase UID is linked to a DIFFERENT customer with a DIFFERENT phone
        if (prisma) {
          const conflictingCustomer = await prisma.customer.findUnique({
            where: { firebaseUid: fbUser.uid },
          });

          if (conflictingCustomer && conflictingCustomer.phone && conflictingCustomer.phone !== cleanPhone) {
            console.error(`[OTP Auth Conflict] Firebase UID ${fbUser.uid} belongs to customer ${conflictingCustomer.id} with phone ${conflictingCustomer.phone}, but verified phone is ${cleanPhone}.`);
            return res.status(409).json({
              error: 'ACCOUNT_CONFLICT',
              message: 'This mobile number is already linked to a different existing customer account. Please contact concierge support to resolve this account conflict.',
            });
          }
        }
        targetUid = fbUser.uid;
      } else {
        // Deterministic, collision-resistant UID for mobile authenticated customer
        targetUid = `phone_${cleanPhone}`;
        try {
          await adminAuth.createUser({
            uid: targetUid,
            phoneNumber: `+91${cleanPhone}`,
            displayName: name ? String(name).trim() : 'Customer',
          });
        } catch (createErr) {
          if (createErr.code === 'auth/uid-already-exists') {
            targetUid = `phone_${cleanPhone}`;
          } else if (createErr.code === 'auth/phone-number-already-exists') {
            const found = await adminAuth.getUserByPhoneNumber(`+91${cleanPhone}`);
            targetUid = found.uid;
          } else {
            // Fallback: create with auto-generated UID
            const autoUser = await adminAuth.createUser({
              displayName: name ? String(name).trim() : 'Customer',
            });
            targetUid = autoUser.uid;
          }
        }
      }
    }

    // 5. Issue Firebase Custom Token for the authoritative target UID
    const customToken = await adminAuth.createCustomToken(targetUid, {
      phone: cleanPhone,
      authMethod: 'mobile_otp',
    });

    // 6. Synchronize with PostgreSQL database
    let savedCustomer = existingCustomer;
    if (prisma) {
      if (existingCustomer) {
        // Update customer with verified phone and firebaseUid if not set
        const updateData = {};
        if (!existingCustomer.firebaseUid) {
          updateData.firebaseUid = targetUid;
        }
        if (name && String(name).trim() && (!existingCustomer.name || existingCustomer.name === 'Customer')) {
          updateData.name = String(name).trim();
        }
        if (!existingCustomer.phone) {
          updateData.phone = cleanPhone;
        }

        if (Object.keys(updateData).length > 0) {
          savedCustomer = await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: updateData,
          });
        }
      } else {
        // Create new Customer record with verified phone and null email
        savedCustomer = await prisma.customer.create({
          data: {
            firebaseUid: targetUid,
            name: name ? String(name).trim() : 'Customer',
            phone: cleanPhone,
            email: null, // Email remains strictly NULL until provided at checkout
          },
        }).catch(async (createErr) => {
          console.warn('[OTP Auth] Customer create note:', createErr.message);
          return await prisma.customer.findFirst({
            where: { OR: [{ firebaseUid: targetUid }, { phone: cleanPhone }] },
          });
        });
      }
    }

    return res.json({
      success: true,
      customToken,
      customer: savedCustomer || {
        id: `fb_${targetUid}`,
        firebaseUid: targetUid,
        phone: cleanPhone,
        name: name || 'Customer',
        email: null,
      },
    });

  } catch (authErr) {
    console.error('[OTP Auth] Verification error:', authErr);
    return res.status(500).json({
      error: 'AUTH_FAILED',
      message: 'Failed to complete mobile authentication. Please try again.',
    });
  }
});

/**
 * GET /api/auth/otp/status
 * Informational endpoint reporting current external SMS provider configuration
 */
router.get('/status', (req, res) => {
  const config = getProviderConfig();
  res.json({
    providerConfigured: config.provider !== 'none',
    providerName: config.provider,
  });
});

router.router = router;
module.exports = router;
