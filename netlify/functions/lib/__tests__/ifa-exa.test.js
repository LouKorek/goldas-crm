// The server-side reader of football.org.il (lib/ifa-exa.js): the fixture
// list parsed from the text Exa returns, the payload shaped like the browser
// sync's, the two doors (Contents API with a key, public MCP without), and
// the quiet-hours rule Golda derives from the schedule.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../ifa-exa.js');
const { viaOf } = require('../../ifa-import-background.js');

// Exa's text of /team-details/team-games/?team_id=1146, 23.10.2026 (trimmed).
const HE_PAGE = `# ההתאחדות לכדורגל בישראל - כל משחקי קבוצה
URL: https://www.football.org.il/team-details/team-games/?team_id=1146

## רשימת המשחקים

תאריך משחק אצטדיון שעה תוצאה

תאריך 17/08/2026

משחקמכבי נתניה שלומי - מכבי פ"ת עסיסי דוד

אצטדיוןנתניה בית מכבי נתניה

שעה 19:45

תוצאה 1-2

תאריך 14/10/2026

משחקהפ' חיפה רובי - מכבי פ"ת עסיסי דוד

אצטדיוןקרית חיים בית נגלר מזרחי (אתוס לשעבר)

שעה 14:30

תאריך 24/10/2026

משחקמכבי פ"ת עסיסי דוד - הפ' ת"א ניסנוב

תאריך 31/10/2026

משחקחופשית - מכבי פ"ת עסיסי דוד

תאריך 05/12/2026

משחקבית"ר י-ם אורן - מכבי פ"ת עסיסי דוד

משחקמכבי פ"ת עסיסי דוד - מכבי הרצליה י כהנא

## פרטי התקשרות

אצטדיון רמת גן. ת.ד. 10030
`;

const EN_PAGE = `## כל המשחקים של קבוצה

Date Game Stadium Time Result

Date 10/21/2026

Game Bney Yehuda Tel Aviv - Maccabi Petah Tikva Asis David

Stadium Sporteck South 1 Grass

Time 8:00 PM

Result 0-5

Date 10/24/2026

Game Maccabi Petah Tikva Asis David - Hapoel Tel Aviv

Stadium Ha-moshava

Time 12:40 PM

Result
`;

test('Hebrew fixture rows are parsed from the text, byes dropped, a dateless second game inherits the date', () => {
  const fx = X.parseFixturesText(HE_PAGE, false);
  assert.deepEqual(fx.map((f) => [f.date, f.homeTeam, f.awayTeam, f.time, f.stadiumName]), [
    ['2026-08-17', 'מכבי נתניה שלומי', 'מכבי פ"ת עסיסי דוד', '19:45', 'נתניה בית מכבי נתניה'],
    ['2026-10-14', "הפ' חיפה רובי", 'מכבי פ"ת עסיסי דוד', '14:30', 'קרית חיים בית נגלר מזרחי (אתוס לשעבר)'],
    ['2026-10-24', 'מכבי פ"ת עסיסי דוד', "הפ' ת\"א ניסנוב", '', ''],
    ['2026-12-05', 'בית"ר י-ם אורן', 'מכבי פ"ת עסיסי דוד', '', ''],
    ['2026-12-05', 'מכבי פ"ת עסיסי דוד', 'מכבי הרצליה י כהנא', '', ''],
  ]);
  assert.equal(fx[0].sourceMatchId, '2026-08-17|מכבי נתניה שלומי|מכבי פ"ת עסיסי דוד');
  assert.equal(fx[0].season, '2026-27');
  assert.ok(X.looksLikeFixturesPage(HE_PAGE));
});

test('English pages: M/D/YYYY dates and 12-hour times', () => {
  const fx = X.parseFixturesText(EN_PAGE, true);
  assert.deepEqual(fx.map((f) => [f.date, f.time, f.homeTeam]), [
    ['2026-10-21', '20:00', 'Bney Yehuda Tel Aviv'],
    ['2026-10-24', '12:40', 'Maccabi Petah Tikva Asis David'],
  ]);
});

test('a Cloudflare page or a page without the list is not a fixtures page', () => {
  assert.ok(!X.looksLikeFixturesPage('## Contact details\n- Ramat Gan Stadium'));
  assert.ok(X._internal.isChallenge('Just a moment... Enable JavaScript and cookies to continue'));
  assert.equal(X.parseFixturesText('nothing here').length, 0);
});

test('the scrape yields a browser-shaped payload with upcoming fixtures only', async () => {
  const calls = [];
  const reader = { via: 'exa-api', fetchText: async (url) => { calls.push(url); return { text: HE_PAGE, cost: 0.001 }; } };
  const targets = [
    { id: 'p1', name: 'נועם', prefix: '/', teamId: '1146', teamFrom: 'cache' },
    { id: 'p2', name: 'חדש', prefix: '/', playerId: '9', teamId: null, teamFrom: null },
    { id: 'p3', name: 'שבור', error: 'ifa-url-invalid' },
  ];
  const now = new Date('2026-10-23T03:00:00Z');
  const payload = await X.scrapeTargets(targets, { reader, now });
  assert.equal(payload.kind, 'ga-ifa');
  assert.equal(payload.stage, 'scraped');
  assert.equal(payload.via, 'exa-api');
  assert.equal(payload.upcomingOnly, true);
  assert.deepEqual(calls, ['https://www.football.org.il/team-details/team-games/?team_id=1146']);
  assert.deepEqual(payload.pages, { count: 1, blocked: 0, failed: 0 });
  const r1 = payload.results.find((r) => r.id === 'p1');
  assert.equal(r1.gamesOk, true);
  assert.equal(r1.allFixtures, 5);
  assert.deepEqual(r1.fixtures.map((f) => f.date), ['2026-10-24', '2026-12-05', '2026-12-05']);
  assert.equal(r1.dataSeason, '2026-27');
  assert.equal(r1.gamesUrl, 'https://www.football.org.il/team-details/team-games/?team_id=1146');
  assert.equal(payload.results.find((r) => r.id === 'p2').error, 'ifa-lookup-needs-browser');
  assert.equal(payload.results.find((r) => r.id === 'p3').error, 'ifa-url-invalid');
  assert.equal(payload.costDollars, 0.001);
  assert.equal(viaOf(payload, 'browser'), 'exa-api');
  assert.equal(viaOf({ via: 'anything-else' }, 'browser'), 'browser');
});

test('a challenge page counts as blocked, a failed fetch as failed, neither as readable', async () => {
  let n = 0;
  const reader = { via: 'exa-mcp', fetchText: async () => { n++; if (n === 1) return { text: 'Just a moment...' }; throw new Error('boom'); } };
  const targets = [{ id: 'a', name: 'a', prefix: '/', teamId: '1' }, { id: 'b', name: 'b', prefix: '/', teamId: '2' }];
  const payload = await X.scrapeTargets(targets, { reader, log: () => {} });
  assert.deepEqual(payload.pages, { count: 2, blocked: 1, failed: 1 });
  assert.equal(payload.results[0].gamesOk, false);
  assert.equal(payload.results[1].error, 'ifa-page-unreadable');
});

test('with EXA_API_KEY the Contents API is used; without it the public MCP server', async () => {
  const seen = [];
  const apiFetch = async (url, opts) => {
    seen.push({ url, key: opts.headers['x-api-key'], body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ text: HE_PAGE }], costDollars: { total: 0.001 } }) };
  };
  const api = X.makeReader({ env: { EXA_API_KEY: 'k' }, fetchImpl: apiFetch });
  assert.equal(api.via, 'exa-api');
  const r = await api.fetchText('https://www.football.org.il/x');
  assert.equal(r.text, HE_PAGE);
  assert.equal(seen[0].url, 'https://api.exa.ai/contents');
  assert.equal(seen[0].key, 'k');
  assert.deepEqual(seen[0].body.urls, ['https://www.football.org.il/x']);
  assert.equal(seen[0].body.livecrawl, 'always');

  // MCP: initialize → (notification) → tools/list → tools/call, JSON or SSE.
  const rpc = [];
  const mcpFetch = async (url, opts) => {
    const msg = JSON.parse(opts.body);
    rpc.push({ method: msg.method, sid: opts.headers['mcp-session-id'] || null, args: msg.params?.arguments });
    const headers = { get: (h) => (h === 'mcp-session-id' ? 'S1' : null) };
    const answer = (result) => ({ ok: true, status: 200, headers, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n` });
    if (msg.method === 'initialize') return answer({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'exa' } });
    if (msg.method === 'notifications/initialized') return { ok: true, status: 202, headers, text: async () => '' };
    if (msg.method === 'tools/list') return answer({ tools: [
      { name: 'web_search_exa', inputSchema: { properties: { query: {} } } },
      { name: 'web_fetch_exa', inputSchema: { properties: { urls: {}, maxCharacters: {} } } },
    ] });
    if (msg.method === 'tools/call') return answer({ content: [{ type: 'text', text: HE_PAGE }] });
    throw new Error('unexpected ' + msg.method);
  };
  const mcp = X.makeReader({ env: {}, fetchImpl: mcpFetch });
  assert.equal(mcp.via, 'exa-mcp');
  const m = await mcp.fetchText('https://www.football.org.il/y');
  assert.equal(m.text, HE_PAGE);
  assert.deepEqual(rpc.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.equal(rpc[3].sid, 'S1');
  assert.deepEqual(rpc[3].args, { urls: ['https://www.football.org.il/y'], maxCharacters: 10000 });
  await mcp.fetchText('https://www.football.org.il/z');
  assert.equal(rpc.length, 5, 'the session is initialised once per run');
});

test('parseRpc reads plain JSON and SSE frames alike', () => {
  assert.equal(X._internal.parseRpc('{"jsonrpc":"2.0","id":1,"result":{"a":1}}').result.a, 1);
  assert.equal(X._internal.parseRpc('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":2}}\n\n').result.a, 2);
  assert.equal(X._internal.parseRpc(''), null);
});

test("Golda's quiet threshold follows the schedule: daily → 36h, Sun/Mon/Thu/Fri → 84h", () => {
  assert.equal(X.quietHours({ days: [0, 1, 2, 3, 4, 5, 6] }), 36);
  assert.equal(X.quietHours({ days: [0, 1, 4, 5] }), 3 * 24 + 12);
  assert.equal(X.quietHours({ days: [1] }), 7 * 24 + 12);
  assert.equal(X.quietHours(), 36);
  assert.equal(X.SCHEDULE.cron, '0 3 * * *');
});
