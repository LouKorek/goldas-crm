// Regulation pointers (lib/regulations.js): which rows touch a player or a
// deal, that every flag carries its source and the closing line, and that an
// unverified topic never states a rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb } = require('./fake-firestore.js');
const { RULES, regulationFlags, regulationTools, DISCLAIMER, READ_ON, READ_ON_PDF } = require('../regulations.js');

const TODAY = '2026-11-25';
const minor = (over = {}) => ({ id: 'p1', name: 'נועם לוי', stage: 'represented', dob: '2010-03-01', leagueCountry: 'Israel', ...over });
const adult = (over = {}) => ({ id: 'p2', name: 'דנה כהן', stage: 'represented', dob: '2000-03-01', leagueCountry: 'Israel', ...over });
const deal = (over = {}) => ({ id: 'd1', playerId: 'p1', clubName: 'FC Köln', stage: 'Negotiation', ...over });
const ids = (list) => list.map((x) => x.id);
const row = (id) => RULES.find((r) => r.id === id);
// A row's source may depend on the day (two editions of one document).
const sourceOf = (r, today = TODAY) => (typeof r.source === 'function' ? r.source({ today }) : r.source);
const heOf = (r, c = { today: TODAY }) => (typeof r.he === 'function' ? r.he(c) : r.he);

test('the table: every row is dated and sourced, and an unverified row states no rule', () => {
  assert.ok(RULES.length >= 10);
  for (const r of RULES) {
    assert.ok(['verified', 'unverified'].includes(r.status), r.id);
    assert.ok(['agents', 'minors', 'windows'].includes(r.area), r.id);
    if (r.status === 'verified') {
      assert.match(r.readOn, /^\d{4}-\d{2}-\d{2}$/, r.id);
      const s = sourceOf(r);
      assert.ok(s.document && /^https:\/\/(([a-z]+\.)*fifa\.com|www\.football\.org\.il)\//.test(s.url), `${r.id}: a verified row is read on the regulator's own page (FIFA or the Israel FA)`);
      assert.ok(s.readIn, `${r.id}: says which page it was read in`);
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
  // None of the rows about money (the fee cap, who pays, the clearing house): only the ones that read no payment.
  assert.deepEqual(ids(out.flags), ['agent_licence', 'ifa_agents']);
});

test('what was not read at the source is listed as not checked, with where to check and no rule', () => {
  const out = regulationFlags({ player: minor({ reprStart: '2025-01-01', reprEnd: '2028-01-01', contractStatus: 'Under Contract', contractEnd: '2027-06-30' }), deal: deal(), club: { country: 'Israel' }, today: TODAY });
  const got = ids(out.notVerified);
  // The season's registration dates in Israel are the one topic that was not read.
  assert.deepEqual(got, ['windows_israel']);
  for (const n of out.notVerified) {
    assert.equal(n.note, 'לא נבדק מול המקור');
    assert.ok(n.checkIn.document && n.checkIn.url);
    assert.equal(n.he, undefined);
  }
  // None of them is among the flags.
  for (const id of got) assert.ok(!ids(out.flags).includes(id));
});

test('the rows read in the official documents on 27.11.2026: each states its article, its edition and what was not read', () => {
  const out = regulationFlags({ player: minor({ reprStart: '2025-01-01', reprEnd: '2028-01-01', contractStatus: 'Under Contract', contractEnd: '2027-06-30' }), deal: deal(), club: { country: 'Israel' }, today: TODAY });
  const flag = (id) => out.flags.find((x) => x.id === id);
  const READ = ['agent_representation_length', 'agent_minor_representation', 'ifa_agents', 'rstp_minor_contract', 'ifa_minors', 'rstp_pre_contract', 'ifa_registration_periods'];
  for (const id of READ) {
    const f = flag(id);
    assert.ok(f, id);
    assert.equal(f.status, 'verified', id);
    assert.equal(f.readOn, READ_ON_PDF, id);
    assert.ok(f.source.article, `${id}: names the article`);
    assert.ok(f.topic && f.topic.length < 80 && !/\d/.test(f.topic), `${id}: a short topic, with no number, for where only the name is shown`);
    assert.match(f.line, /נקרא ב-27\.11\.2026\./, id);
    assert.doesNotMatch(f.line, /לא אומת מול מקור רשמי/, id);
    assert.ok(f.line.endsWith(DISCLAIMER), id);
  }
  // FIFA's agents regulations: the two-year term and the article on minors.
  assert.equal(flag('agent_representation_length').source.article, 'art. 12 par. 3');
  assert.match(flag('agent_representation_length').he, /לא יעלה על שנתיים/);
  assert.match(flag('agent_representation_length').why, /36 חודשים/);
  assert.equal(flag('agent_minor_representation').source.article, 'art. 13 pars 1-4');
  assert.match(flag('agent_minor_representation').he, /בששת החודשים שלפני הגיל.*הסכמה בכתב מראש של האפוטרופוס.*חתמו עליו הקטין והאפוטרופוס/);
  // The Israel FA's documents: the version that was read is named, the link is the FA's rules page, and what was not read is said.
  for (const [id, version, unread] of [['ifa_agents', 'יולי 2026', /סעיפים 29 ו-30 לא נקראו/], ['ifa_minors', 'אוגוסט 2026', /הסעיפים שאחריו לא נקראו/], ['ifa_registration_periods', 'נובמבר 2026', /המועדים של העונה הנוכחית לא כתובים בתקנון, ולא נקראו/]]) {
    const f = flag(id);
    assert.ok(f.source.document.includes(`גרסת ${version}`) && f.he.includes(`גרסת ${version}`), id);
    assert.equal(f.source.url, 'https://www.football.org.il/association/aboutassociation/rules/', id);
    assert.match(f.he, unread, id);
  }
  // A minor: the Israel FA's articles on representing a minor are spelled out; for an adult they are only named.
  assert.match(flag('ifa_agents').he, /לפי סעיף 28, סוכן לא מקבל עמלה על ייצוג של שחקן קטין/);
  const grown = regulationFlags({ player: adult(), deal: deal({ playerId: 'p2' }), club: { country: 'Israel' }, today: TODAY }).flags.find((x) => x.id === 'ifa_agents');
  assert.match(grown.he, /סעיפים 21 עד 24 עוסקים בייצוג של קטינים/);
  assert.doesNotMatch(grown.he, /לא מקבל עמלה/);
  assert.match(flag('ifa_minors').he, /לפי סעיף 9, הסכם בין מועדון לשחקן מתחת לגיל 18 לא יעלה על שלוש שנים/);
});

test('the RSTP rows follow the edition of the day: July 2025 until the end of 2026, January 2027 after it', () => {
  const young = minor({ dob: '2011-03-01', contractStatus: 'Under Contract', contractEnd: '2027-12-31' });
  const before = regulationFlags({ player: young, deal: deal(), club: { country: 'Germany' }, today: TODAY });
  const after = regulationFlags({ player: young, deal: deal(), club: { country: 'Germany' }, today: '2027-02-01' });
  const of = (out, id) => out.flags.find((x) => x.id === id);
  const b = of(before, 'rstp_minor_contract');
  assert.equal(b.source.article, 'art. 18 par. 2');
  assert.match(b.he, /מהדורת יולי 2025.*יותר משלוש שנים.*במהדורת ינואר 2027, שבתוקף מ-1\.1\.2027, נוסף לסעיף חריג של עד חמש שנים/);
  assert.match(b.he, /חוזר של פיפ"א מספטמבר 2026 עם תיקונים ל-RSTP לא נקרא/);
  assert.match(b.source.url, /July-2025-edition\.pdf$/);
  const a = of(after, 'rstp_minor_contract');
  assert.match(a.he, /מהדורת ינואר 2027.*יותר משלוש שנים.*חריג.*עד חמש שנים/);
  assert.doesNotMatch(a.he, /יולי 2025/);
  assert.match(a.source.url, /January-2027\.pdf$/);
  assert.ok(a.line.includes(a.source.url));
  // Approaching a player who is under contract: the same wording in both editions.
  for (const [out, url] of [[before, /July-2025-edition\.pdf$/], [after, /January-2027\.pdf$/]]) {
    const f = of(out, 'rstp_pre_contract');
    assert.equal(f.source.article, 'art. 18 par. 3');
    assert.match(f.he, /להודיע על כך בכתב למועדון הנוכחי.*בתוך שישה חודשים/);
    assert.match(f.why, /בחוזה עד 2027-12-31/);
    assert.match(f.source.url, url);
  }
  // The unread circular is said on every statement of art. 18, in both editions.
  for (const out of [before, after]) for (const id of ['rstp_minor_contract', 'rstp_pre_contract']) assert.match(of(out, id).he, /חוזר של פיפ"א מספטמבר 2026 עם תיקונים ל-RSTP לא נקרא/, id);
  // Next to a row read before the new edition (art. 19), the "check again" note names that row and not these two.
  const note = of(after, 'rstp_new_2027');
  assert.ok(of(after, 'minor_international_transfer') && note);
  assert.match(note.he, /מה שכתוב כאן על סעיף 19 \(העברה בינלאומית של קטינים\) נקרא לפני כן: צריך לבדוק מחדש את הסעיף הזה/);
  assert.match(of(before, 'rstp_new_2027').he, /מה שכתוב כאן על סעיף 19/);
  // Both rows were read in the new edition too, so they do not bring the "check again against the new RSTP" note by themselves.
  const alone = regulationFlags({ player: adult({ contractStatus: 'Under Contract', contractEnd: '2027-12-31' }), deal: deal({ playerId: 'p2' }), today: '2027-02-01' });
  assert.ok(ids(alone.flags).includes('rstp_pre_contract'));
  assert.ok(!ids(alone.flags).includes('rstp_new_2027'));
});

test('the length of a representation agreement on record is compared with the two years of the article', () => {
  assert.equal(row('agent_representation_length').limitMonths, 24);
  const long = regulationFlags({ player: adult({ reprStart: '2025-01-01', reprEnd: '2028-01-01' }), today: TODAY });
  assert.match(long.flags.find((x) => x.id === 'agent_representation_length').why, /36 חודשים/);
  const flagged = (reprStart, reprEnd) => ids(regulationFlags({ player: adult({ reprStart, reprEnd }), today: TODAY }).flags).includes('agent_representation_length');
  // By calendar dates, never by rounded months: two years to the day is within it, a day more is not.
  assert.equal(flagged('2025-01-01', '2026-12-31'), false, 'an agreement of two years is not flagged');
  assert.equal(flagged('2025-01-01', '2027-01-01'), false, 'two years to the day');
  assert.equal(flagged('2025-01-01', '2027-01-02'), true, 'two years and a day');
  assert.equal(flagged('2025-01-01', '2027-01-11'), true, 'two years and ten days, which rounds to 24 months');
  assert.equal(flagged('2025-03-01', '2027-03-15'), true);
  assert.equal(flagged('2025-01-01', '2027-02-01'), true, 'two years and a month');
  assert.equal(flagged('2024-02-29', '2026-02-28'), false, 'from a leap day');
  // The flag names the dates on record.
  const tenDays = regulationFlags({ player: adult({ reprStart: '2025-01-01', reprEnd: '2027-01-11' }), today: TODAY }).flags.find((x) => x.id === 'agent_representation_length');
  assert.match(tenDays.why, /מ-1\.1\.2025 עד 11\.1\.2027, כ-24 חודשים/);
  const none = regulationFlags({ player: adult(), today: TODAY });
  assert.ok(!ids(none.flags).includes('agent_representation_length'), 'no dates on record: nothing to compare');
  // A general question shows the row whatever the records say.
  assert.ok(ids(regulationFlags({ topic: 'agents', today: TODAY }).flags).includes('agent_representation_length'));
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
  // Israel: what the registration regulations say about the periods is a flag; the season's dates were not read.
  assert.ok(ids(israel.flags).includes('ifa_registration_periods'));
  assert.ok(ids(israel.notVerified).includes('windows_israel'));
  assert.doesNotMatch(israel.flags.find((x) => x.id === 'ifa_registration_periods').he, /\d{1,2}\.\d{1,2}\.\d{4}/, 'no date of a period is stated');
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
  const he = (id) => heOf(row(id));
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
  for (const r of RULES.filter((x) => x.he)) {
    for (const c of [{ today: TODAY }, { today: '2027-02-01' }, { today: TODAY, minor: true }]) assert.doesNotMatch(heOf(r, c), /חובה|אסור|מותר|רשאי|חוקי|—/, r.id);
  }
  // A row is verified only by reading its document: the ones read on the regulators' pages on 25.11.2026,
  // and the ones read in the official PDFs on 27.11.2026. The season's dates in Israel stay unverified.
  assert.deepEqual(RULES.filter((r) => r.status === 'verified' && r.readOn === READ_ON).map((r) => r.id),
    ['agent_licence', 'agent_fee_cap_suspended', 'agent_client_pays_suspended', 'agent_clearing_house_suspended', 'agent_dual_representation_suspended', 'agent_rules_cjeu_2026', 'minor_international_transfer', 'rstp_new_2027']);
  assert.deepEqual(RULES.filter((r) => r.status === 'verified' && r.readOn === READ_ON_PDF).map((r) => r.id),
    ['agent_representation_length', 'agent_minor_representation', 'ifa_agents', 'rstp_minor_contract', 'ifa_minors', 'rstp_pre_contract', 'ifa_registration_periods']);
  assert.deepEqual(RULES.filter((r) => r.status !== 'verified').map((r) => r.id), ['windows_israel']);
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
