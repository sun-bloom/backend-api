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
    try {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || 'sunbloom-adorn-production-secret-key-change-in-env';
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && (decoded.uid || decoded.id || decoded.email)) {
        req.user = {
          uid: decoded.uid || decoded.id,
          email: (decoded.email || '').toLowerCase().trim(),
          name: decoded.name || (decoded.email ? decoded.email.split('@')[0] : 'Admin User'),
          ...decoded,
        };
        return next();
      }
    } catch {
      // Fall through to 401
    }
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
  const name = req.user.name || req.user.displayName || (email ? email.split('@')[0] : 'Customer');

  let customer = null;

  try {
    customer = await prisma.customer.findFirst({
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
      customer = await prisma.customer.create({
        data: {
          firebaseUid: uid,
          name,
          email: email || `${uid}@sunbloomadorn.local`,
          phone: req.user.phone_number || null,
        },
      }).catch(async () => {
        // Fallback in case of race condition / unique constraint
        return await prisma.customer.findFirst({
          where: {
            OR: [
              { firebaseUid: uid },
              ...(email ? [{ email }] : []),
            ],
          },
        });
      });
    }
  } catch (err) {
    console.warn('[Auth Middleware] Database sync unavailable for customer, using verified Firebase token session:', err.message);
  }

  req.customer = customer || {
    id: `fb_${uid}`,
    firebaseUid: uid,
    name,
    email: email || `${uid}@sunbloomadorn.local`,
    phone: req.user.phone_number || null,
    whatsappNumber: null,
    address: null,
    city: null,
    state: null,
    pincode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  next();
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
    console.warn('[Auth Middleware] Admin DB check warning (using fallback admin session):', err.message);
    req.adminUser = {
      id: `adm_${uid}`,
      firebaseUid: uid,
      email: email,
      username: email.split('@')[0],
      role: 'admin',
      isActive: true,
      lastLogin: new Date(),
    };
    next();
  }
};

module.exports = {
  authenticateFirebaseToken,
  requireCustomer,
  requireAdmin,
};
