// Investigation tool for the Transfermarkt parsers.
//
// Transfermarkt is unreachable from Lou's network and from the dev sandbox —
// only a Netlify function can see it. Each blind guess at the markup costs a
// deploy, so this fetches any transfermarkt.com URL and reports what is
// actually there: final URL after redirects, size, element counts for a set
// of candidate selectors, and the raw HTML around whatever pattern is asked
// for. That makes the next parser a reading exercise rather than a guess.
//
//   /.netlify/functions/tm-history-debug?url=<encoded transfermarkt url>
//   &find=<regex>        pattern to show in context (default: Israel)
//   &raw=<n>             also return the first n characters of the body
//
// Restricted to transfermarkt.com so this cannot be used to fetch anything
// else, and it only ever reads.

const cheerio = require('cheerio');

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*transfermarkt\.(com|co\.[a-z]{2}|de)\//i;

function headers(url) {
  const json = url.includes('/ceapi/');
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(json ? { 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.transfermarkt.com/' } : {}),
  };
}

async function grab(url) {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  try {
    const r = await fetch(url, { headers: headers(url) });
    if (r.ok) return { via: 'direct', status: r.status, finalUrl: r.url, body: await r.text() };
    if (!apiKey) return { via: 'direct', status: r.status, body: '' };
  } catch (e) {
    if (!apiKey) return { via: 'direct', status: `error: ${String(e.message || e).slice(0, 80)}`, body: '' };
  }
  const r = await fetch(
    `https://api.scraperapi.com/?${new URLSearchParams({ api_key: apiKey, url }).toString()}`,
    { headers: headers(url) });
  return { via: 'proxy', status: r.status, body: r.ok ? await r.text() : '' };
}

// Candidate hooks for the club / competition / season data, old and new.
const SELECTORS = {
  'table.items': 'table.items',
  'any table': 'table',
  'tbody tr': 'tbody > tr',
  'a /verein/': 'a[href*="/verein/"]',
  'a /wettbewerb/': 'a[href*="/wettbewerb/"]',
  'img flaggenrahmen': 'img.flaggenrahmen',
  'any img': 'img',
  'grid cells': '[class*="grid"]',
  'transfer-ish class': '[class*="transfer"]',
  'tm-* components': '[class^="tm-"]',
  'data-* islands': '[data-props], [data-component], [data-react-props]',
  'script type=json': 'script[type="application/json"], script[type="application/ld+json"]',
};

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const url = q.url || '';
  if (!ALLOWED.test(url)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'pass ?url= a https://…transfermarkt.com/… address' }) };
  }

  const got = await grab(url);
  const body = got.body || '';
  const out = { url, via: got.via, status: got.status, finalUrl: got.finalUrl, length: body.length };

  if (body) {
    try {
      const $ = cheerio.load(body);
      out.selectors = Object.fromEntries(
        Object.entries(SELECTORS).map(([k, sel]) => [k, $(sel).length]));
      out.title = $('title').first().text().trim().slice(0, 120);
      // Distinct class names, most frequent first — the quickest way to see
      // what the new markup calls things.
      const freq = new Map();
      $('[class]').each((_, el) => {
        String($(el).attr('class') || '').split(/\s+/).filter(Boolean)
          .forEach(c => freq.set(c, (freq.get(c) || 0) + 1));
      });
      out.topClasses = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
        .map(([c, n]) => `${c}×${n}`);
    } catch (e) { out.parseError = String(e.message || e).slice(0, 120); }

    const pattern = q.find || 'Israel';
    try {
      const re = new RegExp(pattern, 'gi');
      const hits = [];
      let m;
      while ((m = re.exec(body)) && hits.length < 8) {
        hits.push(body.slice(Math.max(0, m.index - 170), m.index + 170).replace(/\s+/g, ' '));
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      out.matches = { pattern, count: (body.match(re) || []).length, context: hits };
    } catch (e) { out.matchError = String(e.message || e).slice(0, 120); }

    const raw = Math.min(Number(q.raw) || 0, 6000);
    if (raw) out.raw = body.slice(0, raw);
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
