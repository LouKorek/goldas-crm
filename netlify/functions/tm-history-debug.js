// Diagnostic for the "played in Israel" check.
//
// The detection has been wrong twice, and Transfermarkt cannot be opened from
// here to see why — so this returns exactly what the collector sees for one
// player: which page loaded, how big it was, and how many of each signal it
// found. Read-only, one player at a time, no writes.
//
//   /.netlify/functions/tm-history-debug?id=796662

const cheerio = require('cheerio');

const TM_BASE = 'https://www.transfermarkt.com';
const ISR_COMP = /\/wettbewerb\/isr[a-z0-9]*/gi;
const ISR_FLAG = /\/74\.png/g;

function headers() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

async function grab(url) {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  const out = { url, via: 'direct' };
  try {
    const r = await fetch(url, { headers: headers() });
    out.status = r.status;
    if (r.ok) return { ...out, html: await r.text() };
  } catch (e) { out.status = `error: ${String(e.message || e).slice(0, 80)}`; }

  if (!apiKey) return { ...out, html: '' };
  try {
    const r = await fetch(
      `https://api.scraperapi.com/?${new URLSearchParams({ api_key: apiKey, url }).toString()}`,
      { headers: headers() });
    return { ...out, via: 'proxy', proxyStatus: r.status, html: r.ok ? await r.text() : '' };
  } catch (e) {
    return { ...out, via: 'proxy', proxyStatus: `error: ${String(e.message || e).slice(0, 80)}`, html: '' };
  }
}

function analyse(html, tmId) {
  if (!html) return { loaded: false };
  const $ = cheerio.load(html);
  const tables = $('table.items');

  const compHrefs = new Set();
  $('a[href*="/wettbewerb/"]').each((_, a) => {
    const h = $(a).attr('href') || '';
    if (/\/wettbewerb\/isr/i.test(h)) compHrefs.add(h);
  });
  const compInTables = new Set();
  tables.find('a[href*="/wettbewerb/"]').each((_, a) => {
    const h = $(a).attr('href') || '';
    if (/\/wettbewerb\/isr/i.test(h)) compInTables.add(h);
  });
  let flagsInTables = 0;
  tables.find('img').each((_, i) => {
    const s = $(i).attr('src') || $(i).attr('data-src') || '';
    if (/\/74\.png/.test(s)) flagsInTables++;
  });

  return {
    loaded: true,
    htmlLength: html.length,
    isThisPlayer: html.includes(`/spieler/${tmId}`),
    looksLikeChallenge: /captcha|are you a human|access denied/i.test(html.slice(0, 4000)),
    tableCount: tables.length,
    tableRows: tables.find('tbody > tr').length,
    isrCompAnywhere: (html.match(ISR_COMP) || []).length,
    isrFlagAnywhere: (html.match(ISR_FLAG) || []).length,
    isrCompLinks: [...compHrefs].slice(0, 8),
    isrCompLinksInTables: [...compInTables].slice(0, 8),
    isrFlagsInTables: flagsInTables,
    // The season selector tells us whether we are looking at one season or all.
    seasonOptions: $('select[name="saison"] option').length,
  };
}

exports.handler = async (event) => {
  const tmId = (event.queryStringParameters || {}).id;
  if (!/^\d+$/.test(tmId || '')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'pass ?id=<transfermarkt player id>' }) };
  }

  const candidates = [
    `${TM_BASE}/x/leistungsdaten/spieler/${tmId}/plus/1`,
    `${TM_BASE}/x/leistungsdaten/spieler/${tmId}/plus/1?saison=ges`,
    `${TM_BASE}/x/profil/spieler/${tmId}`,
    `${TM_BASE}/x/transfers/spieler/${tmId}`,
  ];

  const report = [];
  for (const url of candidates) {
    const got = await grab(url);
    report.push({
      url: got.url, via: got.via, status: got.status, proxyStatus: got.proxyStatus,
      ...analyse(got.html, tmId),
    });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tmId, report }, null, 2),
  };
};
