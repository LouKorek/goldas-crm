// What Golda's model calls cost: the price of one answer, the day's ledger,
// the ceiling on the work she starts by herself, the one notice to the
// owner, and the admin's meter.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fakeDb, stubFirestore, recorder, OWNER } = require('./fake-firestore.js');

let db = null;
stubFirestore(() => db);

const cost = require('../golda-cost.js');
const sc = require('../golda-scouting.js');

const NOW = Date.parse('2026-11-25T10:00:00Z');   // 12:00 in Israel
const DAY = '2026-11-25';
const M = 1e6;
const OPUS = 'claude-opus-5-5';
const quietly = async (fn) => { const warn = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = warn; } };

test('one answer is priced from its tokens: input, output, cache read, both cache writes and web searches', () => {
  assert.deepEqual(cost.priceOf({ model: OPUS, usage: { input_tokens: M, output_tokens: 0 } }), { usd: 4, estimated: false });
  assert.deepEqual(cost.priceOf({ model: OPUS, usage: { output_tokens: M } }), { usd: 20, estimated: false });
  assert.equal(cost.priceOf({ model: OPUS, usage: { cache_read_input_tokens: M } }).usd, 0.2);
  assert.equal(cost.priceOf({ model: OPUS, usage: { cache_creation_input_tokens: M } }).usd, 5);
  // Of a million tokens written to the cache, 400,000 went to the one-hour cache: 0.6 × 5 + 0.4 × 8.
  assert.equal(cost.priceOf({ model: OPUS, usage: { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: 400000 } } }).usd, 6.2);
  // 1,200 in, 800 out, 50,000 read from the cache, 3 searches.
  const usage = { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 50000, server_tool_use: { web_search_requests: 3 } };
  assert.equal(cost.priceOf({ model: OPUS, usage }).usd, 0.0608);
  assert.equal(cost.priceOf({ model: OPUS, usage, searches: 0 }).usd, 0.0308, 'a count given by the caller replaces the one in the usage');
  assert.equal(cost.priceOf({ model: OPUS, searches: 5 }).usd, 0.05);
  assert.equal(cost.priceOf({ model: 'claude-opus-5', usage: { input_tokens: M, output_tokens: M } }).usd, 30);
  // The sums the agent keeps over a tool loop are spelled differently and cost the same.
  assert.equal(cost.priceOf({ model: OPUS, usage: { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 50000, searches: 3 } }).usd, 0.0608);
});

test('a model with no price in the table costs 0 and is marked as an estimate', () => {
  assert.deepEqual(cost.priceOf({ model: 'some-future-model', usage: { input_tokens: M, output_tokens: M } }), { usd: 0, estimated: true });
  assert.deepEqual(cost.priceOf({ usage: { input_tokens: M } }), { usd: 0, estimated: true });
  assert.deepEqual(cost.priceOf(), { usd: 0, estimated: true });
  assert.deepEqual(cost.priceOf({ model: OPUS }), { usd: 0, estimated: false }, 'a known model that reported nothing');
});

test('every model has all five prices, and the table says when it was read', () => {
  assert.match(cost.PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  for (const [model, p] of Object.entries(cost.PRICES)) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) assert.ok(p[k] > 0, `${model}.${k}`);
  }
  assert.equal(cost.WEB_SEARCH_USD, 0.01);
});

test('several steps of one piece of work add up to one usage', () => {
  let spent = null;
  spent = cost.addUsage(spent, { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } });
  spent = cost.addUsage(spent, { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 500, cache_creation_input_tokens: 40, cache_creation: { ephemeral_1h_input_tokens: 10 } });
  spent = cost.addUsage(spent, null);
  assert.deepEqual(cost.tokensOf(spent), { input: 300, output: 40, cacheRead: 500, cacheWrite: 30, cacheWrite1h: 10, searches: 1 });
});

test('the ledger adds up over several calls and kinds, and holds numbers only', async () => {
  db = fakeDb();
  const a = await cost.record(db, { kind: 'chat', model: OPUS, usage: { input_tokens: 100000, output_tokens: 10000 }, now: NOW });               // 0.4 + 0.2
  assert.deepEqual(a, { usd: 0.6, totalUsd: 0.6 });
  const b = await cost.record(db, { kind: 'chat', model: OPUS, usage: { input_tokens: 50000 }, now: NOW });                                       // 0.2
  assert.deepEqual(b, { usd: 0.2, totalUsd: 0.8 });
  await cost.record(db, { kind: 'scouting', model: OPUS, usage: { output_tokens: 50000 }, searches: 4, now: NOW });                               // 1 + 0.04
  await cost.record(db, { kind: 'briefing', model: OPUS, usage: { output_tokens: 5000 }, now: NOW });                                             // 0.1
  await cost.record(db, { kind: 'no such kind', model: OPUS, usage: { output_tokens: 5000 }, now: NOW });                                         // 0.1, filed as "other"
  const last = await cost.record(db, { kind: 'research', model: 'some-future-model', usage: { output_tokens: 5000 }, now: NOW });                 // no price
  assert.deepEqual(last, { usd: 0, totalUsd: 2.04 });
  const day = db.read('golda_cost', DAY);
  assert.equal(day.totalUsd, 2.04);
  assert.equal(day.backgroundUsd, 1.14, 'chats and briefings are not background work');
  assert.deepEqual(day.byKind, {
    chat: { usd: 0.8, calls: 2 }, scouting: { usd: 1.04, calls: 1 }, briefing: { usd: 0.1, calls: 1 }, other: { usd: 0.1, calls: 1 }, research: { usd: 0, calls: 1 },
  });
  assert.deepEqual([day.calls, day.estimatedCalls, day.warnedAt, day.cappedAt, day.updatedAt], [6, 1, null, null, NOW]);
  // Numbers all the way down: no text of any kind is kept.
  const walk = (v) => (v && typeof v === 'object' ? Object.values(v).every(walk) : v === null || typeof v === 'number');
  assert.ok(walk(day));
});

test('a new day in Israel starts a new ledger', async () => {
  db = fakeDb();
  await cost.record(db, { kind: 'chat', model: OPUS, usage: { output_tokens: 50000 }, now: Date.parse('2026-11-25T21:30:00Z') });   // 23:30 in Israel
  await cost.record(db, { kind: 'chat', model: OPUS, usage: { output_tokens: 50000 }, now: Date.parse('2026-11-25T22:30:00Z') });   // 00:30 the next day
  assert.equal(db.read('golda_cost', '2026-11-25').totalUsd, 1);
  assert.equal(db.read('golda_cost', '2026-11-26').totalUsd, 1);
});

test('the gate stops background work at the ceiling and never a chat or a briefing', async () => {
  db = fakeDb();
  assert.deepEqual(await cost.gate(db, 'scouting', { now: NOW }), { ok: true, reason: 'under the cap', spentUsd: 0, capUsd: 5 });
  await cost.record(db, { kind: 'chat', model: OPUS, usage: { output_tokens: 400000 }, now: NOW });       // 8 dollars of chats
  assert.equal((await cost.gate(db, 'scouting', { now: NOW })).ok, true, 'what chats cost does not count against the ceiling');
  await cost.record(db, { kind: 'research', model: OPUS, usage: { output_tokens: 200000 }, now: NOW });   // 4
  assert.equal((await cost.gate(db, 'radar', { now: NOW })).ok, true);
  await cost.record(db, { kind: 'scouting', model: OPUS, usage: { output_tokens: 50000 }, now: NOW });    // 1 more: 5 of 5
  for (const kind of ['scouting', 'radar', 'research', 'review', 'deal', 'other']) {
    assert.deepEqual(await cost.gate(db, kind, { now: NOW }), { ok: false, reason: 'cap reached', spentUsd: 5, capUsd: 5 }, kind);
  }
  for (const kind of ['chat', 'briefing']) {
    assert.deepEqual(await cost.gate(db, kind, { now: NOW }), { ok: true, reason: 'never capped', spentUsd: 5, capUsd: 5 }, kind);
  }
  // The next day starts from nothing.
  assert.equal((await cost.gate(db, 'scouting', { now: NOW + 24 * 3600000 })).ok, true);
});

test('the ceiling is the admin\'s: a higher one lets work go on, 0 switches it off, a bad value falls back to 5', async () => {
  db = fakeDb({ golda_cost: { [DAY]: { totalUsd: 6, backgroundUsd: 6 } } });
  assert.equal((await cost.gate(db, 'research', { now: NOW })).ok, false);
  assert.equal(await cost.setCap(db, 12.346, { by: 'lou.korek@gmail.com', now: NOW }), 12.35);
  assert.deepEqual(db.read('app_meta', 'goldaCost'), { capUsd: 12.35, updatedAt: NOW, updatedBy: 'lou.korek@gmail.com' });
  assert.deepEqual(await cost.gate(db, 'research', { now: NOW }), { ok: true, reason: 'under the cap', spentUsd: 6, capUsd: 12.35 });
  await cost.setCap(db, 0, { now: NOW });
  assert.equal((await cost.gate(fakeDb({ app_meta: { goldaCost: { capUsd: 0 } } }), 'research', { now: NOW })).ok, false, '0 of 0 is already at the ceiling');
  assert.equal((await cost.gate(fakeDb({ app_meta: { goldaCost: { capUsd: 0 } } }), 'chat', { now: NOW })).ok, true);
  for (const bad of [-1, 100.01, '7', null, NaN, Infinity]) {
    await assert.rejects(() => cost.setCap(db, bad), /capUsd must be a number from 0 to 100/);
    assert.equal(await cost.readCap(fakeDb({ app_meta: { goldaCost: { capUsd: bad } } })), 5);
  }
});

test('the owner is told once on the day the ceiling is reached, and never about a ceiling of 0', async () => {
  db = fakeDb();
  assert.equal(await cost.capNotice(db, { now: NOW }), null, 'nothing spent');
  await cost.record(db, { kind: 'scouting', model: OPUS, usage: { output_tokens: 200000 }, now: NOW });   // 4 of 5
  assert.equal(await cost.capNotice(db, { now: NOW }), null, 'under the ceiling');
  await cost.record(db, { kind: 'scouting', model: OPUS, usage: { output_tokens: 60000 }, now: NOW });    // 5.2
  const said = await cost.capNotice(db, { now: NOW + 1000 });
  assert.match(said, /תקרת העלות/);
  assert.match(said, /\(5 דולר\)/);
  assert.match(said, /שיחות ותדריכים ממשיכים כרגיל/);
  assert.equal(db.read('golda_cost', DAY).cappedAt, NOW + 1000);
  assert.equal(await cost.capNotice(db, { now: NOW + 3600000 }), null, 'the same day: said already');
  assert.equal(await cost.capNotice(db, { now: NOW + 5 * 3600000 }), null);
  // Recording after the notice keeps the stamp.
  await cost.record(db, { kind: 'chat', model: OPUS, usage: { output_tokens: 1000 }, now: NOW + 2000 });
  assert.equal(db.read('golda_cost', DAY).cappedAt, NOW + 1000);
  // A notice that could not be sent is tried again.
  await cost.capNoticeUnsent(db, { now: NOW });
  assert.match(await cost.capNotice(db, { now: NOW + 3000 }), /תקרת העלות/);
  // The next day it can be said again, once.
  const tomorrow = NOW + 24 * 3600000;
  await cost.record(db, { kind: 'research', model: OPUS, usage: { output_tokens: 300000 }, now: tomorrow });
  assert.match(await cost.capNotice(db, { now: tomorrow }), /תקרת העלות/);
  assert.equal(await cost.capNotice(db, { now: tomorrow + 1000 }), null);
  // The admin's own switch is not news.
  const off = fakeDb({ app_meta: { goldaCost: { capUsd: 0 } }, golda_cost: { [DAY]: { totalUsd: 1, backgroundUsd: 1 } } });
  assert.equal(await cost.capNotice(off, { now: NOW }), null);
  // A ceiling that is not a whole number is written with its cents.
  const odd = fakeDb({ app_meta: { goldaCost: { capUsd: 2.5 } }, golda_cost: { [DAY]: { totalUsd: 3, backgroundUsd: 3 } } });
  assert.match(await cost.capNotice(odd, { now: NOW }), /\(2\.50 דולר\)/);
});

test('a ledger that cannot be written or read never breaks the call', async () => {
  await quietly(async () => {
    const broken = { collection: () => { throw new Error('firestore is down'); }, runTransaction: async () => { throw new Error('firestore is down'); } };
    assert.deepEqual(await cost.record(broken, { kind: 'chat', model: OPUS, usage: { output_tokens: 50000 }, now: NOW }), { usd: 1, totalUsd: null });
    assert.deepEqual(await cost.record(null, { kind: 'chat', model: OPUS, usage: { output_tokens: 50000 } }), { usd: 1, totalUsd: null });
    assert.deepEqual(await cost.gate(broken, 'scouting', { now: NOW }), { ok: true, reason: 'ledger unreadable', spentUsd: 0, capUsd: 5 }, 'work is not stopped by a ledger that cannot be read');
    assert.equal(await cost.capNotice(broken, { now: NOW }), null);

    // A caller: one scouted requirement still comes back when its cost could not be recorded.
    const client = { beta: { messages: { stream: () => ({ finalMessage: async () => ({
      stop_reason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 700, server_tool_use: { web_search_requests: 2 } },
      content: [{ type: 'text', text: '{"candidates":[{"name":"Ido Levi","age":23,"link":"https://y"}]}' }],
    }) }) } } };
    const r = await sc.scoutRequirement({ clubName: 'A', gender: 'Men', requiredPosition: 'Striker' }, { client, ours: [], db: broken, now: new Date(NOW) });
    assert.equal(r.ai, true);
    assert.deepEqual(r.candidates.map((c) => c.name), ['Ido Levi']);
  });
});

test('scouting records what it cost, once per requirement, and is skipped with a job note at the ceiling', async () => {
  db = fakeDb();
  let calls = 0;
  const client = { beta: { messages: { stream: () => ({ finalMessage: async () => {
    calls++;
    const usage = { input_tokens: 10000, output_tokens: 1000, server_tool_use: { web_search_requests: 2 } };   // 0.04 + 0.02 + 0.02
    if (calls === 1) return { stop_reason: 'pause_turn', usage, content: [{ type: 'text', text: '' }] };
    return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: '{"candidates":[{"name":"Ido Levi","link":"https://y"}]}' }] };
  } }) } } };
  const when = new Date('2026-11-15T08:30:00Z');
  await sc.scoutRequirement({ clubName: 'A' }, { client, ours: [], db, now: when });
  const day = db.read('golda_cost', '2026-11-15');
  assert.deepEqual(day.byKind, { scouting: { usd: 0.16, calls: 1 } }, 'the paused search and its continuation are one piece of work');
  assert.equal(day.backgroundUsd, 0.16);

  // At the ceiling nothing is scouted.
  const capped = fakeDb({ golda_cost: { '2026-11-15': { totalUsd: 5.5, backgroundUsd: 5.5 } } });
  const notes = [];
  let scouted = 0;
  const out = await sc.runScouting(capped, { requirements: [{ id: 'x', clubName: 'X', status: 'open' }], players: [] }, when, { note: (s) => notes.push(s) },
    { scout: async () => { scouted++; return { candidates: [], ai: true }; } });
  assert.deepEqual(out, []);
  assert.equal(scouted, 0);
  assert.match(notes.join('\n'), /scouting skipped: the day's background cost ceiling is reached \(\$5\.50 of \$5\.00\)/);

  // Under it the run goes on as before.
  const open = fakeDb({ golda_cost: { '2026-11-15': { totalUsd: 9, backgroundUsd: 1 } } });
  const went = await sc.runScouting(open, { requirements: [{ id: 'x', clubName: 'X', status: 'open' }], players: [] }, when, { note: () => {} },
    { scout: async () => ({ candidates: [{ name: 'P', link: 'https://p', why: 'כי' }], ai: true }) });
  assert.equal(went.length, 1);
});

test('the hourly run tells the owner through her own-initiative path, once, and tries again when the send fails', async () => {
  const { tellCap } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;
  const owner = { ...OWNER, phone: OWNER.whatsapp };
  const now = new Date(NOW);
  db = fakeDb({ golda_cost: { [DAY]: { totalUsd: 7, backgroundUsd: 6 } } });
  const { out, send } = recorder();
  const notes = [];
  const job = { note: (s) => notes.push(s) };
  assert.deepEqual(await tellCap(db, owner, now, { send, job }), { sent: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cost');
  assert.match(out[0].body, /תקרת העלות/);
  assert.match(notes.join('\n'), /cost ceiling reached/);
  assert.deepEqual(await tellCap(db, owner, now, { send, job }), {}, 'the next hour: nothing more to say');
  assert.equal(out.length, 1);

  // A send that fails leaves the day unstamped, so the next hour says it.
  db = fakeDb({ golda_cost: { [DAY]: { totalUsd: 7, backgroundUsd: 6 } } });
  assert.deepEqual(await tellCap(db, owner, now, { send: async () => { throw new Error('WhatsApp is down'); }, job }), {});
  assert.ok(!db.read('golda_cost', DAY).cappedAt);
  assert.deepEqual(await tellCap(db, owner, now, { send, job }), { sent: 1 });
});

test('the meter shows today, the last 14 days and the ceiling; the admin may change the ceiling to 0–100', async () => {
  const { handle } = require(path.join(__dirname, '..', '..', 'golda-cost.js'))._internal;
  db = fakeDb({ golda_cost: {
    '2026-11-12': { totalUsd: 1.5, backgroundUsd: 1, calls: 9 },
    '2026-11-11': { totalUsd: 99, backgroundUsd: 99, calls: 1 },   // older than 14 days: not counted
    '2026-11-24': { totalUsd: 2.25, backgroundUsd: 0.25, calls: 20 },
  } });
  await cost.record(db, { kind: 'chat', model: OPUS, usage: { output_tokens: 50000 }, now: NOW });
  await cost.record(db, { kind: 'scouting', model: OPUS, usage: { output_tokens: 25000 }, now: NOW });
  const ctx = { auth: { user: { email: 'lou.korek@gmail.com' } } };
  const get = await handle({ httpMethod: 'GET' }, ctx, { db, now: NOW });
  assert.equal(get.statusCode, 200);
  const m = JSON.parse(get.body);
  assert.deepEqual([m.capUsd, m.defaultCapUsd, m.capMin, m.capMax, m.pricesAsOf], [5, 5, 0, 100, cost.PRICES_AS_OF]);
  assert.deepEqual(m.today, { date: DAY, totalUsd: 1.5, backgroundUsd: 0.5, byKind: { chat: { usd: 1, calls: 1 }, scouting: { usd: 0.5, calls: 1 } }, calls: 2, estimatedCalls: 0, capped: false, cappedAt: null });
  assert.equal(m.days.length, 14);
  assert.deepEqual([m.days[0].date, m.days[13].date], ['2026-11-12', DAY]);
  assert.deepEqual(m.days[12], { date: '2026-11-24', totalUsd: 2.25, backgroundUsd: 0.25, calls: 20 });
  assert.equal(m.periodUsd, 5.25);

  const post = await handle({ httpMethod: 'POST', body: JSON.stringify({ capUsd: 0.4 }) }, ctx, { db, now: NOW });
  assert.equal(post.statusCode, 200);
  assert.deepEqual([JSON.parse(post.body).capUsd, JSON.parse(post.body).today.capped], [0.4, true]);
  assert.equal(db.read('app_meta', 'goldaCost').updatedBy, 'lou.korek@gmail.com');
  for (const bad of [{ capUsd: 101 }, { capUsd: -0.01 }, { capUsd: '5' }, { capUsd: null }, {}, { cap: 3 }]) {
    const r = await handle({ httpMethod: 'POST', body: JSON.stringify(bad) }, ctx, { db, now: NOW });
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await handle({ httpMethod: 'POST', body: '{not json' }, ctx, { db, now: NOW })).statusCode, 400);
  assert.equal((await handle({ httpMethod: 'DELETE' }, ctx, { db, now: NOW })).statusCode, 405);
  assert.equal(db.read('app_meta', 'goldaCost').capUsd, 0.4, 'a refused value changes nothing');
  for (const ok of [0, 100]) assert.equal((await handle({ httpMethod: 'POST', body: JSON.stringify({ capUsd: ok }) }, ctx, { db, now: NOW })).statusCode, 200);
});

test('the endpoint is for admins only: no sign-in is refused, and only an admin may manage settings', async () => {
  const { handler } = require(path.join(__dirname, '..', '..', 'golda-cost.js'));
  const r = await handler({ httpMethod: 'GET', headers: {} }, {});
  assert.equal(r.statusCode, 401);
  const { can } = require('@goldas/domain');
  assert.equal(can('admin', 'manage_settings'), true);
  for (const role of ['manager', 'viewer', 'player']) assert.equal(can(role, 'manage_settings'), false, role);
});

test('a chat answer and a briefing are recorded under their own kinds, and neither counts against the ceiling', async () => {
  const { runAgent } = require('../wa-agent.js');
  const { writeBriefing } = require('../golda-briefing-ai.js');
  db = fakeDb();
  const answer = (text, usage) => ({ beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }) }) } } });
  await runAgent({ db, admin: { firestore: { FieldValue: {} } }, identity: { name: 'לו קורק', role: 'admin', email: 'lou.korek@gmail.com' }, assistantName: 'גולדה', memories: [],
    text: 'תודה', session: { history: [] }, client: answer('בשמחה', { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 10000 }) });   // 0.008 + 0.01 + 0.002
  await writeBriefing({ name: 'לו', today: '2026-11-25', games: [], alerts: [], fallbackText: 'תדריך', db,
    client: answer('בוקר טוב לו!\n\n*היום:*\n• אין משחקים\n\nיום שקט.', { input_tokens: 5000, output_tokens: 1000 }) });                               // 0.02 + 0.02
  const [day] = db.all('golda_cost');
  assert.deepEqual(day.byKind, { chat: { usd: 0.02, calls: 1 }, briefing: { usd: 0.04, calls: 1 } });
  assert.deepEqual([day.totalUsd, day.backgroundUsd, day.calls], [0.06, 0, 2]);
});

test('the model a call is priced as: the one that answered when the table knows it, the dearest one when it does not, never 0', () => {
  assert.equal(cost.billedModel('claude-opus-5', OPUS), 'claude-opus-5', 'a fallback that answered is priced as itself');
  assert.equal(cost.billedModel('claude-opus-5-5-20261101', 'claude-opus-5'), 'claude-opus-5-5', 'a dated id is priced as its undated name');
  assert.equal(cost.billedModel('', OPUS), OPUS);
  assert.equal(cost.billedModel(undefined, OPUS), OPUS);
  const dear = cost.billedModel('claude-unknown-9', OPUS);
  assert.ok(cost.PRICES[dear]);
  for (const p of Object.values(cost.PRICES)) assert.ok(cost.PRICES[dear].output >= p.output);
  assert.ok(cost.priceOf({ model: dear, usage: { output_tokens: M } }).usd > 0);
});

test('a call that threw is recorded as an estimate on the high side, and counted as one', async () => {
  const req = { max_tokens: 10000, system: 'x'.repeat(1000), messages: [{ role: 'user', content: 'y'.repeat(1000) }], tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }] };
  const u = cost.estimateUsage(req);
  assert.equal(u.output_tokens, 5000);
  assert.equal(u.server_tool_use.web_search_requests, 6);
  assert.ok(u.input_tokens >= 1000, 'at least one token per two characters of the request');
  assert.equal(cost.estimateUsage({ max_tokens: 100, messages: [] }).server_tool_use.web_search_requests, 0);
  db = fakeDb();
  const r = await cost.record(db, { kind: 'radar', model: OPUS, usage: u, now: NOW, estimate: true });
  assert.ok(r.usd > 0.1);
  const day = db.read('golda_cost', DAY);
  assert.deepEqual([day.calls, day.estimatedCalls], [1, 1]);
  await cost.record(db, { kind: 'radar', model: OPUS, usage: { output_tokens: 10 }, now: NOW });
  assert.deepEqual([db.read('golda_cost', DAY).calls, db.read('golda_cost', DAY).estimatedCalls], [2, 1]);
});
