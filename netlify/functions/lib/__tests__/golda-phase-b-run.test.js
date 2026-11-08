// The hourly briefing pass with phase B on, end to end over an in-memory
// Firestore: what goes to whom, once, and what waits for the morning.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';
delete process.env.SCRAPER_API_KEY;

// --- a small Firestore -------------------------------------------------------------
const TS = { __ts: true };
let seq = 0;
function makeDb(seed) {
  const data = JSON.parse(JSON.stringify(seed));
  const stamp = (v) => (v && v.__ts ? new Date(NOW_MS) : v);
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => !(v && v.__del)).map(([k, v]) => [k, stamp(v)]));
  const snapOf = (name, rows) => ({ empty: !rows.length, docs: rows.map(([id, v]) => ({ id, data: () => v, exists: true })) });
  const all = (name) => Object.entries(data[name] || {});
  const query = (name, filters = [], lim = Infinity) => ({
    where: (f, op, v) => query(name, [...filters, [f, op, v]], lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    async get() {
      const ms = (x) => (x instanceof Date ? x.getTime() : typeof x === 'string' ? Date.parse(x) : x);
      const rows = all(name).filter(([, d]) => filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === '>=' ? ms(d[f]) >= ms(v) : op === 'array-contains' ? (d[f] || []).includes(v) : true)));
      return snapOf(name, rows.slice(0, lim));
    },
  });
  return {
    data,
    collection: (name) => ({
      ...query(name),
      async add(v) { const id = `n${++seq}`; (data[name] = data[name] || {})[id] = clean(v); return { id }; },
      doc: (id) => ({
        async get() { const v = (data[name] || {})[id]; return { exists: v !== undefined, id, data: () => v }; },
        async set(v, opts) { (data[name] = data[name] || {})[id] = opts?.merge ? { ...(data[name][id] || {}), ...clean(v) } : clean(v); },
        async update(v) { data[name][id] = { ...data[name][id], ...clean(v) }; },
        async delete() { delete (data[name] || {})[id]; },
      }),
    }),
  };
}

let DB;
let NOW_MS = 0;
const fakeAdmin = { firestore: { FieldValue: { serverTimestamp: () => TS, delete: () => ({ __del: true }) } } };
const fsPath = require.resolve('../firestore.js');
require.cache[fsPath] = {
  id: fsPath, filename: fsPath, loaded: true,
  exports: {
    admin: fakeAdmin, getDb: () => DB, OWNER_EMAIL: 'lou.korek@gmail.com', isLive: (d) => !(d && d.deletedAt),
    listRepresented: async (db) => (await db.collection('players').get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.deletedAt),
  },
};
const { run } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;

const approved = { templates: { golda_digest: { accounts: { 1: { status: 'APPROVED' } } }, golda_update: { accounts: { 1: { status: 'APPROVED' } } } } };
const thu = new Date('2026-11-12T16:30:00Z');   // Thursday 18:30 in Israel: recap time
const iso = (s) => new Date(s).toISOString();

function seed(extra = {}) {
  return {
    app_users: {
      'lou.korek@gmail.com': { email: 'lou.korek@gmail.com', name: 'לו קורק', role: 'admin', whatsapp: '972500000001', channels: ['whatsapp'], briefingHour: 7 },
      'dani@x.com': { email: 'dani@x.com', name: 'דני לוי', role: 'manager', whatsapp: '972500000002', channels: ['whatsapp'], briefingHour: 7 },
    },
    players: { p1: { fullName: 'Assaf Cohen', gender: 'Men', dob: '2004-03-01', primaryPosition: 'Striker', contractStatus: 'Free' } },
    deals: {
      d1: { playerId: 'p1', playerName: 'Assaf Cohen', clubName: 'Hapoel Test', stage: 'Offered to Club', enteredStageAt: iso('2026-11-01T10:00:00Z'), owner: 'lou.korek@gmail.com',
        history: [{ stage: 'Offered to Club', at: iso('2026-11-12T16:00:00Z'), by: 'dani@x.com' }] },
    },
    club_requirements: { r1: { clubName: 'Hapoel New', gender: 'Men', requiredPosition: 'Striker', ageMin: 18, ageMax: 25, status: 'open', createdAt: iso('2026-11-12T16:10:00Z'), createdBy: 'dani@x.com' } },
    tasks: {}, matches: {}, trainings: {}, jobs: {}, audit: {}, golda_memory: {}, meetings: {}, golda_feedback: {},
    settings: {},
    app_meta: {
      whatsapp: approved,
      goldaSent: { briefings: { 'lou.korek@gmail.com': '2026-11-12', 'dani@x.com': '2026-11-12' }, eventsAt: new Date('2026-11-12T15:30:00Z').getTime() },
    },
    ...extra,
  };
}

const job = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };
const write = Object.assign(async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }), { recap: async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }) });

test('Thursday evening: the requirement goes to the other admin, the move and the follow-up to Lou, the recap to both, each once', async () => {
  DB = makeDb(seed()); NOW_MS = thu.getTime();
  const out = [];
  const send = async (u, body, kind) => { out.push({ to: u.email, kind, body }); return { state: 'sent' }; };
  await run(job(), thu, { send, write });

  const lou = out.filter((m) => m.to === 'lou.korek@gmail.com');
  const dani = out.filter((m) => m.to === 'dani@x.com');
  assert.ok(lou.some((m) => /דרישה חדשה/.test(m.body)), 'Lou hears about the requirement Dani added');
  assert.ok(!dani.some((m) => /דרישה חדשה/.test(m.body)), 'Dani does not hear about his own requirement');
  assert.ok(lou.some((m) => /עדכון עסקאות/.test(m.body) && /דני/.test(m.body)), 'Lou sees Dani\'s deal move');
  assert.ok(!dani.some((m) => /עדכון עסקאות/.test(m.body)), 'deal moves go to admins only');
  assert.ok(lou.some((m) => /פתחתי משימות מעקב/.test(m.body)), 'the deal owner hears about the follow-up');
  assert.equal(out.filter((m) => m.kind === 'recap').length, 2);
  assert.ok(lou.find((m) => m.kind === 'recap').body.startsWith('*סיכום שבוע, לו*'));

  const tasks = Object.values(DB.data.tasks);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].auto, 'deal_followup');
  assert.equal(tasks[0].createdBy, 'golda');
  assert.ok(Object.values(DB.data.audit).some((a) => a.actor === 'golda-auto' && a.collection === 'tasks'));

  // The next hour: nothing repeats.
  const again = [];
  const later = new Date(thu.getTime() + 3600000); NOW_MS = later.getTime();
  await run(job(), later, { send: async (u, body, kind) => { again.push({ to: u.email, kind, body }); return { state: 'sent' }; }, write });
  assert.deepEqual(again, []);
  assert.equal(Object.values(DB.data.tasks).length, 1);
});

test('a follow-up closes by itself when the deal moves on', async () => {
  DB = makeDb(seed()); NOW_MS = thu.getTime();
  await run(job(), thu, { send: async () => ({ state: 'sent' }), write });
  const [id] = Object.keys(DB.data.tasks);
  DB.data.deals.d1.stage = 'Negotiation';
  DB.data.deals.d1.enteredStageAt = iso('2026-11-12T17:00:00Z');
  const later = new Date(thu.getTime() + 3600000); NOW_MS = later.getTime();
  await run(job(), later, { send: async () => ({ state: 'sent' }), write });
  assert.equal(DB.data.tasks[id].done, true);
  assert.match(DB.data.tasks[id].notes, /נסגרה אוטומטית/);
});

test('at night nothing is sent between briefings and no follow-up is opened; the events wait for the morning', async () => {
  const night = new Date('2026-11-12T21:30:00Z');   // 23:30 Israel
  DB = makeDb(seed()); NOW_MS = night.getTime();
  const out = [];
  await run(job(), night, { send: async (u, body, kind) => { out.push(kind); return { state: 'sent' }; }, write });
  assert.deepEqual(out, []);
  assert.equal(Object.keys(DB.data.tasks).length, 0);
  assert.equal(DB.data.app_meta.goldaSent.eventsAt, new Date('2026-11-12T15:30:00Z').getTime());
});

test('no more than five follow-up tasks a day, longest waits first', async () => {
  const deals = {};
  for (let i = 0; i < 8; i++) deals[`d${i}`] = { playerName: `P${i}`, clubName: 'C', stage: 'Waiting Response', enteredStageAt: iso(`2026-10-${String(10 + i).padStart(2, '0')}T10:00:00Z`) };
  DB = makeDb(seed({ deals })); NOW_MS = thu.getTime();
  await run(job(), thu, { send: async () => ({ state: 'sent' }), write });
  const titles = Object.values(DB.data.tasks).map((t) => t.dealId).sort();
  assert.deepEqual(titles, ['d0', 'd1', 'd2', 'd3', 'd4']);
  const later = new Date(thu.getTime() + 3600000); NOW_MS = later.getTime();
  await run(job(), later, { send: async () => ({ state: 'sent' }), write });
  assert.equal(Object.keys(DB.data.tasks).length, 5);
});
