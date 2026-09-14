// middleware/auth.middleware.js
// Firebase Authentication & Role-Based Authorization Middleware

const { getAuth } = require('../lib/firebase-admin');

/**
 * Verifies Firebase ID Token from Authorization header.
 * Attaches decoded token to req.user.
 */
const authenticateFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required. Bearer token missing.' });
  }

  const auth = getAuth();
  if (!auth) {
    return res.status(500).json({ error: 'CONFIG_ERROR', message: 'Firebase Admin authentication is not configured on the server.' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (err) {
    console.warn('[Auth Middleware] Token verification failed:', err.message);
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Invalid or expired authentication token.' });
  }
};

/**
 * Requires verified Firebase Customer identity.
 * Finds or synchronizes PostgreSQL Customer record linked to firebaseUid.
 */
const requireCustomer = async (req, res, next) => {
  if (!req.user || !req.user.uid) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  const prisma = req.app.locals.prisma;
  const uid = req.user.uid;
  const email = (req.user.email || '').toLowerCase().trim();
  const name = req.user.name || req.user.displayName || email.split('@')[0] || 'Customer';

  try {
    let customer = await prisma.customer.findFirst({
      where: {
        OR: [
          { firebaseUid: uid },
          ...(email ? [{ email }] : []),
        ],
      },
    });

    if (customer) {
      // Link firebaseUid if previously matched by email
      if (!customer.firebaseUid) {
        customer = await prisma.customer.update({
          where: { id: customer.id },
          data: { firebaseUid: uid },
        });
      }
    } else {
      // Atomic get-or-create to handle concurrent first logins
      customer = await prisma.customer.upsert({
        where: { firebaseUid: uid },
        update: {},
        create: {
          firebaseUid: uid,
          name,
          email: email || `${uid}@sunbloomadorn.local`,
          phone: req.user.phone_number || null,
        },
      });
    }

    req.customer = customer;
    next();
  } catch (err) {
    console.error('[Auth Middleware] Customer sync error:', err.message);
    return res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to synchronize customer record.' });
  }
};

/**
 * Requires verified Admin User identity.
 * Validates against PostgreSQL AdminUser table (role === 'admin' and isActive === true).
 */
const requireAdmin = async (req, res, next) => {
  if (!req.user || !req.user.uid) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  const prisma = req.app.locals.prisma;
  const uid = req.user.uid;
  const email = (req.user.email || '').toLowerCase().trim();

  const ALLOWED_ADMIN_EMAILS = ['sunbloomadornwork@gmail.com', 'skavinraj.dev@gmail.com'];
  if (!ALLOWED_ADMIN_EMAILS.includes(email)) {
    console.warn(`[Auth Middleware] Unauthorized admin access attempt by: ${email || uid}`);
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: `Access denied (${email || 'unknown'}). Only authorized admin accounts are permitted to access the admin portal.`,
    });
  }

  try {
    let adminUser = await prisma.adminUser.findFirst({
      where: {
        OR: [
          { firebaseUid: uid },
          { email: email },
        ],
        isActive: true,
      },
    });

    if (!adminUser) {
      // Auto-provision or activate the designated admin user if not present
      adminUser = await prisma.adminUser.upsert({
        where: { email: email },
        update: {
          firebaseUid: uid,
          role: 'admin',
          isActive: true,
          lastLogin: new Date(),
        },
        create: {
          email: email,
          firebaseUid: uid,
          username: email.split('@')[0],
          role: 'admin',
          isActive: true,
          lastLogin: new Date(),
        },
      });
    } else {
      adminUser = await prisma.adminUser.update({
        where: { id: adminUser.id },
        data: {
          firebaseUid: uid,
          role: 'admin',
          lastLogin: new Date(),
        },
      });
    }

    req.adminUser = adminUser;
    next();
  } catch (err) {
    console.error('[Auth Middleware] Admin authorization check error:', err.message);
    return res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to verify admin authorization.' });
  }
};

module.exports = {
  authenticateFirebaseToken,
  requireCustomer,
  requireAdmin,
};
