// Reads football.org.il from the server, through Exa.
//
// football.org.il answers datacenter IPs with a Cloudflare 403, which is why
// the Israeli fixtures were read by Chrome on Lou's computer (the "browser
// sync"). Exa (exa.ai) keeps a crawled, live-refreshable copy of public pages
// and hands the page back as clean text, so the CRM's own functions can read
// the fixture list without any computer being on.
//
// Two doors, in this order:
//   1. EXA_API_KEY set on Netlify → POST https://api.exa.ai/contents
//      (the "Contents" endpoint, $1 per 1,000 pages; the free plan carries
//      $10 of credit a month, about 20 pages a run here).
//   2. no key → Exa's public MCP server, https://mcp.exa.ai/mcp, the same
//      service the Claude connector uses, spoken over JSON-RPC.
//
// The page comes back as text, not HTML, so the fixture rows are parsed from
// the label/value lines Exa emits ("תאריך 17/08/2026", "משחק א - ב", ...),
// through the same ifaFixtureFromCells the browser and the server sync use.
// Text carries no links, so a fixture's id is "date|home|away" rather than
// the IFA game id; the import resolves those to existing records by identity
// for upcoming matches, which is why this reader hands over upcoming matches
// only (past ones are frozen history and already in the CRM).
//
// The club register and the player page are not read here: resolving a
// player URL to a squad needs the links on those pages. A target whose squad
// is not yet known (no team link, pin or this season's cache) is reported as
// `ifa-lookup-needs-browser`; the Chrome routine, when it runs, resolves it
// and the cache then serves the server for the rest of the season.

const T = require('../../../apps/web/public/tools/ifa-text.js');

const API_URL = 'https://api.exa.ai/contents';
const MCP_URL = 'https://mcp.exa.ai/mcp';
const IFA_ORIGIN = 'https://www.football.org.il';
const PAGE_TIMEOUT_MS = 60000;
const GAP_MS = 400;
const MAX_CHARS = 10000;

// When the server sync runs (Netlify cron, UTC). 05:00 Israel in winter,
// 06:00 in summer. Days are cron's: 0 = Sunday.
const SCHEDULE = { cron: '0 3 * * *', days: [0, 1, 2, 3, 4, 5, 6] };

// How long Golda waits before calling the sync quiet: the longest gap between
// two scheduled runs, plus half a day of slack.
function quietHours(schedule = SCHEDULE) {
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  if (!days.length) return 36;
  let gap = 1;
  for (let i = 0; i < days.length; i++) {
    const next = days[(i + 1) % days.length];
    const d = ((next - days[i]) + 7) % 7 || 7;
    gap = Math.max(gap, d);
  }
  return gap * 24 + 12;
}

const isChallenge = (s) => /Just a moment|cf-browser-verification|Attention Required|Enable JavaScript and cookies/i.test(s || '');

// ───────────────────── door 1: the Contents API ─────────────────────
async function fetchViaApi(url, { apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ urls: [url], text: { maxCharacters: MAX_CHARS }, livecrawl: 'always', livecrawlTimeout: 30000 }),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`exa api ${res.status}: ${body.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(body); } catch { throw new Error('exa api: not json'); }
  const r = (j.results || [])[0];
  if (!r) throw new Error(`exa api: no result (${JSON.stringify(j.statuses || j.error || '').slice(0, 200)})`);
  return { text: String(r.text || ''), cost: j.costDollars?.total ?? null };
}

// ───────────────────── door 2: the public MCP server ─────────────────────
// Streamable HTTP: every call is a POST carrying one JSON-RPC message; the
// answer is JSON or a short SSE stream whose `data:` lines hold the JSON.
function parseRpc(body) {
  const s = String(body || '').trim();
  if (!s) return null;
  if (s[0] === '{' || s[0] === '[') { try { return JSON.parse(s); } catch { return null; } }
  let last = null;
  for (const line of s.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { const m = JSON.parse(line.slice(5).trim()); if (m && (m.result || m.error)) last = m; } catch { /* keep going */ }
  }
  return last;
}

class McpClient {
  constructor({ fetchImpl = fetch, url = MCP_URL } = {}) {
    this.fetchImpl = fetchImpl; this.url = url; this.session = null; this.id = 0; this.tool = null;
  }
  async rpc(method, params, { notify = false } = {}) {
    const msg = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.session) headers['mcp-session-id'] = this.session;
    const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    const sid = res.headers?.get?.('mcp-session-id');
    if (sid) this.session = sid;
    const body = await res.text();
    if (notify) return null;
    if (!res.ok) throw new Error(`exa mcp ${method} ${res.status}: ${body.slice(0, 200)}`);
    const m = parseRpc(body);
    if (!m) throw new Error(`exa mcp ${method}: empty answer`);
    if (m.error) throw new Error(`exa mcp ${method}: ${m.error.message || JSON.stringify(m.error).slice(0, 200)}`);
    return m.result;
  }
  async init() {
    if (this.tool) return this.tool;
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'goldas-crm', version: '1.0' } });
    await this.rpc('notifications/initialized', {}, { notify: true }).catch(() => {});
    const list = await this.rpc('tools/list', {});
    const tools = list?.tools || [];
    const tool = tools.find((t) => /fetch|crawl/i.test(t.name)) || tools.find((t) => /contents/i.test(t.name));
    if (!tool) throw new Error(`exa mcp: no fetch tool among ${tools.map((t) => t.name).join(', ') || 'none'}`);
    const props = tool.inputSchema?.properties || {};
    this.tool = { name: tool.name, urlsKey: props.urls ? 'urls' : (props.url ? 'url' : 'urls'), maxKey: props.maxCharacters ? 'maxCharacters' : null };
    return this.tool;
  }
  async fetchText(url) {
    const tool = await this.init();
    const args = { [tool.urlsKey]: tool.urlsKey === 'urls' ? [url] : url };
    if (tool.maxKey) args[tool.maxKey] = MAX_CHARS;
    const result = await this.rpc('tools/call', { name: tool.name, arguments: args });
    const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (result?.isError) throw new Error(`exa mcp tool: ${text.slice(0, 200)}`);
    return { text, cost: null };
  }
}

// One reader for a run: API when there is a key, MCP otherwise.
function makeReader({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = (env.EXA_API_KEY || '').trim();
  if (apiKey) return { via: 'exa-api', fetchText: (url) => fetchViaApi(url, { apiKey, fetchImpl }) };
  const mcp = new McpClient({ fetchImpl });
  return { via: 'exa-mcp', fetchText: (url) => mcp.fetchText(url) };
}

// ───────────────────── the fixture list, from text ─────────────────────
const LABELS = {
  he: { date: 'תאריך', game: 'משחק', stadium: 'אצטדיון', time: 'שעה', result: 'תוצאה' },
  en: { date: 'Date', game: 'Game', stadium: 'Stadium', time: 'Time', result: 'Result' },
};

function looksLikeFixturesPage(text) {
  return /רשימת המשחקים|כל המשחקים של קבוצה|תאריך\s*\d{1,2}\/\d{1,2}\/\d{4}|Date\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(text || '');
}

// Lines of the form "<label><value>" or "<label> <value>", one cell each; a
// new row starts at a date line. Labels and dates: Hebrew DD/MM/YYYY on the
// default pages, English M/D/YYYY under /en/.
function parseFixturesText(text, isEnglish = false) {
  const L = isEnglish ? LABELS.en : LABELS.he;
  const keys = ['date', 'game', 'stadium', 'time', 'result'];
  const rows = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // A heading after the rows began is the end of the list (contact details
    // and cookie notices follow it on the real page).
    if (rows.length && /^#/.test(line)) break;
    let hit = null;
    for (const k of keys) {
      const label = L[k];
      if (line.startsWith(label)) {
        const value = line.slice(label.length).trim();
        if (k === 'date' && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) continue;
        hit = { k, label, value };
        break;
      }
    }
    if (!hit) continue;
    if (hit.k === 'date') { cur = {}; rows.push(cur); }
    if (!cur) continue;
    if (hit.k === 'game' && cur[hit.label]) {
      // A row without its own date line (a second game on the same date on
      // the page) opens a new row that inherits the date.
      cur = { [L.date]: cur[L.date] }; rows.push(cur);
    }
    cur[hit.label] = hit.value;
  }
  const out = [], seen = new Set();
  for (const cells of rows) {
    const fx = T.ifaFixtureFromCells(cells, '', isEnglish);
    if (fx && !seen.has(fx.sourceMatchId)) { seen.add(fx.sourceMatchId); out.push(fx); }
  }
  return out;
}

// ───────────────────── the scrape ─────────────────────
// Produces the same payload GA_SCRAPE leaves in window.name, so the import
// function treats a server read exactly like a browser read.
async function scrapeTargets(targets, { reader, now = new Date(), log = () => {} } = {}) {
  const t0 = Date.now();
  const pages = { count: 0, blocked: 0, failed: 0 };
  const todayStr = now.toISOString().slice(0, 10);
  const results = [];
  let costDollars = 0;
  let last = 0;
  for (const t of targets) {
    const out = { id: t.id, name: t.name, teamFrom: t.teamFrom || null };
    if (t.error) { results.push({ ...out, error: t.error }); continue; }
    if (!t.teamId) { results.push({ ...out, error: 'ifa-lookup-needs-browser', detail: 'הקבוצה טרם זוהתה; הזיהוי נעשה מהדפדפן או בקישור לקבוצה' }); continue; }
    const prefix = t.prefix || '/';
    const isEnglish = prefix === '/en/';
    const gamesUrl = `${IFA_ORIGIN}${prefix}team-details/team-games/?team_id=${encodeURIComponent(t.teamId)}`;
    out.teamId = String(t.teamId);
    out.gamesUrl = gamesUrl;
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    pages.count++;
    let text = '';
    try {
      const r = await reader.fetchText(gamesUrl);
      text = r.text || '';
      if (typeof r.cost === 'number') costDollars += r.cost;
    } catch (e) {
      pages.failed++;
      log(`[ifa-exa] ${t.name}: ${String(e.message || e).slice(0, 200)}`);
      results.push({ ...out, gamesOk: false, error: 'ifa-page-unreadable', detail: String(e.message || e).slice(0, 120) });
      continue;
    }
    if (isChallenge(text)) { pages.blocked++; results.push({ ...out, gamesOk: false }); continue; }
    if (!looksLikeFixturesPage(text)) { pages.failed++; results.push({ ...out, gamesOk: false, detail: 'no fixture list in page text' }); continue; }
    const all = parseFixturesText(text, isEnglish);
    const seasons = {};
    all.forEach((f) => { seasons[f.season] = (seasons[f.season] || 0) + 1; });
    out.gamesOk = true;
    out.allFixtures = all.length;
    out.fixtures = all.filter((f) => f.date >= todayStr);
    out.dataSeason = Object.entries(seasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    results.push(out);
  }
  return {
    kind: 'ga-ifa', stage: 'scraped', scrapedAt: now.toISOString(), ms: Date.now() - t0,
    via: reader.via, upcomingOnly: true, costDollars: costDollars || null,
    pages, results, clubIndex: null, clubIndexFetched: false,
  };
}

module.exports = {
  SCHEDULE, quietHours, makeReader, scrapeTargets, parseFixturesText, looksLikeFixturesPage,
  _internal: { parseRpc, McpClient, fetchViaApi, isChallenge },
};
