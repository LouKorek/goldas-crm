// Data migrations of the new model, for the admin screen and the deploy hook.
//
//   GET  /.netlify/functions/migrate?dry=1   plan every pending migration and
//                                            return its report, writing nothing
//   GET  /.netlify/functions/migrate         the recorded status of each migration
//   POST /.netlify/functions/migrate         start migrate-background: back the
//                                            database up, then run the pending
//                                            migrations in order
//
// Admin (manage_settings) or an internal nonce. A run takes a backup first,
// so every step can be undone from backups/{id}. The run itself happens in
// migrate-background (15-minute limit); this function answers at once and the
// screen polls GET until nothing is 'running'.
const { withAuth, json, internalHeaders } = require('./lib/auth.js');
const { admin, getDb } = require('./lib/firestore.js');
const { runJob } = require('./lib/jobs.js');
const { firestoreStore } = require('./lib/migrations/store.js');
const migrations = require('./lib/migrations/index.js');
const { _runBackup } = require('./backup-weekly.js');

async function runAll(trigger) {
  const db = getDb();
  return runJob('migrate', async (job) => {
    const store = firestoreStore(db, admin);
    if (!(await migrations.hasPending(store))) { job.note('nothing pending'); return { ran: [], backup: null }; }
    const backup = await _runBackup(job);
    job.note(`backup ${backup.id}: ${backup.docs} docs`);
    const r = await migrations.run(store, { log: job.note });
    return { ...r, backup: backup.id };
  }, { trigger });
}

/** Kick off migrate-background on this site with a single-use nonce. */
async function startBackground(trigger) {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  const res = await fetch(`${base}/.netlify/functions/migrate-background?trigger=${encodeURIComponent(trigger)}`, {
    method: 'POST', headers: await internalHeaders('migrate'),
  });
  return { ok: res.status < 400, status: res.status };
}

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event, context) => {
  const db = getDb();
  const q = event.queryStringParameters || {};
  if (event.httpMethod === 'POST') {
    const store = firestoreStore(db, admin);
    if (!(await migrations.hasPending(store))) return json(200, { started: false, migrations: await migrations.status(store) });
    const r = await startBackground(context.auth.via === 'user' ? context.auth.user.email : 'internal');
    return json(r.ok ? 202 : 502, { started: r.ok, status: r.status });
  }
  const store = firestoreStore(db, admin);
  const rows = q.dry ? await migrations.dryRun(store) : await migrations.status(store);
  return json(200, { migrations: rows });
});

exports._runAll = runAll;
exports._startBackground = startBackground;
