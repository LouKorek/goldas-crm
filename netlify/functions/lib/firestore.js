// One firebase-admin app for every function (was copied into each file).
const admin = require('firebase-admin');

let _db;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  _db = admin.firestore();
  return _db;
}

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'lou.korek@gmail.com').toLowerCase();

module.exports = { admin, getDb, OWNER_EMAIL };
