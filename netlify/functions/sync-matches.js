// Daily auto-sync of match fixtures for represented players.
//
// Runs on Netlify's scheduler (06:00 UTC) and can also be triggered manually
// from the Matches screen via the Sync Now button (admin only — verified with
// a Firebase ID token).
//
// PHASE 1 (this file): wiring + auth + routing decisions are in place. The
// actual source clients (IFA scrape, 365scores, SofaScore) will be added in
// the next phases and plugged in at the TODO marker.

const { schedule } = require('@netlify/functions');
const admin        = require('firebase-admin');

const OWNER_EMAIL = 'lou.korek@gmail.com';

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

// ───────────────────── Source routing ─────────────────────
// Returns an ordered list of sources to try for a given represented player.
// Empty array = no source available → no matches will be created.
function decideSources(p) {
  const country  = (p.leagueCountry || '').trim().toLowerCase();
  const isIsrael = country === 'israel';
  const isWomen  = p.gender === 'Women';
  const isYouth  = !!p.currentClubIsYouth;
  // Tier value can be stored either as 'Tier 1' / 'Tier 2' / ... (constants)
  // or '1st' / '2nd' / ... (ChipGroup labels) depending on the save path.
  const tier     = (p.leagueTier || '').toLowerCase();
  const isTopTwo = ['tier 1', 'tier 2', '1st', '2nd'].includes(tier);

  if (isIsrael) {
    if (isWomen || isYouth || !isTopTwo) return ['ifa'];
    return ['365'];
  }
  if (isWomen) return ['sofascore'];
  return ['365', 'sofascore']; // try 365 first, then fall back to SofaScore
}

// ───────────────────── Main sync routine ─────────────────────
async function runSync() {
  const db = getDb();
  const playersSnap = await db.collection('players').get();
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const routing = players.map((p) => ({
    id: p.id,
    name: p.fullName || '(unnamed)',
    club: p.currentClub || '(no club)',
    country: p.leagueCountry || '',
    tier: p.leagueTier || '',
    gender: p.gender || '',
    youth: !!p.currentClubIsYouth,
    sources: decideSources(p),
  }));

  // TODO Phase 2/3 — for each routing entry:
  //   1. resolve external Team ID for the chosen source (cache on player doc)
  //   2. fetch fixtures for current + previous season
  //   3. upsert matches in Firestore by (source, sourceMatchId)
  //   4. remove the player from any auto match (future only) whose source
  //      team no longer matches their current club
  //   5. on "team not found" → write a warning to app_meta.syncWarnings

  console.log(`Sync routing computed for ${players.length} player(s).`);
  console.log(JSON.stringify(routing, null, 2));

  const noSource = routing.filter((r) => r.sources.length === 0);
  const summary = {
    totalPlayers: players.length,
    bySource: routing.reduce((acc, r) => {
      const key = r.sources.join('→') || 'none';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    withoutSource: noSource.length,
  };

  return {
    ok: true,
    phase: 1,
    message: `Routing ready for ${players.length} player(s). Source clients will be added in the next phase.`,
    summary,
    routing,
  };
}

// ───────────────────── Handler (scheduled + HTTP) ─────────────────────
exports.handler = schedule('0 6 * * *', async (event) => {
  // Ensure Firebase Admin is up before we use admin.auth() to verify a token.
  getDb();

  // For HTTP invocations from the Sync Now button, require a valid ID token
  // from the owner. Scheduled invocations skip this — they have no headers.
  const isHttp = event && event.httpMethod;
  if (isHttp) {
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = auth.replace(/^Bearer /i, '').trim();
    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'No auth token' }) };
    }
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      if ((decoded.email || '').toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
      }
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }
  }

  try {
    const result = await runSync();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (e) {
    console.error('sync-matches failed:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(e && e.message || e) }),
    };
  }
});
