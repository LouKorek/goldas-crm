// Read-only: the last result ifa-probe-background left in app_meta/ifaProbe.
// Kept separate because a background function answers 202 and nothing else.
const admin = require('firebase-admin');

exports.handler = async () => {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  const snap = await admin.firestore().collection('app_meta').doc('ifaProbe').get();
  const d = snap.exists ? snap.data() : { note: 'no probe has run yet' };
  const ts = (v) => v?.toDate?.()?.toISOString?.() || v || null;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...d, at: ts(d.at), lastChargedAt: ts(d.lastChargedAt) }, null, 2),
  };
};
