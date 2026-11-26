// The deal room (lib/golda-deal.js): the facts of a deal, three scenarios
// built only from numbers on record, the red lines from the contract, the
// what-ifs that save nothing, and the one model call that may word but never
// add a number.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb } = require('./fake-firestore.js');
const { dealFacts, playerFacts, buildScenarios, scenariosText, readFigure, readCommission, checkReasoning, dealTools, DEAL_TOOL_DEFS } = require('../golda-deal.js');

const NOW = new Date('2026-11-25T10:00:00Z');
const dana = (over = {}) => ({
  id: 'p1', name: 'דנה כהן', stage: 'represented', gender: 'Women', dob: '2000-03-01', primaryPosition: 'CM', contractStatus: 'Under Contract', currentClub: 'מכבי חיפה',
  contractEnd: '2027-06-30', reprEnd: '2027-03-01', leagueCountry: 'Israel',
  contractTerms: { salary: 5000, currency: 'EUR', salaryPeriod: 'month', releaseClause: 150000, optionYears: 1, optionHolder: 'club', optionDeadline: '2027-01-31', signingFee: 10000, bonuses: 'בונוס אליפות', keyDates: [{ date: '2027-02-01', label: 'העלאת שכר' }], source: 'contract.pdf' },
  ...over,
});
const other = { id: 'p2', name: 'נועה לוי', stage: 'represented', gender: 'Women', primaryPosition: 'CM', contractTerms: { salary: 120000, currency: 'EUR', salaryPeriod: 'year' } };
const dollars = { id: 'p3', name: 'מאיה בר', stage: 'represented', gender: 'Women', primaryPosition: 'CM', contractTerms: { salary: 30000, currency: 'USD', salaryPeriod: 'month' } };
const deal = (over = {}) => ({ id: 'd1', playerId: 'p1', playerName: 'דנה כהן', clubId: 'c1', clubName: 'FC Köln', stage: 'Negotiation', enteredStageAt: '2026-11-20T10:00:00Z', salary: '8000', transferFee: '100000', commission: '10%', requirementId: 'r1', payments: [], ...over });
const requirement = (over = {}) => ({ id: 'r1', clubName: 'FC Köln', salary: '9000', transferFee: 'Not specified', leagueCountry: 'Germany', ...over });
const data = (over = {}) => ({ deals: [deal()], players: [dana(), other, dollars], requirements: [requirement()], now: NOW, ...over });
const byKey = (plan, key) => plan.scenarios.find((s) => s.key === key);

test('a figure typed as text: the number, its currency and period when written, the app\'s own when not', () => {
  assert.deepEqual(readFigure('8000', { salary: true }), { amount: 8000, currency: 'EUR', assumed: ['currency', 'period'], text: '8000', period: 'month', perMonth: 8000 });
  assert.deepEqual(readFigure('₪240,000 לשנה', { salary: true }), { amount: 240000, currency: 'ILS', assumed: [], text: '₪240,000 לשנה', period: 'year', perMonth: 20000 });
  assert.equal(readFigure('120k דולר לעונה', { salary: true }).perMonth, 10000);
  assert.equal(readFigure('8000 per month', { salary: true }).amount, 8000, 'the m of "month" is not a million');
  assert.equal(readFigure('8000eur').amount, 8000);
  assert.equal(readFigure('Not specified'), null);
  assert.equal(readFigure(''), null);
  assert.deepEqual(readCommission('10%'), { percent: 10, text: '10%' });
  assert.equal(readCommission('€5,000').amount, 5000);
  assert.equal(readCommission(''), null);
});

test('a figure is read only when it is one clear number: a range, an ordinal or words left over are unclear', () => {
  // "." or "," before exactly three digits is a thousands separator.
  assert.deepEqual(readFigure('€8.000 לחודש', { salary: true }), { amount: 8000, currency: 'EUR', assumed: [], text: '€8.000 לחודש', period: 'month', perMonth: 8000 });
  assert.equal(readFigure('1.250.000').amount, 1250000);
  assert.equal(readFigure('8.5k').amount, 8500, 'a decimal point before one or two digits is a decimal');
  // A range is not a number.
  for (const t of ['8000-10000', '8000 – 10000', '8000 עד 10000', '8k to 10k']) assert.deepEqual(readFigure(t, { salary: true }), { unclear: true, text: t }, t);
  // A period only from an explicit phrase; "בשנה הראשונה" is an ordinal.
  assert.deepEqual(readFigure('8000 בשנה הראשונה', { salary: true }), { unclear: true, text: '8000 בשנה הראשונה' });
  assert.equal(readFigure('8000 שנתי', { salary: true }).period, 'year');
  assert.equal(readFigure('8000 חודשי', { salary: true }).period, 'month');
  assert.deepEqual(readFigure('8000 month', { salary: true }), { unclear: true, text: '8000 month' }, 'a bare "month" is not a phrase');
  // Anything left over beyond the number, the currency and the period.
  for (const t of ['8000 + בונוסים', 'בערך 8000', '8000 נטו', '8,5', '٩٠٠٠ ₪', '8000 € $', 'שמונת אלפים יורו']) assert.equal(readFigure(t, { salary: true }).unclear, true, t);
  assert.equal(readFigure('Not specified'), null, 'what the app writes for no number is missing, not unclear');
  assert.deepEqual(readCommission('8%-10%'), { unclear: true, text: '8%-10%' });
});

test('an unclear figure is treated like a missing one: its field and its text are named, and no number is built on it', () => {
  for (const salary of ['8000-10000', '€8.000 לחודש בשנה הראשונה', '٩٠٠٠ ₪']) {
    const f = dealFacts(data({ deals: [deal({ salary })] }), 'd1');
    assert.equal(f.ask.salary, null, salary);
    const plan = buildScenarios(f);
    const target = byKey(plan, 'target');
    assert.equal(target.salaryPerMonth, null, salary);
    assert.equal(target.missing, `השכר המבוקש בעסקה לא ברור ("${salary}"), אז לא בניתי עליו מספר`);
    assert.ok(plan.missing.includes(target.missing));
    assert.ok(!plan.missing.includes('השכר המבוקש לא רשום בעסקה'), 'it is on record: unclear, not absent');
    // No commission is computed on the unclear salary either.
    assert.ok(plan.scenarios.every((s) => s.salaryPerMonth === null || s.key !== 'target'));
    assert.match(scenariosText(f, plan), /\*יעד:\* אין מספר\. השכר המבוקש בעסקה לא ברור/);
  }
  const range = dealFacts(data({ requirements: [requirement({ salary: '9000-12000' })] }), 'd1');
  assert.equal(range.budget.salary, null);
  assert.ok(range.missing.includes('השכר בדרישה של המועדון לא ברור ("9000-12000"), אז לא בניתי עליו מספר'));
});

test('a salary for a season divided into months says so in the assumptions', () => {
  const f = dealFacts(data({ deals: [deal({ salary: '96000 לעונה' })] }), 'd1');
  assert.equal(f.ask.salary.perMonth, 8000);
  assert.ok(f.assumptions.some((a) => a.startsWith('השכר בעסקה: רשום לעונה') && a.includes('12')), 'the twelve months are an assumption, and it is shown');
  const yearly = dealFacts(data({ deals: [deal({ salary: '96000 לשנה' })] }), 'd1');
  assert.ok(!yearly.assumptions.some((a) => a.includes('לעונה')));
});

test('dealFacts: what the CRM holds about the deal, and nothing else', () => {
  const f = dealFacts(data(), 'd1');
  assert.equal(f.player.name, 'דנה כהן');
  assert.equal(f.player.age, 26);
  assert.equal(f.stage, 'Negotiation');
  assert.equal(f.daysInStage, 5);
  assert.equal(f.ask.salary.perMonth, 8000);
  assert.equal(f.budget.salary.perMonth, 9000);
  assert.equal(f.current.salary.perMonth, 5000);
  assert.equal(f.current.releaseClause.amount, 150000);
  // A similar player of ours, per month; the yearly salary is divided, the dollars stay dollars.
  assert.deepEqual(f.comparables.map((c) => [c.player, c.perMonth, c.currency]), [['מאיה בר', 30000, 'USD'], ['נועה לוי', 10000, 'EUR']]);
  assert.ok(f.assumptions.some((a) => a.includes('השכר בעסקה') && a.includes('אירו')), 'a bare number is said to be read as euros per month');
  assert.equal(dealFacts(data(), 'nope'), null);
});

test('three scenarios, each resting on a named fact of ours', () => {
  const f = dealFacts(data(), 'd1');
  const plan = buildScenarios(f);
  // The anchor is the highest number of ours in the deal's currency: the similar player, above the club's own budget.
  assert.equal(byKey(plan, 'anchor').salaryPerMonth, 10000);
  assert.match(byKey(plan, 'anchor').restsOn, /נועה לוי/);
  assert.equal(byKey(plan, 'target').salaryPerMonth, 8000);
  assert.match(byKey(plan, 'target').restsOn, /רשום בעסקה/);
  assert.equal(byKey(plan, 'walkaway').salaryPerMonth, 5000);
  assert.match(byKey(plan, 'walkaway').restsOn, /בחוזה הנוכחי/);
  // 10% on a year of each salary.
  assert.deepEqual(plan.scenarios.map((s) => s.commission.perYear), [12000, 9600, 6000]);
  // The dollars of the third player were never mixed in.
  assert.ok(plan.scenarios.every((s) => s.currency === 'EUR'));
});

test('red lines come from the contract on record, each saying where it is written', () => {
  const plan = buildScenarios(dealFacts(data(), 'd1'));
  const all = plan.redLines.map((r) => r.he).join('\n');
  assert.match(all, /סעיף שחרור: €150,000/);
  assert.match(all, /אופציה ל-1 שנה בידי המועדון, עד 31\.1\.2027 \(בעוד 67 ימים\)/);
  assert.match(all, /השכר היום: €5,000 לחודש/);
  assert.match(all, /מענק חתימה בחוזה היום: €10,000/);
  assert.match(all, /1\.2\.2027 \(בעוד 68 ימים\): העלאת שכר/);
  assert.match(all, /מסתיים ב-30\.6\.2027/);
  assert.match(all, /הסכם הייצוג שלנו עם השחקן מסתיים ב-1\.3\.2027/);
  assert.ok(plan.redLines.filter((r) => r.restsOn.includes('contract.pdf')).length >= 4);
});

test('a missing number is named and never made up', () => {
  const bare = data({ deals: [deal({ salary: '', commission: '', requirementId: '' })], players: [dana({ contractTerms: undefined, contractStatus: 'Free', contractEnd: '' })] });
  const f = dealFacts(bare, 'd1');
  const plan = buildScenarios(f);
  for (const s of plan.scenarios) {
    assert.equal(s.salaryPerMonth, null, s.key);
    assert.equal(s.display, null, s.key);
    assert.ok(s.missing, s.key);
  }
  assert.match(byKey(plan, 'target').missing, /לא רשום בעסקה/);
  assert.match(byKey(plan, 'walkaway').missing, /אין רצפה מהנתונים/);
  assert.match(byKey(plan, 'anchor').missing, /אין עוגן מהנתונים/);
  for (const m of ['השכר המבוקש לא רשום בעסקה', 'העמלה לא רשומה בעסקה', 'תנאי החוזה הנוכחי של השחקן לא שמורים בתיק']) assert.ok(plan.missing.includes(m), m);
  const text = scenariosText(f, plan);
  assert.match(text, /\*יעד:\* אין מספר/);
  assert.match(text, /חסר, ולא השלמתי מעצמי/);
  // The only digits in the whole answer are the deal's fee, the stage's days and the link's id.
  assert.doesNotMatch(text, /€\d+(,\d+)? לחודש/);
});

test('no anchor is invented when nothing of ours is above the target', () => {
  const plan = buildScenarios(dealFacts(data({ players: [dana()], requirements: [requirement({ salary: '7000' })] }), 'd1'));
  assert.equal(byKey(plan, 'anchor').salaryPerMonth, null);
  assert.ok(plan.warnings.some((w) => /נמוך מהיעד/.test(w)), 'the club wrote less than the target: said, not hidden');
});

test('different currencies are never compared and never converted', () => {
  const shekels = dana({ contractTerms: { salary: 20000, currency: 'ILS', salaryPeriod: 'month' } });
  const plan = buildScenarios(dealFacts(data({ players: [shekels, other] }), 'd1'));
  assert.equal(byKey(plan, 'walkaway').currency, 'ILS');
  assert.equal(byKey(plan, 'walkaway').salaryPerMonth, 20000);
  assert.equal(byKey(plan, 'target').currency, 'EUR');
  assert.ok(plan.warnings.some((w) => /מטבעות שונים לא משווים ולא ממירים/.test(w)));
  assert.ok(!plan.warnings.some((w) => /נמוך מהשכר הנוכחי/.test(w)), '8,000 euros is not called lower than 20,000 shekels');
});

test('what to watch: a target under the current salary, a fee above the release clause, a deal that stands still', () => {
  const f = dealFacts(data({ deals: [deal({ salary: '4000', transferFee: '200000', enteredStageAt: '2026-11-01T10:00:00Z' })] }), 'd1');
  const w = buildScenarios(f).warnings.join('\n');
  assert.match(w, /היעד \(€4,000 לחודש\) נמוך מהשכר הנוכחי \(€5,000 לחודש\)/);
  assert.match(w, /גבוהים מסעיף השחרור \(€150,000\)/);
  assert.match(w, /24 ימים בשלב Negotiation/);
});

test('a player with no deal: his contract and red lines, and the scenarios say what is missing', () => {
  const f = playerFacts(data({ deals: [] }), 'p1');
  const plan = buildScenarios(f);
  assert.equal(byKey(plan, 'target').salaryPerMonth, null);
  assert.equal(byKey(plan, 'walkaway').salaryPerMonth, 5000);
  assert.equal(byKey(plan, 'anchor').salaryPerMonth, 10000);
  assert.match(scenariosText(f, plan), /אין עסקה פתוחה/);
});

test('the model\'s wording may carry no number at all: a sentence with one is dropped', () => {
  const ok = checkReasoning('{"anchor":"לפתוח גבוה כי שחקנית דומה שלנו מקבלת יותר.","target":"זה מה שרשום בעסקה.","advice":"להתחיל גבוה ולרדת לאט."}');
  assert.deepEqual(Object.keys(ok), ['anchor', 'target', 'advice']);
  // Numbers in any form: digits, digits of another script, number words, currencies and percents.
  for (const s of ['לפתוח ב-12k דולר.', 'שמונת אלפים יורו זה הוגן.', '٩٠٠٠ ₪ זה הרף.', 'לפתוח ב-8,000.', 'עשרה אחוז מעל הממוצע.', 'שווי השוק שלה חצי מיליון.', 'זה שלושה לחודש יותר.', 'רק כמה שקלים יותר.', 'טוב, ש"ח זה המטבע.']) {
    assert.equal(checkReasoning(JSON.stringify({ anchor: s })), null, s);
  }
  // Sentence by sentence: the clean one stays.
  assert.deepEqual(checkReasoning('{"anchor":"לפתוח גבוה. לפתוח ב-12k דולר.","advice":"טוב — מאוד"}'), { anchor: 'לפתוח גבוה.', advice: 'טוב, מאוד' }, 'an em-dash is taken out');
  assert.equal(checkReasoning('not json'), null);
});

const seed = (over = {}) => fakeDb({ players: { p1: dana(), p2: other, p3: dollars }, deals: { d1: deal() }, club_requirements: { r1: requirement() }, clubs: { c1: { name: 'FC Köln', country: 'Germany' } }, ...over });
const snapshot = (db) => JSON.stringify([...db.data].map(([k, v]) => [k, [...v]]));
const fakeClient = (text, calls = []) => ({ beta: { messages: { stream: (req) => ({ finalMessage: async () => { calls.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 } }; } }) } } });

test('deal_scenarios and finance_whatif are refused without the money permission', async () => {
  for (const role of ['manager', 'viewer', undefined]) {
    const tools = dealTools({ db: seed(), identity: { name: 'רון' }, role });
    await assert.rejects(() => tools.deal_scenarios({ dealId: 'd1' }), /money is for admins only/);
    await assert.rejects(() => tools.finance_whatif({ kind: 'commission', percent: 10, currency: 'EUR', fee: 1000 }), /money is for admins only/);
  }
});

test('deal_scenarios: the answer is built by code, saves nothing and sends nothing', async () => {
  const db = seed();
  const before = snapshot(db);
  const out = await dealTools({ db, identity: { name: 'לו' }, role: 'admin' }).deal_scenarios({ dealId: 'd1' });
  assert.equal(snapshot(db), before, 'no write of any kind without a question');
  assert.equal(out.saved, false);
  assert.match(out.text, /\*עוגן פתיחה:\* €10,000 לחודש/);
  assert.match(out.text, /\*יעד:\* €8,000 לחודש/);
  assert.match(out.text, /\*קו עצירה:\* €5,000 לחודש/);
  assert.match(out.text, /עמלה 10%: €9,600 לשנת חוזה/);
  assert.doesNotMatch(out.text, /—/);
  assert.equal(out.reasoning, undefined);
  assert.match(out.rule, /outreach_prepare/);
  // The German window comes with it, marked as not officially verified, with the closing line.
  assert.ok(out.regulation.flags.some((l) => /Bundesliga/.test(l) && /לא אומת מול מקור רשמי/.test(l) && /עורך דין/.test(l)));
});

test('deal_scenarios by player: one open deal is used, several are asked about, none still gives his contract', async () => {
  const tools = (db) => dealTools({ db, identity: {}, role: 'admin' });
  assert.equal((await tools(seed()).deal_scenarios({ playerId: 'p1' })).dealId, 'd1');
  const two = await tools(seed({ deals: { d1: deal(), d2: deal({ id: 'd2', clubName: 'Ajax' }) } })).deal_scenarios({ playerId: 'p1' });
  assert.equal(two.ambiguous, true);
  assert.equal(two.candidates.length, 2);
  const none = await tools(seed({ deals: {} })).deal_scenarios({ playerId: 'p1' });
  assert.equal(none.dealId, null);
  assert.ok(none.missing.some((m) => m.startsWith('אין עסקה פתוחה')));
  await assert.rejects(() => tools(seed()).deal_scenarios({}), /pass dealId or playerId/);
  await assert.rejects(() => tools(seed()).deal_scenarios({ dealId: 'x' }), /deal not found/);
});

test('with a question: one model call at the deal effort, counted in the ledger, and only clean wording comes back', async () => {
  const db = seed();
  const calls = [];
  const client = fakeClient('{"anchor":"לפתוח ב-10,000 כי זה מה שנועה מקבלת.","target":"8,000 הוא מה שרשום.","walkaway":"מתחת ל-5,000 אין טעם, שווי השוק 900,000.","advice":"להתחיל גבוה."}', calls);
  const out = await dealTools({ db, identity: {}, role: 'admin', client }).deal_scenarios({ dealId: 'd1', question: 'כדאי לפתוח גבוה?' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.deepEqual(calls[0].output_config, { effort: 'high' });
  assert.deepEqual(out.reasoning, { advice: 'להתחיל גבוה.' }, 'every sentence with a number is gone, the ones with our own numbers too');
  // The instruction says the same: no numbers at all, the system shows them.
  assert.match(calls[0].system, /Write NO numbers at all/);
  const day = db.all('golda_cost')[0];
  assert.equal(day.byKind.deal.calls, 1);
  // The numbers of the answer are still the code's.
  assert.match(out.text, /\*יעד:\* €8,000 לחודש/);
});

test('at the day\'s cost ceiling the wording is skipped and the scenarios still come', async () => {
  const db = seed({ app_meta: { goldaCost: { capUsd: 0 } } });
  const calls = [];
  const out = await dealTools({ db, identity: {}, role: 'admin', client: fakeClient('{}', calls) }).deal_scenarios({ dealId: 'd1', question: 'מה דעתך?' });
  assert.equal(calls.length, 0);
  assert.match(out.reasoningSkipped, /ceiling/);
  assert.match(out.text, /\*יעד:\*/);
});

test('finance_whatif commission: the arithmetic, in one currency, and nothing saved', async () => {
  const db = seed();
  const before = snapshot(db);
  const tools = dealTools({ db, identity: {}, role: 'admin' });
  const out = await tools.finance_whatif({ kind: 'commission', percent: 10, currency: 'EUR', salary: 8000, salaryPeriod: 'month', years: 2, fee: 200000 });
  assert.equal(out.saved, false);
  assert.equal(out.result.onSalary, 19200);
  assert.equal(out.result.onFee, 20000);
  assert.equal(out.result.total, 39200);
  assert.match(out.text, /עמלה על השכר: €19,200 \(€9,600 לשנה\)/);
  assert.match(out.text, /שום דבר לא נשמר/);
  assert.equal(snapshot(db), before);
});

test('finance_whatif: a number that was not given is asked for, never assumed', async () => {
  const tools = dealTools({ db: seed(), identity: {}, role: 'admin' });
  const out = await tools.finance_whatif({ kind: 'commission', percent: 10, salary: 8000 });
  assert.equal(out.saved, false);
  assert.equal(out.result, undefined);
  assert.deepEqual(out.missing, ['המטבע', 'האם השכר לחודש, לשנה או לעונה', 'אורך החוזה (בחודשים או בשנים)']);
  assert.match(out.instruction, /never assume/);
  const split = await tools.finance_whatif({ kind: 'schedule', total: 9000, currency: 'EUR', count: 3 });
  assert.deepEqual(split.missing, ['תאריך התשלום הראשון']);
});

test('finance_whatif schedule: laid over the cash flow on record, per currency, and the record is untouched', async () => {
  const paid = (id, amount, currency, dueDate) => ({ id, label: '', amount, currency, dueDate, payer: { kind: 'club', name: 'FC Köln' }, paidAt: null, paidAmount: null, note: '', createdBy: 'a@x.com', createdAt: '2026-11-01T00:00:00Z' });
  const db = seed({ deals: { d1: deal({ payments: [paid('a', 5000, 'EUR', '2026-12-10'), paid('b', 1200, 'USD', '2027-01-05')] }) } });
  const before = snapshot(db);
  const tools = dealTools({ db, identity: {}, role: 'admin' });
  const out = await tools.finance_whatif({ kind: 'schedule', total: 9000, currency: 'EUR', count: 3, firstDue: '2026-12-15' });
  assert.equal(out.saved, false);
  assert.deepEqual(out.payments.map((p) => [p.amount, p.dueDate]), [[3000, '2026-12-15'], [3000, '2027-01-15'], [3000, '2027-02-15']]);
  const dec = out.months.find((m) => m.month === '2026-12');
  assert.deepEqual(dec.byCurrency, { EUR: { expected: 5000, added: 3000, withWhatIf: 8000 } });
  const jan = out.months.find((m) => m.month === '2027-01');
  assert.deepEqual(jan.byCurrency.USD, { expected: 1200, added: 0, withWhatIf: 1200 }, 'the dollars on record are not touched by euros');
  assert.deepEqual(out.totals.EUR, { expected: 5000, added: 9000, withWhatIf: 14000 });
  assert.match(out.text, /12\/2026: €5,000 צפוי היום \+ €3,000 = €8,000/);
  assert.equal(snapshot(db), before, 'a what-if writes nothing: not the payments, not the deal, nothing');
  assert.equal(paymentsOnDeal(db), 2);
  const mixed = await tools.finance_whatif({ kind: 'schedule', payments: [{ amount: 1000, currency: 'EUR', dueDate: '2026-12-01' }, { amount: 500, currency: 'USD', dueDate: '2026-12-01' }] });
  assert.match(mixed.text, /לא מחברים מטבעות ולא ממירים/);
  const broken = await tools.finance_whatif({ kind: 'schedule', payments: [{ amount: 1000, currency: 'EUR', dueDate: 'soon' }] });
  assert.match(broken.errors[0], /dueDate must be YYYY-MM-DD/);
});
function paymentsOnDeal(db) { return db.read('deals', 'd1').payments.length; }

test('the tool list: both tools exist and neither has a way to send or to save', () => {
  assert.deepEqual(DEAL_TOOL_DEFS.map((t) => t.name), ['deal_scenarios', 'finance_whatif']);
  for (const t of DEAL_TOOL_DEFS) {
    const props = Object.keys(t.input_schema.properties);
    for (const banned of ['to', 'phone', 'send', 'email', 'save', 'confirmed']) assert.ok(!props.includes(banned), `${t.name}.${banned}`);
  }
});

test('the ledger is told the model that answered, by the name the price table knows', async () => {
  const cost = require('../golda-cost.js');
  const real = cost.record;
  const seen = [];
  cost.record = async (db, row) => { seen.push(row.model); return real(db, row); };
  try {
    const reported = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ model: 'claude-opus-5-20260801', content: [{ type: 'text', text: '{"advice":"להתחיל גבוה."}' }], usage: { input_tokens: 10, output_tokens: 5 } }) }) } } };
    await dealTools({ db: seed(), identity: {}, role: 'admin', client: reported }).deal_scenarios({ dealId: 'd1', question: 'מה דעתך?' });
    await dealTools({ db: seed(), identity: {}, role: 'admin', client: fakeClient('{"advice":"טוב."}') }).deal_scenarios({ dealId: 'd1', question: 'מה דעתך?' });
  } finally { cost.record = real; }
  assert.deepEqual(seen, ['claude-opus-5', 'claude-opus-5-5']);
});
