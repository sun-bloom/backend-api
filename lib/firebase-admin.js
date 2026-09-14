// lib/firebase-admin.js
// Server-side Firebase Admin SDK initialization using environment variables.

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth: getFirebaseAuth } = require('firebase-admin/auth');

let firebaseApp;

function getFirebaseAdmin() {
  if (!firebaseApp) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';
    const privateKey = rawKey.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      console.warn('[Firebase Admin] Missing server-side credentials. Firebase Admin authentication will not function until credentials are provided.');
      return null;
    }

    try {
      if (getApps().length === 0) {
        firebaseApp = initializeApp({
          credential: cert({
            projectId,
            clientEmail,
            privateKey,
          }),
        });
        console.log('[Firebase Admin] Initialized successfully for project:', projectId);
      } else {
        firebaseApp = getApps()[0];
      }
    } catch (err) {
      console.error('[Firebase Admin] Initialization error:', err.message);
      return null;
    }
  }

  return firebaseApp;
}

const getAuth = () => {
  const app = getFirebaseAdmin();
  return app ? getFirebaseAuth(app) : null;
};

module.exports = {
  getFirebaseAdmin,
  getAuth,
};
