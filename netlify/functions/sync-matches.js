// Daily auto-sync of match fixtures for represented players.
//
// Runs on Netlify's scheduler (06:00 UTC) and is also invokable from the
// Matches screen via the Sync Now button (admin only — verified with a
// Firebase ID token).
//
// PHASE 2: SofaScore client is fully wired. 365 and IFA clients are stubs
// that return [] for now — they'll be added in the next phases. The pipeline
// already handles routing, fallbacks, caching team IDs, upserts by
// (source, sourceMatchId), and unlinking a player from future auto matches
// when their team no longer matches the latest fetch (e.g., after a transfer).

const { schedule } = require('@netlify/functions');
const admin        = require('firebase-admin');

const OWNER_EMAIL = 'lou.korek@gmail.com';
const TZ          = 'Asia/Jerusalem';

// Per-page caps for paged event endpoints. 5 pages × ~10 events ≈ a full
// season per direction (last + next). Keeps total runtime safely under the
// 30-second scheduled-function budget for ~15 represented players.
const MAX_PAGES = 5;

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

// ───────────────────── Helpers ─────────────────────
function toLocalDateTime(utcSeconds) {
  if (!utcSeconds) return { date: '', time: '' };
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcSeconds * 1000));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
function deriveSeason(dateStr) {
  // Football season runs Aug → Jul. "2025-26" means Aug 2025 → Jul 2026.
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// ───────────────────── Routing ─────────────────────
function decideSources(p) {
  const country  = (p.leagueCountry || '').trim().toLowerCase();
  const isIsrael = country === 'israel';
  const isWomen  = p.gender === 'Women';
  const isYouth  = !!p.currentClubIsYouth;
  const tier     = (p.leagueTier || '').toLowerCase();
  const isTopTwo = ['tier 1', 'tier 2', '1st', '2nd'].includes(tier);

  if (isIsrael) {
    if (isWomen || isYouth || !isTopTwo) return ['ifa'];
    return ['365'];
  }
  if (isWomen) return ['sofascore'];
  return ['365', 'sofascore'];
}

// ───────────────────── SofaScore client ─────────────────────
const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; goldas-crm-sync/1.0)',
  'Accept': 'application/json',
};

async function sofascoreSearchTeam(name, hints = {}) {
  if (!name || name.trim().length < 2) return [];
  try {
    const res = await fetch(`${SOFA_BASE}/search/teams/${encodeURIComponent(name.trim())}`, { headers: SOFA_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = (data.teams || []).map((t) => ({
      id: t.id,
      name: t.name,
      country: t.country?.name,
      gender: t.gender,         // 'M' | 'F'
      slug: t.slug,
    }));
    // Prefer teams matching the player's gender + country if hints provided.
    let pref = raw;
    if (hints.gender) {
      const wantedG = hints.gender === 'Women' ? 'F' : 'M';
      const byG = pref.filter((t) => t.gender === wantedG);
      if (byG.length) pref = byG;
    }
    if (hints.country) {
      const wantedC = hints.country.toLowerCase();
      const byC = pref.filter((t) => (t.country || '').toLowerCase() === wantedC);
      if (byC.length) pref = byC;
    }
    return pref;
  } catch (e) {
    console.error('SofaScore search error:', e.message);
    return [];
  }
}

async function sofascoreFetchFixtures(teamId, fromDateMs) {
  if (!teamId) return [];
  const events = [];
  for (const phase of ['last', 'next']) {
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        const res = await fetch(`${SOFA_BASE}/team/${teamId}/events/${phase}/${page}`, { headers: SOFA_HEADERS });
        if (!res.ok) break;
        const data = await res.json();
        if (!data.events || !data.events.length) break;
        events.push(...data.events);
        if (!data.hasNextPage) break;
        if (phase === 'last') {
          const oldestMs = Math.min(...data.events.map((e) => (e.startTimestamp || 0) * 1000));
          if (oldestMs < fromDateMs) break;
        }
      } catch (e) {
        console.error('SofaScore events error:', e.message);
        break;
      }
    }
  }
  // Dedup + window-filter + normalise
  const seen = new Set();
  return events
    .filter((e) => {
      if (!e.id || seen.has(e.id)) return false;
      seen.add(e.id);
      return e.startTimestamp && e.startTimestamp * 1000 >= fromDateMs;
    })
    .map((e) => {
      const dt = toLocalDateTime(e.startTimestamp);
      return {
        source: 'sofascore',
        sourceMatchId: String(e.id),
        sourceTeamId: String(teamId),
        date: dt.date,
        time: dt.time,
        homeTeam: e.homeTeam?.name || '',
        awayTeam: e.awayTeam?.name || '',
        stadiumName: e.venue?.stadium?.name || '',
        season: deriveSeason(dt.date),
      };
    });
}

// ───────────────────── 365 + IFA stubs ─────────────────────
async function stubSearchTeam() { return []; }
async function stubFetchFixtures() { return []; }

const SOURCE_CLIENTS = {
  sofascore: { searchTeam: sofascoreSearchTeam, fetchFixtures: sofascoreFetchFixtures },
  '365':     { searchTeam: stubSearchTeam,      fetchFixtures: stubFetchFixtures },
  ifa:       { searchTeam: stubSearchTeam,      fetchFixtures: stubFetchFixtures },
};

// ───────────────────── Resolve team ID with caching ─────────────────────
async function resolveTeamId(db, player, source) {
  const cached    = player.autoFetch?.teamIds?.[source];
  const cachedFor = player.autoFetch?.cachedClubs?.[source];
  if (cached && cachedFor === player.currentClub) return cached;

  const client = SOURCE_CLIENTS[source];
  const teams = await client.searchTeam(player.currentClub, {
    country: player.leagueCountry,
    gender:  player.gender,
  });
  if (!teams.length) return null;
  const pick = teams[0].id;

  await db.collection('players').doc(player.id).set({
    autoFetch: {
      teamIds:     { [source]: String(pick) },
      cachedClubs: { [source]: player.currentClub },
      lastSyncAt:  admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  return String(pick);
}

// ───────────────────── Upsert + cleanup ─────────────────────
async function syncMatchesForPlayer(db, player, source, fetched) {
  const col = db.collection('matches');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  // Existing auto matches where THIS player is currently linked.
  const existSnap = await col.where('source', '==', source)
    .where('linkedPlayers', 'array-contains', player.id).get();
  const existing = new Map();
  existSnap.forEach((d) => existing.set(d.data().sourceMatchId, { ref: d.ref, data: d.data() }));

  const fetchedIds = new Set(fetched.map((m) => m.sourceMatchId));
  let upserts = 0, removed = 0;

  // Cleanup: future auto matches not in current fetch → player moved on.
  for (const [smid, info] of existing) {
    const m = info.data;
    if (m.date && m.date >= todayStr && !fetchedIds.has(smid)) {
      const newLinked = (m.linkedPlayers || []).filter((id) => id !== player.id);
      if (newLinked.length === 0) await info.ref.delete();
      else await info.ref.update({ linkedPlayers: newLinked, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      removed++;
    }
  }

  // Upsert each fetched match.
  for (const fm of fetched) {
    const ex = existing.get(fm.sourceMatchId);
    if (ex) {
      const linked = new Set(ex.data.linkedPlayers || []);
      linked.add(player.id);
      await ex.ref.update({
        date: fm.date, time: fm.time,
        homeTeam: fm.homeTeam, awayTeam: fm.awayTeam,
        stadiumName: fm.stadiumName,
        sourceTeamId: fm.sourceTeamId,
        season: fm.season,
        linkedPlayers: Array.from(linked),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // Maybe another player already created this same match — link instead.
      const otherSnap = await col.where('source', '==', source)
        .where('sourceMatchId', '==', fm.sourceMatchId).limit(1).get();
      if (!otherSnap.empty) {
        const ref = otherSnap.docs[0].ref;
        const linked = new Set(otherSnap.docs[0].data().linkedPlayers || []);
        linked.add(player.id);
        await ref.update({
          linkedPlayers: Array.from(linked),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await col.add({
          source,
          sourceMatchId:  fm.sourceMatchId,
          sourceTeamId:   fm.sourceTeamId,
          date:           fm.date,
          time:           fm.time,
          homeTeam:       fm.homeTeam,
          homeTeamIsYouth: false,
          awayTeam:       fm.awayTeam,
          awayTeamIsYouth: false,
          stadiumName:    fm.stadiumName,
          stadiumPlaceId: '',
          stadiumMapsUrl: '',
          notes:          '',
          season:         fm.season,
          linkedPlayers:  [player.id],
          createdAt:      admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
          lastFetchedAt:  admin.firestore.FieldValue.serverTimestamp(),
          createdBy:      'sync',
          lastEditedBy:   'sync',
          lastEditedByName: 'Auto-sync',
        });
      }
    }
    upserts++;
  }

  return { upserts, removed };
}

// ───────────────────── Main routine ─────────────────────
async function runSync() {
  const db = getDb();
  const playersSnap = await db.collection('players').get();
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Retain window: from start of last season (~Aug last year) onwards.
  const now = new Date();
  const fromDate = new Date(now.getFullYear() - 1, 7, 1); // Aug 1, prev year
  const fromDateMs = fromDate.getTime();

  const stats = { totalPlayers: players.length, processed: 0, upserts: 0, removed: 0, perSource: {} };
  const warnings = [];

  for (const p of players) {
    try {
      const sources = decideSources(p);
      if (!sources.length) {
        warnings.push({ playerId: p.id, name: p.fullName, reason: 'no-source' });
        continue;
      }
      if (!p.currentClub) {
        warnings.push({ playerId: p.id, name: p.fullName, reason: 'no-club' });
        continue;
      }

      let success = null;
      for (const source of sources) {
        const teamId = await resolveTeamId(db, p, source);
        if (!teamId) continue;
        const fixtures = await SOURCE_CLIENTS[source].fetchFixtures(teamId, fromDateMs);
        if (!fixtures.length) continue;
        const { upserts, removed } = await syncMatchesForPlayer(db, p, source, fixtures);
        stats.upserts += upserts; stats.removed += removed;
        stats.perSource[source] = (stats.perSource[source] || 0) + 1;
        success = source;
        break;
      }
      if (success) stats.processed++;
      else warnings.push({ playerId: p.id, name: p.fullName, club: p.currentClub, reason: 'no-fixtures-or-team-not-found', triedSources: sources });
    } catch (e) {
      console.error(`Sync error for ${p.fullName}:`, e);
      warnings.push({ playerId: p.id, name: p.fullName, reason: 'error', message: String(e?.message || e) });
    }
  }

  await db.collection('app_meta').doc('syncWarnings').set({
    list: warnings,
    runAt: admin.firestore.FieldValue.serverTimestamp(),
    stats,
  });

  console.log('Sync complete:', JSON.stringify(stats), 'warnings:', warnings.length);
  return {
    ok: true,
    message: `Synced ${stats.processed}/${stats.totalPlayers} players · ${stats.upserts} match upserts · ${stats.removed} cleanups · ${warnings.length} warnings`,
    stats,
    warnings,
  };
}

// ───────────────────── Handler (scheduled + HTTP) ─────────────────────
exports.handler = schedule('0 6 * * *', async (event) => {
  getDb();

  const isHttp = event && event.httpMethod;
  if (isHttp) {
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = auth.replace(/^Bearer /i, '').trim();
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'No auth token' }) };
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
      body: JSON.stringify({ error: String(e?.message || e) }),
    };
  }
});
