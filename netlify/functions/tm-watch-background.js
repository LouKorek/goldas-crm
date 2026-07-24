// Transfermarkt watch — finds football players worldwide with an Israeli /
// Jewish connection, playing OUTSIDE Israel.
//
// Two detection tracks, run daily (see tm-watch-cron.js) or on demand from
// the TM Watch screen:
//
//   A. CITIZENSHIP — Transfermarkt's "Foreigners" statistic lists every
//      player with Israeli citizenship currently playing outside Israel.
//      A daily diff of that list catches: brand-new profiles, existing
//      players whose profile just gained Israeli citizenship, and players
//      who moved abroad. Highest confidence.
//
//   B. NAMES — a large curated database of Jewish/Israeli surnames and
//      first names (data/jewish-names.js, ~650 search spellings expanded by
//      transliteration folding) is rotated through Transfermarkt's player
//      search, a batch per run. New hits are verified via their profile
//      page (citizenship, club, league country) and excluded if they play
//      in Israel, are retired, or are 40+.
//
// Results live in the `tmWatch` Firestore collection; the client screen is
// /pipeline/jewish/tm-watch. New candidates are emailed to the owner.
//
// Env: FIREBASE_SERVICE_ACCOUNT_KEY, SCRAPER_API_KEY, GMAIL_APP_PASSWORD.

const admin      = require('firebase-admin');
const cheerio    = require('cheerio');
const nodemailer = require('nodemailer');
const { matchName, buildQueries } = require('./data/jewish-names.js');

const OWNER_EMAIL    = 'lou.korek@gmail.com';
const TM_BASE        = 'https://www.transfermarkt.com';
const ISRAEL_LAND_ID = 74;

// Per-run request budget (overridable via app_meta/tmWatch doc).
const DEFAULTS = {
  nameQueriesPerRun: 50,   // TM search queries per run (rotates the full list)
  profileFetchCap:   40,   // max new-candidate profile verifications per run
  maxPagesPerHost:   6,    // legionaere pagination cap per host country
};

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

// ───────────────────── Fetch via ScraperAPI ─────────────────────
// Transfermarkt is fully server-rendered — no JS render needed, which keeps
// ScraperAPI usage at 1 credit per request.
let REQUEST_COUNT = 0;
async function fetchHtml(targetUrl) {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  const fetchUrl = apiKey
    ? `https://api.scraperapi.com/?${new URLSearchParams({ api_key: apiKey, url: targetUrl }).toString()}`
    : targetUrl;
  REQUEST_COUNT++;
  const isJson = targetUrl.includes('/ceapi/');
  const res = await fetch(fetchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': isJson ? 'application/json' : 'text/html,application/xhtml+xml',
      ...(isJson ? { 'X-Requested-With': 'XMLHttpRequest', 'Referer': TM_BASE + '/' } : {}),
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`fetch ${targetUrl} → ${res.status}`);
  return res.text();
}

const tmIdFromHref = (href) => {
  const m = /\/spieler\/(\d+)/.exec(href || '');
  return m ? m[1] : null;
};
const abs = (href) => (href && href.startsWith('/') ? TM_BASE + href : href);

// ───────────────────── Track A: citizenship (Foreigners pages) ──────────
async function scanCitizenshipTrack(log) {
  const players = new Map(); // tmId → player
  const overviewUrl = `${TM_BASE}/land-statistik/legionaere/statistik/stat/?land_id=${ISRAEL_LAND_ID}`;
  const $ov = cheerio.load(await fetchHtml(overviewUrl));

  // Country rows link to per-host-country player lists.
  const hosts = [];
  $ov('table.items a[href*="/spieler-statistik/legionaere/"]').each((_, a) => {
    const href = $ov(a).attr('href');
    const text = $ov(a).text().trim();
    if (!href || !text) return;
    if (!hosts.some(h => h.href === href)) hosts.push({ href, country: text });
  });
  log.push(`Track A: ${hosts.length} host countries`);

  for (const host of hosts) {
    const seenPages = new Set();
    let pageUrls = [abs(host.href)];
    for (let i = 0; i < pageUrls.length && seenPages.size < DEFAULTS.maxPagesPerHost; i++) {
      const url = pageUrls[i];
      if (seenPages.has(url)) continue;
      seenPages.add(url);
      let $;
      try { $ = cheerio.load(await fetchHtml(url)); }
      catch (e) { log.push(`A ${host.country}: ${e.message}`); continue; }

      $('table.items tbody > tr').each((_, tr) => {
        const $tr = $(tr);
        const a = $tr.find('a[href*="/profil/spieler/"]').first();
        const id = tmIdFromHref(a.attr('href'));
        if (!id || players.has(id)) return;
        const cells = $tr.children('td').map((_, td) => $(td).text().trim().replace(/\s+/g, ' ')).get();
        if (cells.length < 4) return; // nested sub-row
        const clubA   = $tr.find('a[href*="/startseite/verein/"]').first();
        const clubTd  = clubA.closest('td').last();
        const leagueA = $tr.find('a[href*="/wettbewerb/"]').first();
        const leagueCode = (/\/wettbewerb\/([A-Za-z0-9]+)/.exec(leagueA.attr('href') || '') || [])[1] || '';
        // Citizenship flags only — drop any flag rendered inside the club/league cell.
        const flags = $tr.find('img.flaggenrahmen')
          .filter((_, f) => !(clubTd.length && $.contains(clubTd.get(0), f)))
          .map((_, f) => $(f).attr('title')).get().filter(Boolean);
        const name = a.text().trim() || a.attr('title') || '';
        // cells[1] is "Name Position" from the nested table — strip the name.
        const position = (cells[1] || '').replace(name, '').trim();
        const contractUntil = cells.find(c => /^\d{2}[./-]\d{2}[./-]\d{4}$/.test(c)) || '';
        const mv = cells[cells.length - 1] || '';
        players.set(id, {
          tmId: id,
          name,
          tmUrl: abs(a.attr('href')),
          club: clubA.attr('title') || clubA.text().trim() || '',
          clubCountry: host.country,
          league: leagueA.text().trim() || '',
          leagueCode,
          contractUntil,
          position,
          citizenships: flags,
          marketValue: /€|k|m/.test(mv) ? mv : '',
          age: parseInt(cells[2], 10) || null,
          matchType: 'citizenship',
          tier: 0,
          matchedOn: 'Israeli citizenship (plays abroad)',
        });
      });

      // Follow pagination on the first page only.
      if (i === 0) {
        $('ul.tm-pagination a, .pager a, ul.pagination a').each((_, a) => {
          const href = abs($(a).attr('href'));
          if (href && /\/page\/\d+/.test(href) && !pageUrls.includes(href)) pageUrls.push(href);
        });
        pageUrls = pageUrls.slice(0, DEFAULTS.maxPagesPerHost);
      }
    }
  }
  log.push(`Track A: ${players.size} players with Israeli citizenship abroad`);
  return players;
}

// ───────────────────── Track B: name search rotation ─────────────────────
async function scanNameTrack(meta, existingIds, log) {
  const queries = buildQueries();
  const perRun  = meta.nameQueriesPerRun || DEFAULTS.nameQueriesPerRun;
  const start   = (meta.cursor || 0) % queries.length;
  const batch   = [];
  for (let i = 0; i < perRun; i++) batch.push(queries[(start + i) % queries.length]);

  const candidates = new Map(); // tmId → shallow candidate
  for (const q of batch) {
    let $;
    try { $ = cheerio.load(await fetchHtml(`${TM_BASE}/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(q)}`)); }
    catch (e) { log.push(`B "${q}": ${e.message}`); continue; }
    $('table.items tbody > tr').each((_, tr) => {
      const $tr = $(tr);
      const a = $tr.find('a[href*="/profil/spieler/"]').first();
      const id = tmIdFromHref(a.attr('href'));
      if (!id || candidates.has(id) || existingIds.has(id)) return;
      const cells = $tr.children('td').map((_, td) => $(td).text().trim().replace(/\s+/g, ' ')).get();
      if (cells.length < 4) return;
      const rowText = cells.join(' ');
      if (/retired|karriereende/i.test(rowText)) return;              // פרשו — לא רלוונטי
      const age = parseInt(cells[3], 10);
      if (age && age >= 40) return;
      const flags = $tr.find('img.flaggenrahmen').map((_, f) => $(f).attr('title')).get().filter(Boolean);
      if (flags.includes('Israel')) return; // Track A owns citizenship cases
      const name = a.text().trim() || a.attr('title') || '';
      const nameHit = matchName(name);
      if (!nameHit) return;
      candidates.set(id, {
        tmId: id, name, tmUrl: abs(a.attr('href')),
        citizenships: flags, age: age || null,
        tier: nameHit.tier, matchedOn: nameHit.matchedOn, matchType: 'name',
      });
    });
  }
  const nextCursor = (start + perRun) % queries.length;
  log.push(`Track B: queries ${start}–${start + perRun} / ${queries.length}, ${candidates.size} unverified candidates`);
  return { candidates, nextCursor };
}

// Verify a name-track candidate via their profile page. Returns enriched
// candidate, or null if excluded (Israel league / retired).
async function verifyCandidate(cand, log) {
  let html;
  try { html = await fetchHtml(cand.tmUrl); }
  catch (e) { log.push(`verify ${cand.name}: ${e.message}`); return { ...cand, verifyFailed: true }; }
  const $ = cheerio.load(html);

  // Info-table label/value pairs.
  const info = {};
  $('span.info-table__content--regular').each((_, el) => {
    const label = $(el).text().trim().replace(/:$/, '');
    const val = $(el).next('span.info-table__content--bold');
    if (label && val.length) info[label] = val;
  });

  const citiz = info['Citizenship']
    ? info['Citizenship'].find('img.flaggenrahmen').map((_, f) => $(f).attr('title')).get()
      .concat(info['Citizenship'].text().trim().split(/\s{2,}/)).map(s => (s || '').trim()).filter(Boolean)
    : cand.citizenships;
  const citizenships = [...new Set(citiz)];

  const clubA = $('.data-header__club a, a.data-header__club-link').first();
  const club  = clubA.text().trim() || (info['Current club'] ? info['Current club'].text().trim() : '');
  const leagueA = $('a[href*="/startseite/wettbewerb/"]').first();
  const league  = leagueA.text().trim();
  const leagueCode = (/\/wettbewerb\/([A-Za-z0-9]+)/.exec(leagueA.attr('href') || '') || [])[1] || '';
  const tierWord = /League level:?\s*([A-Za-z]+)\s+Tier/i.exec($('.data-header').text());
  const leagueTier = tierWord ? ({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }[tierWord[1].toLowerCase()] || null) : null;
  // League country: the small flag beside the league line in the header.
  const clubCountry = $('.data-header__league-area img.flaggenrahmen, .data-header__club-info img.flaggenrahmen')
    .first().attr('title') || '';

  const headerText = $('.data-header').text();
  if (/retired/i.test(club) || /Retired since/i.test(headerText)) return null;
  if ((clubCountry || '').toLowerCase() === 'israel') return null;
  if (citizenships.includes('Israel') && (clubCountry || '').toLowerCase() === 'israel') return null;

  const mv = $('.data-header__market-value-wrapper').first().text().trim().replace(/\s+/g, ' ').split('Last update')[0].trim();
  const pos = info['Position'] ? info['Position'].text().trim() : '';

  return {
    ...cand,
    citizenships,
    club: club || cand.club || '',
    league, leagueCode, leagueTier, clubCountry,
    marketValue: /€/.test(mv) ? mv : '',
    position: pos,
    // A name candidate that turns out to hold Israeli citizenship but plays
    // abroad is effectively a citizenship match.
    matchType: citizenships.includes('Israel') ? 'citizenship' : 'name',
    matchedOn: citizenships.includes('Israel')
      ? `Israeli citizenship + ${cand.matchedOn}`
      : cand.matchedOn,
    tier: citizenships.includes('Israel') ? 0 : cand.tier,
  };
}

// ───────────────── Israel career-history check ─────────────────
// TM's internal transfer-history API returns every career move (youth
// included) with a country flag URL per club — /flagge/.../74.png = Israel.
// One request per player, cached forever on the doc as israelHistory:
// 'never' | 'played'.
async function checkIsraelHistory(tmId) {
  try {
    const raw = await fetchHtml(`${TM_BASE}/ceapi/transferHistory/list/${tmId}`);
    const j = JSON.parse(raw);
    // Strict shape check: anything unexpected (error payloads, challenge
    // pages that happen to parse) must NOT be misread as "no transfers".
    if (!j || !Array.isArray(j.transfers)) return null;
    const israelClubs = new Set();
    let sides = 0;
    for (const t of j.transfers) {
      for (const side of [t.from, t.to]) {
        if (!side) continue;
        sides++;
        if (/\/74\.png/.test(side.countryFlag || '')) israelClubs.add(side.clubName || '');
      }
    }
    // A valid response with transfer rows but zero country flags is also
    // suspicious — treat as inconclusive rather than declaring "never".
    if (j.transfers.length > 0 && sides === 0) return null;
    return {
      israelHistory: israelClubs.size ? 'played' : 'never',
      israelClubs: [...israelClubs].filter(Boolean),
      transferCount: j.transfers.length,
    };
  } catch (e) {
    return null; // retried on a later run
  }
}

// ───────────────────── Email digest ─────────────────────
function buildEmail(newOnes) {
  const gold = '#C9A84C', dark = '#16201A';
  const label = { 0: '🇮🇱 Israeli citizenship', 1: '🕎 Strong name match', 2: '❔ Possible name match' };
  const groups = [0, 1, 2].map(t => ({ t, items: newOnes.filter(p => p.tier === t) })).filter(g => g.items.length);
  let rows = '';
  for (const g of groups) {
    rows += `<tr><td style="padding:16px 0 4px;font:700 13px Arial;color:${gold};text-transform:uppercase;letter-spacing:.04em">${label[g.t]} (${g.items.length})</td></tr>`;
    for (const p of g.items) {
      rows += `<tr><td><div style="border-left:3px solid ${g.t === 0 ? '#4A90D9' : gold};background:#faf8f2;border-radius:6px;padding:10px 14px;margin:5px 0">
        <div style="font:600 14px Arial;color:#1c1c1c"><a href="${p.tmUrl}" style="color:#1c1c1c;text-decoration:none">${p.name}</a>${p.age ? ` · ${p.age}` : ''}${p.position ? ` · ${p.position}` : ''}</div>
        <div style="font:12px Arial;color:#666;margin-top:2px">${[p.club, p.clubCountry, p.marketValue].filter(Boolean).join(' · ')}</div>
        <div style="font:11px Arial;color:#999;margin-top:2px">${p.matchedOn} · <a href="${p.tmUrl}" style="color:${gold}">Transfermarkt ↗</a></div>
      </div></td></tr>`;
    }
  }
  return `<div style="max-width:620px;margin:0 auto;font-family:Arial"><div style="background:${dark};padding:20px 24px;border-radius:12px 12px 0 0"><div style="font:700 22px Georgia,serif;color:${gold}">Gold A&amp;S</div><div style="font:12px Arial;color:#9bbf9d;letter-spacing:.1em;text-transform:uppercase;margin-top:2px">TM Watch · ${newOnes.length} new candidate${newOnes.length === 1 ? '' : 's'}</div></div><div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:8px 24px 20px"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table><div style="font:11px Arial;color:#aaa;padding-top:12px">Review at goldas-crm.netlify.app → Jewish → TM Watch</div></div></div>`;
}

// ───────────────────── Main ─────────────────────
async function run() {
  const log = [];
  const db = getDb();
  const metaRef = db.collection('app_meta').doc('tmWatch');
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() : {};

  // Re-entrancy guard: skip if a run started < 20 minutes ago.
  const startedAt = meta.runStartedAt ? meta.runStartedAt.toMillis?.() ?? 0 : 0;
  if (meta.running && Date.now() - startedAt < 20 * 60 * 1000) {
    return { statusCode: 200, body: 'already running' };
  }
  await metaRef.set({ running: true, runStartedAt: admin.firestore.Timestamp.now() }, { merge: true });

  try {
    const existingSnap = await db.collection('tmWatch').get();
    const existing = new Map(existingSnap.docs.map(d => [d.id, d.data()]));
    const existingIds = new Set(existing.keys());

    // Track A
    const abroad = await scanCitizenshipTrack(log);

    // Track B
    const { candidates, nextCursor } = await scanNameTrack(meta, existingIds, log);
    const verified = [];
    let fetches = 0;
    const cap = meta.profileFetchCap || DEFAULTS.profileFetchCap;
    for (const cand of candidates.values()) {
      if (abroad.has(cand.tmId)) continue;
      if (fetches >= cap) break;
      fetches++;
      const v = await verifyCandidate(cand, log);
      if (v && !v.verifyFailed) verified.push(v);
    }
    log.push(`Track B: ${fetches} profiles verified, ${verified.length} passed`);

    // League tier resolution — one competition-page fetch per league, cached
    // forever in app_meta/tmLeagues ({ code: { name, tier } }).
    const leagueCacheRef = db.collection('app_meta').doc('tmLeagues');
    const leagueCache = (await leagueCacheRef.get()).data() || {};
    const wanted = new Map();
    for (const p of [...abroad.values(), ...verified]) {
      if (p.leagueCode && p.leagueTier == null && !(p.leagueCode in leagueCache)) {
        wanted.set(p.leagueCode, p.league || '');
      }
    }
    let leagueFetches = 0;
    for (const [code, lname] of wanted) {
      if (leagueFetches >= 25) break;
      leagueFetches++;
      try {
        const html = await fetchHtml(`${TM_BASE}/x/startseite/wettbewerb/${code}`);
        const m = /League level:?[\s\S]{0,300}?(First|Second|Third|Fourth|Fifth|Sixth)\s+Tier/i.exec(html);
        leagueCache[code] = {
          name: lname,
          tier: m ? ({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }[m[1].toLowerCase()] || null) : null,
        };
      } catch (e) { leagueCache[code] = { name: lname, tier: null }; }
    }
    if (leagueFetches) await leagueCacheRef.set(leagueCache, { merge: true });
    log.push(`Leagues: ${leagueFetches} fetched, ${Object.keys(leagueCache).length} cached`);
    const applyTier = (p) => {
      if (p.leagueTier == null && p.leagueCode && leagueCache[p.leagueCode]) {
        p.leagueTier = leagueCache[p.leagueCode].tier;
      }
      return p;
    };
    abroad.forEach(applyTier);
    verified.forEach(applyTier);

    // Merge + diff
    const now = admin.firestore.Timestamp.now();
    const newOnes = [];
    const writes = [];
    const seenThisRun = new Set();

    const upsert = (p) => {
      seenThisRun.add(p.tmId);
      const prev = existing.get(p.tmId);
      const ref = db.collection('tmWatch').doc(p.tmId);
      if (!prev) {
        newOnes.push(p);
        writes.push(ref.set({
          ...p, status: 'new', starred: false, activeAbroad: true,
          firstSeen: now, lastSeen: now,
        }));
      } else {
        const upgraded = prev.matchType !== 'citizenship' && p.matchType === 'citizenship';
        if (upgraded && prev.status !== 'dismissed') newOnes.push({ ...p, upgraded: true });
        writes.push(ref.set({
          name: p.name, tmUrl: p.tmUrl,
          club: p.club || prev.club || '', clubCountry: p.clubCountry || prev.clubCountry || '',
          league: p.league || prev.league || '',
          leagueCode: p.leagueCode || prev.leagueCode || '',
          leagueTier: p.leagueTier ?? prev.leagueTier ?? null,
          contractUntil: p.contractUntil || prev.contractUntil || '',
          position: p.position || prev.position || '',
          citizenships: p.citizenships?.length ? p.citizenships : prev.citizenships || [],
          marketValue: p.marketValue || prev.marketValue || '',
          age: p.age || prev.age || null,
          matchType: upgraded ? 'citizenship' : prev.matchType,
          tier: upgraded ? 0 : Math.min(prev.tier ?? 2, p.tier ?? 2),
          matchedOn: upgraded ? p.matchedOn : prev.matchedOn,
          activeAbroad: true, lastSeen: now,
          ...(upgraded && prev.status === 'seen' ? { status: 'new' } : {}),
        }, { merge: true }));
      }
    };
    abroad.forEach(upsert);
    verified.forEach(upsert);

    // Citizenship players who vanished from the abroad list (moved to Israel,
    // retired, or lost the flag) — mark inactive, keep the record.
    for (const [id, prev] of existing) {
      if (prev.matchType === 'citizenship' && prev.activeAbroad !== false && !seenThisRun.has(id)) {
        writes.push(db.collection('tmWatch').doc(id).set({ activeAbroad: false, lastSeen: now }, { merge: true }));
      }
    }
    await Promise.all(writes);

    // Backfill Israel career history for docs that don't have it yet
    // (existing + just-created), capped per run.
    const histCap = meta.historyChecksPerRun || 40;
    const needHistory = [];
    for (const [id, prev] of existing) {
      // transferCount was added with the hardened checker — entries written
      // before it exists are re-verified once with the strict logic.
      if (prev.israelHistory == null || prev.transferCount == null) needHistory.push(id);
    }
    for (const p of newOnes) {
      if (!p.upgraded && !existing.has(p.tmId)) needHistory.push(p.tmId);
    }
    let histChecked = 0, histNever = 0, histPlayed = 0, histFailed = 0;
    const histWrites = [];
    for (const id of needHistory) {
      if (histChecked >= histCap) break;
      histChecked++;
      const h = await checkIsraelHistory(id);
      if (h) {
        if (h.israelHistory === 'never') histNever++; else histPlayed++;
        histWrites.push(db.collection('tmWatch').doc(id).set({
          ...h, historyCheckedAt: now,
        }, { merge: true }));
      } else histFailed++;
    }
    await Promise.all(histWrites);
    log.push(`History: ${histChecked} checked (never ${histNever} / played ${histPlayed} / failed ${histFailed}), ${needHistory.length - histChecked} remaining`);

    // Email digest for genuinely new/upgraded candidates.
    if (newOnes.length && process.env.GMAIL_APP_PASSWORD) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: OWNER_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
      });
      await transporter.sendMail({
        from: `"Gold A&S TM Watch" <${OWNER_EMAIL}>`,
        to: OWNER_EMAIL,
        subject: `TM Watch — ${newOnes.length} new candidate${newOnes.length === 1 ? '' : 's'}`,
        html: buildEmail(newOnes),
      });
      log.push(`Email sent (${newOnes.length} new)`);
    }

    await metaRef.set({
      running: false, cursor: nextCursor,
      lastRunAt: now, lastRunLog: log.slice(0, 40).join(' | '),
      lastRunRequests: REQUEST_COUNT, lastRunNew: newOnes.length,
      totalTracked: existingIds.size + newOnes.filter(p => !p.upgraded).length,
    }, { merge: true });

    console.log(log.join('\n'));
    return { statusCode: 200, body: `ok: ${newOnes.length} new, ${REQUEST_COUNT} requests` };
  } catch (e) {
    await metaRef.set({ running: false, lastError: String(e), lastRunAt: admin.firestore.Timestamp.now() }, { merge: true });
    console.error('tm-watch failed:', e);
    return { statusCode: 500, body: String(e) };
  }
}

exports.handler = async () => run();
