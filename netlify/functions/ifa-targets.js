// What the browser sync should read from football.org.il, and what its last
// run did. Called by public/tools/ifa-browser-sync.js from a tab on this site
// (same origin), with the shared secret.
//
//   GET /.netlify/functions/ifa-targets            → the players to read
//   GET /.netlify/functions/ifa-targets?report=1   → the last import's report
//
// A target is every player the server sync would send to IFA: an Israeli
// player with an IFA link and a current club. Its team is included when it is
// already known (a team link, a pin, or a resolution from this season for the
// same club), so the browser reads one page for him instead of four.

const { _lib } = require('./sync-matches-background.js');
const { checkSyncSecret } = require('./lib/ifa-sync-auth.js');

const { getDb, decideSources, seasonStartMs, IFA_TEAM_PINS } = _lib;
const CLUB_INDEX_TTL_DAYS = 30;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function targetFor(p) {
  if (!decideSources(p).includes('ifa') || !p.ifaTeamUrl || !p.currentClub) return null;
  let u;
  try { u = new URL(p.ifaTeamUrl); } catch { return { id: p.id, name: p.fullName, error: 'ifa-url-invalid' }; }
  if (!u.hostname.endsWith('football.org.il')) return { id: p.id, name: p.fullName, error: 'ifa-url-invalid' };
  const prefix = u.pathname.match(/^\/[a-z]{2}\//)?.[0] || '/';
  const base = { id: p.id, name: p.fullName, club: p.currentClub, gender: p.gender || '', prefix };

  const directTeamId = u.searchParams.get('team_id');
  if (directTeamId) return { ...base, teamId: directTeamId, teamFrom: 'link' };
  const playerId = u.searchParams.get('player_id');
  if (!playerId) return { ...base, error: 'ifa-url-has-no-id' };

  const cache = p.autoFetch?.ifa;
  const resolvedMs = cache?.resolvedAt ? new Date(cache.resolvedAt).getTime() : 0;
  if (cache?.teamId && cache.playerId === playerId && cache.forClub === p.currentClub
      && resolvedMs >= seasonStartMs()) {
    return { ...base, playerId, teamId: String(cache.teamId), teamFrom: 'cache' };
  }
  const pin = IFA_TEAM_PINS[playerId];
  if (pin?.teamId && (!pin.forClub || pin.forClub === p.currentClub)) {
    return { ...base, playerId, teamId: String(pin.teamId), teamFrom: 'pin' };
  }
  return { ...base, playerId, teamId: null, teamFrom: null };
}

exports.handler = async (event) => {
  const auth = checkSyncSecret(event);
  if (!auth.ok) return json(auth.statusCode, { error: auth.error });
  const db = getDb();
  const q = event.queryStringParameters || {};

  if (q.report) {
    const doc = (await db.collection('app_meta').doc('ifaBrowserSync').get()).data() || null;
    const iso = (t) => t?.toDate?.()?.toISOString?.() || null;
    return json(200, doc ? {
      ...doc,
      lastRunAt: iso(doc.lastRunAt), lastSuccessAt: iso(doc.lastSuccessAt),
      lastDryRunAt: iso(doc.lastDryRunAt),
    } : null);
  }

  const snap = await db.collection('players').get();
  const targets = snap.docs.map((d) => targetFor({ id: d.id, ...d.data() })).filter(Boolean);

  // The club register barely changes; hand over the stored copy when it is
  // fresh so the browser can skip that page.
  let clubIndex = null;
  try {
    const ci = (await db.collection('app_meta').doc('ifaClubIndex').get()).data();
    const ageMs = ci?.fetchedAt ? Date.now() - ci.fetchedAt.toDate().getTime() : Infinity;
    if (ci?.clubs?.length && ageMs < CLUB_INDEX_TTL_DAYS * 86400000) clubIndex = ci.clubs;
  } catch (e) { console.error('ifaClubIndex read failed:', e.message); }

  return json(200, { at: new Date().toISOString(), targets, clubIndex });
};
