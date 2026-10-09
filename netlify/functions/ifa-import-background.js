// Publishes what the browser sync read from football.org.il.
//
// POST /.netlify/functions/ifa-import-background   (x-sync-secret header)
//   body: { payload: <what GA_SCRAPE left in window.name>, dryRun: bool }
//
// Background function: Netlify answers 202 at once and the writes happen
// after, so the report lands in app_meta/ifaBrowserSync, where
// ifa-targets?report=1 and sync-status read it.
//
// Nothing is written unless the whole scrape passes the checks below. Stale
// data on the Matches screen is much better than wrong data:
//   • no page came back as a Cloudflare challenge
//   • at least MIN_READABLE of the targets got a readable fixtures page
//   • at least MIN_FIXTURES fixtures in total (not checked in June and July,
//     when the federation has legitimately published nothing yet)
//   • the fixtures are from the current season
// And per player: someone who has upcoming matches on file and came back
// with none is left alone and reported, never wiped.

const admin = require('firebase-admin');
const { _lib } = require('./sync-matches-background.js');
const { checkSyncSecret } = require('./lib/ifa-sync-auth.js');

const { getDb, decideSources, seasonStartMs, syncMatchesForPlayer } = _lib;

const MIN_READABLE = 0.7;
const MIN_FIXTURES = 5;
const MAX_PAYLOAD_AGE_MS = 6 * 60 * 60 * 1000;

const isOffSeason = (d = new Date()) => d.getMonth() === 5 || d.getMonth() === 6;   // June, July

function cleanFixture(f, gamesUrl) {
  const str = (v, n) => String(v ?? '').slice(0, n);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f?.date || '')) return null;
  if (!f.homeTeam || !f.awayTeam) return null;
  return {
    source: 'ifa',
    sourceMatchId: str(f.sourceMatchId, 200),
    sourceTeamId: gamesUrl,
    date: f.date,
    time: /^\d{2}:\d{2}$/.test(f.time || '') ? f.time : '',
    homeTeam: str(f.homeTeam, 120),
    awayTeam: str(f.awayTeam, 120),
    stadiumName: str(f.stadiumName, 160),
    season: str(f.season, 10),
  };
}

// Every check, on the server's own reading of the payload. Returns the plan
// for each player and, when the run as a whole must not be published, why.
async function plan(db, payload) {
  const refuse = [];
  const scrapedAt = Date.parse(payload?.scrapedAt || '');
  if (payload?.kind !== 'ga-ifa' || payload.stage !== 'scraped' || !Array.isArray(payload.results)) {
    return { refuse: ['payload is not a finished scrape'], players: [] };
  }
  if (!scrapedAt || Date.now() - scrapedAt > MAX_PAYLOAD_AGE_MS) refuse.push('payload is older than 6 hours');

  const snap = await db.collection('players').get();
  const players = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const isTarget = (p) => decideSources(p).includes('ifa') && !!p.ifaTeamUrl && !!p.currentClub;
  const targets = [...players.values()].filter(isTarget);

  const blocked = Number(payload.pages?.blocked || 0);
  if (blocked > 0) refuse.push(`${blocked} page(s) came back as a Cloudflare challenge`);

  const byId = new Map(payload.results.map((r) => [r.id, r]));
  const readable = targets.filter((p) => byId.get(p.id)?.gamesOk).length;
  if (targets.length && readable / targets.length < MIN_READABLE) {
    refuse.push(`only ${readable} of ${targets.length} players got a readable fixtures page`);
  }

  const seasonStart = new Date(seasonStartMs()).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  const out = [];
  let total = 0, oldSeason = 0;
  for (const p of targets) {
    const r = byId.get(p.id);
    const gamesUrl = r?.gamesUrl && /^https:\/\/[a-z.]*football\.org\.il\//.test(r.gamesUrl) ? r.gamesUrl : '';
    const fixtures = (r?.fixtures || []).map((f) => cleanFixture(f, gamesUrl)).filter(Boolean);
    const entry = { p, r, fixtures, gamesUrl };
    if (!r) { out.push({ ...entry, action: 'skip', reason: 'ifa-not-scraped' }); continue; }
    if (r.error) { out.push({ ...entry, action: 'skip', reason: r.error, detail: r.detail }); continue; }
    if (!r.gamesOk) { out.push({ ...entry, action: 'skip', reason: 'ifa-page-unreadable' }); continue; }

    if (fixtures.length && !isOffSeason() && !fixtures.some((f) => f.date >= seasonStart)) {
      oldSeason++;
      out.push({ ...entry, action: 'skip', reason: 'ifa-old-season', detail: `latest ${fixtures.map(f => f.date).sort().pop()}` });
      continue;
    }
    if (!fixtures.length) {
      const existing = await db.collection('matches').where('source', '==', 'ifa')
        .where('linkedPlayers', 'array-contains', p.id).get();
      const upcoming = existing.docs.filter((d) => (d.data().date || '') >= todayStr).length;
      out.push({ ...entry, action: 'skip', reason: upcoming ? 'ifa-kept-existing' : 'ifa-no-fixtures-published', upcoming });
      continue;
    }
    total += fixtures.length;
    out.push({ ...entry, action: 'write' });
  }
  if (!isOffSeason() && total < MIN_FIXTURES) refuse.push(`only ${total} fixtures in total`);
  if (oldSeason && oldSeason / Math.max(1, readable) > 0.3) refuse.push(`${oldSeason} players got last season's fixtures`);
  return { refuse, players: out, total, readable, targets: targets.length };
}

function warningFor(e) {
  const p = e.p;
  return {
    playerId: p.id, name: p.fullName, club: p.currentClub, reason: e.reason,
    ...(e.detail ? { detail: String(e.detail).slice(0, 200) } : {}),
    via: 'browser',
  };
}

exports.handler = async (event) => {
  const auth = checkSyncSecret(event);
  if (!auth.ok) { console.error('[ifa-import]', auth.error); return { statusCode: auth.statusCode }; }

  const db = getDb();
  const ref = db.collection('app_meta').doc('ifaBrowserSync');
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const dryRun = !!body.dryRun;
  const payload = body.payload || {};
  const t0 = Date.now();

  const pl = await plan(db, payload);
  const perPlayer = pl.players.map((e) => ({
    name: e.p.fullName, action: e.action, reason: e.reason || null,
    fixtures: e.fixtures.length,
    upcoming: e.fixtures.filter((f) => f.date >= new Date().toISOString().slice(0, 10)).length,
    teamId: e.r?.teamId || null, teamFrom: e.r?.teamFrom || null,
    squadSeason: e.r?.resolved?.seasonLabel || null, dataSeason: e.r?.dataSeason || null,
  }));
  const summary = {
    scrapedAt: payload.scrapedAt || null, pages: payload.pages || null,
    targets: pl.targets || 0, readable: pl.readable || 0, fixtures: pl.total || 0,
    toWrite: pl.players.filter((e) => e.action === 'write').length,
    refused: pl.refuse.length ? pl.refuse : null,
  };

  if (dryRun || pl.refuse.length) {
    await ref.set({
      [dryRun ? 'lastDryRun' : 'lastRefused']: { summary, perPlayer },
      [dryRun ? 'lastDryRunAt' : 'lastRunAt']: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[ifa-import] ${dryRun ? 'dry run' : 'REFUSED'}:`, JSON.stringify(summary));
    return { statusCode: 200 };
  }

  // Publish.
  let upserts = 0, removed = 0, written = 0;
  const warnings = [];
  for (const e of pl.players) {
    if (e.action !== 'write') { warnings.push(warningFor(e)); continue; }
    try {
      const res = e.r.resolved;
      const playerId = (() => { try { return new URL(e.p.ifaTeamUrl).searchParams.get('player_id'); } catch { return null; } })();
      if (res?.teamId && playerId) {
        await db.collection('players').doc(e.p.id).set({
          autoFetch: {
            ifa: {
              playerId, teamId: String(res.teamId), clubId: res.clubId || '',
              teamName: res.teamName || '', ageGroup: res.ageGroup || '', league: res.league || '',
              seasonLabel: res.seasonLabel || '', forClub: e.p.currentClub,
              resolvedAt: new Date().toISOString(), via: 'browser',
            },
            ifaFail: admin.firestore.FieldValue.delete(),
          },
        }, { merge: true });
      }
      const r = await syncMatchesForPlayer(db, e.p, 'ifa', e.fixtures);
      upserts += r.upserts; removed += r.removed; written++;
      await db.collection('players').doc(e.p.id).set({
        autoFetch: { ifa: { lastFixturesAt: new Date().toISOString() } },
      }, { merge: true });
    } catch (err) {
      console.error(`[ifa-import] ${e.p.fullName}:`, err);
      warnings.push({ ...warningFor({ ...e, reason: 'error' }), detail: String(err?.message || err).slice(0, 200) });
    }
  }

  if (Array.isArray(payload.clubIndex) && payload.clubIndex.length && payload.clubIndexFetched) {
    await db.collection('app_meta').doc('ifaClubIndex').set({
      key: 'https://www.football.org.il/', clubs: payload.clubIndex.slice(0, 3000),
      fetchedAt: admin.firestore.Timestamp.now(),
    }).catch((err) => console.error('club index write failed:', err.message));
  }

  const stats = { ...summary, written, upserts, removed, durationS: Math.round((Date.now() - t0) / 1000) };
  await ref.set({
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
    stats, perPlayer, warnings,
    lastRefused: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  // The Matches screen reads one warnings list. Replace the Israeli players'
  // lines in it with this run's, and drop the "computer sync is quiet" line.
  const ids = new Set(pl.players.map((e) => e.p.id));
  const wref = db.collection('app_meta').doc('syncWarnings');
  const cur = (await wref.get()).data() || {};
  const kept = (cur.list || []).filter((w) => !ids.has(w.playerId) && w.playerId !== '_ifa');
  await wref.set({ ...cur, list: [...kept, ...warnings], runAt: admin.firestore.FieldValue.serverTimestamp() });

  console.log('[ifa-import] published:', JSON.stringify(stats));
  return { statusCode: 200 };
};

exports._plan = plan;
