// The night run of the domain engines (packages/domain/src/engines):
//   1. matching  — for every open club requirement, the best fits among the
//                  players, saved to match_scores/{requirementId};
//   2. alerts    — the full alert set, saved to app_meta/alertsSnapshot so
//                  Golda's morning briefing and the email read one list;
//   3. cleanup   — stored files no player references any more are removed.
// Age groups need no job: they follow the IFA cohort rule from the season
// (July 1), so the rollover happens on its own (ageGroups.ts).
//
// 03:00 UTC = 05:00 (winter) / 06:00 (summer) in Israel.
const { schedule } = require('@netlify/functions');
const { admin, getDb, isLive } = require('./lib/firestore.js');
const { runJob } = require('./lib/jobs.js');
const { computeAlerts, topMatches, mergeSettings } = require('@goldas/domain');

const FILE_FIELDS = ['contractFiles', 'passportFiles', 'reprFiles', 'mandateFiles', 'files'];
const ORPHAN_MIN_AGE_MS = 7 * 86400000;
const ORPHAN_BATCH = 40;

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isLive);

async function loadAll(db) {
  const [players, requirements, deals, tasks, matches, jobs, settings] = await Promise.all([
    db.collection('players').get().then(rows),
    db.collection('club_requirements').get().then(rows),
    db.collection('deals').get().then(rows),
    db.collection('tasks').get().then(rows),
    db.collection('matches').get().then(rows),
    db.collection('jobs').orderBy('startedAt', 'desc').limit(60).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('settings').doc('notifications').get().then((s) => (s.exists ? s.data() : null)),
  ]);
  return { players, requirements, deals, tasks, matches, jobs, settings: mergeSettings(settings) };
}

/** match_scores/{requirementId} ← top 5 fits of every open requirement. */
async function runMatching(db, data, job) {
  const now = new Date();
  const open = data.requirements.filter((r) => !r.status || r.status === 'open');
  const candidates = data.players.filter((p) => (p.stage || 'represented') !== 'not_relevant');
  const batch = db.batch();
  let n = 0;
  for (const r of open) {
    const top = topMatches(r, candidates, { n: 5, min: 35, now });
    batch.set(db.collection('match_scores').doc(r.id), {
      requirementId: r.id, clubName: r.clubName || '', requiredPosition: r.requiredPosition || '',
      computedAt: admin.firestore.Timestamp.now(),
      top: top.map((m) => ({ playerId: m.playerId, playerName: m.playerName, stage: m.stage, score: m.score, he: m.reasons.map((x) => x.he).join(' · '), en: m.reasons.map((x) => x.en).join(' · ') })),
    });
    n++;
  }
  // Scores of requirements that were filled, closed or deleted go away.
  const keep = new Set(open.map((r) => r.id));
  const stale = await db.collection('match_scores').get();
  stale.docs.forEach((d) => { if (!keep.has(d.id)) batch.delete(d.ref); });
  await batch.commit();
  job.note(`matching: ${n} open requirements scored`);
  return n;
}

/** app_meta/alertsSnapshot ← what needs action this morning. */
async function runAlerts(db, data, job) {
  const represented = data.players.filter((p) => !p.stage || p.stage === 'represented');
  const r = computeAlerts({ ...data, players: represented, now: new Date() });
  const slim = r.alerts.slice(0, 200).map((a) => ({ type: a.type, severity: a.severity, days: a.days, dueDate: a.dueDate, overdue: a.overdue, subject: a.subject, he: a.proof.he, en: a.proof.en }));
  const counts = Object.fromEntries(Object.entries(r.byType).map(([k, v]) => [k, v.length]));
  await db.collection('app_meta').doc('alertsSnapshot').set({ computedAt: admin.firestore.Timestamp.now(), total: r.total, counts, alerts: slim });
  job.note(`alerts: ${r.total} need action`);
  return r.total;
}

/** Remove stored files no record points to any more (older than a week). */
async function runOrphanCleanup(db, data, job) {
  const referenced = new Set();
  const collect = (doc) => { for (const f of FILE_FIELDS) for (const x of Array.isArray(doc[f]) ? doc[f] : []) if (x && x.fileId) referenced.add(String(x.fileId)); };
  data.players.forEach(collect);
  data.deals.forEach(collect);
  // Recycle-bin records still own their files; they come back with the record.
  const binned = await db.collection('players').get();
  binned.docs.forEach((d) => collect(d.data()));
  const files = await db.collection('files').get();
  const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
  const orphans = files.docs.filter((d) => {
    if (referenced.has(d.id)) return false;
    const up = new Date(d.data().uploadedAt || 0).getTime();
    return !up || up < cutoff;
  }).slice(0, ORPHAN_BATCH);
  let removed = 0;
  for (const d of orphans) {
    const chunks = await d.ref.collection('chunks').get();
    const batch = db.batch();
    chunks.docs.forEach((c) => batch.delete(c.ref));
    batch.delete(d.ref);
    await batch.commit();
    removed++;
  }
  job.note(`cleanup: ${removed} orphan files removed (${files.size} stored, ${referenced.size} referenced)`);
  return removed;
}

async function nightly(job) {
  const db = getDb();
  const data = await loadAll(db);
  const out = {};
  out.matching = await runMatching(db, data, job);
  out.alerts = await runAlerts(db, data, job);
  try { out.cleanup = await runOrphanCleanup(db, data, job); }
  catch (e) { job.note(`cleanup failed: ${e.message}`); out.cleanupError = String(e.message); }
  return out;
}

exports.handler = schedule('0 3 * * *', async () => {
  try { const r = await runJob('nightly-engines', nightly); return { statusCode: 200, body: JSON.stringify(r) }; }
  catch (e) { console.error('nightly-engines failed:', e); return { statusCode: 500, body: String(e) }; }
});
exports._internal = { runMatching, runAlerts, runOrphanCleanup };
