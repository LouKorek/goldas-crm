// Regulation pointers (lib/regulations.js): which rows touch a player or a
// deal, that every flag carries its source and the closing line, and that an
// unverified topic never states a rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb } = require('./fake-firestore.js');
const { RULES, regulationFlags, regulationTools, DISCLAIMER, READ_ON } = require('../regulations.js');

const TODAY = '2026-11-25';
const minor = (over = {}) => ({ id: 'p1', name: 'נועם לוי', stage: 'represented', dob: '2010-03-01', leagueCountry: 'Israel', ...over });
const adult = (over = {}) => ({ id: 'p2', name: 'דנה כהן', stage: 'represented', dob: '2000-03-01', leagueCountry: 'Israel', ...over });
const deal = (over = {}) => ({ id: 'd1', playerId: 'p1', clubName: 'FC Köln', stage: 'Negotiation', ...over });
const ids = (list) => list.map((x) => x.id);

test('the table: every row is dated and sourced, and an unverified row states no rule', () => {
  assert.ok(RULES.length >= 10);
  for (const r of RULES) {
    assert.ok(['verified', 'unverified'].includes(r.status), r.id);
    assert.ok(['agents', 'minors', 'windows'].includes(r.area), r.id);
    if (r.status === 'verified') {
      assert.match(r.readOn, /^\d{4}-\d{2}-\d{2}$/, r.id);
      assert.ok(r.source.document && /^https:\/\/([a-z]+\.)*fifa\.com\//.test(r.source.url), `${r.id}: a verified row is read on the regulator's own page`);
      assert.ok(r.source.readIn, `${r.id}: says which page it was read in`);
    } else {
      assert.equal(r.he, undefined, `${r.id}: an unverified row has no statement of the rule`);
      assert.ok(r.topic && r.check.document && /^https:\/\//.test(r.check.url), r.id);
      assert.doesNotMatch(r.topic, /\d/, `${r.id}: no number in an unverified topic`);
    }
  }
  assert.equal(new Set(ids(RULES)).size, RULES.length);
});

test('a minor moving abroad: the under-18 rule, with its article, its link, the day it was read and the closing line', () => {
  const out = regulationFlags({ player: minor(), deal: deal(), club: { country: 'Germany' }, today: TODAY });
  const f = out.flags.find((x) => x.id === 'minor_international_transfer');
  assert.ok(f);
  assert.equal(f.status, 'verified');
  assert.equal(f.source.article, 'art. 19');
  assert.match(f.source.url, /^https:\/\/inside\.fifa\.com\//);
  assert.equal(f.readOn, READ_ON);
  assert.match(f.line, /בן 16/);
  assert.ok(f.line.includes(f.source.url));
  assert.ok(f.line.endsWith(DISCLAIMER));
  // The new RSTP of 2027 travels with it.
  assert.ok(ids(out.flags).includes('rstp_new_2027'));
});

test('every flag ends with the lawyer line and carries a source link, whatever the case', () => {
  const cases = [
    { player: minor(), deal: deal({ commission: '10%', payments: [{ payer: { kind: 'club' } }] }), club: { country: 'Germany' } },
    { player: adult(), deal: deal({ playerId: 'p2', stage: 'Mandate Received' }), club: { country: 'Israel' } },
    { topic: 'all' },
  ];
  for (const c of cases) {
    const out = regulationFlags({ ...c, today: TODAY });
    assert.ok(out.flags.length > 0);
    for (const f of out.flags) {
      assert.ok(f.line.endsWith(DISCLAIMER), f.id);
      assert.match(f.source.url, /^https:\/\//, f.id);
      assert.ok(f.line.includes(f.source.url), f.id);
      assert.ok(f.source.document, f.id);
      assert.doesNotMatch(f.line, /—/, 'no em-dash in a text a person reads');
    }
  }
});

test('a minor moving inside the same country, or an adult: no under-18 flag', () => {
  const home = regulationFlags({ player: minor(), deal: deal({ clubName: 'מכבי חיפה' }), club: { country: 'Israel' }, today: TODAY });
  assert.ok(!ids(home.flags).includes('minor_international_transfer'));
  const grown = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Germany' }, today: TODAY });
  assert.ok(!ids(grown.flags).includes('minor_international_transfer'));
});

test('a minor and a club whose country is not on record: flagged, and the flag says what is not known', () => {
  const out = regulationFlags({ player: minor(), deal: deal(), today: TODAY });
  const f = out.flags.find((x) => x.id === 'minor_international_transfer');
  assert.match(f.why, /לא רשום באיזו מדינה/);
});

test('agent rules: the suspended ones say so, each with its article, and the state of the suspension comes with them', () => {
  const out = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2', stage: 'Mandate Received', commission: '10%', payments: [{ payer: { kind: 'club' } }] }), today: TODAY });
  const got = ids(out.flags);
  for (const id of ['agent_licence', 'agent_fee_cap_suspended', 'agent_client_pays_suspended', 'agent_clearing_house_suspended', 'agent_dual_representation_suspended', 'agent_rules_cjeu_2026']) assert.ok(got.includes(id), id);
  const cap = out.flags.find((x) => x.id === 'agent_fee_cap_suspended');
  assert.equal(cap.source.article, 'art. 15 pars 1-4');
  assert.match(cap.he, /הודיעה ב-8\.9\.2023 על השעיית הכלל/);
  assert.equal(out.flags.find((x) => x.id === 'agent_dual_representation_suspended').source.article, 'art. 12 pars 8-10');
});

test('payments are not read for someone who may not see money', () => {
  const d = deal({ playerId: 'p2', stage: 'Initial Talks', commission: '10%', payments: [{ payer: { kind: 'club' } }] });
  const out = regulationFlags({ player: adult(), deal: d, today: TODAY, money: false });
  assert.deepEqual(ids(out.flags), ['agent_licence']);
});

test('what was not read at the source is listed as not checked, with where to check and no rule', () => {
  const out = regulationFlags({ player: minor({ reprStart: '2025-01-01', reprEnd: '2028-01-01', contractStatus: 'Under Contract', contractEnd: '2027-06-30' }), deal: deal(), club: { country: 'Israel' }, today: TODAY });
  const got = ids(out.notVerified);
  for (const id of ['agent_representation_length', 'agent_minor_representation', 'ifa_agents', 'ifa_minors', 'rstp_pre_contract', 'windows_israel']) assert.ok(got.includes(id), id);
  for (const n of out.notVerified) {
    assert.equal(n.note, 'לא נבדק מול המקור');
    assert.ok(n.checkIn.document && n.checkIn.url);
    assert.equal(n.he, undefined);
  }
  // None of them is among the flags.
  for (const id of got) assert.ok(!ids(out.flags).includes(id));
});

test('a limit that someone verified and filled is compared with the agreement on record', () => {
  const LIMIT = 24;
  const rules = RULES.map((r) => (r.id === 'agent_representation_length'
    ? { ...r, status: 'verified', limitMonths: LIMIT, readOn: TODAY, he: 'הסכם ייצוג מוגבל באורכו.', source: { document: 'Test Regulations', article: 'art. 1', readIn: 'the test', url: 'https://example.org/rules' } }
    : r));
  const long = regulationFlags({ player: adult({ reprStart: '2025-01-01', reprEnd: '2028-01-01' }), today: TODAY, rules });
  const f = long.flags.find((x) => x.id === 'agent_representation_length');
  assert.match(f.why, /36 חודשים/);
  assert.ok(f.line.endsWith(DISCLAIMER));
  const short = regulationFlags({ player: adult({ reprStart: '2025-01-01', reprEnd: '2026-12-31' }), today: TODAY, rules });
  assert.ok(!ids(short.flags).includes('agent_representation_length'));
});

test('the league window: closed today or closing soon, always marked as not officially verified', () => {
  const closed = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Germany' }, today: TODAY });
  const w = closed.flags.find((x) => x.id === 'window_league');
  assert.equal(w.status, 'unverified');
  assert.match(w.line, /סגור היום, ונפתח ב-1\.1\.2027/);
  assert.match(w.line, /לא אומת מול מקור רשמי/);
  const closing = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Germany' }, today: '2027-01-25' });
  assert.match(closing.flags.find((x) => x.id === 'window_league').line, /נסגר ב-1\.2\.2027 בשעה 20:00: נשארו 7 ימים/);
  const wide = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Germany' }, today: '2026-07-10' });
  assert.ok(!ids(wide.flags).includes('window_league'), 'a window open for more than a month is not a flag');
  const israel = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Israel' }, today: TODAY });
  assert.ok(!ids(israel.flags).includes('window_league'));
  assert.ok(ids(israel.notVerified).includes('windows_israel'));
});

test('the table is dated: after 1.1.2027 the RSTP note says to check again, and an old row says how old it is', () => {
  const later = regulationFlags({ player: minor({ dob: '2011-03-01' }), deal: deal(), club: { country: 'Germany' }, today: '2027-08-01' });
  assert.match(later.flags.find((x) => x.id === 'rstp_new_2027').he, /נכנס לתוקף ב-1\.1\.2027.*לבדוק מחדש/);
  assert.match(later.flags.find((x) => x.id === 'minor_international_transfer').line, /לפני יותר מחצי שנה/);
});

test('regulation_check: reads the player, his one open deal and the club, and tells Golda how to show it', async () => {
  const db = fakeDb({
    players: { p1: minor() },
    deals: { d1: deal({ clubId: 'c1' }), d0: deal({ stage: 'Not Relevant', clubName: 'אחר' }) },
    clubs: { c1: { name: 'FC Köln', country: 'Germany' } },
  });
  const tools = regulationTools({ db, role: 'manager', can: () => false });
  const out = await tools.regulation_check({ playerId: 'p1' });
  assert.equal(out.about.dealId, 'd1');
  const f = out.flags.find((x) => x.id === 'minor_international_transfer');
  assert.ok(f.text.endsWith(DISCLAIMER));
  assert.match(f.source.url, /^https:\/\/inside\.fifa\.com\//);
  assert.match(out.rule, /Never conclude/);
  await assert.rejects(() => tools.regulation_check({}), /pass playerId, dealId or a topic/);
  await assert.rejects(() => tools.regulation_check({ dealId: 'nope' }), /deal not found/);
  const general = await tools.regulation_check({ topic: 'minors' });
  assert.ok(general.flags.some((x) => x.id === 'minor_international_transfer'));
});

test('every row reads as a pointer, never a legal conclusion', () => {
  const he = (id) => { const r = RULES.find((x) => x.id === id); return typeof r.he === 'function' ? r.he({ today: TODAY }) : r.he; };
  const minorRow = he('minor_international_transfer');
  assert.match(minorRow, /עוסק בהעברות בינלאומיות של שחקנים מתחת לגיל 18 ומגביל אותן/);
  assert.match(minorRow, /החריגים מפורטים בסעיף עצמו/);
  assert.doesNotMatch(minorRow, /מותרת רק|ששת|שישה חריגים|אוסר/);
  assert.match(he('agent_licence'), /עוסק בדרישה לרישיון סוכן/);
  assert.doesNotMatch(he('agent_licence'), /חובה/);
  for (const id of ['agent_fee_cap_suspended', 'agent_client_pays_suspended', 'agent_clearing_house_suspended', 'agent_dual_representation_suspended']) {
    const t = he(id);
    assert.match(t, /פיפ"א הודיעה ב-8\.9\.2023 על השעיית הכלל/, id);
    assert.ok(RULES.find((x) => x.id === id).source.readIn.includes('8.9.2023'), `${id}: the date is the notice's own`);
    assert.match(t, /נכון ל-25\.11\.2026, היום שבו נקרא, לא מצאתי הודעה רשמית שההשעיה הסתיימה/, id);
    assert.match(t, /פסק הדין של בית הדין של האיחוד האירופי מיולי 2026 זה עשוי להשתנות/, id);
    assert.doesNotMatch(t, /מושעה בכל העולם|האיסור/, id);
  }
  assert.match(he('agent_fee_cap_suspended'), /לא אישור שהעמלה הרשומה בעסקה תקינה/);
  assert.doesNotMatch(he('agent_rules_cjeu_2026'), /ניתנים להצדקה/);
  // Nothing in the table states a conclusion.
  for (const r of RULES.filter((x) => x.he)) assert.doesNotMatch(he(r.id), /חובה|אסור|מותר|חוקי/, r.id);
  // Statuses are as they were: no row was verified by rewording it.
  assert.deepEqual(RULES.filter((r) => r.status === 'verified').map((r) => r.id),
    ['agent_licence', 'agent_fee_cap_suspended', 'agent_client_pays_suspended', 'agent_clearing_house_suspended', 'agent_dual_representation_suspended', 'agent_rules_cjeu_2026', 'minor_international_transfer', 'rstp_new_2027']);
  // The league window says its dates are not official, on the flag itself.
  const w = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Germany' }, today: TODAY }).flags.find((x) => x.id === 'window_league');
  assert.match(w.he, /המועדים האלה לא ממקור רשמי/);
  assert.ok(w.line.endsWith(DISCLAIMER));
});

test('the age that decides is the age on the deal\'s registration date, and without one the flag says so', () => {
  // Seventeen today, eighteen on the registration date: not a minor for this move.
  const turning = minor({ dob: '2008-12-20' });
  const later = regulationFlags({ player: turning, deal: deal({ registrationDate: '2027-01-05' }), club: { country: 'Germany' }, today: TODAY });
  assert.ok(!ids(later.flags).includes('minor_international_transfer'));
  // Sixteen on the date: flagged, and the date is named.
  const young = regulationFlags({ player: minor(), deal: deal({ registrationDate: '2027-01-05' }), club: { country: 'Germany' }, today: TODAY });
  assert.match(young.flags.find((x) => x.id === 'minor_international_transfer').why, /השחקן יהיה בן 16 ב-5\.1\.2027, מועד הרישום הצפוי בעסקה/);
  // No date on the deal: the age today, and the flag says the registration date decides.
  const today = regulationFlags({ player: turning, deal: deal(), club: { country: 'Germany' }, today: TODAY });
  assert.match(today.flags.find((x) => x.id === 'minor_international_transfer').why, /בן 17 היום; הגיל שקובע הוא הגיל במועד הרישום, שלא רשום בעסקה/);
});

test('no date of birth: minority could not be checked, and that is said', () => {
  const out = regulationFlags({ player: minor({ dob: '' }), deal: deal(), club: { country: 'Germany' }, today: TODAY });
  assert.deepEqual(out.missing.map((m) => m.id), ['minor_age_unknown']);
  assert.match(out.missing[0].he, /תאריך הלידה של השחקן לא רשום, אז לא בדקתי אם הוא מתחת לגיל 18/);
  assert.deepEqual(regulationFlags({ player: minor(), deal: deal(), today: TODAY }).missing, []);
  assert.deepEqual(regulationFlags({ topic: 'minors', today: TODAY }).missing, [], 'a general question has no player to check');
});

test('regulation_check passes on what could not be checked', async () => {
  const db = fakeDb({ players: { p1: minor({ dob: '' }) }, deals: { d1: deal() } });
  const out = await regulationTools({ db, role: 'manager' }).regulation_check({ playerId: 'p1' });
  assert.equal(out.missing.length, 1);
  assert.match(out.missing[0], /לא בדקתי/);
});
