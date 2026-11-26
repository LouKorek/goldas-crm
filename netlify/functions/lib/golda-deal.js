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
//    word the reasoning; a sentence of the model that carries any number at
//    all (a digit of any script, a number word, a currency, a percent) is
//    dropped, so every number the owner sees comes from code.
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

const MULTIPLIER = { k: 1e3, m: 1e6, אלף: 1e3, אלפים: 1e3, מיליון: 1e6 };
// A period is read only from an explicit phrase. "בשנה הראשונה" is an ordinal, not a period: it is left over, so the figure is unclear.
const notLetter = '(?![\\p{L}])';
const PERIODS = [
  ['month', new RegExp(`(?<![\\p{L}])(?:לחודש|חודשית|חודשי|per\\s+month|monthly)${notLetter}|\\/\\s*(?:month|mo)${notLetter}`, 'iu')],
  ['year', new RegExp(`(?<![\\p{L}])(?:לשנה|שנתית|שנתי|per\\s+(?:year|annum)|yearly|annual(?:ly)?)${notLetter}|\\/\\s*(?:year|yr)${notLetter}`, 'iu')],
  ['season', new RegExp(`(?<![\\p{L}])(?:לעונה|per\\s+season)${notLetter}|\\/\\s*season${notLetter}`, 'iu')],
];
// What the app itself writes when there is no number: missing, not unclear.
const NO_NUMBER = /^(?:not specified|לא צוין|לא ידוע|n\/?a|tbd|[-–—?]+)$/i;
// Two numbers joined by a dash, "עד" or "to": a range, not a number.
const RANGE = /\d\s*(?:[-–—]|עד|to)\s*[€$₪£]?\s*\d/i;
// The number itself. "." or "," followed by exactly three digits is a thousands separator ("€8.000", "8,000").
const NUMBER = /\d[\d.,]*/;
const READ_NUMBER = [
  [/^\d+$/, (t) => Number(t)],
  [/^\d+\.\d{1,2}$/, (t) => Number(t)],
  [/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/, (t) => Number(t.replace(/,/g, ''))],
  [/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/, (t) => Number(t.replace(/\./g, '').replace(',', '.'))],
];
const unclear = (s) => ({ unclear: true, text: s.slice(0, TEXT_MAX) });

/**
 * A figure typed as free text ("8000", "€8,000 לחודש", "120k לשנה").
 * → { amount, currency, period?, perMonth?, assumed: [..] }, null when there is no number,
 *   or { unclear: true, text } when the text holds more than one number, a currency and a period:
 *   a range ("8000-10000"), an ordinal ("בשנה הראשונה"), words left over. An unclear
 *   figure is treated like a missing one, and its text is shown as it is.
 * A currency or a period that is not written is the app's own (euros, per
 * month), and `assumed` says so: it is shown to the owner, never hidden.
 */
function readFigure(text, { salary = false } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (!/\d/.test(s)) return NO_NUMBER.test(s) ? null : unclear(s);
  // A digit of another script ("٩٠٠٠") is not read: shown as it is.
  if (/\p{N}/u.test(s.replace(/[0-9]/g, ''))) return unclear(s);
  if (RANGE.test(s)) return unclear(s);
  const n = NUMBER.exec(s);
  const token = n[0].replace(/[.,]+$/, '');
  const reader = READ_NUMBER.find(([re]) => re.test(token));
  if (!reader) return unclear(s);
  let rest = `${s.slice(0, n.index)} ${s.slice(n.index + token.length)}`;
  let amount = reader[1](token);
  // "k" / "m" / "אלף" / "מיליון" right after the number, as a word of its own ("120k", not the m of "month").
  const after = s.slice(n.index + token.length);
  const mult = /^\s*(k|m|אלפים|אלף|מיליון)(?![\p{L}])/iu.exec(after);
  if (mult) {
    amount *= MULTIPLIER[mult[1].toLowerCase()];
    rest = `${s.slice(0, n.index)} ${after.slice(mult[0].length)}`;
  }
  if (!Number.isFinite(amount) || amount <= 0) return unclear(s);
  // The currency: a sign, or a word the domain knows; two different ones are unclear.
  const found = new Set();
  rest = rest.replace(/[€$₪£]/g, (c) => { found.add(toCurrency(c)); return ' '; });
  rest = rest.replace(/ש["״׳']ח|ליש["״׳']ט/g, (w) => { found.add(toCurrency(w)); return ' '; });
  rest = rest.replace(/[\p{L}]+/gu, (w) => { const c = toCurrency(w); if (!c) return w; found.add(c); return ' '; });
  if (found.size > 1) return unclear(s);
  const currency = found.size ? [...found][0] : null;
  // The period, only from an explicit phrase, and only for a salary.
  let period = null;
  if (salary) {
    for (const [key, re] of PERIODS) {
      if (!re.test(rest)) continue;
      if (period) return unclear(s);
      period = key;
      rest = rest.replace(re, ' ');
    }
  }
  if (rest.replace(/[\s.,:;()]+/g, '')) return unclear(s);
  const assumed = currency ? [] : ['currency'];
  const out = { amount, currency: currency || APP_CURRENCY, assumed, text: s.slice(0, TEXT_MAX) };
  if (!salary) return out;
  if (!period) assumed.push('period');
  out.period = period || APP_PERIOD;
  out.perMonth = perMonth(amount, out.period);
  return out;
}

/** A figure that can carry a number: not missing and not unclear. */
const clear = (f) => (f && !f.unclear ? f : null);

/** The commission written on a deal: a percent ("10%") or a fixed sum. */
function readCommission(text) {
  const s = String(text ?? '').trim();
  if (s.includes('%')) {
    // One percent and nothing else ("10%"); "8%-10%" or "10% + bonus" is unclear.
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
    return pct && Number(pct[1]) > 0 && Number(pct[1]) <= 100 ? { percent: Number(pct[1]), text: s.slice(0, TEXT_MAX) } : unclear(s);
  }
  const f = readFigure(s);
  if (!f || f.unclear) return f;
  return { amount: f.amount, currency: f.currency, assumed: f.assumed, text: f.text };
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
    .map((x) => ({ player: playerName(x.p), position: x.p.primaryPosition, perMonth: x.f.perMonth, currency: x.f.currency, period: x.f.period, from: x.from, assumed: x.f.assumed }))
    .sort((a, b) => b.perMonth - a.perMonth)
    .slice(0, MAX_COMPARABLES);
}

/** A salary for a season is turned into a monthly one as a year: twelve months. Said whenever it was done. */
const SEASON_LINE = (what) => `${what}: רשום לעונה, וחילקתי אותו ב-12 כדי לקבל סכום לחודש (הנחתי שעונה היא שנה של 12 חודשים).`;

/** One line for the figures that were read the app's way (a bare number = euros, a salary = per month), and one for a season divided into months. */
function assumptionsOf(pairs, seasonal = []) {
  const bare = pairs.filter(([, f]) => f && f.assumed && f.assumed.length).map(([what, f]) => `${what} ("${f.text}")`);
  const seasons = seasonal.filter(([, f]) => f && f.period === 'season').map(([what]) => what);
  return [
    ...(bare.length ? [`${bare.join(', ')}: רשום כמספר בלי מטבע, אז קראתי אותו כאירו, ושכר כסכום לחודש, כמו שהמערכת מציגה.`] : []),
    ...(seasons.length ? [SEASON_LINE(seasons.join(', '))] : []),
  ];
}

// The fields a figure is read from, as the owner calls them.
const FIELD_HE = { salary: 'השכר המבוקש בעסקה', transferFee: 'דמי ההעברה בעסקה', commission: 'העמלה בעסקה', budgetSalary: 'השכר בדרישה של המועדון', budgetFee: 'דמי ההעברה בדרישה של המועדון' };
const unclearLine = (u) => `${u.label} לא ברור ("${u.text}"), אז לא בניתי עליו מספר`;

function factsFor({ deals = [], players = [], requirements = [], now = new Date() }, deal, player) {
  const today = israelDate(now);
  const p = player || {};
  const terms = p.contractTerms || null;
  const requirement = deal && deal.requirementId ? requirements.find((r) => r.id === deal.requirementId && !r.deletedAt) || null : null;
  const read = deal ? { salary: readFigure(deal.salary, { salary: true }), transferFee: readFigure(deal.transferFee), commission: readCommission(deal.commission) } : {};
  const readBudget = requirement ? { budgetSalary: readFigure(requirement.salary, { salary: true }), budgetFee: readFigure(requirement.transferFee) } : {};
  // An unclear figure is treated like a missing one: it names its field and shows the text on record, and no number is built on it.
  const unclear = Object.entries({ ...read, ...readBudget }).filter(([, f]) => f && f.unclear).map(([field, f]) => ({ field, label: FIELD_HE[field], text: f.text }));
  const isUnclear = (field) => unclear.some((u) => u.field === field);
  const ask = deal ? { salary: clear(read.salary), transferFee: clear(read.transferFee), commission: clear(read.commission) } : { salary: null, transferFee: null, commission: null };
  const budget = requirement ? { salary: clear(readBudget.budgetSalary), transferFee: clear(readBudget.budgetFee) } : null;
  const currentSalary = termsSalary(terms);
  const comparables = comparablesOf({ players, deals }, p);
  const rows = deal ? paymentRows([deal], now) : [];
  const payments = Object.fromEntries(CURRENCIES.filter((c) => rows.some((r) => r.payment.currency === c)).map((c) => {
    const mine = rows.filter((r) => r.payment.currency === c);
    return [c, { scheduled: mine.reduce((n, r) => n + r.payment.amount, 0), paid: mine.reduce((n, r) => n + r.paid, 0), outstanding: mine.reduce((n, r) => n + r.outstanding, 0), count: mine.length }];
  }));
  const missing = [
    !deal && 'אין עסקה פתוחה על השחקן, אז אין שכר מבוקש ואין מועדון',
    deal && !ask.salary && !isUnclear('salary') && 'השכר המבוקש לא רשום בעסקה',
    deal && !ask.commission && !isUnclear('commission') && 'העמלה לא רשומה בעסקה',
    deal && !requirement && 'העסקה לא מקושרת לדרישה של המועדון, אז אין תקציב של המועדון',
    requirement && !budget.salary && !isUnclear('budgetSalary') && 'בדרישה של המועדון לא רשום שכר',
    ...unclear.map(unclearLine),
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
    ask, budget, unclear,
    current: terms ? {
      salary: currentSalary, signingFee: termsMoney(terms, 'signingFee'), releaseClause: termsMoney(terms, 'releaseClause'),
      optionDeadline: terms.optionDeadline || '', optionYears: Number(terms.optionYears) || 0, optionHolder: terms.optionHolder || '',
      bonuses: String(terms.bonuses || '').slice(0, TEXT_MAX), keyDates: Array.isArray(terms.keyDates) ? terms.keyDates.filter((k) => k && k.date) : [], source: terms.source || '',
    } : null,
    payments,
    comparables,
    assumptions: assumptionsOf([['השכר בעסקה', ask.salary], ['דמי ההעברה בעסקה', ask.transferFee], ['העמלה בעסקה', ask.commission], ['השכר בדרישה של המועדון', budget && budget.salary]],
      [['השכר בעסקה', ask.salary], ['השכר בדרישה של המועדון', budget && budget.salary], ['השכר בחוזה שבתיק', currentSalary], ...comparables.map((c) => [`השכר של ${c.player}`, c])]),
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
  const askUnclear = (facts.unclear || []).find((u) => u.field === 'salary');
  const targetScenario = make('target', 'יעד', target, target && `השכר שרשום בעסקה: ${perMo(target)}`, askUnclear ? unclearLine(askUnclear) : 'השכר המבוקש לא רשום בעסקה');
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
  'Write NO numbers at all: no digits, no number words (אלף, מיליון, שמונה…), no currency, no percent. The system shows every number next to each scenario itself; your words only explain the reasoning ("כי זה מה ששחקן דומה שלנו מקבל"). Never add an estimate, a market value, a date or a name that is not in the JSON. When a scenario has no number, its value is null. No legal conclusions. No em-dashes.',
  'Answer with JSON only: {"anchor": "" | null, "target": "" | null, "walkaway": "" | null, "advice": ""}.',
].join('\n');

// What makes a sentence of the model carry a number, in any form. Every number the owner sees comes from code.
// Matches "€", "₪", "%" and the like.
const MONEY_SIGN = /[€$₪£¥%]/;
// Matches "ש"ח", "ש״ח", "ליש"ט".
const QUOTED_CURRENCY = /ש["״׳']ח|ליש["״׳']ט/;
const AMOUNT_WORDS = new Set(['אלף', 'אלפים', 'אלפי', 'מיליון', 'מיליונים', 'מיליוני', 'מיליארד', 'מאה', 'מאות', 'עשרות', 'thousand', 'thousands', 'million', 'millions', 'billion', 'billions']);
const CURRENCY_WORDS = new Set(['יורו', 'אירו', 'דולר', 'דולרים', 'שקל', 'שקלים', 'שח', 'פאונד', 'euro', 'euros', 'eur', 'dollar', 'dollars', 'usd', 'shekel', 'shekels', 'ils', 'nis', 'pound', 'pounds', 'gbp']);
const PERCENT_WORDS = new Set(['אחוז', 'אחוזים', 'אחוזי', 'percent', 'percentage']);
const PERIOD_AFTER = new Set(['לחודש', 'בחודש', 'לשנה', 'בשנה', 'לעונה', 'בעונה']);
const SPELLED = new Set(['אחד', 'אחת', 'שניים', 'שתיים', 'שני', 'שתי', 'שלוש', 'שלושה', 'שלושת', 'ארבע', 'ארבעה', 'ארבעת', 'חמש', 'חמישה', 'חמשת', 'שש', 'שישה', 'ששת', 'שבע', 'שבעה', 'שבעת', 'שמונה', 'שמונת', 'תשע', 'תשעה', 'תשעת', 'עשר', 'עשרה', 'עשרת',
  'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'twenty', 'thirty', 'forty', 'fifty', 'hundred']);
const PREFIXES = 'והבכלמש';
/** A Hebrew word and the same word without one to three of the one-letter prefixes ("ביורו" → "יורו"). */
function forms(word) {
  const out = [word];
  for (let i = 1; i <= 3 && i < word.length - 1 && PREFIXES.includes(word[i - 1]); i++) out.push(word.slice(i));
  return out;
}
const lettersOf = (s) => (String(s ?? '').toLowerCase().match(/\p{L}+/gu) || []);

/** Does this text carry a number: a digit of any script, a currency, a percent, an amount word, or a spelled number before an amount? */
function carriesNumber(text) {
  const s = String(text ?? '');
  if (/\p{N}/u.test(s) || MONEY_SIGN.test(s) || QUOTED_CURRENCY.test(s)) return true;
  const w = lettersOf(s);
  const isIn = (set, word) => forms(word).some((f) => set.has(f));
  for (let i = 0; i < w.length; i++) {
    if (isIn(AMOUNT_WORDS, w[i]) || isIn(CURRENCY_WORDS, w[i]) || isIn(PERCENT_WORDS, w[i])) return true;
    if (isIn(SPELLED, w[i]) && w[i + 1] && (isIn(PERIOD_AFTER, w[i + 1]) || PERIOD_AFTER.has(w[i + 1]))) return true;
  }
  return false;
}

const sentencesOf = (s) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

/**
 * The model's wording, kept sentence by sentence: a sentence that carries any
 * number is dropped, whatever the number. null when nothing is left, and the
 * answer is then the code's own text.
 */
function checkReasoning(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const out = {};
  for (const k of ['anchor', 'target', 'walkaway', 'advice']) {
    const s = typeof j[k] === 'string' ? j[k].replace(/\s*[—–]\s*/g, ', ').replace(/[ \t]+/g, ' ').trim() : '';
    const kept = sentencesOf(s).filter((x) => !carriesNumber(x)).join(' ').slice(0, REASON_MAX);
    if (kept) out[k] = kept;
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
  let usedModel = MODEL;
  try {
    const anthropic = client || new (require('@anthropic-ai/sdk'))();
    const res = await anthropic.beta.messages.stream({
      model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
      system: REASON_SYSTEM, messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }).finalMessage();
    spent = cost.addUsage(spent, res.usage);
    usedModel = cost.billedModel(res.model, usedModel);
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return checkReasoning(text) || { skipped: 'the wording carried numbers, so it was dropped: the numbers are the code\'s' };
  } catch {
    return { skipped: 'the wording could not be written' };
  } finally {
    if (spent) await cost.record(db, { kind: 'deal', model: usedModel, usage: spent, now });
  }
}

// ── What-ifs ────────────────────────────────────────────────────────────────
const MISSING_HE = {
  percent: 'אחוז העמלה (בין 0 ל-100)', currency: 'המטבע', 'salary or fee': 'שכר או סכום חד-פעמי', salary: 'השכר', salaryPeriod: 'האם השכר לחודש, לשנה או לעונה',
  months: 'אורך החוזה (בחודשים או בשנים)', fee: 'הסכום החד-פעמי', total: 'הסכום הכולל', count: 'מספר התשלומים', firstDue: 'תאריך התשלום הראשון', everyMonths: 'כל כמה חודשים',
};
const NOT_SAVED = 'זה חישוב בלבד: שום דבר לא נשמר.';
const monthHe = (m) => `${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

function commissionText(r, input = {}) {
  const lines = [`*מה אם: עמלה של ${r.percent}%*`];
  if (r.onSalary !== null && input.salaryPeriod === 'season') lines.push(SEASON_LINE('השכר'));
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
        regulation: { flags: regs.flags.filter((f) => f.area !== 'agents').map((f) => f.line), notVerified: regs.notVerified.map((n) => n.topic), missing: regs.missing.map((m) => m.he), more: 'regulation_check with this dealId has the agent rules too.' },
        rule: 'Answer with `text` as it is (you may shorten, never change a number). Every number comes from the CRM: never add, round, convert or estimate one, and never fill what `missing` lists: say it is missing and ask; once the writer gives it, save it on the deal or in the contract terms and call again. `reasoning`, when present, is wording only. A scenario with salaryPerMonth null has no number: say which fact is missing. A counter-offer to the club is a draft the writer sends himself: outreach_prepare, then outreach_link. You never send it.',
      };
    },

    finance_whatif: async (input = {}) => {
      need();
      if (input.kind === 'commission') {
        const r = commissionWhatIf(input);
        return r.ok ? { saved: false, kind: 'commission', result: r, text: commissionText(r, input), rule: 'A calculation only: say that nothing was saved. Never add a number that is not in the result.' } : missingOut(r.missing);
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

module.exports = { dealFacts, playerFacts, buildScenarios, scenariosText, readFigure, readCommission, checkReasoning, carriesNumber, wordReasoning, dealTools, dealSection, DEAL_TOOL_DEFS };
