// The hourly pass and the two messages Golda starts with the owner (the website
// following the CRM, the daily question): only to him, in the day, after his
// briefing, never both in one hour, and a failure costs nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
delete process.env.SCRAPER_API_KEY;
const { fakeDb, stubFirestore, OWNER, MANAGER } = require('./fake-firestore.js');
const { fakeSite } = require('./fake-site.js');

let DB;
stubFirestore(() => DB);
const { run } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;
const { viewOf } = require('../golda-site-follow.js');

const approved = { templates: { golda_digest: { accounts: { 1: { status: 'APPROVED' } } }, golda_update: { accounts: { 1: { status: 'APPROVED' } } } } };
const TODAY = '2026-11-25';
const at = (israelHHMM) => new Date(`${TODAY}T${String(Number(israelHHMM.slice(0, 2)) - 2).padStart(2, '0')}:${israelHHMM.slice(3)}:00Z`);   // Israel is UTC+2 in November
const GAVIN = { fullName: 'Gavin Karam', gender: 'Men', currentClub: 'Hapoel Kfar Saba', contractStatus: 'Under Contract', contractEnd: '2028-06-30', reprEnd: '2028-06-30', passportExpiry: '2031-01-01',
  primaryPosition: 'CDM', secondaryPositions: ['CM'], dob: '2007-05-01', foot: '', nationalities: ['Israel', 'United States'] };
const MOVED = { ...GAVIN, currentClub: 'Maccabi Haifa' };

function seed({ users = { lou: OWNER, dani: MANAGER }, briefed = TODAY, meta = {}, player = GAVIN } = {}) {
  return fakeDb({
    app_users: users, players: { p1: player },
    app_meta: { whatsapp: approved, goldaSent: { briefings: { 'lou.korek@gmail.com': briefed, 'dani@x.com': briefed }, eventsAt: at('13:30').getTime() }, ...meta },
  });
}
const write = Object.assign(async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }), { recap: async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }) });
async function hour(when, site = fakeSite()) {
  const out = [], notes = [];
  const send = async (u, body, kind, buttons = []) => { out.push({ to: u.email, kind, body, buttons }); return { state: 'sent' }; };
  const r = await run({ note: (s) => notes.push(s) }, at(when), { send, write, site });
  return { out, notes, r, site };
}
const own = (out) => out.filter((m) => m.kind === 'website' || m.kind === 'question');

test('the daily question goes to the owner only, once, in the afternoon', async () => {
  DB = seed();
  const first = await hour('14:30');
  assert.deepEqual(own(first.out).map((m) => [m.to, m.kind, m.buttons]), [['lou.korek@gmail.com', 'question', ['ימין', 'שמאל', 'שתיהן']]]);
  assert.match(own(first.out)[0].body, /מה הרגל החזקה של Gavin Karam\?/);
  assert.ok(!first.out.some((m) => m.to === 'dani@x.com'), 'a manager gets nothing of this');
  assert.equal(first.r.sent, 1);
  assert.equal(first.site.reads, 0, 'the first pass only records the players; the site is not read');
  assert.ok(DB.read('app_meta', 'goldaSiteFollow').seen.p1);
  assert.deepEqual(own((await hour('15:30')).out), [], 'not again the same day');
});

test('a change in the CRM that a card shows: the draft and the question to publish, and no daily question on top', async () => {
  DB = seed({ meta: { goldaSiteFollow: { seen: { p1: viewOf(GAVIN) } } }, player: MOVED });
  const first = await hour('14:30');
  assert.deepEqual(own(first.out).map((m) => [m.to, m.kind, m.buttons]), [['lou.korek@gmail.com', 'website', ['כן, לפרסם', 'לא']]]);
  assert.match(own(first.out)[0].body, /\*Gavin Karam\*\n• מועדון: Maccabi Haifa \(במקום Hapoel Kfar Saba\)/);
  assert.equal(first.site.published.length, 0, 'nothing is published by the hourly pass');
  // an hour later his answer is still awaited: no question on top of it
  assert.deepEqual(own((await hour('15:30')).out), []);
  // by the evening the day's question may come
  assert.deepEqual(own((await hour('18:30')).out).map((m) => m.kind), ['question']);
});

test('at night, and before his morning briefing, she starts nothing', async () => {
  DB = seed();
  assert.deepEqual(own((await hour('23:30')).out), []);
  DB = seed({ briefed: '2026-11-24' });
  assert.deepEqual(own((await hour('14:30')).out), [], 'today\'s briefing has not gone out yet');
  assert.equal(DB.read('app_meta', 'goldaSiteFollow'), undefined);
  assert.equal(DB.read('app_meta', 'goldaDailyQuestion'), undefined);
});

test('with the owner off WhatsApp nobody else gets his messages', async () => {
  DB = seed({ users: { lou: { ...OWNER, channels: [] }, dani: { ...MANAGER, role: 'admin' } } });
  const h = await hour('14:30');
  assert.deepEqual(own(h.out), []);
  assert.equal(DB.read('app_meta', 'goldaDailyQuestion'), undefined);
});

test('a website that does not answer is noted and costs nothing else', async () => {
  DB = seed({ meta: { goldaSiteFollow: { seen: { p1: viewOf(GAVIN) } } }, player: MOVED });
  const h = await hour('14:30', fakeSite({ down: true }));
  assert.ok(h.notes.some((n) => /site follow failed: the site did not answer/.test(n)));
  assert.deepEqual(own(h.out).map((m) => m.kind), ['question'], 'the day\'s question still goes out');
  assert.equal(DB.read('app_meta', 'goldaSiteFollow').seen.p1.club, 'Hapoel Kfar Saba', 'the change waits for the next hour');
  assert.ok(DB.read('app_meta', 'goldaSent').eventsAt, 'the hour\'s state is saved as always');
});
