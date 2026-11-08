// Golda's deeper mode: long replies split for WhatsApp, long-term memory,
// the changes/overview read tools and the model-written morning briefing.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';

const { splitText } = require('../wa-api.js');
const { visibleMemories, memorySection, memoryTools, MEMORY_MAX_CHARS } = require('../golda-memory.js');
const { changesFrom, overviewOf, parseWhen } = require('../golda-insights.js');
const { writeBriefing, shapeBriefing, briefingFacts, APP_LINK } = require('../golda-briefing-ai.js');
const { systemPrompt, toolsFor, EFFORT } = require('../wa-agent.js');

// --- splitText ---------------------------------------------------------------
test('a short reply is one message', () => {
  assert.deepEqual(splitText('שלום'), ['שלום']);
  assert.deepEqual(splitText(''), ['']);
});

test('a long reply is split at paragraph breaks, every part within the limit', () => {
  const para = 'א'.repeat(900);
  const body = Array.from({ length: 10 }, (_, i) => `${i}${para}`).join('\n\n');
  const parts = splitText(body, 4000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 4000, `part of ${p.length}`);
  assert.equal(parts.join('').replace(/\s/g, ''), body.replace(/\s/g, ''), 'nothing lost');
  assert.ok(parts.every((p) => /^\d/.test(p)), 'each part starts at a paragraph');
});

test('text with no breaks is still cut to size', () => {
  const parts = splitText('x'.repeat(9000), 4000);
  assert.deepEqual(parts.map((p) => p.length), [4000, 4000, 1000]);
});

// --- memory --------------------------------------------------------------------
const rows = [
  { id: 'a', text: 'לו מעדיף עדכונים בבוקר', shared: true, owner: 'lou.korek@gmail.com', ownerName: 'לו', updatedAt: 3 },
  { id: 'b', text: 'personal of yuval', shared: false, owner: 'yuval@x.com', updatedAt: 5 },
  { id: 'c', text: 'personal of lou', shared: false, owner: 'lou.korek@gmail.com', updatedAt: 1, about: 'לו' },
  { id: 'd', text: '', shared: true, updatedAt: 9 },
];

test('a person sees shared memories and only their own personal ones, newest first', () => {
  assert.deepEqual(visibleMemories(rows, { email: 'lou.korek@gmail.com' }).map((m) => m.id), ['a', 'c']);
  assert.deepEqual(visibleMemories(rows, { email: 'yuval@x.com' }).map((m) => m.id), ['b', 'a']);
  assert.deepEqual(visibleMemories(rows, {}).map((m) => m.id), ['a'], 'no identity: shared only');
  assert.deepEqual(visibleMemories(rows, { phone: '972500000001' }).map((m) => m.id), ['a']);
});

test('the memory section lists ids and is capped in size', () => {
  assert.equal(memorySection([]), 'What you remember: nothing yet.');
  const s = memorySection(visibleMemories(rows, { email: 'lou.korek@gmail.com' }));
  assert.match(s, /\[a\] לו מעדיף/);
  assert.match(s, /\[c\] \(לו\) personal of lou — personal/);
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, text: 'y'.repeat(300), shared: true, updatedAt: i }));
  const big = memorySection(many);
  assert.ok(big.length < MEMORY_MAX_CHARS + 500);
  assert.match(big, /older memories not shown/);
});

function fakeDb() {
  const docs = new Map(); let n = 0;
  const ref = (id) => ({
    id,
    get: async () => ({ id, exists: docs.has(id), data: () => docs.get(id) }),
    delete: async () => { docs.delete(id); },
  });
  return { docs, collection: (name) => { assert.equal(name, 'golda_memory'); return { add: async (d) => { const id = `id${++n}`; docs.set(id, d); return ref(id); }, doc: ref }; } };
}

test('remember saves a shared memory by default, forget removes it', async () => {
  const db = fakeDb();
  const t = memoryTools({ db, identity: { email: 'lou.korek@gmail.com', name: 'לו' } });
  const r = await t.remember({ text: '  מכבי חיפה מחפשת בלם שמאלי  ', about: 'מכבי חיפה' });
  assert.equal(r.saved, true);
  assert.equal(r.shared, true);
  const saved = db.docs.get(r.id);
  assert.equal(saved.text, 'מכבי חיפה מחפשת בלם שמאלי');
  assert.equal(saved.owner, 'lou.korek@gmail.com');
  const f = await t.forget({ id: r.id });
  assert.equal(f.forgotten, true);
  assert.equal(db.docs.size, 0);
});

test('remember refuses empty or very long text; forget refuses someone else\'s personal memory', async () => {
  const db = fakeDb();
  const lou = memoryTools({ db, identity: { email: 'lou.korek@gmail.com' } });
  const yuval = memoryTools({ db, identity: { email: 'yuval@x.com' } });
  await assert.rejects(lou.remember({ text: '   ' }), /empty/);
  await assert.rejects(lou.remember({ text: 'x'.repeat(601) }), /under 600/);
  const p = await lou.remember({ text: 'private', shared: false });
  await assert.rejects(yuval.forget({ id: p.id }), /someone else/);
  await assert.rejects(yuval.forget({ id: 'nope' }), /no memory/);
  const s = await lou.remember({ text: 'shared one' });
  assert.equal((await yuval.forget({ id: s.id })).forgotten, true, 'anyone may forget a shared memory');
});

// --- changes / overview -------------------------------------------------------
const NOW = Date.parse('2026-11-08T08:00:00Z');
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const audit = [
  { action: 'update', collection: 'players', docId: 'p1', byName: 'יובל', via: 'web', at: ts('2026-11-08T06:00:00Z'), fields: ['club'] },
  { action: 'update', collection: 'players', docId: 'p2', byName: 'גולדה', via: 'golda', at: ts('2026-11-07T20:00:00Z'),
    before: { fullName: 'Dana Levi', club: 'A', contractFiles: [1] }, after: { fullName: 'Dana Levi', club: 'B', contractFiles: [1, 2] } },
  { action: 'create', collection: 'deals', docId: 'd1', by: 'lou.korek@gmail.com', via: 'web', at: ts('2026-11-01T10:00:00Z') },
  { action: 'delete', collection: 'tasks', docId: 't1', byName: 'לו', via: 'web', at: ts('2026-10-01T10:00:00Z') },
];

test('changes defaults to the last 7 days, newest first, with Golda diffs', () => {
  const r = changesFrom(audit, {}, { 'players/p1': 'Noa Cohen' }, NOW);
  assert.equal(r.total, 3);
  assert.deepEqual(r.changes.map((c) => c.docId), ['p1', 'p2', 'd1']);
  assert.equal(r.changes[0].name, 'Noa Cohen', 'name from the lookup when the row has no snapshot');
  assert.equal(r.changes[1].name, 'Dana Levi');
  assert.deepEqual(r.changes[1].diff.club, { from: 'A', to: 'B' });
  assert.equal(r.changes[1].diff.contractFiles, undefined, 'file lists are left out of diffs');
});

test('changes filters by period, collection and person', () => {
  assert.equal(changesFrom(audit, { since: '24h' }, {}, NOW).total, 2);
  assert.equal(changesFrom(audit, { since: '2026-09-01' }, {}, NOW).total, 4);
  assert.equal(changesFrom(audit, { since: '60d', collection: 'tasks' }, {}, NOW).total, 1);
  assert.equal(changesFrom(audit, { by: 'יובל' }, {}, NOW).total, 1);
  assert.equal(changesFrom(audit, { since: '30d', by: 'lou.korek' }, {}, NOW).total, 1);
  assert.equal(changesFrom(audit, { collection: 'pipeline_men' }, {}, NOW).total, 2, 'pipeline rows live in players');
  assert.throws(() => parseWhen('yesterday', NOW), /since\/until/);
});

test('overview sums up the agency', () => {
  const o = overviewOf({
    players: [
      { id: 'p1', gender: 'women', contractStatus: 'active' },
      { id: 'p2', stage: 'represented', gender: 'men' },
      { id: 'p3', stage: 'prospect', category: 'men', status: 'contacted' },
      { id: 'p4', stage: 'prospect', category: 'men', status: 'contacted' },
    ],
    deals: [{ id: 'd1', stage: 'negotiation' }, { id: 'd2', stage: 'negotiation', closedAt: 1 }],
    requirements: [{ id: 'r1', clubName: 'X', validUntil: '2026-11-01' }, { id: 'r2', status: 'closed' }, { id: 'r3' }],
    tasks: [{ id: 't1', title: 'call', dueDate: '2026-11-01' }, { id: 't2', done: true, dueDate: '2026-11-01' }, { id: 't3' }],
    matches: [{ id: 'm1', date: '2026-11-09', homeTeam: 'A', awayTeam: 'B' }, { id: 'm2', date: '2026-12-01', homeTeam: 'C', awayTeam: 'D' }],
    audit: [{ via: 'golda', at: ts('2026-11-07T00:00:00Z') }, { via: 'web', at: ts('2026-11-07T00:00:00Z') }],
  }, new Date(NOW));
  assert.equal(o.today, '2026-11-08');
  assert.equal(o.represented.total, 2);
  assert.deepEqual(o.prospects.byCategory.men, { total: 2, byStatus: { contacted: 2 } });
  assert.equal(o.deals.open, 1);
  assert.deepEqual([o.requirements.open, o.requirements.expired], [2, 1]);
  assert.deepEqual([o.tasks.open, o.tasks.overdue], [2, 1]);
  assert.equal(o.thisWeek.matches, 1);
  assert.equal(o.thisWeek.matchList[0].game, 'A – B');
  assert.equal(o.goldaChangesLast7Days, 1);
});

// --- agent prompt and tools ---------------------------------------------------
test('every role gets the insight and memory tools; the prompt carries memory and the new writing rules', () => {
  for (const role of ['admin', 'manager', 'viewer']) {
    const names = toolsFor(role).map((t) => t.name);
    for (const n of ['changes', 'overview', 'remember', 'forget']) assert.ok(names.includes(n), `${role} has ${n}`);
  }
  const p = systemPrompt('גולדה', { name: 'לו', role: 'admin', email: 'lou.korek@gmail.com' }, null, [], 'whatsapp', [{ id: 'a', text: 'זכור אותי', shared: true }]);
  assert.match(p, /How you think/);
  assert.match(p, /מה עכשיו/);
  assert.match(p, /\[a\] זכור אותי/);
  assert.doesNotMatch(p, /Keep replies short/);
  assert.equal(EFFORT, 'xhigh');
});

// --- the model-written briefing -----------------------------------------------
const base = {
  name: 'לו', today: '2026-11-08', fallbackText: 'TEMPLATE',
  games: [{ date: '2026-11-08', time: '19:00', title: 'A – B', sub: 'Dana' }],
  alerts: [{ type: 'contract', severity: 'high', subject: { name: 'Dana' }, proof: { he: 'חוזה מסתיים' }, dueDate: '2026-11-12' }],
  changes24h: [{ byName: 'יובל', action: 'update', collection: 'players', name: 'Noa', fields: ['club'] }],
  deals: [{ playerName: 'Dana', clubName: 'X', stage: 'negotiation' }, { playerName: 'Old', stage: 'negotiation', closedAt: 1 }],
  requirements: [{ clubName: 'X', position: 'CB' }, { clubName: 'Y', status: 'closed' }],
  memories: [{ text: 'לו אוהב תמציתי', about: 'לו' }],
};
const fakeClient = (reply, seen = {}) => ({ beta: { messages: { stream: (req) => { seen.req = req; return { finalMessage: async () => (reply instanceof Error ? Promise.reject(reply) : { content: [{ type: 'text', text: reply }], usage: {} }) }; } } } });

test('briefing facts keep only open deals and requirements, and the memories', () => {
  const f = briefingFacts(base);
  assert.equal(f.openDeals.length, 1);
  assert.equal(f.openRequirements.length, 1);
  assert.deepEqual(f.memories, ['(לו) לו אוהב תמציתי']);
  assert.equal(f.alerts[0].who, 'Dana');
});

test('the model briefing gets the fixed first line and the app link last', async () => {
  const seen = {};
  const b = await writeBriefing({ ...base, client: fakeClient('בוקר טוב לו!\n\n*הכי חשוב היום:*\n• Dana משחקת 19:00\n\nהכל בבית: ' + APP_LINK + '\n', seen) });
  assert.equal(b.ai, true);
  const lines = b.text.split('\n');
  assert.equal(lines[0], '*בוקר טוב, לו* ☀️ 08/11');
  assert.equal(lines[lines.length - 1], `הכל בבית: ${APP_LINK}`);
  assert.equal(b.text.split(APP_LINK).length, 2, 'the link appears once');
  assert.equal(seen.req.output_config.effort, 'high');
  assert.deepEqual(seen.req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(seen.req.fallbacks, 'default');
});

test('a briefing without the greeting gets the first line prepended', () => {
  const t = shapeBriefing('*הכי חשוב היום:*\n• א\n• ב', 'לו', '2026-11-08');
  assert.match(t, /^\*בוקר טוב, לו\* ☀️ 08\/11\n\*הכי חשוב היום:\*/);
});

test('the briefing falls back to the template on no key, an error, or an empty answer', async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const none = await writeBriefing({ ...base });
    assert.deepEqual([none.text, none.ai], ['TEMPLATE', false]);
    assert.match(none.reason, /ANTHROPIC_API_KEY/);
  } finally { if (key !== undefined) process.env.ANTHROPIC_API_KEY = key; }
  const err = await writeBriefing({ ...base, client: fakeClient(new Error('overloaded')) });
  assert.deepEqual([err.text, err.ai, err.reason], ['TEMPLATE', false, 'overloaded']);
  const empty = await writeBriefing({ ...base, client: fakeClient('   ') });
  assert.deepEqual([empty.text, empty.ai], ['TEMPLATE', false]);
});
