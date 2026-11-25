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

// The last run of every job, in one small document (app_meta/jobStatus), so
// the Health screen shows a weekly job's last run even after hundreds of
// hourly runs have pushed it out of the recent list. Best effort.
const remember = (db, name, fields) => db.collection('app_meta').doc('jobStatus')
  .set({ [name]: fields }, { merge: true }).catch(() => {});

async function runJob(name, fn, meta = {}) {
  const db = getDb();
  const ref = db.collection('jobs').doc();
  const t0 = Date.now();
  const notes = [];
  const startedAt = admin.firestore.Timestamp.now();
  await ref.set({
    name, status: 'running', startedAt, notes, ...meta,
  });
  await remember(db, name, { runningSince: startedAt });
  const job = { id: ref.id, note: (s) => { if (notes.length < 200) notes.push(String(s).slice(0, 500)); } };
  try {
    const summary = await fn(job);
    await ref.set({
      status: 'ok', finishedAt: admin.firestore.Timestamp.now(), durationMs: Date.now() - t0,
      notes, summary: trim(summary),
    }, { merge: true });
    await remember(db, name, { runningSince: null, last: { status: 'ok', startedAt, durationMs: Date.now() - t0, trigger: meta.trigger || null } });
    prune(db).catch(() => {});
    return summary;
  } catch (e) {
    await ref.set({
      status: 'error', finishedAt: admin.firestore.Timestamp.now(), durationMs: Date.now() - t0,
      notes, error: String(e && e.message || e).slice(0, 2000),
    }, { merge: true }).catch(() => {});
    const failed = { status: 'error', startedAt, durationMs: Date.now() - t0, trigger: meta.trigger || null, error: String(e && e.message || e).slice(0, 300) };
    await remember(db, name, { runningSince: null, last: failed, lastError: failed });
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
