// Data migrations of the new model. Each migration plans its writes from the
// current data (pure: no write happens while planning), so the admin screen
// can show exactly what will change before anything runs, and the same plan
// is what runs. Each is idempotent and recorded in `migrations/{id}`.
//
//   status(store)        → [{ id, title, status, ranAt, report }]
//   dryRun(store)        → the same, with a fresh report for every pending one
//   run(store, opts)     → runs every pending migration in order; returns { migrations, ran }
const MIGRATIONS = [
  require('./001-unify-players.js'),
  require('./002-clubs.js'),
  require('./003-deals.js'),
  require('./004-golda-audit.js'),
  require('./005-golda-numbers.js'),
  require('./006-clean-matches.js'),
];

async function records(store) {
  const rows = await store.load('migrations');
  return new Map(rows.map((r) => [r.id, r]));
}

async function status(store) {
  const rec = await records(store);
  return MIGRATIONS.map((m) => {
    const r = rec.get(m.id);
    return { id: m.id, title: m.title, status: r?.status || 'pending', ranAt: r?.ranAt || null, report: r?.report || null, error: r?.error || null };
  });
}

async function dryRun(store) {
  const out = await status(store);
  for (const row of out) {
    if (row.status === 'done') continue;
    const m = MIGRATIONS.find((x) => x.id === row.id);
    try {
      const { report } = await m.plan(store);
      row.report = report;
    } catch (e) {
      row.report = { summary: `שגיאה בתכנון: ${e.message}`, notes: [] };
    }
  }
  return out;
}

async function run(store, opts = {}) {
  const { only = null, log = () => {} } = opts;
  const ran = [];
  for (const m of MIGRATIONS) {
    const rec = (await records(store)).get(m.id);
    if (rec?.status === 'done') continue;
    if (only && !only.includes(m.id)) continue;
    log(`${m.id}: planning`);
    store.set('migrations', m.id, { id: m.id, title: m.title, status: 'running', startedAt: store.now() });
    await store.flush();
    try {
      const { report, writes } = await m.plan(store);
      for (const [col, docId, data, merge] of writes) store.set(col, docId, data, merge !== false);
      const n = await store.flush();
      store.set('migrations', m.id, { status: 'done', ranAt: store.now(), report, writes: n, error: null });
      await store.flush();
      log(`${m.id}: ${n} writes`);
      ran.push({ id: m.id, writes: n, summary: report.summary });
    } catch (e) {
      store.set('migrations', m.id, { status: 'error', ranAt: store.now(), error: String(e && e.message || e).slice(0, 2000) });
      await store.flush();
      throw e;
    }
  }
  return { migrations: await status(store), ran };
}

async function hasPending(store) {
  return (await status(store)).some((m) => m.status !== 'done');
}

module.exports = { MIGRATIONS, status, dryRun, run, hasPending };
