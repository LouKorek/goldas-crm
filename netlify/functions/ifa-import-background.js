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

const { admin, listRepresented } = require('./lib/firestore.js');
const { _lib } = require('./sync-matches-background.js');
const { checkSyncSecret } = require('./lib/ifa-sync-auth.js');
const { ifaAgeGroupOf, ifaContainment, ifaNormalizeName, ifaTokens } = require('../../apps/web/public/tools/ifa-text.js');
const { resolveAgeGroup } = require('@goldas/domain');

const { getDb, decideSources, seasonStartMs, syncMatchesForPlayer } = _lib;

// Lou's rule of 13.10.2026: a squad the IFA lookup found is linked to a player
// only when it is plausibly his. Otherwise nothing is linked and the player
// gets an alert (autoFetch.ifaFail → Home / Notifications, and the Matches
// screen's sync warnings). Two checks, from data the CRM already holds:
//   • age — the squad's age group (נערים ג') against the group the player's
//     birth date puts him in this season (IFA cohort rule, manual override
//     respected). A seniors squad passes for a youth player (talents play up);
//     a youth squad that is not his cohort does not.
//   • club — when both names are Hebrew, the squad's club must be his
//     currentClub (token containment, as the lookup itself uses). A Latin
//     currentClub ("Ironi Modi'in") cannot be compared with the IFA's Hebrew,
//     so the age check carries that case.
// Squads Lou chose himself (a team link in ifaTeamUrl, or a pin) are trusted.
const YOUTH_GROUPS = new Set(['noar', 'nearim_a', 'nearim_b', 'nearim_c', 'yeladim_a', 'yeladim_b', 'yeladim_c', 'trom_a', 'trom_b', 'trom_c']);
function ifaMismatch(player, info, now = new Date()) {
  if (!info) return null;
  const squadGroup = ifaAgeGroupOf(info.ageGroup || '') || ifaAgeGroupOf(info.league || '') || ifaAgeGroupOf(info.teamLabel || '');
  if (squadGroup && YOUTH_GROUPS.has(squadGroup)) {
    const mine = resolveAgeGroup({ dob: player.dob, ageGroupOverride: player.ageGroupOverride || null }, now);
    if (!mine || mine.id !== squadGroup) {
      return { reason: 'ifa-squad-mismatch', kind: 'age', detail: `שכבת הגיל בהתאחדות "${info.ageGroup || info.league || info.teamLabel}" לא מתאימה לתאריך הלידה (${mine ? mine.he : 'בוגר'})` };
    }
  }
  const ifaClub = info.clubName || info.teamName || '';
  if (/[א-ת]/.test(player.currentClub || '') && ifaClub && ifaContainment(player.currentClub, ifaClub) < 0.5) {
    return { reason: 'ifa-squad-mismatch', kind: 'club', detail: `המועדון בהתאחדות "${ifaClub}" אינו ${player.currentClub}` };
  }
  return null;
}

// The squad information to check for a target: this run's lookup, or the
// cached resolution the browser reused (teamFrom 'cache').
function squadInfo(p, r) {
  if (r?.resolved) return r.resolved;
  const c = p.autoFetch?.ifa;
  if (c?.teamId && r?.teamId && String(c.teamId) === String(r.teamId)) return c;
  return null;
}

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
    time: /^\d{2}:\d{2}$/.test(f.time || '') && f.time !== '00:00' ? f.time : '',
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

  const players = new Map((await listRepresented(db)).map((p) => [p.id, p]));
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

    if (r.teamFrom !== 'link' && r.teamFrom !== 'pin') {
      const mm = ifaMismatch(p, squadInfo(p, r));
      if (mm) { out.push({ ...entry, action: 'skip', reason: mm.reason, detail: mm.detail, mismatch: mm }); continue; }
    }
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

function warningFor(e, via = 'browser') {
  const p = e.p;
  return {
    playerId: p.id, name: p.fullName, club: p.currentClub, reason: e.reason,
    ...(e.detail ? { detail: String(e.detail).slice(0, 200) } : {}),
    via,
  };
}

exports.handler = async (event) => {
  const auth = await checkSyncSecret(event);
  if (!auth.ok) { console.error('[ifa-import]', auth.error); return { statusCode: auth.statusCode }; }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const payload = body.payload || {};
  const r = await runImport(getDb(), payload, { dryRun: !!body.dryRun, via: viaOf(payload, 'browser') });
  return { statusCode: r.statusCode };
};

// Where a payload was read: the browser (Chrome on Lou's computer) or the
// server's own reader (lib/ifa-exa.js, via Exa). Recorded on every record and
// warning the import writes, so the admin screens can tell the two apart.
function viaOf(payload, fallback) {
  const v = String(payload?.via || '');
  return /^exa-/.test(v) ? v : fallback;
}

// The import itself: every check, then the writes. Used by the HTTP handler
// above (browser payloads) and by ifa-server-sync-background (server reads).
// Returns { statusCode, summary, stats } and never throws for a refused run.
async function runImport(db, payload, { dryRun = false, via = 'browser' } = {}) {
  const ref = db.collection('app_meta').doc('ifaBrowserSync');
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
    via, upcomingOnly: !!payload.upcomingOnly, costDollars: payload.costDollars ?? null,
  };

  if (dryRun || pl.refuse.length) {
    await ref.set({
      [dryRun ? 'lastDryRun' : 'lastRefused']: { summary, perPlayer },
      [dryRun ? 'lastDryRunAt' : 'lastRunAt']: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[ifa-import] ${dryRun ? 'dry run' : 'REFUSED'}:`, JSON.stringify(summary));
    return { statusCode: 200, summary, perPlayer, stats: null };
  }

  // Publish.
  let upserts = 0, removed = 0, written = 0;
  const warnings = [];
  const squads = new Set();
  for (const e of pl.players) {
    if (e.action !== 'write') {
      warnings.push(warningFor(e, via));
      if (e.mismatch) {
        // The alert lives on the player record (Home and Notifications read
        // players); it clears itself on the next run that passes the checks.
        await db.collection('players').doc(e.p.id).set({
          autoFetch: { ifaFail: { reason: e.reason, detail: e.detail, teamId: e.r?.teamId || null, at: new Date().toISOString(), via } },
        }, { merge: true }).catch((err) => console.error(`[ifa-import] ifaFail ${e.p.fullName}:`, err.message));
      }
      continue;
    }
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
              resolvedAt: new Date().toISOString(), via,
            },
            ifaFail: admin.firestore.FieldValue.delete(),
          },
        }, { merge: true });
      }
      const r = await syncMatchesForPlayer(db, e.p, 'ifa', e.fixtures);
      upserts += r.upserts; removed += r.removed; written++;
      await db.collection('players').doc(e.p.id).set({
        autoFetch: { ifa: { lastFixturesAt: new Date().toISOString() }, ifaFail: admin.firestore.FieldValue.delete() },
      }, { merge: true });
      if (e.gamesUrl) squads.add(e.gamesUrl);
    } catch (err) {
      console.error(`[ifa-import] ${e.p.fullName}:`, err);
      warnings.push({ ...warningFor({ ...e, reason: 'error' }, via), detail: String(err?.message || err).slice(0, 200) });
    }
  }

  if (Array.isArray(payload.clubIndex) && payload.clubIndex.length && payload.clubIndexFetched) {
    await db.collection('app_meta').doc('ifaClubIndex').set({
      key: 'https://www.football.org.il/', clubs: payload.clubIndex.slice(0, 3000),
      fetchedAt: admin.firestore.Timestamp.now(),
    }).catch((err) => console.error('club index write failed:', err.message));
  }

  // After every squad was brought up to date, no two live future records of
  // one squad may describe the same match (same date, same two teams). Any
  // that still do are merged into one, keeping every linked player.
  let merged = 0;
  const mergedNotes = [];
  for (const squad of squads) {
    try {
      const m = await mergeSquadDuplicates(db, squad);
      merged += m.merged; mergedNotes.push(...m.notes);
    } catch (err) { console.error('[ifa-import] merge duplicates:', err.message); }
  }

  const stats = { ...summary, written, upserts, removed, merged, durationS: Math.round((Date.now() - t0) / 1000) };
  await ref.set({
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
    stats, perPlayer, warnings, merged: mergedNotes.slice(0, 50),
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
  return { statusCode: 200, summary, perPlayer, stats };
}

// One squad's live future records grouped by identity: same date, same home
// team and same away team after name normalisation (a sponsor suffix or an
// abbreviation does not make a different team, as in the sync itself). In a
// group of two or more, the copy to keep is the one that carries the IFA game
// id, then the one with a time, then the oldest; the others go to the recycle
// bin and their players move onto it.
const teamKey = (name) => ifaTokens(ifaNormalizeName(name)).join(' ');
const sameTeam = (a, b) => teamKey(a) === teamKey(b) || ifaContainment(a, b) >= 0.5;
const identity = (m) => `${m.date}|${teamKey(m.homeTeam)}|${teamKey(m.awayTeam)}`;
const hasGameId = (m) => /^\d+$/.test(String(m.sourceMatchId || ''));
const hasTime = (m) => /^\d{2}:\d{2}$/.test(m.time || '') && m.time !== '00:00';
const createdMs = (m) => (m.createdAt?.toMillis ? m.createdAt.toMillis() : Date.parse(m.createdAt || '') || Infinity);
function pickKeeper(group) {
  return group.slice().sort((a, b) =>
    (hasGameId(b) - hasGameId(a)) || (hasTime(b) - hasTime(a)) || (createdMs(a) - createdMs(b)) || a.id.localeCompare(b.id))[0];
}
function duplicateGroups(rows, todayStr) {
  const byDate = new Map();
  for (const m of rows) {
    if (m.deletedAt || !m.date || m.date < todayStr || !m.homeTeam || !m.awayTeam) continue;
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  const groups = [];
  for (const rowsOfDay of byDate.values()) {
    const clusters = [];
    for (const m of rowsOfDay) {
      const c = clusters.find((cl) => sameTeam(cl[0].homeTeam, m.homeTeam) && sameTeam(cl[0].awayTeam, m.awayTeam));
      if (c) c.push(m); else clusters.push([m]);
    }
    groups.push(...clusters.filter((g) => g.length > 1));
  }
  return groups;
}
async function mergeSquadDuplicates(db, sourceTeamId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const snap = await db.collection('matches').where('source', '==', 'ifa').where('sourceTeamId', '==', sourceTeamId).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const notes = [];
  let merged = 0;
  for (const group of duplicateGroups(rows, todayStr)) {
    const keep = pickKeeper(group);
    const others = group.filter((m) => m.id !== keep.id);
    const players = others.flatMap((m) => m.linkedPlayers || []).filter((p) => !(keep.linkedPlayers || []).includes(p));
    const batch = db.batch();
    const keepRef = db.collection('matches').doc(keep.id);
    const upd = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (players.length) upd.linkedPlayers = admin.firestore.FieldValue.arrayUnion(...new Set(players));
    if (!hasTime(keep)) { const t = others.find(hasTime); if (t) upd.time = t.time; }
    if (!keep.stadiumName) { const st = others.find((m) => m.stadiumName); if (st) { upd.stadiumName = st.stadiumName; upd.stadiumMapsUrl = st.stadiumMapsUrl || ''; } }
    batch.update(keepRef, upd);
    for (const m of others) {
      batch.update(db.collection('matches').doc(m.id), {
        deletedAt: admin.firestore.FieldValue.serverTimestamp(), deletedBy: 'sync', deletedVia: 'ifa-dedupe',
        mergedInto: keep.id, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    merged += others.length;
    notes.push(`${keep.date} ${keep.homeTeam} - ${keep.awayTeam}: נשאר ${keep.id}, לסל המחזור ${others.map((m) => m.id).join(', ')}`);
  }
  return { merged, notes };
}

exports._plan = plan;
exports.runImport = runImport;
exports.viaOf = viaOf;
exports._internal = { ifaMismatch, squadInfo, duplicateGroups, pickKeeper, identity };
