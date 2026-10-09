// Runs the matches sync right after a production deploy, so a fix to the
// sync is proven on real data within minutes instead of at the next 03:10
// cron — with nobody having to press anything.
//
// Netlify calls a function named deploy-succeeded on every successful
// deploy (it signs the event; outside callers can't reach it). Deploy
// previews are skipped, and so is any deploy within MIN_GAP_H of a run that
// finished complete, so a busy day of deploys can't spend the credits
// several times. A run that left players behind doesn't count: the next
// deploy picks up where it stopped.
//
// Same hand-off as sync-matches-cron: a single-use nonce in Firestore, then
// an HTTP call to the background worker.

const admin = require('firebase-admin');
const crypto = require('crypto');

const MIN_GAP_H = 20;
// Noam Barzilai is the player this pipeline was verified on; putting him
// first only changes the order, and costs nothing once he is synced. His
// record is in English, so both spellings.
const FIRST = 'Barzilai|ברזילי';

function getDb() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  return admin.firestore();
}

exports.handler = async (event) => {
  let payload = {};
  try { payload = JSON.parse(event.body || '{}').payload || {}; } catch { payload = {}; }
  if (payload.context && payload.context !== 'production') {
    return { statusCode: 200, body: `skipped: ${payload.context}` };
  }

  const db = getDb();
  const status = (await db.collection('app_meta').doc('syncStatus').get()).data() || {};
  const finished = status.finishedAt?.toDate?.()?.getTime?.() || 0;
  const complete = status.lastResult && !status.lastResult.partial;
  if (complete && Date.now() - finished < MIN_GAP_H * 3600000) {
    return { statusCode: 200, body: 'skipped: a sync finished recently' };
  }

  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  const nonce = crypto.randomBytes(24).toString('hex');
  await db.collection('app_meta').doc('syncTrigger').set({
    nonce,
    issuedAt: admin.firestore.Timestamp.now(),
  });
  const res = await fetch(`${base}/.netlify/functions/sync-matches-background?first=${encodeURIComponent(FIRST)}`, {
    method: 'POST',
    headers: { 'x-sync-nonce': nonce },
  });
  console.log(`[deploy-succeeded] sync triggered: ${res.status}`);
  return { statusCode: 200, body: `triggered: ${res.status}` };
};
