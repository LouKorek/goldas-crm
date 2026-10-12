// Every scheduled or background run is recorded in the `jobs` collection,
// so the admin screen can show what ran, when, how long, and why it failed,
// instead of that living only in Netlify's real-time log.
//
//   await runJob('tm-watch', async (job) => { job.note('50 queries'); return { found: 3 }; });
//
// The returned value (small, JSON-able) is stored as the summary. Errors are
// recorded and re-thrown. Runs older than KEEP_DAYS are pruned opportunistically.
const { admin, getDb } = require('./firestore.js');

const KEEP_DAYS = 60;

async function runJob(name, fn, meta = {}) {
  const db = getDb();
  const ref = db.collection('jobs').doc();
  const t0 = Date.now();
  const notes = [];
  await ref.set({
    name, status: 'running', startedAt: admin.firestore.Timestamp.now(), notes, ...meta,
  });
  const job = { id: ref.id, note: (s) => { if (notes.length < 200) notes.push(String(s).slice(0, 500)); } };
  try {
    const summary = await fn(job);
    await ref.set({
      status: 'ok', finishedAt: admin.firestore.Timestamp.now(), durationMs: Date.now() - t0,
      notes, summary: trim(summary),
    }, { merge: true });
    prune(db).catch(() => {});
    return summary;
  } catch (e) {
    await ref.set({
      status: 'error', finishedAt: admin.firestore.Timestamp.now(), durationMs: Date.now() - t0,
      notes, error: String(e && e.message || e).slice(0, 2000),
    }, { merge: true }).catch(() => {});
    throw e;
  }
}

// Keep summaries small: Firestore documents are capped at 1 MB.
function trim(v) {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    return s.length > 50000 ? { truncated: true, preview: s.slice(0, 50000) } : JSON.parse(s);
  } catch { return String(v).slice(0, 1000); }
}

async function prune(db) {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - KEEP_DAYS * 86400000);
  const old = await db.collection('jobs').where('startedAt', '<', cutoff).limit(100).get();
  if (old.empty) return;
  const batch = db.batch();
  old.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

module.exports = { runJob, KEEP_DAYS };
