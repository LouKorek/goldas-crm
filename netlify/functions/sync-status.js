// Read-only health check for the matches sync, readable without signing in
// so a run can be verified from anywhere (a script, a phone) without the
// Firebase console. It shows timings, counts and reasons only: no player
// names, no fixtures, no keys.
//
//   /.netlify/functions/sync-status
//   &player=<name fragment>   also: how many upcoming auto-synced matches
//                             are linked to the matching player(s)

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  return admin.firestore();
}

const ts = (v) => v?.toDate?.()?.toISOString?.() || null;

exports.handler = async (event) => {
  const db = getDb();
  const q = event.queryStringParameters || {};
  const [status, warnings, strategy] = await Promise.all(
    ['syncStatus', 'syncWarnings', 'ifaStrategy'].map((id) => db.collection('app_meta').doc(id).get()));
  const s = status.data() || {};
  const w = warnings.data() || {};
  const reasons = {};
  for (const x of w.list || []) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
  const ifa = w.stats?.ifa || {};

  const out = {
    status: { state: s.state || null, startedAt: ts(s.startedAt), finishedAt: ts(s.finishedAt), error: s.error || null },
    lastReport: {
      runAt: ts(w.runAt),
      totalPlayers: w.stats?.totalPlayers ?? null,
      processed: w.stats?.processed ?? null,
      upserts: w.stats?.upserts ?? null,
      partial: w.stats?.partial ?? null,
      durationS: w.stats?.durationS ?? null,
      reasons,
      ifa: {
        strategy: ifa.strategy ?? null, creditsAtStart: ifa.creditsAtStart ?? null,
        creditCap: ifa.creditCap ?? null, creditsSpent: ifa.creditsSpent ?? null,
        attempts: (ifa.attempts || []).map(({ bodyStart, ...a }) => a),
      },
    },
    rememberedStrategy: strategy.exists ? { strategy: strategy.data().strategy, at: ts(strategy.data().at) } : null,
  };

  if (q.player) {
    const re = new RegExp(String(q.player).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const players = (await db.collection('players').get()).docs.filter((d) => re.test(d.data().fullName || ''));
    const today = new Date().toISOString().slice(0, 10);
    out.player = [];
    for (const d of players) {
      const snap = await db.collection('matches').where('linkedPlayers', 'array-contains', d.id).get();
      const auto = snap.docs.map((m) => m.data()).filter((m) => m.source && m.createdBy === 'sync');
      out.player.push({
        matched: true,
        autoMatches: auto.length,
        upcoming: auto.filter((m) => (m.date || '') >= today).length,
        lastFetchedAt: auto.map((m) => ts(m.lastFetchedAt)).filter(Boolean).sort().pop() || null,
        ifaTeamKnown: !!d.data().autoFetch?.ifa?.teamId,
        ifaLastFixturesAt: d.data().autoFetch?.ifa?.lastFixturesAt || null,
      });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(out, null, 2),
  };
};
