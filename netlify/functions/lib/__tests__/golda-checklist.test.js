// The player checklist on the server: Golda's player_checklist tool (one player,
// and the least complete first) and the nightly stamp of who has a card on the
// website, which the checklist's "website card" item reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore } = require('./fake-firestore.js');
stubFirestore();

const { checklistTools, CHECKLIST_TOOL_DEF } = require('../golda-checklist.js');
const { checkSiteCards, stampSiteCards, CARD_CHECK_HOUR } = require('../golda-site-follow.js');
const { fakeSite } = require('./fake-site.js');
const { systemPrompt, toolsFor } = require('../wa-agent.js');

const FILE = [{ name: 'x.pdf', fileId: 'f1' }];
const FULL = {
  fullName: 'Gavin Karam', gender: 'Men', stage: 'represented', contractStatus: 'Under Contract', contractEnd: '2027-06-30', reprEnd: '2027-06-30',
  passportExpiry: '2030-01-01', dob: '2007-05-01', primaryPosition: 'CDM', currentClub: 'Hapoel Kfar Saba', foot: 'Right', nationalities: ['Israel'],
  leagueCountry: 'Israel', reprFiles: FILE, passportFiles: FILE, photoFiles: FILE, videoLink: 'https://youtu.be/x', ifaTeamUrl: 'https://www.football.org.il/players/player/?player_id=1',
  profileLink: 'https://www.transfermarkt.com/x/profil/spieler/1', siteCard: { on: true, checkedAt: '2026-11-25' }, createdAt: '2024-01-01T00:00:00Z',
};
const seed = (players, report = { list: [], runAt: '2026-11-25T06:00:00Z' }) => fakeDb({ players, app_meta: report ? { syncWarnings: report } : {} });

test('what is missing for one player, most important first, with how to fix it', async () => {
  const db = seed({
    p1: FULL,
    p2: { ...FULL, fullName: 'New Kid', reprFiles: [], photoFiles: [], videoLink: '', createdAt: new Date().toISOString() },
  });
  const tool = checklistTools({ db }).player_checklist;
  const full = await tool({ playerId: 'p1' });
  assert.deepEqual([full.score, full.missing, full.title], [100, [], 'שלמות התיק']);
  const kid = await tool({ playerId: 'p2' });
  assert.equal(kid.title, 'קליטת שחקן');
  assert.deepEqual(kid.missing.map((m) => m.key), ['reprAgreement', 'photo', 'video']);
  assert.ok(kid.missing.every((m) => m.what && m.how));
  assert.ok(kid.score < 100 && kid.score > 0);
  assert.equal(kid.link, 'https://goldas-crm.netlify.app/players/p2');
});

test('the calendar says why; what cannot be known is said, not guessed', async () => {
  const db = seed({ p1: { ...FULL, siteCard: undefined } }, { list: [{ playerId: 'p1', reason: 'ifa-team-not-matched' }], runAt: '2026-11-25T06:00:00Z' });
  const r = await checklistTools({ db }).player_checklist({ playerId: 'p1' });
  assert.deepEqual(r.missing.map((m) => m.key), ['calendar']);
  assert.match(r.missing[0].how, /הקבוצה שלו בהתאחדות לא זוהתה/);
  assert.deepEqual(r.notKnownYet, ['כרטיס באתר']);
  // no sync report at all: the calendar is not known either
  const none = await checklistTools({ db: seed({ p1: FULL }, null) }).player_checklist({ playerId: 'p1' });
  assert.deepEqual(none.notKnownYet, ['משחקים ביומן']);
  assert.equal(none.score, 100);
});

test('the least complete first; prospects are not scored', async () => {
  const db = seed({
    a: FULL,
    b: { ...FULL, fullName: 'Half', reprFiles: [], passportFiles: [], photoFiles: [] },
    c: { ...FULL, fullName: 'Little', videoLink: '' },
    d: { ...FULL, fullName: 'Prospect', stage: 'tracking', reprFiles: [], dob: '' },
    e: { ...FULL, fullName: 'Gone', deletedAt: 'x', dob: '' },
  });
  const tool = checklistTools({ db }).player_checklist;
  const r = await tool({});
  assert.deepEqual(r.players.map((x) => x.name), ['Half', 'Little', 'Gavin Karam']);
  assert.deepEqual([r.total, r.complete], [3, 1]);
  assert.equal((await tool({ n: 1 })).players.length, 1);
  await assert.rejects(tool({ playerId: 'd' }), /not a represented player/);
});

test('every role can read the checklist, and the prompt says when to use it', () => {
  for (const role of ['viewer', 'manager', 'admin']) assert.ok(toolsFor(role).some((t) => t.name === 'player_checklist'), role);
  assert.equal(CHECKLIST_TOOL_DEF.name, 'player_checklist');
  const p = systemPrompt('גולדה', { name: 'לו', role: 'admin', email: 'lou.korek@gmail.com' });
  assert.match(p, /"מה חסר ל…".*player_checklist/);
  assert.match(p, /field=photoFiles/);
});

test('the website card: once a night, stamped only where it changed', async () => {
  const players = [
    { id: 'p1', fullName: 'Gavin Karam' },                                       // on the site
    { id: 'p2', fullName: 'Someone Else', siteCard: { on: false, checkedAt: '2026-11-01' } },   // not on it, already known
    { id: 'p3', fullName: 'Yair', profileLink: 'https://www.transfermarkt.com/yair-shemesh/profil/spieler/1' }, // found by his Transfermarkt name
    { id: 'p4', fullName: 'Eyal Prashizky', siteCard: { on: false, checkedAt: '2026-11-01' } }, // a card appeared
  ];
  const db = fakeDb({ players: Object.fromEntries(players.map(({ id, ...p }) => [id, p])) });
  const site = fakeSite();
  const at = (hour) => ({ hour, today: '2026-11-25', site });
  assert.deepEqual(await checkSiteCards(db, players, new Date(), at(14)), { skipped: 'not the hour' });
  assert.equal(site.reads, 0);
  const r = await checkSiteCards(db, players, new Date(), at(CARD_CHECK_HOUR));
  assert.deepEqual(r, { stamped: 3, cards: 3 });
  assert.equal(site.reads, 1);
  assert.deepEqual(db.read('players', 'p1').siteCard, { on: true, checkedAt: '2026-11-25' });
  assert.deepEqual(db.read('players', 'p2').siteCard, { on: false, checkedAt: '2026-11-01' }, 'unchanged: not written');
  assert.equal(db.read('players', 'p3').siteCard.on, true);
  assert.equal(db.read('players', 'p4').siteCard.on, true);
  // once a day
  assert.deepEqual(await checkSiteCards(db, players, new Date(), at(CARD_CHECK_HOUR)), { skipped: 'checked today' });
  // the next day nothing changed: nothing is written
  const now = players.map((p) => ({ ...p, ...db.read('players', p.id) }));
  assert.equal(await stampSiteCards(db, now, [{ name: 'Gavin Karam' }, { name: 'Yair Shemesh' }, { name: 'Eyal Prashizky' }], '2026-11-26'), 0);
});

test('a site that does not answer stamps nothing', async () => {
  const db = fakeDb({ players: { p1: { fullName: 'Gavin Karam' } } });
  await assert.rejects(checkSiteCards(db, [{ id: 'p1', fullName: 'Gavin Karam' }], new Date(), { hour: CARD_CHECK_HOUR, today: '2026-11-25', site: fakeSite({ down: true }) }), /did not answer/);
  assert.equal(db.read('players', 'p1').siteCard, undefined);
});
