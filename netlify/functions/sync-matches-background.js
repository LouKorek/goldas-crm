// Auto-sync of match fixtures for represented players.
//
// This is a Netlify BACKGROUND function (filename ends in `-background.js`)
// which gives us a 15-minute timeout instead of the synchronous 30-second
// limit. Netlify returns 202 to the caller immediately, then the work
// continues in the background. The Sync Now button on the Matches screen
// invokes this directly; the daily 06:00 UTC cron is handled separately
// (we used to mix schedule() + this file but background + schedule together
// produced flaky behavior, so the cron now lives in its own tiny function).
//
// SofaScore client is wired; 365 is a stub; IFA goes through ScraperAPI
// to bypass football.org.il's IP block.

const admin   = require('firebase-admin');
const cheerio = require('cheerio');

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
// Effective country for a player. Rule: if only a league is written (manual
// league text) and no country, treat the player as based in the US — that's
// how the agency tags US college / academy leagues that don't fit the
// country+tier picker.
function effectiveCountry(p) {
  const raw = (p.leagueCountry || '').trim();
  if (raw) return raw;
  const hasManualLeague = !!((p.leagueManual || '').trim());
  if (hasManualLeague) return 'United States';
  return '';
}

function decideSources(p) {
  const country  = effectiveCountry(p).toLowerCase();
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

// ───────────────────── IFA (football.org.il) client ─────────────────────
// IFA doesn't expose a JSON API. We require a per-player team URL (the page
// /team-details/?season_id=X&team_id=Y) and parse the "רשימת המשחקים" tables
// from it. Lou pastes the URL once per Israeli player from the IFA website.
//
// football.org.il blocks Netlify's IPs at the edge (Cloudflare anti-bot →
// 403 Forbidden on every request, regardless of headers). To get around the
// IP block we route the fetch through ScraperAPI when SCRAPER_API_KEY is set.
// Without the key we fall back to a direct fetch — useful for local dev from
// an Israeli IP, but will return 403 on Netlify.
async function ifaFetchHtml(targetUrl) {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  // render=true tells ScraperAPI to spin up a headless browser and execute
  // JS. Required to clear Cloudflare's anti-bot challenge on football.org.il
  // (without it the API returns 500 because the proxy itself gets blocked).
  // Costs 10 ScraperAPI credits per call instead of 1 — at 5 IFA players × 1
  // call/day that's 1,500 credits/month, comfortably under the 5K free quota.
  const fetchUrl = apiKey
    ? `https://api.scraperapi.com/?api_key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=il`
    : targetUrl;
  const via = apiKey ? 'ScraperAPI' : 'direct';
  let res;
  try {
    res = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      },
    });
  } catch (e) {
    console.error(`IFA fetch error (via ${via}):`, e.message);
    return { ok: false, status: 0, html: '', via };
  }
  const html = res.ok ? await res.text() : '';
  return { ok: res.ok, status: res.status, html, via };
}

async function ifaFetchFixtures(rawUrl) {
  if (!rawUrl) return [];
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return []; }
  if (!parsed.hostname.endsWith('football.org.il')) return [];
  const teamId   = parsed.searchParams.get('team_id');
  const seasonId = parsed.searchParams.get('season_id') || '';
  if (!teamId) return [];
  // Preserve the language path/host the user pasted (so an English URL —
  // /en/... or en.football.org.il — stays English and we get English labels
  // back). If the URL already points at the /team-games/ list, use it as-is;
  // otherwise rewrite the path to /team-details/team-games/ while keeping
  // the same origin and any /en/ prefix in the path.
  const isGamesUrl = parsed.pathname.includes('/team-games/');
  let gamesPath;
  if (isGamesUrl) {
    gamesPath = parsed.pathname;
  } else {
    // Insert /team-games/ after /team-details/, or append a fresh path if
    // /team-details/ isn't present.
    if (parsed.pathname.includes('/team-details/')) {
      gamesPath = parsed.pathname.replace('/team-details/', '/team-details/team-games/');
    } else {
      // Keep any leading language prefix like /en/.
      const prefix = parsed.pathname.match(/^\/[a-z]{2}\//)?.[0] || '/';
      gamesPath = `${prefix}team-details/team-games/`;
    }
  }
  const fetchUrl = `${parsed.origin}${gamesPath}?team_id=${encodeURIComponent(teamId)}${seasonId ? `&season_id=${encodeURIComponent(seasonId)}` : ''}`;
  const { ok, status, html, via } = await ifaFetchHtml(fetchUrl);
  if (!ok) {
    console.log(`IFA fetch ${fetchUrl} (via ${via}) → status=${status}`);
    return [];
  }
  const $ = cheerio.load(html);
  const rowCount = $('a.table_row.link_url').length;
  console.log(`IFA fetch ${fetchUrl} (via ${via}) → status=${status} html_len=${html.length} rows=${rowCount}`);
  // Diagnostic dump when there aren't enough match rows to be a real fixture
  // list (only the header showed up, or the page uses a different DOM in
  // English). We log:
  //   1) A long HTML snippet anchored on the first occurrence of "date"
  //      or "match" or "team-games" so we see the actual structure.
  //   2) A summary of all class names that look like they could be a match
  //      row (table/row/fixture/match/game).
  // This lets me design the right selector without guessing.
  if (rowCount < 5) {
    const $tables = $('table');
    const $allRows = $('tr, .table_row, .fixture-row, .game-row, .match-row, [class*="fixture"], [class*="game-row"]');
    const summary = {
      tableCount: $tables.length,
      anchorWithGameId: $('a[href*="game_id="]').length,
      candidateRowSelectors: $allRows.length,
      classesSeen: [],
    };
    const classes = new Set();
    $('div, a, tr').each((_, el) => {
      const cls = $(el).attr('class') || '';
      cls.split(/\s+/).forEach(c => {
        if (/table|row|fixture|game|match|sched/i.test(c) && c.length < 40) classes.add(c);
      });
    });
    summary.classesSeen = Array.from(classes).slice(0, 30);
    console.log('IFA diag:', JSON.stringify(summary));
    // First 2.5K of stripped HTML, starting wherever interesting content begins.
    const stripped = html.replace(/\s+/g, ' ');
    const anchor = stripped.search(/game_id=|fixture|game-row|table_row|<table/i);
    const start = anchor > 0 ? Math.max(0, anchor - 200) : 0;
    console.log('IFA HTML snippet:', stripped.slice(start, start + 2500));
  }
  const out = [];

  // Each match row is rendered as:
  //   <a class="table_row link_url" href="...game_id=NNN">
  //     <div class="table_col"><span class="sr-only">תאריך</span>16/08/2025</div>
  //     <div class="table_col"><span class="sr-only">משחק</span>Home - Away</div>
  //     <div class="table_col"><span class="sr-only">אצטדיון</span>Stadium</div>
  //     <div class="table_col"><span class="sr-only">שעה</span>17:30</div>
  //     <div class="table_col"><span class="sr-only">תוצאה</span>3-1</div>
  //   </a>
  $('a.table_row.link_url').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    let sourceMatchId = '';
    const gm = /game_id=(\d+)/.exec(href);
    if (gm) sourceMatchId = gm[1];

    const cells = {};
    $a.find('div.table_col').each((__, col) => {
      const $col = $(col);
      const labelText = $col.find('span.sr-only').first().text();
      const label = labelText.trim();
      const value = $col.text().slice(labelText.length).replace(/\s+/g, ' ').trim();
      if (label) cells[label] = value;
    });

    // Cell labels are language-dependent — accept both the Hebrew and the
    // English IFA labels so the parser works whether Lou pasted a Hebrew
    // or English team URL.
    const cell = (...keys) => {
      for (const k of keys) if (cells[k]) return cells[k];
      return '';
    };
    const dateStr  = cell('תאריך', 'Date');
    const matchStr = cell('משחק', 'Match');
    const stadium  = cell('אצטדיון', 'Stadium');
    const timeStr  = cell('שעה', 'Time');
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateStr);
    if (!dm) return;
    const date = `${dm[3]}-${dm[2]}-${dm[1]}`;

    const sep = matchStr.lastIndexOf(' - ');
    if (sep < 1) return;
    const homeTeam = matchStr.slice(0, sep).trim();
    const awayTeam = matchStr.slice(sep + 3).trim();
    if (!homeTeam || !awayTeam) return;
    // IFA marks a "bye" round (no opponent that week) as a match against
    // "חופשית" in Hebrew or "Bye" / "Free" in English — skip either form.
    const isPlaceholder = (t) => t === 'חופשית' || /^(bye|free)$/i.test(t);
    if (isPlaceholder(homeTeam) || isPlaceholder(awayTeam)) return;
    if (!sourceMatchId) sourceMatchId = `${date}|${homeTeam}|${awayTeam}`;

    out.push({
      source: 'ifa',
      sourceMatchId,
      sourceTeamId: rawUrl,
      date,
      time: timeStr,
      homeTeam,
      awayTeam,
      stadiumName: stadium,
      season: deriveSeason(date),
    });
  });

  // Older table-based fallback (in case some pages still render as <table>).
  $('table').each((_, table) => {
    const $table = $(table);
    const headerText = $table.find('th').map((__, th) => $(th).text().replace(/\s+/g, ' ').trim()).get().join(' ');
    // Only look at the fixture-list tables. Standings (place / wins / etc.)
    // are skipped. The fixture table has columns including a date column.
    if (!/תאריך/.test(headerText)) return;
    if (!/אצטדיון|משחק/.test(headerText)) return;
    if (/נצ'|הפ'|נק'/.test(headerText)) return; // standings table

    $table.find('tbody tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length < 4) return;
      // Find date cell (dd/mm/yyyy) and home/away in the row.
      const dateIdx = cells.findIndex((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c));
      if (dateIdx < 0) return;
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[dateIdx]);
      const date = `${m[3]}-${m[2]}-${m[1]}`;
      // Match cell — pick the cell containing " - " (Home - Away).
      const matchIdx = cells.findIndex((c) => c.includes(' - ') && c.length > cells[dateIdx].length);
      let homeTeam = '', awayTeam = '';
      if (matchIdx >= 0) {
        const txt = cells[matchIdx];
        const sep = txt.lastIndexOf(' - ');
        homeTeam = txt.slice(0, sep).trim();
        awayTeam = txt.slice(sep + 3).trim();
      }
      if (!homeTeam || !awayTeam) return;
      // Stadium = next cell after match; time = next cell that looks like HH:MM.
      const stadium = (matchIdx >= 0 && cells[matchIdx + 1]) ? cells[matchIdx + 1] : '';
      const timeCell = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c)) || '';

      // game_id from a link in the row (best unique id we can get from IFA).
      let sourceMatchId = '';
      $(tr).find('a[href*="game_id="]').each((___, a) => {
        const href = $(a).attr('href') || '';
        const gm = /game_id=(\d+)/.exec(href);
        if (gm && !sourceMatchId) sourceMatchId = gm[1];
      });
      if (!sourceMatchId) sourceMatchId = `${date}|${homeTeam}|${awayTeam}`;

      out.push({
        source: 'ifa',
        sourceMatchId,
        sourceTeamId: rawUrl, // the URL itself identifies the (club × season × age)
        date,
        time: timeCell,
        homeTeam,
        awayTeam,
        stadiumName: stadium,
        season: deriveSeason(date),
      });
    });
  });
  // Dedup by sourceMatchId.
  const seen = new Set();
  return out.filter((m) => { if (seen.has(m.sourceMatchId)) return false; seen.add(m.sourceMatchId); return true; });
}

// 365 still a stub for the next phase.
async function stubSearchTeam() { return []; }
async function stubFetchFixtures() { return []; }

const SOURCE_CLIENTS = {
  sofascore: { searchTeam: sofascoreSearchTeam, fetchFixtures: sofascoreFetchFixtures },
  '365':     { searchTeam: stubSearchTeam,      fetchFixtures: stubFetchFixtures },
  // IFA is handled outside this table because it takes a URL, not a team-id.
};

// ───────────────────── Resolve team ID with caching ─────────────────────
async function resolveTeamId(db, player, source) {
  const cached    = player.autoFetch?.teamIds?.[source];
  const cachedFor = player.autoFetch?.cachedClubs?.[source];
  if (cached && cachedFor === player.currentClub) return cached;

  const client = SOURCE_CLIENTS[source];
  const teams = await client.searchTeam(player.currentClub, {
    country: effectiveCountry(player),
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
    // Stadiums on auto-synced matches get a Google Maps search URL so the
    // Match card's location chip is clickable, matching manual matches.
    const stadiumMapsUrl = fm.stadiumName
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fm.stadiumName)}`
      : '';

    const ex = existing.get(fm.sourceMatchId);
    if (ex) {
      // Past matches are FROZEN — once a match has happened it's part of the
      // player's history and we never let a later sync rewrite it. This is
      // critical when a player moves to a new club: the past matches at the
      // old club must stay untouched.
      if (ex.data.date && ex.data.date < todayStr) continue;
      const linked = new Set(ex.data.linkedPlayers || []);
      linked.add(player.id);
      await ex.ref.update({
        date: fm.date, time: fm.time,
        homeTeam: fm.homeTeam, awayTeam: fm.awayTeam,
        stadiumName: fm.stadiumName,
        stadiumMapsUrl,
        sourceTeamId: fm.sourceTeamId,
        season: fm.season,
        linkedPlayers: Array.from(linked),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      upserts++;
    } else {
      // Maybe another player already created this same match — link instead.
      const otherSnap = await col.where('source', '==', source)
        .where('sourceMatchId', '==', fm.sourceMatchId).limit(1).get();
      if (!otherSnap.empty) {
        const otherData = otherSnap.docs[0].data();
        // Same frozen rule for the link-to-existing path: a past match
        // belongs to whoever played in it at the time. Don't add this
        // player to it just because their new team has it in its archive.
        if (otherData.date && otherData.date < todayStr) continue;
        const ref = otherSnap.docs[0].ref;
        const linked = new Set(otherData.linkedPlayers || []);
        linked.add(player.id);
        await ref.update({
          linkedPlayers: Array.from(linked),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastFetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        upserts++;
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
          stadiumMapsUrl,
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
        upserts++;
      }
    }
  }

  return { upserts, removed };
}

// ───────────────────── Main routine ─────────────────────
async function runSync() {
  const db = getDb();

  // Status sentinel: write a "running" doc to Firestore so the UI / Lou
  // can confirm the function actually started. Updated again at the end.
  const statusRef = db.collection('app_meta').doc('syncStatus');
  await statusRef.set({
    state: 'running',
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    finishedAt: null,
    error: null,
  }, { merge: true });
  console.log('[sync] STARTED');

  const playersSnap = await db.collection('players').get();
  const players = playersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`[sync] loaded ${players.length} players`);

  // Retain window: from start of last season (~Aug last year) onwards.
  const now = new Date();
  const fromDate = new Date(now.getFullYear() - 1, 7, 1); // Aug 1, prev year
  const fromDateMs = fromDate.getTime();

  const stats = { totalPlayers: players.length, processed: 0, upserts: 0, removed: 0, perSource: {} };
  const warnings = [];

  // Run all players in parallel — each call is bounded by its own external
  // API (ScraperAPI for IFA can take 10–25s with render=true). Sequentially
  // this would blow past Netlify's 30s synchronous-function budget; in
  // parallel the wall-clock time is governed by the slowest single player.
  // Each player only touches its own player doc + own match docs so there
  // are no Firestore write conflicts.
  const perPlayer = await Promise.all(players.map(async (p) => {
    const localWarnings = [];
    try {
      const sources = decideSources(p);
      if (!sources.length) {
        return { ok: false, warnings: [{ playerId: p.id, name: p.fullName, reason: 'no-source' }] };
      }
      if (!p.currentClub) {
        return { ok: false, warnings: [{ playerId: p.id, name: p.fullName, reason: 'no-club' }] };
      }

      for (const source of sources) {
        let fixtures = [];
        if (source === 'ifa') {
          if (!p.ifaTeamUrl) {
            localWarnings.push({ playerId: p.id, name: p.fullName, club: p.currentClub, reason: 'ifa-url-missing' });
            continue;
          }
          console.log(`[sync] ${p.fullName} → IFA fetch start (${p.ifaTeamUrl})`);
          fixtures = await ifaFetchFixtures(p.ifaTeamUrl);
          console.log(`[sync] ${p.fullName} → IFA fetch done, ${fixtures.length} fixtures`);
        } else {
          const teamId = await resolveTeamId(db, p, source);
          if (!teamId) { console.log(`[sync] ${p.fullName} → ${source} team-id not resolved`); continue; }
          console.log(`[sync] ${p.fullName} → ${source} fetch start (teamId=${teamId})`);
          fixtures = await SOURCE_CLIENTS[source].fetchFixtures(teamId, fromDateMs);
          console.log(`[sync] ${p.fullName} → ${source} fetch done, ${fixtures.length} fixtures`);
        }
        if (!fixtures.length) continue;
        const { upserts, removed } = await syncMatchesForPlayer(db, p, source, fixtures);
        console.log(`[sync] ${p.fullName} → ${source} upsert ${upserts} / remove ${removed}`);
        return { ok: true, source, upserts, removed, warnings: [] };
      }
      // No source produced fixtures.
      if (!localWarnings.length) {
        localWarnings.push({ playerId: p.id, name: p.fullName, club: p.currentClub, reason: 'no-fixtures-or-team-not-found', triedSources: sources });
      }
      return { ok: false, warnings: localWarnings };
    } catch (e) {
      console.error(`Sync error for ${p.fullName}:`, e);
      return { ok: false, warnings: [{ playerId: p.id, name: p.fullName, reason: 'error', message: String(e?.message || e) }] };
    }
  }));

  for (const r of perPlayer) {
    if (r.warnings.length) warnings.push(...r.warnings);
    if (r.ok) {
      stats.processed++;
      stats.upserts += r.upserts;
      stats.removed += r.removed;
      stats.perSource[r.source] = (stats.perSource[r.source] || 0) + 1;
    }
  }
  console.log(`[sync] FINISHED ${stats.processed}/${stats.totalPlayers} processed, ${stats.upserts} upserts, ${warnings.length} warnings`);
  await statusRef.set({
    state: 'idle',
    finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastResult: stats,
    lastWarningCount: warnings.length,
  }, { merge: true });

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

// ───────────────────── Handler (HTTP-only background) ─────────────────────
// Background functions accept POST and return 202 immediately; the body
// returned here is only seen in the function logs (the client already has
// its 202 by the time we finish writing it).
exports.handler = async (event) => {
  getDb();

  // Auth is REQUIRED — owner-only. Even though the caller doesn't wait for
  // our response, we still validate the token before doing any work.
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

  try {
    const result = await runSync();
    console.log('Sync complete via HTTP:', JSON.stringify(result.stats));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (e) {
    console.error('sync-matches-background failed:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(e?.message || e) }),
    };
  }
};
