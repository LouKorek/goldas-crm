// Nightly trigger for the match-fixture sync.
//
// Until now the sync only ran when Lou pressed Sync Now — the file comment in
// sync-matches-background.js promised a cron that was never actually written.
// This is it. Same shape as tm-watch-cron / ig-watch-cron: background
// functions and schedule() don't mix reliably, so the scheduled function just
// kicks the background worker over HTTP and returns.
//
// The worker is owner-authenticated, and a cron has no Firebase ID token. So
// we mint a single-use nonce in Firestore first and hand it over in a header;
// only the service-account key can write there, and the worker deletes the
// nonce the moment it reads it.
//
// 03:10 UTC = 05:10/06:10 Israel — fixtures are current before Lou's morning.

const { schedule } = require('@netlify/functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

function getDb() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  return admin.firestore();
}

exports.handler = schedule('10 3 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const nonce = crypto.randomBytes(24).toString('hex');
    await getDb().collection('app_meta').doc('syncTrigger').set({
      nonce,
      issuedAt: admin.firestore.Timestamp.now(),
    });
    const res = await fetch(`${base}/.netlify/functions/sync-matches-background`, {
      method: 'POST',
      headers: { 'x-sync-nonce': nonce },
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
