// Brings the agency's mail with the CRM's contacts and clubs into the CRM
// (rules and privacy in lib/mail-store.js).
//
// Called by gmail-sync-cron every 15 minutes, right after the mailbox is
// connected, and from System › Email ("sync now"). With the mailbox not
// connected it stops at once and records nothing. One run at a time: a lock
// in mail_state/sync.
//
// Env: FIREBASE_SERVICE_ACCOUNT_KEY (the database, and switching the Gmail API on).
const { getDb } = require('./lib/firestore.js');
const { withAuth } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');
const store = require('./lib/mail-store.js');
const gmailAuth = require('./lib/gmail-auth.js');

const LOCK_MS = 14 * 60 * 1000;

async function lock(db) {
  const ref = db.collection(store.STATE[0]).doc(store.STATE[1]);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const m = snap.exists ? snap.data() : {};
    if (m.lockUntil && m.lockUntil > Date.now()) return false;
    tx.set(ref, { lockUntil: Date.now() + LOCK_MS }, { merge: true });
    return true;
  });
}
const unlock = (db) => db.collection(store.STATE[0]).doc(store.STATE[1]).set({ lockUntil: 0 }, { merge: true }).catch(() => {});

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event, ctx) => {
  const db = getDb();
  const pub = await gmailAuth.publicStatus(db);
  if (!pub.connected) return { statusCode: 200, body: 'not connected' };
  if (!(await lock(db))) return { statusCode: 200, body: 'already running' };
  let reason = '';
  try { reason = String(JSON.parse(event.body || '{}').reason || ''); } catch { /* none */ }
  try {
    await runJob('gmail-sync', (job) => store.syncMailbox(db, { job, enable: () => gmailAuth.enableGmailApi(gmailAuth.serviceAccount()) }),
      { trigger: ctx.auth.via === 'user' || reason.startsWith('admin') ? 'manual' : 'schedule' });
  } catch (e) {
    console.error('[gmail-sync] failed:', e.message);
  } finally {
    await unlock(db);
  }
  return { statusCode: 200, body: 'done' };
});
