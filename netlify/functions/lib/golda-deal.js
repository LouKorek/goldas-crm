// The deal room: preparing a negotiation from the agency's own numbers, and
// money what-ifs. For admins only (can(role, 'money')).
//
// 1. dealFacts(data, dealId): pure. What the CRM holds about the deal: the
//    player, the stage, what the deal asks for, what the club wrote in its
//    requirement, the terms of the player's current contract, the payments on
//    the deal, and what similar players of ours earn.
// 2. buildScenarios(facts): pure. Three scenarios (opening anchor, target,
//    walk-away), each resting on one named fact; the red lines from the
//    contract on record; what to watch. Nothing is estimated: when the CRM has
//    no number for a scenario, the scenario says which number is missing.
// 3. deal_scenarios: the tool. With a question it may make ONE model call to
//    word the reasoning; a sentence of the model that carries a number the
//    facts do not have is dropped, so the numbers always come from code.
// 4. finance_whatif: commission and payment-schedule what-ifs
//    (packages/domain/src/engines/finance.ts). Nothing is saved, ever.
//
// A counter-offer goes out the way every message to a club does: a draft
// through outreach_prepare / outreach_link that the owner sends himself
// (lib/golda-outreach.js). There is no sending here.
const { can, israelDate, daysBetween, ageOn, daysInStage, isClosedStage, playerName, toCurrency, formatMoney, perMonth, isSalaryPeriod,
  paymentRows, commissionWhatIf, installments, scheduleWhatIf, CURRENCIES, SALARY_PERIODS, DEAL_STALE_DAYS } = require('@goldas/domain');
const { effortForTask } = require('./golda-effort.js');
const cost = require('./golda-cost.js');
const { regulationFlags } = require('./regulations.js');

const { model: MODEL, effort: EFFORT } = effortForTask('deal');
const MAX_TOKENS = 4000;
const APP = 'https://goldas-crm.netlify.app';
const dealLink = (id) => `${APP}/market/deals?deal=${id}`;
// The app shows a deal's, a prospect's and a requirement's salary and fee as
// "€…" and "€…/mo" (Requirements.jsx, Pipeline.jsx): a bare number there is euros, per month.
const APP_CURRENCY = 'EUR';
const APP_PERIOD = 'month';
const MONTHS_PER_YEAR = 12;
const MAX_COMPARABLES = 5;
const SOON_DAYS = 180;
const TEXT_MAX = 200;
const REASON_MAX = 400;

const dmy = (d) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;
const money = (amount, currency) => formatMoney(amount, currency);
const perMo = (f) => `${money(f.perMonth, f.currency)} לחודש`;
const inDays = (n) => (n < 0 ? `לפני ${-n} ימים` : n === 0 ? 'היום' : `בעוד ${n} ימים`);

const MULTIPLIER = { k: 1e3, m: 1e6, אלף: 1e3, מיליון: 1e6 };
const PERIOD_WORDS = [['month', /month|\/\s*mo|חודש/i], ['year', /year|annual|שנה|שנתי/i], ['season', /season|עונה/i]];

/**
 * A figure typed as free text ("8000", "€8,000 לחודש", "120k לשנה").
 * → { amount, currency, period?, perMonth?, assumed: [..] } or null when there is no number.
 * A currency or a period that is not written is the app's own (euros, per
 * month), and `assumed` says so: it is shown to the owner, never hidden.
 */
function readFigure(text, { salary = false } = {}) {
  const s = String(text ?? '').trim();
  // The number, and "k" / "m" / "אלף" / "מיליון" only as a word of its own ("120k", not the m of "month").
  const m = /(\d[\d,]*(?:\.\d+)?)(?:\s*(k|m|אלף|מיליון)(?![a-z֐-׿]))?/i.exec(s);
  if (!m) return null;
  const amount = Number(m[1].replace(/,/g, '')) * (MULTIPLIER[(m[2] || '').toLowerCase()] || 1);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const sym = s.match(/[€$₪£]/);
  const word = s.split(/[\s\d.,/()%+-]+/).filter(Boolean).map(toCurrency).find(Boolean);
  const currency = (sym && toCurrency(sym[0])) || word || null;
  const assumed = currency ? [] : ['currency'];
  const out = { amount, currency: currency || APP_CURRENCY, assumed, text: s.slice(0, TEXT_MAX) };
  if (!salary) return out;
  const hit = PERIOD_WORDS.find(([, re]) => re.test(s));
  if (!hit) assumed.push('period');
  out.period = hit ? hit[0] : APP_PERIOD;
  out.perMonth = perMonth(amount, out.period);
  return out;
}

/** The commission written on a deal: a percent ("10%") or a fixed sum. */
function readCommission(text) {
  const s = String(text ?? '').trim();
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(s);
  if (pct) return { percent: Number(pct[1]), text: s.slice(0, TEXT_MAX) };
  const f = readFigure(s);
  return f ? { amount: f.amount, currency: f.currency, assumed: f.assumed, text: f.text } : null;
}

/** The salary of a contract on record, per month, when its currency and its period are written. */
function termsSalary(terms) {
  const t = terms || {};
  const amount = Number(t.salary);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = toCurrency(t.currency);
  const period = isSalaryPeriod(t.salaryPeriod) ? t.salaryPeriod : null;
  return { amount, currency, period, perMonth: period ? perMonth(amount, period) : null, assumed: [] };
}

const termsMoney = (terms, key) => {
  const n = Number((terms || {})[key]);
  const currency = toCurrency((terms || {}).currency);
  return Number.isFinite(n) && n > 0 ? { amount: n, currency } : null;
};

/** What similar players of ours earn: the same position, from a contract on record or a signed deal. */
function comparablesOf({ players, deals }, player) {
  if (!player || !player.primaryPosition) return [];
  const alike = (p) => p && p.id !== player.id && !p.deletedAt && p.primaryPosition === player.primaryPosition && (!player.gender || !p.gender || p.gender === player.gender);
  const byId = new Map(players.map((p) => [p.id, p]));
  const fromContracts = players.filter(alike).map((p) => ({ p, f: termsSalary(p.contractTerms), from: 'contract' }));
  const fromDeals = deals.filter((d) => d.stage === 'Contract Signed' && !d.deletedAt && alike(byId.get(d.playerId)))
    .map((d) => ({ p: byId.get(d.playerId), f: readFigure(d.salary, { salary: true }), from: 'signed_deal' }));
  const seen = new Set();
  return [...fromContracts, ...fromDeals]
    .filter((x) => x.f && x.f.currency && x.f.perMonth && !seen.has(x.p.id) && seen.add(x.p.id))
    .map((x) => ({ player: playerName(x.p), position: x.p.primaryPosition, perMonth: x.f.perMonth, currency: x.f.currency, from: x.from, assumed: x.f.assumed }))
    .sort((a, b) => b.perMonth - a.perMonth)
    .slice(0, MAX_COMPARABLES);
}

/** One line for the figures that were read the app's way (a bare number = euros, a salary = per month). */
function assumptionsOf(pairs) {
  const bare = pairs.filter(([, f]) => f && f.assumed && f.assumed.length).map(([what, f]) => `${what} ("${f.text}")`);
  return bare.length ? [`${bare.join(', ')}: רשום כמספר בלי מטבע, אז קראתי אותו כאירו, ושכר כסכום לחודש, כמו שהמערכת מציגה.`] : [];
}

function factsFor({ deals = [], players = [], requirements = [], now = new Date() }, deal, player) {
  const today = israelDate(now);
  const p = player || {};
  const terms = p.contractTerms || null;
  const requirement = deal && deal.requirementId ? requirements.find((r) => r.id === deal.requirementId && !r.deletedAt) || null : null;
  const ask = deal ? { salary: readFigure(deal.salary, { salary: true }), transferFee: readFigure(deal.transferFee), commission: readCommission(deal.commission) } : { salary: null, transferFee: null, commission: null };
  const budget = requirement ? { salary: readFigure(requirement.salary, { salary: true }), transferFee: readFigure(requirement.transferFee) } : null;
  const currentSalary = termsSalary(terms);
  const rows = deal ? paymentRows([deal], now) : [];
  const payments = Object.fromEntries(CURRENCIES.filter((c) => rows.some((r) => r.payment.currency === c)).map((c) => {
    const mine = rows.filter((r) => r.payment.currency === c);
    return [c, { scheduled: mine.reduce((n, r) => n + r.payment.amount, 0), paid: mine.reduce((n, r) => n + r.paid, 0), outstanding: mine.reduce((n, r) => n + r.outstanding, 0), count: mine.length }];
  }));
  const missing = [
    !deal && 'אין עסקה פתוחה על השחקן, אז אין שכר מבוקש ואין מועדון',
    deal && !ask.salary && 'השכר המבוקש לא רשום בעסקה',
    deal && !ask.commission && 'העמלה לא רשומה בעסקה',
    deal && !requirement && 'העסקה לא מקושרת לדרישה של המועדון, אז אין תקציב של המועדון',
    requirement && !budget.salary && 'בדרישה של המועדון לא רשום שכר',
    !terms && 'תנאי החוזה הנוכחי של השחקן לא שמורים בתיק',
    terms && !currentSalary && 'בתנאי החוזה שבתיק לא רשום שכר',
    currentSalary && !currentSalary.currency && 'המטבע של השכר בחוזה שבתיק לא רשום',
    currentSalary && !currentSalary.period && 'לא רשום אם השכר בחוזה שבתיק הוא לחודש או לשנה',
    ask.commission && ask.commission.percent && 'אורך החוזה המוצע לא רשום בעסקה, אז העמלה באחוזים מחושבת לשנת חוזה אחת',
  ].filter(Boolean);
  const contractEnd = p.contractEnd || '';
  return {
    today, dealId: deal ? deal.id : null, link: deal ? dealLink(deal.id) : null,
    club: deal ? deal.clubName || '' : '', stage: deal ? deal.stage || '' : '', closed: deal ? isClosedStage(deal.stage) : false,
    daysInStage: deal ? daysInStage(deal, now) : null,
    player: {
      id: p.id || (deal && deal.playerId) || '', name: playerName(p) || (deal && deal.playerName) || '', age: p.dob ? ageOn(p.dob, today) : null,
      position: p.primaryPosition || '', contractStatus: p.contractStatus || '', currentClub: p.currentClub || '', loanFrom: p.loanFrom || '',
      contractEnd, daysToContractEnd: contractEnd ? daysBetween(today, contractEnd) : null, reprEnd: p.reprEnd || '',
    },
    ask, budget,
    current: terms ? {
      salary: currentSalary, signingFee: termsMoney(terms, 'signingFee'), releaseClause: termsMoney(terms, 'releaseClause'),
      optionDeadline: terms.optionDeadline || '', optionYears: Number(terms.optionYears) || 0, optionHolder: terms.optionHolder || '',
      bonuses: String(terms.bonuses || '').slice(0, TEXT_MAX), keyDates: Array.isArray(terms.keyDates) ? terms.keyDates.filter((k) => k && k.date) : [], source: terms.source || '',
    } : null,
    payments,
    comparables: comparablesOf({ players, deals }, p),
    assumptions: assumptionsOf([['השכר בעסקה', ask.salary], ['דמי ההעברה בעסקה', ask.transferFee], ['העמלה בעסקה', ask.commission], ['השכר בדרישה של המועדון', budget && budget.salary]]),
    missing,
  };
}

/** dealFacts(data, dealId): data = { deals, players, requirements, now }. null when the deal is not there. */
function dealFacts(data = {}, dealId) {
  const deal = (data.deals || []).find((d) => d.id === dealId && !d.deletedAt);
  if (!deal) return null;
  return factsFor(data, deal, (data.players || []).find((p) => p.id === deal.playerId) || null);
}

/** The same facts for a player with no deal on record: his contract and the players like him. */
function playerFacts(data = {}, playerId) {
  const player = (data.players || []).find((p) => p.id === playerId && !p.deletedAt);
  return player ? factsFor(data, null, player) : null;
}

const HOLDER_HE = { club: 'בידי המועדון', player: 'בידי השחקן', both: 'בידי שני הצדדים' };

/** The red lines the contract on record draws, each with the fact it rests on. */
function redLinesOf(facts) {
  const c = facts.current;
  const p = facts.player;
  const fromContract = `החוזה שבתיק${c && c.source ? ` (${c.source})` : ''}`;
  const lines = [];
  const add = (he, restsOn) => lines.push({ he, restsOn });
  if (c && c.releaseClause) add(`סעיף שחרור: ${c.releaseClause.currency ? money(c.releaseClause.amount, c.releaseClause.currency) : `${c.releaseClause.amount} (המטבע לא רשום)`}.`, fromContract);
  if (c && (c.optionYears || c.optionDeadline)) {
    add(`אופציה${c.optionYears ? ` ל-${c.optionYears} ${c.optionYears === 1 ? 'שנה' : 'שנים'}` : ''}${HOLDER_HE[c.optionHolder] ? ` ${HOLDER_HE[c.optionHolder]}` : ''}${c.optionDeadline ? `, עד ${dmy(c.optionDeadline)} (${inDays(daysBetween(facts.today, c.optionDeadline))})` : ''}.`, fromContract);
  }
  if (c && c.salary && c.salary.currency && c.salary.perMonth) add(`השכר היום: ${perMo(c.salary)}. הצעה מתחת לזה היא ירידה בשכר.`, fromContract);
  if (c && c.signingFee && c.signingFee.currency) add(`מענק חתימה בחוזה היום: ${money(c.signingFee.amount, c.signingFee.currency)}.`, fromContract);
  if (c && c.bonuses) add(`בונוסים בחוזה היום: ${c.bonuses}`, fromContract);
  for (const k of (c ? c.keyDates : [])) {
    const days = daysBetween(facts.today, k.date);
    if (days >= 0 && days <= SOON_DAYS) add(`${dmy(k.date)} (${inDays(days)}): ${k.label || 'תאריך מהחוזה'}.`, fromContract);
  }
  if (p.contractStatus === 'Free') add('שחקן חופשי: אין מועדון שמגיעים לו דמי העברה.', 'מצב החוזה בכרטיס השחקן');
  else if (p.contractEnd) add(`החוזה במועדון הנוכחי${p.currentClub ? ` (${p.currentClub})` : ''} מסתיים ב-${dmy(p.contractEnd)} (${inDays(p.daysToContractEnd)}).`, 'תאריך סיום החוזה בכרטיס השחקן');
  if (p.contractStatus === 'Loan' && p.loanFrom) add(`השחקן מושאל מ-${p.loanFrom}: כל מעבר צריך גם את המועדון הזה.`, 'כרטיס השחקן');
  if (p.reprEnd && daysBetween(facts.today, p.reprEnd) <= SOON_DAYS) add(`הסכם הייצוג שלנו עם השחקן מסתיים ב-${dmy(p.reprEnd)} (${inDays(daysBetween(facts.today, p.reprEnd))}).`, 'תאריך סיום הייצוג בכרטיס השחקן');
  return lines;
}

/** The agency's commission for one scenario: a percent on a year of the salary, or the fixed sum on the deal. */
function commissionFor(commission, salaryPerMonth, currency) {
  if (!commission) return null;
  if (commission.percent) {
    if (!salaryPerMonth) return null;
    const r = commissionWhatIf({ percent: commission.percent, currency, salary: salaryPerMonth, salaryPeriod: 'month', months: MONTHS_PER_YEAR });
    return r.ok ? { percent: commission.percent, perYear: r.perYear, currency, display: `עמלה ${commission.percent}%: ${money(r.perYear, currency)} לשנת חוזה` } : null;
  }
  return { amount: commission.amount, currency: commission.currency, display: `עמלה קבועה שרשומה בעסקה: ${money(commission.amount, commission.currency)}` };
}

/**
 * buildScenarios(facts) → { scenarios: [anchor, target, walkaway], redLines, warnings, missing, assumptions }
 * A scenario with a number: { key, label, salaryPerMonth, currency, display, restsOn, commission }.
 * A scenario without one: { key, label, salaryPerMonth: null, missing } (which number is not in the CRM).
 */
function buildScenarios(facts) {
  const { ask, budget, current } = facts;
  const target = ask.salary;
  const floor = current && current.salary && current.salary.currency && current.salary.perMonth ? current.salary : null;
  const base = target || floor;   // the currency the scenarios are in
  const make = (key, label, f, restsOn, missing) => (f
    ? { key, label, salaryPerMonth: f.perMonth, currency: f.currency, display: perMo(f), restsOn, commission: commissionFor(ask.commission, f.perMonth, f.currency) }
    : { key, label, salaryPerMonth: null, currency: null, display: null, restsOn: null, commission: null, missing });

  // The opening anchor: the highest number of OURS above the target, in the same currency.
  const candidates = [
    budget && budget.salary && { f: budget.salary, restsOn: `השכר שהמועדון רשם בדרישה שלו: ${perMo(budget.salary)}` },
    ...facts.comparables.map((c) => ({ f: { perMonth: c.perMonth, currency: c.currency }, restsOn: `השכר של ${c.player} (${c.position}) ${c.from === 'contract' ? 'בחוזה שבתיק' : 'בעסקה שנחתמה'}: ${money(c.perMonth, c.currency)} לחודש` })),
  ].filter((x) => x && base && x.f.currency === base.currency && (!target || x.f.perMonth > target.perMonth)).sort((a, b) => b.f.perMonth - a.f.perMonth);
  const top = candidates[0] || null;
  const anchor = make('anchor', 'עוגן פתיחה', top && top.f, top && top.restsOn,
    'אין אצלנו מספר שגבוה מהיעד (שכר שהמועדון רשם בדרישה, או שכר של שחקן דומה שלנו באותו מטבע), אז אין עוגן מהנתונים');
  const targetScenario = make('target', 'יעד', target, target && `השכר שרשום בעסקה: ${perMo(target)}`, 'השכר המבוקש לא רשום בעסקה');
  const walkaway = make('walkaway', 'קו עצירה', floor, floor && `השכר של השחקן בחוזה הנוכחי שבתיק: ${perMo(floor)}`,
    facts.player.contractStatus === 'Free' ? 'השחקן חופשי ואין חוזה נוכחי בתיק, אז אין רצפה מהנתונים' : 'השכר בחוזה הנוכחי לא רשום בתיק (עם מטבע ותקופה), אז אין רצפה מהנתונים');

  const same = (a, b) => a && b && a.currency === b.currency;
  const warnings = [
    target && floor && !same(target, floor) && `היעד ב-${target.currency} והשכר הנוכחי ב-${floor.currency}: מטבעות שונים לא משווים ולא ממירים.`,
    same(target, floor) && target.perMonth < floor.perMonth && `היעד (${perMo(target)}) נמוך מהשכר הנוכחי (${perMo(floor)}).`,
    budget && same(budget.salary, target) && budget.salary.perMonth < target.perMonth && `השכר שהמועדון רשם בדרישה (${perMo(budget.salary)}) נמוך מהיעד (${perMo(target)}).`,
    current && same(current.releaseClause, ask.transferFee) && ask.transferFee.amount > current.releaseClause.amount && `דמי ההעברה שבעסקה (${money(ask.transferFee.amount, ask.transferFee.currency)}) גבוהים מסעיף השחרור (${money(current.releaseClause.amount, current.releaseClause.currency)}).`,
    facts.daysInStage !== null && facts.daysInStage >= DEAL_STALE_DAYS && !facts.closed && `העסקה כבר ${facts.daysInStage} ימים בשלב ${facts.stage}.`,
    facts.closed && `העסקה סגורה (${facts.stage}).`,
  ].filter(Boolean);
  return { scenarios: [anchor, targetScenario, walkaway], redLines: redLinesOf(facts), warnings, missing: facts.missing, assumptions: facts.assumptions };
}

/** The answer as Golda sends it, built by code: every number in it is in the facts. */
function scenariosText(facts, plan) {
  const head = facts.dealId
    ? `*הכנה למשא ומתן: ${facts.player.name} ↔ ${facts.club}*${facts.stage ? ` (${facts.stage}${facts.daysInStage !== null ? `, ${facts.daysInStage} ימים בשלב` : ''})` : ''}`
    : `*הכנה למשא ומתן: ${facts.player.name}* (אין עסקה פתוחה)`;
  const lines = [head, ''];
  for (const s of plan.scenarios) {
    if (s.salaryPerMonth === null) { lines.push(`*${s.label}:* אין מספר. ${s.missing}.`, ''); continue; }
    lines.push(`*${s.label}:* ${s.display}`, `נשען על: ${s.restsOn}.`, ...(s.commission ? [`${s.commission.display}.`] : []), '');
  }
  if (facts.ask.transferFee) lines.push(`דמי העברה שרשומים בעסקה: ${money(facts.ask.transferFee.amount, facts.ask.transferFee.currency)}.`, '');
  if (plan.redLines.length) lines.push('*קווים אדומים מהנתונים שלנו:*', ...plan.redLines.map((r) => `• ${r.he} (${r.restsOn})`), '');
  if (plan.warnings.length) lines.push('*לשים לב:*', ...plan.warnings.map((w) => `• ${w}`), '');
  if (plan.assumptions.length) lines.push('*איך קראתי את המספרים:*', ...plan.assumptions.map((a) => `• ${a}`), '');
  if (plan.missing.length) lines.push('*חסר, ולא השלמתי מעצמי:*', ...plan.missing.map((m) => `• ${m}.`), '');
  if (facts.link) lines.push(facts.link);
  return lines.join('\n').trim();
}

// ── The one model call: wording, never numbers ────────────────────────────────
const REASON_SYSTEM = [
  "You are Golda (גולדה), the assistant of Gold A&S, a football players' agency in Israel. The owner is preparing a negotiation.",
  'You get JSON: his question, the facts the CRM holds, three scenarios and the red lines. All of it was computed by code from the CRM.',
  'Write in Hebrew, short and plain, for the owner: one sentence of reasoning for each scenario that has a number (why open there, why aim there, why stop there), and one or two sentences that answer his question.',
  'Use only numbers that appear in the JSON, written exactly as they are there. Never add a number, a percentage, a date, an estimate, a market value or a name that is not in the JSON. When a scenario has no number, do not give one: its value is null. Never convert a currency. No legal conclusions. No em-dashes.',
  'Answer with JSON only: {"anchor": "" | null, "target": "" | null, "walkaway": "" | null, "advice": ""}.',
].join('\n');

/** Every number in a text, as plain digits: "€8,000" → "8000", "06" → "6". */
const numbersIn = (s) => (String(s ?? '').replace(/(\d),(?=\d{3})/g, '$1').match(/\d+/g) || []).map((x) => String(Number(x)));

/** The model's sentences, kept only when every number in them is a number of the facts. */
function checkReasoning(text, payload) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const allowed = new Set(numbersIn(JSON.stringify(payload)));
  const out = {};
  for (const k of ['anchor', 'target', 'walkaway', 'advice']) {
    const s = typeof j[k] === 'string' ? j[k].replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
    if (s && numbersIn(s).every((n) => allowed.has(n))) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

/** One call, counted in the day's ledger; skipped at the day's ceiling. Never throws. */
async function wordReasoning(db, { facts, plan, question, client = null, now = new Date() }) {
  if (!client && !process.env.ANTHROPIC_API_KEY) return { skipped: 'no model here' };
  const allowed = await cost.gate(db, 'deal', { now });
  if (!allowed.ok) return { skipped: "the day's background cost ceiling is reached" };
  const payload = { question: String(question || '').slice(0, REASON_MAX), facts, scenarios: plan.scenarios, redLines: plan.redLines, warnings: plan.warnings, missing: plan.missing };
  let spent = null;
  try {
    const anthropic = client || new (require('@anthropic-ai/sdk'))();
    const res = await anthropic.beta.messages.stream({
      model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
      system: REASON_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }).finalMessage();
    spent = cost.addUsage(spent, res.usage);
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return checkReasoning(text, payload) || { skipped: 'the wording carried a number that is not in the CRM, so it was dropped' };
  } catch {
    return { skipped: 'the wording could not be written' };
  } finally {
    if (spent) await cost.record(db, { kind: 'deal', model: MODEL, usage: spent, now });
  }
}

// ── What-ifs ────────────────────────────────────────────────────────────────
const MISSING_HE = {
  percent: 'אחוז העמלה (בין 0 ל-100)', currency: 'המטבע', 'salary or fee': 'שכר או סכום חד-פעמי', salary: 'השכר', salaryPeriod: 'האם השכר לחודש, לשנה או לעונה',
  months: 'אורך החוזה (בחודשים או בשנים)', fee: 'הסכום החד-פעמי', total: 'הסכום הכולל', count: 'מספר התשלומים', firstDue: 'תאריך התשלום הראשון', everyMonths: 'כל כמה חודשים',
};
const NOT_SAVED = 'זה חישוב בלבד: שום דבר לא נשמר.';
const monthHe = (m) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

function commissionText(r) {
  const lines = [`*מה אם: עמלה של ${r.percent}%*`];
  if (r.onSalary !== null) lines.push(`שכר לאורך ${r.months} חודשים: ${money(r.salaryTotal, r.currency)}`, `עמלה על השכר: ${money(r.onSalary, r.currency)} (${money(r.perYear, r.currency)} לשנה)`);
  if (r.onFee !== null) lines.push(`עמלה על ${money(r.fee, r.currency)}: ${money(r.onFee, r.currency)}`);
  if (r.onSalary !== null && r.onFee !== null) lines.push(`ביחד: ${money(r.total, r.currency)}`);
  return [...lines, NOT_SAVED].join('\n');
}

function scheduleText(r) {
  const lines = ['*מה אם: לוח תשלומים*'];
  for (const m of r.months) {
    for (const [c, cell] of Object.entries(m.byCurrency)) {
      if (cell.added) lines.push(`• ${monthHe(m.month)}: ${money(cell.expected, c)} צפוי היום + ${money(cell.added, c)} = ${money(cell.withWhatIf, c)}`);
    }
  }
  for (const [c, t] of Object.entries(r.totals)) if (t.added) lines.push(`סך הכל בתקופה (${c}): ${money(t.expected, c)} צפוי היום + ${money(t.added, c)} = ${money(t.withWhatIf, c)}`);
  if (Object.values(r.totals).filter((t) => t.added).length > 1) lines.push('כל מטבע בשורה משלו: לא מחברים מטבעות ולא ממירים.');
  if (r.outside.length) lines.push(`${r.outside.length} תשלומים נופלים אחרי התקופה שמוצגת.`);
  return [...lines, NOT_SAVED].join('\n');
}

const DEAL_TOOL_DEFS = [
  {
    name: 'deal_scenarios',
    description: 'Prepare a negotiation from the agency\'s own numbers (admins only): three scenarios (opening anchor, target, walk-away), each with the CRM fact it rests on; the red lines from the player\'s contract on record; what to watch; what is missing. Every number comes from the CRM (the deal, the club\'s requirement, the contract terms, similar players of ours). A number the CRM does not have is listed as missing and never estimated. Pass dealId, or playerId when the deal is not known. question: the writer\'s own question in his words, when he asked one ("כדאי לפתוח גבוה?"); it adds a short reasoning. Nothing is saved and nothing is sent.',
    input_schema: { type: 'object', properties: { dealId: { type: 'string' }, playerId: { type: 'string' }, question: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'finance_whatif',
    description: 'A money what-if (admins only). NOTHING is saved, ever. kind=commission: what a percent earns on a salary over a contract (percent, currency, salary, salaryPeriod, and months or years) and/or on a one-off sum (fee). kind=schedule: what a payment schedule would add to the cash flow already expected, month by month and per currency: payments [{amount, currency, dueDate}], or total + count + firstDue (+ everyMonths) for equal installments. Every number comes from the writer or from a record you read; a missing one comes back as missing and is asked for, never assumed. Different currencies are never added and never converted.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['commission', 'schedule'] },
        percent: { type: 'number', description: 'commission: 10 = 10%' },
        currency: { type: 'string', enum: [...CURRENCIES] },
        salary: { type: 'number' }, salaryPeriod: { type: 'string', enum: [...SALARY_PERIODS] },
        months: { type: 'number', description: 'commission: the contract length in months' }, years: { type: 'number' },
        fee: { type: 'number', description: 'commission: a one-off sum the percent is taken on (a transfer fee, a signing fee)' },
        payments: { type: 'array', items: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string', enum: [...CURRENCIES] }, dueDate: { type: 'string', description: 'YYYY-MM-DD' }, label: { type: 'string' } }, required: ['amount', 'currency', 'dueDate'], additionalProperties: false } },
        total: { type: 'number' }, count: { type: 'integer' }, firstDue: { type: 'string', description: 'YYYY-MM-DD' }, everyMonths: { type: 'integer' },
        from: { type: 'string', description: 'schedule: the first month shown, YYYY-MM (default: this month)' },
        monthsShown: { type: 'integer', description: 'schedule: how many months to show (default: to the last payment)' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
];

/** dealTools({ db, identity, role, client }): `client` is the model client of a test. */
function dealTools({ db, identity = {}, role, client = null }) {
  const need = () => { if (!can(role, 'money')) throw new Error(`${identity.name || 'the writer'} is a ${role || 'viewer'}; money is for admins only`); };
  const all = async (col) => (await db.collection(col).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.deletedAt);
  const missingOut = (missing) => ({
    saved: false, missing: missing.map((k) => MISSING_HE[k] || k),
    instruction: 'Nothing was calculated. Ask the writer for what is missing in one short question; never assume a number, a currency or a date.',
  });

  return {
    deal_scenarios: async (input = {}) => {
      need();
      const now = new Date();
      const [deals, players, requirements, clubs] = await Promise.all(['deals', 'players', 'club_requirements', 'clubs'].map(all));
      const data = { deals, players, requirements, now };
      let deal = null;
      if (input.dealId) {
        deal = deals.find((d) => d.id === input.dealId);
        if (!deal) throw new Error('deal not found');
      } else if (input.playerId) {
        if (!players.some((p) => p.id === input.playerId)) throw new Error('player not found');
        const open = deals.filter((d) => d.playerId === input.playerId && !isClosedStage(d.stage));
        if (open.length > 1) return { ambiguous: true, candidates: open.map((d) => ({ dealId: d.id, club: d.clubName || '', stage: d.stage || '', link: dealLink(d.id) })), instruction: 'Several open deals for this player. Ask which club, then call again with its dealId.' };
        [deal] = open;
      } else throw new Error('pass dealId or playerId');
      const facts = deal ? dealFacts(data, deal.id) : playerFacts(data, input.playerId);
      const plan = buildScenarios(facts);
      const player = players.find((p) => p.id === facts.player.id) || null;
      const regs = regulationFlags({ player, deal, club: deal ? clubs.find((c) => c.id === deal.clubId) || null : null, requirement: deal ? requirements.find((r) => r.id === deal.requirementId) || null : null, today: facts.today });
      const reasoning = input.question ? await wordReasoning(db, { facts, plan, question: input.question, client, now }) : null;
      return {
        saved: false, dealId: facts.dealId, link: facts.link, player: facts.player.name, club: facts.club, stage: facts.stage,
        text: scenariosText(facts, plan),
        scenarios: plan.scenarios, redLines: plan.redLines, warnings: plan.warnings, missing: plan.missing, assumptions: plan.assumptions,
        comparables: facts.comparables, paymentsOnDeal: facts.payments,
        ...(reasoning && !reasoning.skipped ? { reasoning } : {}),
        ...(reasoning && reasoning.skipped ? { reasoningSkipped: reasoning.skipped } : {}),
        regulation: { flags: regs.flags.filter((f) => f.area !== 'agents').map((f) => f.line), notVerified: regs.notVerified.map((n) => n.topic), more: 'regulation_check with this dealId has the agent rules too.' },
        rule: 'Answer with `text` as it is (you may shorten, never change a number). Every number comes from the CRM: never add, round, convert or estimate one, and never fill what `missing` lists: say it is missing and ask; once the writer gives it, save it on the deal or in the contract terms and call again. `reasoning`, when present, is wording only. A scenario with salaryPerMonth null has no number: say which fact is missing. A counter-offer to the club is a draft the writer sends himself: outreach_prepare, then outreach_link. You never send it.',
      };
    },

    finance_whatif: async (input = {}) => {
      need();
      if (input.kind === 'commission') {
        const r = commissionWhatIf(input);
        return r.ok ? { saved: false, kind: 'commission', result: r, text: commissionText(r), rule: 'A calculation only: say that nothing was saved. Never add a number that is not in the result.' } : missingOut(r.missing);
      }
      if (input.kind !== 'schedule') throw new Error('kind is commission or schedule');
      let schedule = Array.isArray(input.payments) ? input.payments : null;
      if (!schedule || !schedule.length) {
        const split = installments(input);
        if (!split.ok) return missingOut(split.missing);
        schedule = split.payments;
      }
      const now = new Date();
      const r = scheduleWhatIf(paymentRows(await all('deals'), now), schedule, { from: input.from || undefined, months: input.monthsShown || undefined, now });
      if (!r.ok) return { saved: false, errors: r.errors, instruction: 'Nothing was calculated. Ask the writer for what is wrong or missing; never assume it.' };
      return {
        saved: false, kind: 'schedule', from: r.from, months: r.months.filter((m) => Object.keys(m.byCurrency).length), totals: r.totals, payments: r.payments, outside: r.outside, text: scheduleText(r),
        rule: 'A calculation only: say that nothing was saved (to make it real the writer asks for the payments to be added: payment_set). Totals are per currency: never add currencies together and never convert.',
      };
    },
  };
}

/** Her lines about negotiations and what-ifs in the system prompt. */
function dealSection(role) {
  if (!can(role, 'money')) return '- Negotiation scenarios and money what-ifs (deal_scenarios, finance_whatif) are for admins only: you do not have them for this writer; if asked, say only Lou can see them.';
  return `- Preparing a negotiation (admins only): "תכיני אותי למו"מ על…" / "מה לבקש ל…" / "מה הקו האדום ב…" / "תרחישים לעסקה של…" → find the deal (or the player), then deal_scenarios with the dealId (playerId when the deal is not known), and question with the writer's own question when he asked one. Answer with its text: three scenarios (עוגן פתיחה, יעד, קו עצירה), each with the fact it rests on, the red lines from the contract on record, what to watch and what is missing. Every number there comes from the CRM: never add, round, convert or estimate a number yourself, not a market value either, and never fill a missing one: say it is missing and ask; when he gives it, save it (the deal's salary / transferFee / commission, or the player's contractTerms) and call again. A counter-offer or an answer to the club is a draft he sends himself: outreach_prepare (contact, player, deal), write it in his style with the numbers he approved, then outreach_link. You never send it and never offer to.
- Money what-ifs (admins only): "כמה נרוויח אם…" / "מה אם העמלה 8%…" / "מה יקרה לתזרים אם ישלמו ב-3 תשלומים…" → finance_whatif (kind commission or schedule) with the numbers exactly as he said them, or as a record you read has them. A number he did not give is asked for in one short question, never assumed. Nothing is saved by a what-if: say so in one line. Amounts in different currencies are separate lines, never added and never converted. To make it real he asks for it (payment_set add).`;
}

module.exports = { dealFacts, playerFacts, buildScenarios, scenariosText, readFigure, readCommission, checkReasoning, wordReasoning, dealTools, dealSection, DEAL_TOOL_DEFS };
