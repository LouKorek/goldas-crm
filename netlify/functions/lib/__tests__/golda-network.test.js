// The relationship map through Golda: network_path and network_cold read the
// same engine as the Contacts map (every role, like the Contacts page);
// contact_link writes the explicit link through her audited update (edit only),
// never links a similar name, and asks when several contacts fit. No money.
const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.SCRAPER_API_KEY;
const { fakeDb, stubFirestore } = require('./fake-firestore.js');

const admin = stubFirestore(() => null);
const { createTools, toolsFor, systemPrompt } = require('../wa-agent.js');
const { israelDate, addDays } = require('@goldas/domain');

const LOU = { email: 'lou.korek@gmail.com', name: 'לו', role: 'admin', phone: '972500000001' };
const DANI = { email: 'dani@x.com', name: 'דני', role: 'manager', phone: '972500000002' };
const VIEW = { email: 'v@x.com', name: 'צופה', role: 'viewer', phone: '972500000003' };
const tools = (db, identity = LOU) => createTools({ db, admin, identity, media: null, session: { turn: 1 }, assistantName: 'גולדה', channel: 'whatsapp' });

const today = israelDate(new Date());
const ago = (n) => `${addDays(today, -n)}T09:00:00Z`;
const seed = () => fakeDb({
  clubs: { rb: { name: 'Real Betis', key: 'real betis' }, mh: { name: 'מכבי חיפה', key: 'מכבי חיפה' } },
  contacts: {
    a: { contactName: 'אבי כהן', clubName: 'הפועל אשדוד', contactPhone: '0501111111', touches: [{ id: 't1', at: ago(5), channel: 'call' }], knows: [{ contactId: 'b', kind: 'introduced', at: ago(12) }] },
    b: { contactName: 'Benny Levi', clubName: 'Real Betis', contactPhone: '0522222222' },
    c: { contactName: 'כרמל', clubId: 'mh', clubName: 'מכבי חיפה', touches: [{ id: 't2', at: ago(200), channel: 'whatsapp' }] },
    d: { contactName: 'דור', clubName: 'מכבי חיפה' },
    e1: { contactName: 'אלי לוי', clubName: 'X' },
    e2: { contactName: 'אלי לוי', clubName: 'Y' },
  },
  deals: { d1: { playerId: 'p1', playerName: 'Noam', clubId: 'mh', clubName: 'מכבי חיפה', stage: 'Negotiation', enteredStageAt: addDays(today, -400), commission: '777777', payments: [{ id: 'x', amount: 777777, currency: 'EUR' }] } },
  players: { p1: { fullName: 'Noam', stage: 'tracking' } },
  club_requirements: {}, meetings: {},
});

test('the map tools: reading for every role, the link for editors only', () => {
  const names = (role) => toolsFor(role).map((x) => x.name);
  for (const role of ['admin', 'manager', 'viewer']) {
    assert.ok(names(role).includes('network_path'));
    assert.ok(names(role).includes('network_cold'));
  }
  assert.ok(names('manager').includes('contact_link'));
  assert.ok(!names('viewer').includes('contact_link'));
  assert.match(systemPrompt('גולדה', LOU), /network_path/);
  assert.match(systemPrompt('גולדה', DANI), /contact_link action=add/);
  assert.ok(!/contact_link action=add/.test(systemPrompt('גולדה', VIEW)));
});

test('network_path: the warm introduction first, dates on each link, no money', async () => {
  const r = await tools(seed(), VIEW).run('network_path', { club: 'betis' });
  assert.equal(r.club, 'Real Betis');
  assert.equal(r.ways[0].firstCall.name, 'אבי כהן');
  assert.deepEqual(r.ways[0].chain.map((x) => x.name), ['אבי כהן', 'Benny Levi', 'Real Betis']);
  assert.equal(r.ways[0].chain[0].lastDate, addDays(today, -5));
  assert.equal(r.ways[0].chain[0].warmth, 'warm');
  assert.equal(r.ways[0].chain[1].link, 'הכיר/ה לנו');
  assert.match(r.link, /contacts\?view=map&club=k%3Arb$/);
  const haifa = await tools(seed(), VIEW).run('network_path', { club: 'מכבי חיפה' });
  assert.ok(!JSON.stringify(haifa).includes('777777'), 'never an amount');
  const none = await tools(seed()).run('network_path', { club: 'Barcelona' });
  assert.equal(none.found, false);
});

test('network_cold: the oldest first, no record apart', async () => {
  const r = await tools(seed(), VIEW).run('network_cold', {});
  assert.deepEqual(r.cold.map((x) => [x.name, x.daysAgo, x.channel]), [['כרמל', 200, 'whatsapp']]);
  assert.deepEqual(r.noRecord.map((x) => x.name).sort(), ['Benny Levi', 'דור', 'אלי לוי', 'אלי לוי'].sort());
  assert.equal(r.spokenRecently, 1);
  const haifa = await tools(seed()).run('network_cold', { club: 'מכבי חיפה', days: 30 });
  assert.deepEqual(haifa.cold.map((x) => x.name), ['כרמל']);
  assert.deepEqual(haifa.noRecord.map((x) => x.name), ['דור']);
});

test('contact_link: saved on the contact through the audited update; undo reverses it', async () => {
  const db = seed();
  const t = tools(db, DANI);
  const r = await t.run('contact_link', { action: 'add', contact: 'כרמל', other: 'דור', kind: 'knows', note: 'שיחקו יחד' });
  assert.equal(r.saved, true);
  const k = db.read('contacts', 'c').knows;
  assert.equal(k.length, 1);
  assert.deepEqual([k[0].contactId, k[0].kind, k[0].note, k[0].by], ['d', 'knows', 'שיחקו יחד', DANI.email]);
  // The way to Maccabi Haifa now has that link on the map.
  const path = await t.run('network_path', { club: 'מכבי חיפה' });
  assert.ok(path.ways.length >= 1);
  await t.run('undo_last', {});
  assert.deepEqual(db.read('contacts', 'c').knows || [], []);
  // Remove a link kept on the other side.
  const rm = await tools(db, LOU).run('contact_link', { action: 'remove', contact: 'Benny Levi', other: 'אבי כהן' });
  assert.equal(rm.saved, true);
  assert.deepEqual(db.read('contacts', 'a').knows, []);
});

test('contact_link: never a guess; several fit → candidates; viewers may not', async () => {
  const db = seed();
  const miss = await tools(db).run('contact_link', { action: 'add', contact: 'כרמל', other: 'Beni Levy' });
  assert.equal(miss.saved, false);
  assert.deepEqual(miss.missing, ['Beni Levy']);
  const two = await tools(db).run('contact_link', { action: 'add', contact: 'כרמל', other: 'אלי לוי' });
  assert.equal(two.saved, false);
  assert.equal(two.candidates.other.length, 2);
  await assert.rejects(tools(db, VIEW).run('contact_link', { action: 'add', contact: 'כרמל', other: 'דור' }), /may not/);
  assert.equal(db.read('contacts', 'c').knows, undefined);
  // The generic update cleans a hand-made list.
  await tools(db).run('update', { collection: 'contacts', id: 'd', data: { knows: [{ contactId: 'c', kind: 'weird' }, { contactId: 'c', kind: 'introduced' }, { note: 'no id' }] } });
  assert.deepEqual(db.read('contacts', 'd').knows.map((x) => [x.contactId, x.kind]), [['c', 'knows']]);
});
