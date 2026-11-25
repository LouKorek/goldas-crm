// The website follows the CRM: what counts as a change a card shows, what is
// drafted without guessing, what is only asked, that nothing is published from
// here, and that one change is proposed once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, stubFirestore, recorder, OWNER } = require('./fake-firestore.js');
const admin = stubFirestore();

const { viewOf, flagCode, cardFor, cardChange, followSite, BUTTONS } = require('../golda-site-follow.js');
const { readSite } = require('../website-html.js');
const { PAGE, fakeSite } = require('./fake-site.js');
const { websiteTools } = require('../golda-website.js');
const drafts = require('../website-drafts.js');
const { whatsappRecipients } = require('../golda-identity.js');
const { ownerOf } = require('../golda-nudge.js');

const GAVIN = { id: 'p1', fullName: 'Gavin Karam', gender: 'Men', currentClub: 'Hapoel Kfar Saba', contractStatus: 'Under Contract', primaryPosition: 'CDM', secondaryPositions: ['CM', 'CB'], dob: '2007-05-01', foot: 'Right', nationalities: ['Israel', 'United States'] };
const EYAL = { id: 'p2', fullName: 'Eyal Prashizky', gender: 'Men', currentClub: "Ironi Modi'in", currentClubIsYouth: true, contractStatus: 'Under Contract', primaryPosition: 'GK', dob: '2010-02-02', foot: 'Right', nationalities: ['Israel'] };
const DANA = { id: 'p3', fullName: 'דנה כהן', gender: 'Women', currentClub: 'מכבי חיפה', primaryPosition: 'ST', dob: '2004-03-01', foot: 'Left', nationalities: ['Israel'] };
const YAIR = { id: 'p4', fullName: 'יאיר שמש', gender: 'Men', currentClub: 'Ironi Karmiel', primaryPosition: 'CDM', secondaryPositions: ['CM'], dob: '2006-08-08', foot: 'Right', nationalities: ['Israel'], profileLink: 'https://www.transfermarkt.com/yair-shemesh/profil/spieler/123456' };
const ALL = [GAVIN, EYAL, DANA, YAIR];

const NOW = new Date('2026-11-25T12:30:00Z');
const owner = ownerOf(whatsappRecipients([OWNER]));
const jobOf = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };

/** A CRM that was already seen once, then changed. */
async function seen(players = ALL, extra = {}) {
  const db = fakeDb({ wa_sessions: { 972500000001: { turn: 7 } }, ...extra });
  const site = fakeSite();
  const first = await followSite(db, owner, players, NOW, { admin, site, send: async () => { throw new Error('nothing may be sent on the first run'); } });
  assert.deepEqual(first, { baseline: players.length });
  return { db, site };
}
const follow = (db, site, players, send, job = jobOf()) => followSite(db, owner, players, NOW, { admin, site, send, job });
const edited = (players, id, patch) => players.map((p) => (p.id === id ? { ...p, ...patch } : p));

test('what a card shows is taken from the record; anything else is not a change', () => {
  assert.deepEqual(viewOf(GAVIN), { name: 'Gavin Karam', club: 'Hapoel Kfar Saba', youth: false, free: false, pos: 'CDM/CM', born: '2007', foot: 'Right', nat: 'Israel|United States' });
  const same = (patch) => JSON.stringify(viewOf({ ...GAVIN, ...patch })) === JSON.stringify(viewOf(GAVIN));
  for (const patch of [{ notes: 'x' }, { contractEnd: '2027-06-30' }, { videoLink: 'https://youtu.be/x' }, { phone: '050' }, { dob: '2007-12-31' }, { secondaryPositions: ['CM', 'RB'] }]) assert.ok(same(patch), JSON.stringify(patch));
  for (const patch of [{ currentClub: 'Maccabi Haifa' }, { primaryPosition: 'CB' }, { foot: 'Left' }, { dob: '2008-01-01' }, { nationalities: ['Israel'] }, { fullName: 'Gavin Karem' }, { contractStatus: 'Free' }, { currentClubIsYouth: true }]) assert.ok(!same(patch), JSON.stringify(patch));
});

test('a country becomes the two letters of its flag, or nothing when it is not known', () => {
  assert.deepEqual(['Israel', 'United States', 'DR Congo', 'England', 'Ivory Coast', 'Bosnia and Herzegovina', 'germany', 'Türkiye', 'Turkey', 'Republic of Ireland'].map(flagCode), ['il', 'us', 'cd', 'gb', 'ci', 'ba', 'de', 'tr', 'tr', 'ie']);
  assert.equal(flagCode('Atlantis'), null);
  assert.equal(flagCode(''), null);
});

test('the card is the one with the same name, in any order, or the name in the Transfermarkt link', () => {
  const cards = readSite(PAGE).players;
  assert.equal(cardFor(cards, ['Gavin Karam']).name, 'Gavin Karam');
  assert.equal(cardFor(cards, ['Karam Gavin']).name, 'Gavin Karam');
  assert.equal(cardFor(cards, ['יאיר שמש'], YAIR.profileLink).name, 'Yair Shemesh');
  assert.equal(cardFor(cards, ['יאיר שמש']), null);
  assert.equal(cardFor(cards, ['Gavin']), null, 'a first name alone is not a match');
  assert.equal(cardFor(cards, ['Dan Cohen']), null);
});

test('the first run only records; a run with no change does not even read the site', async () => {
  const { db, site } = await seen();
  assert.deepEqual(Object.keys(db.read('app_meta', 'goldaSiteFollow').seen).sort(), ['p1', 'p2', 'p3', 'p4']);
  const { out, send } = recorder();
  assert.deepEqual(await follow(db, site, ALL, send), { changed: 0 });
  // a change the card does not show is no change
  assert.deepEqual(await follow(db, site, edited(ALL, 'p1', { contractEnd: '2027-06-30', notes: 'חדש' }), send), { changed: 0 });
  assert.deepEqual([out.length, site.reads], [0, 0]);
  // a new player is recorded without a word: a new card needs a picture and is asked for
  await follow(db, site, [...ALL, { id: 'p9', fullName: 'New Player', currentClub: 'X' }], send);
  assert.ok(db.read('app_meta', 'goldaSiteFollow').seen.p9);
  assert.equal(out.length, 0);
});

test('a club and a position changed in the CRM: a draft, the question, and nothing live', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  const job = jobOf();
  const now = edited(ALL, 'p1', { currentClub: 'Maccabi Haifa', primaryPosition: 'CB', secondaryPositions: [] });
  assert.deepEqual(await follow(db, site, now, send, job), { sent: 1, drafted: 1, asks: 0 });

  assert.equal(out.length, 1);
  assert.deepEqual([out[0].to, out[0].kind, out[0].buttons], ['lou.korek@gmail.com', 'website', BUTTONS]);
  assert.match(out[0].body, /^\*לו, האתר לא מעודכן לפי ה-CRM\* 🌐/);
  assert.match(out[0].body, /\*Gavin Karam\*\n• מועדון: Maccabi Haifa \(במקום Hapoel Kfar Saba\)\n• עמדה: CB \(במקום DM \/ CM\)/);
  assert.match(out[0].body, /שום דבר לא באוויר עדיין\. לפרסם\?$/);
  assert.match(job.notes.at(-1), /site follow → lou\.korek@gmail\.com: 1 card\(s\) drafted/);

  // the draft is his, made at the chat's current turn
  const draft = await drafts.getDraft(db, owner.email);
  assert.deepEqual(draft.changes, [{ type: 'update_player', player: 'Gavin Karam', club: 'Maccabi Haifa', position: 'CB' }]);
  assert.equal(draft.changedTurn, 7);
  assert.equal(site.published.length, 0, 'nothing is published from here');
  // the question is in the chat, so his one-word answer has something to answer
  const history = db.all('wa_sessions/972500000001/threads')[0].history;
  assert.deepEqual([history.at(-1).role, history.at(-1).proactive, history.at(-1).buttons], ['assistant', 'website', BUTTONS]);

  // the agent cannot publish in the same turn; his yes in the next message can
  const agent = (turn) => websiteTools({ db, admin, identity: owner, media: null, session: { turn }, role: 'admin', state: { outFiles: [] }, site });
  await assert.rejects(agent(7).website_publish({ action: 'publish' }), /has not answered the draft yet/);
  const done = await agent(8).website_publish({ action: 'publish' });
  assert.equal(done.published, true);
  assert.deepEqual(site.published[0], [{ type: 'update_player', player: 'Gavin Karam', club: 'Maccabi Haifa', position: 'CB' }]);

  // the same change is never proposed twice
  assert.deepEqual(await follow(db, site, now, send), { changed: 0 });
  assert.equal(out.length, 1);
});

test('a youth team gets its age group; the year, the foot and the flags follow the record', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  let now = edited(ALL, 'p2', { currentClub: 'Maccabi Petah Tikva', dob: '2009-02-02', foot: 'Left', nationalities: ['Israel', 'Germany'] });
  now = edited(now, 'p4', { primaryPosition: 'CAM', secondaryPositions: [] });
  const r = await follow(db, site, now, send);
  assert.deepEqual([r.drafted, r.asks], [2, 0]);
  const draft = await drafts.getDraft(db, owner.email);
  assert.deepEqual(draft.changes, [
    { type: 'update_player', player: 'Eyal Prashizky', club: 'Maccabi Petah Tikva (U19)', born: '2009', foot: 'Left', flags: ['il', 'de'] },
    { type: 'update_player', player: 'Yair Shemesh', position: 'AM' },   // found through his Transfermarkt link
  ]);
  assert.match(out[0].body, /• דגלים: Israel \+ Germany \(במקום Israel\)/);
  assert.match(out[0].body, /\*Yair Shemesh\*\n• עמדה: AM \(במקום DM \/ CM\)/);
});

test('what cannot be written without guessing is asked, not drafted', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  let now = edited(ALL, 'p1', { currentClub: 'הפועל חדרה' });
  now = edited(now, 'p2', { contractStatus: 'Free', currentClub: '' });
  now = edited(now, 'p4', { nationalities: ['Israel', 'Atlantis'] });
  assert.deepEqual(await follow(db, site, now, send), { sent: 1, drafted: 0, asks: 3 });
  assert.deepEqual(out[0].buttons, [], 'an open question has no yes/no buttons');
  assert.match(out[0].body, /^\*לו, משהו השתנה ב-CRM שנוגע לאתר\* 🌐/);
  assert.match(out[0].body, /• \*Gavin Karam\*: המועדון ב-CRM הוא "הפועל חדרה", ובכרטיס כתוב "Hapoel Kfar Saba"\. איך לכתוב את המועדון החדש באנגלית\?/);
  assert.match(out[0].body, /• \*Eyal Prashizky\*: ב-CRM הוא שחקן חופשי עכשיו/);
  assert.match(out[0].body, /• \*Yair Shemesh\*: האזרחויות ב-CRM הן Israel, Atlantis/);
  assert.equal((await drafts.getDraft(db, owner.email)).changes.length, 0);
  assert.equal(out.length, 1);
  await follow(db, site, now, send);
  assert.equal(out.length, 1, 'asked once');
});

test('a draft and a question can come in one message', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  const now = edited(edited(ALL, 'p1', { foot: 'Both' }), 'p2', { currentClub: 'בני יהודה' });
  assert.deepEqual(await follow(db, site, now, send), { sent: 1, drafted: 1, asks: 1 });
  assert.match(out[0].body, /• רגל: Both \(במקום Right\)/);
  assert.match(out[0].body, /\*ועוד דבר שצריך את המילה שלך לפני שאגע בכרטיס:\*\n• \*Eyal Prashizky\*/);
  assert.deepEqual(out[0].buttons, BUTTONS);
});

test('a player with no card, or a card that already says it: silence, and the record moves on', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  // Dana has no card; Gavin's "new" club is what the card already shows (Lou fixed the site himself)
  const before = ALL.map((p) => (p.id === 'p1' ? { ...p, currentClub: 'Old Club' } : p));
  const s = await seen(before);
  const r = await follow(s.db, s.site, edited(edited(before, 'p1', { currentClub: 'Hapoel Kfar Saba' }), 'p3', { currentClub: 'הפועל ירושלים' }), send);
  assert.deepEqual(r, { changed: 2, onSite: 0 });
  assert.equal(out.length, 0);
  assert.equal(s.db.read('app_meta', 'goldaSiteFollow').seen.p1.club, 'Hapoel Kfar Saba');
  assert.deepEqual(await follow(db, site, ALL, send), { changed: 0 });
});

test('a player who left the agency and still has a card: she asks whether to take it down', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  const r = await follow(db, site, ALL.filter((p) => p.id !== 'p1' && p.id !== 'p3'), send);
  assert.deepEqual(r, { sent: 1, drafted: 0, asks: 1 });
  assert.match(out[0].body, /• \*Gavin Karam\*: כבר לא ברשימת המיוצגים ב-CRM, והכרטיס עדיין באתר\. להוריד אותו\?/);
  assert.equal((await drafts.getDraft(db, owner.email)).changes.length, 0, 'a card is never removed from here');
});

test('when the site does not answer, or the message cannot go out, the change waits for the next hour', async () => {
  const { db, site } = await seen();
  const { out, send } = recorder();
  const now = edited(ALL, 'p1', { currentClub: 'Maccabi Haifa' });
  site.down = true;
  await assert.rejects(follow(db, site, now, send), /the site did not answer/);
  site.down = false;
  await assert.rejects(follow(db, site, now, async () => { throw new Error('WhatsApp API 500'); }), /WhatsApp API 500/);
  assert.equal(db.read('app_meta', 'goldaSiteFollow').seen.p1.club, 'Hapoel Kfar Saba');
  assert.deepEqual(await follow(db, site, now, send), { sent: 1, drafted: 1, asks: 0 });
  assert.equal(out.length, 1);
  assert.deepEqual((await drafts.getDraft(db, owner.email)).changes, [{ type: 'update_player', player: 'Gavin Karam', club: 'Maccabi Haifa' }], 'the retry did not double the draft');
});

test('his own open draft is kept: her lines join it, or she only asks when they collide', async () => {
  // he has a text change waiting: hers joins it and the message says so
  const a = await seen();
  await websiteTools({ db: a.db, admin, identity: owner, media: null, session: { turn: 5 }, role: 'admin', state: { outFiles: [] }, site: a.site })
    .website_edit({ changes: [{ type: 'update_player', player: 'Yair Shemesh', foot: 'Left' }] });
  const one = recorder();
  await follow(a.db, a.site, edited(ALL, 'p1', { foot: 'Left' }), one.send);
  assert.match(one.out[0].body, /בטיוטה של האתר מחכים גם שינויים קודמים שלך, ופרסום יעלה את כולם יחד\./);
  assert.equal((await drafts.getDraft(a.db, owner.email)).changes.length, 2);

  // his draft removes the very card: no draft from her, the change is told as a question
  const b = await seen();
  await websiteTools({ db: b.db, admin, identity: owner, media: null, session: { turn: 5 }, role: 'admin', state: { outFiles: [] }, site: b.site })
    .website_edit({ changes: [{ type: 'remove_player', player: 'Gavin Karam' }] });
  const two = recorder();
  const job = jobOf();
  assert.deepEqual(await follow(b.db, b.site, edited(ALL, 'p1', { foot: 'Left' }), two.send, job), { sent: 1, drafted: 0, asks: 1 });
  assert.match(job.notes[0], /site follow: no draft \(Gavin Karam is set to be removed in this draft/);
  assert.match(two.out[0].body, /• \*Gavin Karam\*: רגל: Left \(במקום Right\)\. לא הצלחתי להכין טיוטה לבד; להכין\?/);
  assert.deepEqual((await drafts.getDraft(b.db, owner.email)).changes, [{ type: 'remove_player', player: 'Gavin Karam' }]);
});

test('one changed field at a time: only what changed in the CRM is compared with the card', () => {
  const card = readSite(PAGE).players.find((c) => c.name === 'Gavin Karam');
  const before = viewOf(GAVIN);
  // the card says "DM / CM" and the CRM says CDM/CM: not a difference, and not touched when only the foot changed
  const c = cardChange(card, before, viewOf({ ...GAVIN, foot: 'Left' }), GAVIN, NOW);
  assert.deepEqual(c.fields, { foot: 'Left' });
  assert.deepEqual(cardChange(card, before, viewOf({ ...GAVIN, fullName: 'Gavin Karem' }), GAVIN, NOW).fields, { name: 'Gavin Karem' });
  assert.deepEqual(cardChange(card, before, viewOf({ ...GAVIN, fullName: 'גאווין כרם' }), GAVIN, NOW).fields, {});
  // a youth team with no birth date: the club is drafted without brackets and she says what is missing
  const noAge = cardChange(card, before, viewOf({ ...GAVIN, currentClub: 'Maccabi Haifa', currentClubIsYouth: true, dob: '' }), { ...GAVIN, dob: '' }, NOW);
  assert.deepEqual(noAge.fields, { club: 'Maccabi Haifa' });
  assert.match(noAge.asks[0], /לא ידוע לי השנתון/);
});
