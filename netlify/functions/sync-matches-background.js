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
// Normalises an IFA time string to "HH:MM" (24h). Handles:
//   "17:30"      → "17:30"   (already 24h, Hebrew page)
//   "5:00 PM"    → "17:00"   (US 12h with PM, English page)
//   "11:00 AM"   → "11:00"
//   "12:00 AM"   → "00:00"   (midnight edge case)
//   "12:30 PM"   → "12:30"   (noon edge case)
function normalizeIfaTime(s) {
  if (!s) return '';
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/i.exec(s.trim());
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const mn = m[2];
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${mn}`;
}

async function ifaFetchHtml(targetUrl) {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  // render=true   — headless Chromium so Cloudflare's anti-bot challenge
  //                 is cleared and the page's React/Vue chunks execute.
  // country_code  — Israeli IP so the page is served the same content
  //                 it shows to a real Israeli visitor.
  // device_type   — force the desktop layout: the IFA page has rows
  //                 marked `new-desktop-only`, and on mobile those are
  //                 hidden, so without this flag we lose rows.
  // wait          — additional seconds to wait after the initial render
  //                 finishes, giving the fixtures table time to lazy-load
  //                 the rest of the season. 6s = comfortable headroom.
  // The cost is 10 credits per call (instead of 1) — at ~5 IFA players
  // per Sync × 1 sync/day that's ~1.5K credits/month, well under the
  // 5K free quota.
  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render: 'true',
    country_code: 'il',
    device_type: 'desktop',
    wait: '6',
  });
  const fetchUrl = apiKey
    ? `https://api.scraperapi.com/?${params.toString()}`
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

// ───────────────────── IFA entity resolution ─────────────────────
// Every IFA URL carries a season_id, which used to mean re-pasting the link
// each August. Two facts make that unnecessary, both verified against the
// live site:
//
//   • Omitting season_id makes IFA serve the NEWEST season it holds for that
//     entity. /players/player/?player_id=254006 alone returns 2025/26 and the
//     team he plays for now; the same URL with &season_id=26 returns 2024/25
//     and a different age group.
//   • team_id is stable across seasons — only season_id moves. team-games for
//     team_id=3142 returns 2025/26 fixtures bare, 2024/25 with &season_id=26.
//
// So we always strip season_id. That alone future-proofs a team URL. A player
// URL needs one more step, because the player page carries no team link and
// its "משחקים בעונה" table is past appearances, not fixtures. The club page
// bridges the gap:
//
//   /players/player/?player_id=P   → club name + age-group label
//   /clubs/                        → club_id for that club
//   /clubs/club/?club_id=C         → team_id for each age group
//   /team-details/team-games/?team_id=T  → the fixture list
//
// The resolved team_id is cached on the player document, so the chain only
// runs when it is missing, a week old, or the player's club has changed.

const IFA_RESOLVE_TTL_DAYS = 7;

function ifaStripSeason(u) {
  u.searchParams.delete('season_id');
  return u;
}

// "נער.א" is how the player page abbreviates "נערים א"; the club page spells
// it out. Expand before tokenising so the two can be compared.
function ifaExpandAbbrev(s) {
  return String(s || '')
    .replace(/נערו['׳"]?\s*\.\s*/g, 'נערות ')
    .replace(/נער['׳"]?\s*\.\s*/g,  'נערים ')
    .replace(/ילדו['׳"]?\s*\.\s*/g, 'ילדות ')
    .replace(/ילד['׳"]?\s*\.\s*/g,  'ילדים ')
    .replace(/טרו['׳"]?\s*\.\s*/g,  'טרום ');
}

const IFA_STOPWORDS = new Set(['ליגה', 'ליגת', 'קבוצה', 'קבוצת', 'גיל', 'של']);

function ifaTokens(s, { dropShort = true } = {}) {
  return ifaExpandAbbrev(s)
    .replace(/["'״׳()]/g, ' ')
    .replace(/[.,\-–—]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t && !IFA_STOPWORDS.has(t) && (!dropShort || t.length > 1 || /^[א-ת]$/.test(t)));
}

// Club names differ between the player page ("מכבי ע. בת ים") and the club
// index ("מועדון כדורגל מכבי ..."), so compare on distinctive words only.
const IFA_CLUB_NOISE = new Set(['מועדון', 'כדורגל', 'מכ', 'מס', 'אס', 'קפ', 'עמותת', 'ספורט']);
function ifaClubTokens(s) {
  return ifaTokens(s).filter(t => t.length > 1 && !IFA_CLUB_NOISE.has(t));
}
function ifaContainment(wanted, candidate) {
  const w = ifaClubTokens(wanted), c = new Set(ifaClubTokens(candidate));
  if (!w.length) return 0;
  return w.filter(t => c.has(t)).length / w.length;
}

// Step 1 — the player page. Returns the current season and the team caption.
async function ifaReadPlayer(origin, prefix, playerId) {
  const url = `${origin}${prefix}players/player/?player_id=${encodeURIComponent(playerId)}`;
  const { ok, html } = await ifaFetchHtml(url);
  if (!ok || !html) return null;
  const $ = cheerio.load(html);
  const caption = $('h2.new-player-data_title').first().text().replace(/\s+/g, ' ').trim();
  const m = /בקבוצה:\s*(.+)$/.exec(caption);
  if (!m) return null;
  const full = m[1].trim();
  // "מכבי ע. בת ים "צו פיוס" (נער.א שפלה)" → club + parenthesised label.
  const lm = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(full);
  // The season list is ordered newest-first and carries no `selected`
  // attribute, so the first option is the season the page is showing.
  const firstOpt = $('select[id*="ddlSeason"] option').first();
  return {
    clubName:    (lm ? lm[1] : full).trim(),
    teamLabel:   (lm ? lm[2] : '').trim(),
    seasonId:    firstOpt.attr('value') || '',
    seasonLabel: firstOpt.text().trim(),
  };
}

// Step 2 — the club index. One page holds every club, so fetch it once per
// run and share it across players.
let _ifaClubIndex = null;
async function ifaClubIndex(origin, prefix) {
  if (_ifaClubIndex) return _ifaClubIndex;
  const { ok, html } = await ifaFetchHtml(`${origin}${prefix}clubs/`);
  if (!ok || !html) return (_ifaClubIndex = []);
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="club_id="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const id = /club_id=(\d+)/.exec(href)?.[1];
    if (!id) return;
    const $h = $(a).find('.head h2').first();
    const sector = $h.find('span').first().text().trim();   // גברים / נשים / …
    const name = $h.clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
    if (name) out.push({ clubId: id, name, sector });
  });
  _ifaClubIndex = out;
  return out;
}

// Step 3 — the club page lists one entry per active age-group team.
async function ifaClubTeams(origin, prefix, clubId) {
  const { ok, html } = await ifaFetchHtml(`${origin}${prefix}clubs/club/?club_id=${encodeURIComponent(clubId)}`);
  if (!ok || !html) return [];
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="team_id="]').each((_, a) => {
    const $a = $(a);
    const id = /team_id=(\d+)/.exec($a.attr('href') || '')?.[1];
    const $head = $a.find('h3.head').first();
    if (!id || !$head.length) return;   // skip the honours table, which has no h3.head
    const ageGroup = $head.clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
    let league = '', teamName = '';
    $a.find('.field_side > div').each((__, d) => {
      const label = $(d).find('span').first().text().trim();
      const value = $(d).clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
      if (/ליגה/.test(label)) league = value;
      if (/קבוצה/.test(label)) teamName = value;
    });
    out.push({ teamId: id, ageGroup, league, teamName });
  });
  return out;
}

// The player page says "(נער.א שפלה)"; the club page says age group "נערים א"
// and league "ליגת נערים א' שפלה". Score the overlap, weighting an exact
// age-group match heavily so a sibling squad in the same region can't win.
function ifaScoreTeam(teamLabel, clubName, cand) {
  const want = new Set(ifaTokens(teamLabel));
  const have = new Set([...ifaTokens(cand.ageGroup), ...ifaTokens(cand.league)]);
  let score = 0;
  for (const t of want) if (have.has(t)) score++;
  const age = ifaTokens(cand.ageGroup);
  if (age.length && age.every(t => want.has(t))) score += 3;
  if (ifaContainment(clubName, cand.teamName) >= 0.5) score += 2;
  return score;
}

// Full chain. Returns { teamId, … } or a { error } explaining where it broke,
// so the reason lands in the sync-warnings list instead of vanishing.
async function ifaResolveFromPlayerUrl(origin, prefix, playerId, gender) {
  const info = await ifaReadPlayer(origin, prefix, playerId);
  if (!info) return { error: 'ifa-player-page-unreadable' };

  const index = await ifaClubIndex(origin, prefix);
  if (!index.length) return { error: 'ifa-club-index-unreadable' };

  const wantWomen = gender === 'Women';
  const scored = index
    .filter(c => (wantWomen ? c.sector === 'נשים' : c.sector !== 'נשים') || !c.sector)
    .map(c => ({ ...c, s: ifaContainment(info.clubName, c.name) }))
    // Deliberately loose. A team caption often carries a sponsor nickname the
    // club register doesn't ("מכבי ע. בת ים \"צו פיוס\""), so a weak name match
    // is worth following; the age-group gate below is what actually decides.
    .filter(c => c.s >= 0.4)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { error: 'ifa-club-not-found', clubName: info.clubName };

  // Try the best-matching clubs in order — a club can appear more than once
  // (separate men's / women's / futsal registrations).
  for (const club of scored.slice(0, 4)) {
    const teams = await ifaClubTeams(origin, prefix, club.clubId);
    if (!teams.length) continue;
    const best = teams
      .map(t => ({ ...t, s: ifaScoreTeam(info.teamLabel, info.clubName, t) }))
      .sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 3) {
      return {
        teamId: best.teamId, clubId: club.clubId,
        teamName: best.teamName, ageGroup: best.ageGroup, league: best.league,
        seasonLabel: info.seasonLabel,
      };
    }
  }
  return { error: 'ifa-team-not-matched', clubName: info.clubName, teamLabel: info.teamLabel };
}

// Turns whatever Lou pasted into a team-games URL for the current season,
// caching the player→team resolution on the player document.
async function ifaTeamGamesUrl(db, player) {
  const raw = player.ifaTeamUrl || '';
  let u;
  try { u = new URL(raw); } catch { return { error: 'ifa-url-invalid' }; }
  if (!u.hostname.endsWith('football.org.il')) return { error: 'ifa-url-invalid' };

  const origin = u.origin;
  const prefix = u.pathname.match(/^\/[a-z]{2}\//)?.[0] || '/';   // keep an /en/ prefix
  const build  = (teamId) => `${origin}${prefix}team-details/team-games/?team_id=${teamId}`;

  const directTeamId = u.searchParams.get('team_id');
  if (directTeamId) return { url: build(directTeamId), teamId: directTeamId };

  const playerId = u.searchParams.get('player_id');
  if (!playerId) return { error: 'ifa-url-has-no-id' };

  const cache = player.autoFetch?.ifa;
  const ageMs = cache?.resolvedAt ? Date.now() - new Date(cache.resolvedAt).getTime() : Infinity;
  if (cache?.teamId && cache.playerId === playerId
      && cache.forClub === (player.currentClub || '')
      && ageMs < IFA_RESOLVE_TTL_DAYS * 86400000) {
    return { url: build(cache.teamId), teamId: cache.teamId, cached: true };
  }

  const res = await ifaResolveFromPlayerUrl(origin, prefix, playerId, player.gender);
  if (res.error) return res;

  await db.collection('players').doc(player.id).set({
    autoFetch: {
      ifa: {
        playerId, teamId: res.teamId, clubId: res.clubId,
        teamName: res.teamName, ageGroup: res.ageGroup, league: res.league,
        seasonLabel: res.seasonLabel, forClub: player.currentClub || '',
        resolvedAt: new Date().toISOString(),
      },
    },
  }, { merge: true });

  return { url: build(res.teamId), teamId: res.teamId, resolved: res };
}

async function ifaFetchFixtures(rawUrl) {
  if (!rawUrl) return [];
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return []; }
  if (!parsed.hostname.endsWith('football.org.il')) return [];
  const teamId = parsed.searchParams.get('team_id');
  if (!teamId) return [];
  // Deliberately dropped: without season_id IFA serves the current season,
  // which is the whole point — the stored link never goes stale.
  ifaStripSeason(parsed);
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
  const fetchUrl = `${parsed.origin}${gamesPath}?team_id=${encodeURIComponent(teamId)}`;
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

    // Cell labels differ by language: Hebrew uses תאריך/משחק/אצטדיון/שעה,
    // English uses Date/Game/Stadium/Time (note: "Game" — NOT "Match").
    const cell = (...keys) => {
      for (const k of keys) if (cells[k]) return cells[k];
      return '';
    };
    const dateStr  = cell('תאריך', 'Date');
    const matchStr = cell('משחק', 'Game', 'Match');
    const stadium  = cell('אצטדיון', 'Stadium');
    const timeStr  = cell('שעה', 'Time');

    // Date format ALSO differs:
    //   Hebrew page:   16/08/2025  → DD/MM/YYYY
    //   English page:  5/23/2026   → M/D/YYYY  (US order)
    // We accept 1 or 2 digits for each part, and pick the order based on
    // the page language detected from the URL.
    const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateStr);
    if (!dm) return;
    const isEnglishPage = parsed.pathname.startsWith('/en/');
    const day   = isEnglishPage ? dm[2] : dm[1];
    const month = isEnglishPage ? dm[1] : dm[2];
    const year  = dm[3];
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

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
      // Hebrew page returns "17:30", English page returns "5:00 PM" — both
      // get normalised to 24h HH:MM so the rest of the app sees one format.
      time: normalizeIfaTime(timeStr),
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
  _ifaClubIndex = null;   // shared within a run, never across runs

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
          const target = await ifaTeamGamesUrl(db, p);
          if (target.error) {
            localWarnings.push({
              playerId: p.id, name: p.fullName, club: p.currentClub,
              reason: target.error,
              detail: [target.clubName, target.teamLabel].filter(Boolean).join(' · ') || undefined,
            });
            continue;
          }
          console.log(`[sync] ${p.fullName} → IFA team ${target.teamId}${target.cached ? ' (cached)' : ''}`);
          fixtures = await ifaFetchFixtures(target.url);
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

// Reads and destroys the cron's one-time nonce. Rejects anything older than
// two minutes so a leaked value is worthless.
async function consumeSyncNonce(nonce) {
  const ref = getDb().collection('app_meta').doc('syncTrigger');
  try {
    const snap = await ref.get();
    if (!snap.exists) return false;
    const d = snap.data() || {};
    await ref.delete().catch(() => {});
    if (!d.nonce || d.nonce !== nonce) return false;
    const issued = d.issuedAt?.toDate?.()?.getTime?.() || 0;
    return Date.now() - issued < 2 * 60 * 1000;
  } catch (e) {
    console.error('nonce check failed:', e.message);
    return false;
  }
}

// ───────────────────── Handler (HTTP-only background) ─────────────────────
// Background functions accept POST and return 202 immediately; the body
// returned here is only seen in the function logs (the client already has
// its 202 by the time we finish writing it).
exports.handler = async (event) => {
  getDb();

  // Auth is REQUIRED. Two callers are legitimate:
  //   • Lou pressing Sync Now — a Firebase ID token for the owner account.
  //   • The nightly cron — a single-use nonce it wrote to Firestore moments
  //     before calling. Only code holding the service-account key can put a
  //     nonce there, so this needs no new secret and no manual setup.
  const headers = event.headers || {};
  const nonce = (headers['x-sync-nonce'] || headers['X-Sync-Nonce'] || '').trim();
  if (nonce) {
    const ok = await consumeSyncNonce(nonce);
    if (!ok) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid nonce' }) };
  } else {
    const auth = headers.authorization || headers.Authorization || '';
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
