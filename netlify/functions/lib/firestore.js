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

/** True for a live document (not in the recycle bin). */
const isLive = (data) => !(data && data.deletedAt);

/**
 * The represented players, as `{ id, ...data }`, skipping recycle-bin items.
 * Since the model unification, `players` also holds candidates (stage
 * tracking / in_process / not_relevant); a record without a stage is a
 * pre-migration represented player. Every server reader that used to call
 * `db.collection('players').get()` for the represented list goes through
 * here, so the cron jobs and Golda never pick a candidate up by mistake.
 */
async function listRepresented(db = getDb()) {
  const snap = await db.collection('players').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => isLive(p) && (!p.stage || p.stage === 'represented'));
}

module.exports = { admin, getDb, OWNER_EMAIL, isLive, listRepresented };
