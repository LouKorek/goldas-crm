// 10 · Finance. Money the agency expects per deal: a payment schedule on the
// deal's own record (deal.payments), who pays, when, what came in. Pure, and
// shared by the app (the deal's Payments section, the /finance screen), the
// alerts engine (payment_late, payment_due) and Golda (lib/golda-finance.js).
//
// Rules:
//   - Amounts are never added across currencies and never converted: every
//     total is per currency.
//   - Day counts use the Israeli calendar, like the other engines.
//   - A deal closed as "Not Relevant" keeps its payments, but the unpaid ones
//     leave every total and alert (excluded); what was paid still counts.
//   - A deal in the recycle bin counts for nothing.
//   - Seeing and editing money is one permission: can(role, 'money').
import { israelDate, daysBetween, toDateStr, addMonths } from './dates.js';

export const CURRENCIES = ['ILS', 'EUR', 'USD', 'GBP'] as const;
export type Currency = typeof CURRENCIES[number];
export const PAYER_KINDS = ['club', 'player', 'other'] as const;
export type PayerKind = typeof PAYER_KINDS[number];
export const PAYMENT_STATUSES = ['paid', 'partial', 'late', 'due_soon', 'scheduled'] as const;
export type PaymentStatus = typeof PAYMENT_STATUSES[number];
/** A payment is "due soon" this many days before its date (and on the day). */
export const PAYMENT_DUE_SOON_DAYS = 7;

export const CURRENCY_SYMBOL: Record<Currency, string> = { ILS: '₪', EUR: '€', USD: '$', GBP: '£' };

/** Money is kept to the cent. */
const CENTS = 100;
/** Length of 'YYYY-MM' and of 'YYYY' at the start of a 'YYYY-MM-DD'. */
const MONTH_LEN = 7;
const YEAR_LEN = 4;
const ID_RADIX = 36;
const ID_RANDOM_FROM = 2;
const ID_RANDOM_TO = 7;
const MAX_FRACTION_DIGITS = 2;

export interface Payment {
  id: string;
  label: string;
  amount: number;
  currency: Currency;
  dueDate: string;
  payer: { kind: PayerKind; name: string };
  paidAt: string | null;
  /** For a partial payment: how much came in so far. null = the whole amount (when paidAt is set). */
  paidAmount: number | null;
  note: string;
  createdBy: string;
  createdAt: string;
}

const CURRENCY_WORDS: Record<string, Currency> = {
  ils: 'ILS', nis: 'ILS', '₪': 'ILS', shekel: 'ILS', shekels: 'ILS', 'שח': 'ILS', 'ש"ח': 'ILS', 'שקל': 'ILS', 'שקלים': 'ILS',
  eur: 'EUR', euro: 'EUR', euros: 'EUR', '€': 'EUR', 'יורו': 'EUR', 'אירו': 'EUR',
  usd: 'USD', dollar: 'USD', dollars: 'USD', '$': 'USD', 'דולר': 'USD', 'דולרים': 'USD',
  gbp: 'GBP', pound: 'GBP', pounds: 'GBP', '£': 'GBP', 'פאונד': 'GBP', 'ליש"ט': 'GBP', 'לירה שטרלינג': 'GBP',
};

const round2 = (n: number): number => Math.round(n * CENTS) / CENTS;

// Hebrew geresh or an apostrophe, written instead of a double quote ("ש׳ח" for "ש"ח").
// Matches "׳" and "'"; rejects '"'. https://regex101.com/?regex=%5B%D7%B3'%5D
const GERESH = /[׳']/g;

/** 'EUR' / 'euro' / '€' / 'יורו' → 'EUR'; anything else → null (never a guess). */
export const toCurrency = (v: unknown): Currency | null => {
  const s = String(v ?? '').trim();
  if ((CURRENCIES as readonly string[]).includes(s.toUpperCase())) return s.toUpperCase() as Currency;
  return CURRENCY_WORDS[s.toLowerCase()] ?? CURRENCY_WORDS[s.replace(GERESH, '"')] ?? null;
};

// Thousands separators, spaces and currency signs inside a typed amount.
// Matches "," in "5,000" and "€" in "€5000"; leaves digits and "." alone.
// https://regex101.com/?regex=%5B%2C%5Cs%E2%82%AA%E2%82%AC%24%C2%A3%5D
const AMOUNT_NOISE = /[,\s₪€$£]/g;
// A plain decimal number. Matches "5000", "-12.5"; rejects "5.", "abc", "1e3".
// https://regex101.com/?regex=%5E-%3F%5Cd%2B(%5C.%5Cd%2B)%3F%24
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** 5000 / '5,000' / '5000.5' → number; '' / 'abc' / NaN → null. */
export const toAmount = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
  const s = String(v ?? '').replace(AMOUNT_NOISE, '');
  return s && PLAIN_NUMBER.test(s) ? round2(Number(s)) : null;
};

/** €5,000 / ₪12,500.5 — the symbol with the number, the same in both languages. */
export const formatMoney = (amount: number, currency: Currency | string): string => {
  const sym = CURRENCY_SYMBOL[currency as Currency] ?? `${currency} `;
  const n = Math.abs(amount).toLocaleString('en-US', { maximumFractionDigits: MAX_FRACTION_DIGITS });
  return `${amount < 0 ? '-' : ''}${sym}${n}`;
};

// A calendar day written as YYYY-MM-DD. Matches "2027-01-31"; rejects "2027-1-31", "31/01/2027".
// https://regex101.com/?regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7D%24
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: unknown): s is string => typeof s === 'string' && DAY.test(s)
  && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export type CleanResult = { ok: true; payment: Payment } | { ok: false; errors: string[] };

const newId = (now: Date): string =>
  `pay_${now.getTime().toString(ID_RADIX)}${Math.random().toString(ID_RADIX).slice(ID_RANDOM_FROM, ID_RANDOM_TO)}`;

const readPaidAt = (v: unknown): { value: string | null; error?: string } => {
  if (v == null || v === '') return { value: null };
  const d = toDateStr(v);
  return d && isDay(d) ? { value: d } : { value: null, error: 'paidAt must be YYYY-MM-DD' };
};

const readPaidAmount = (v: unknown, paidAt: string | null): { value: number | null; error?: string } => {
  if (v == null || v === '') return { value: null };
  const n = toAmount(v);
  if (n === null || n <= 0) return { value: null, error: 'paidAmount must be a number above 0' };
  return paidAt ? { value: n } : { value: n, error: 'a paid amount needs the date it was paid (paidAt)' };
};

/**
 * Clean and validate one payment. Fills id, createdBy and createdAt when
 * missing (from opts). Never invents an amount, a currency or a date: each is
 * an error when absent or unreadable.
 */
export function cleanPayment(raw: Record<string, unknown> | null | undefined, opts: { now?: Date; by?: string; id?: () => string } = {}): CleanResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const amount = toAmount(r.amount);
  const currency = toCurrency(r.currency);
  const dueDate = toDateStr(r.dueDate);
  const payerRaw = (r.payer && typeof r.payer === 'object' ? r.payer : {}) as Record<string, unknown>;
  const kindRaw = String(payerRaw.kind ?? r.payerKind ?? 'other');
  const kind = (PAYER_KINDS as readonly string[]).includes(kindRaw) ? kindRaw as PayerKind : null;
  const paidAt = readPaidAt(r.paidAt);
  const paidAmount = readPaidAmount(r.paidAmount, paidAt.value);
  const errors = [
    amount === null || amount <= 0 ? 'amount must be a number above 0' : '',
    currency ? '' : `currency must be one of ${CURRENCIES.join(', ')}`,
    dueDate && isDay(dueDate) ? '' : 'dueDate must be YYYY-MM-DD',
    kind ? '' : `payer.kind must be one of ${PAYER_KINDS.join(', ')}`,
    paidAt.error ?? '', paidAmount.error ?? '',
  ].filter(Boolean);
  if (errors.length) return { ok: false, errors };
  const total = amount as number;
  const now = opts.now ?? new Date();
  const id = String(r.id ?? '').trim() || (opts.id ? opts.id() : newId(now));
  return {
    ok: true,
    payment: {
      id,
      label: String(r.label ?? '').trim(),
      amount: total,
      currency: currency as Currency,
      dueDate: dueDate as string,
      payer: { kind: kind as PayerKind, name: String(payerRaw.name ?? r.payerName ?? '').trim() },
      paidAt: paidAt.value,
      // Paying the whole amount (or more) is a full payment: no partial figure kept.
      paidAmount: paidAmount.value !== null && paidAmount.value < total ? paidAmount.value : null,
      note: String(r.note ?? '').trim(),
      createdBy: String(r.createdBy ?? opts.by ?? ''),
      createdAt: String(r.createdAt ?? now.toISOString()),
    },
  };
}

/** The money that came in for a payment (0 when nothing did). */
export const paidSoFar = (p: Pick<Payment, 'amount' | 'paidAt' | 'paidAmount'>): number =>
  (p.paidAt ? (p.paidAmount ?? p.amount) : 0);

/** What is still owed on a payment. */
export const outstandingOf = (p: Pick<Payment, 'amount' | 'paidAt' | 'paidAmount'>): number =>
  Math.max(0, round2(p.amount - paidSoFar(p)));

export interface PaymentState {
  status: PaymentStatus;
  /** Whole days from today (Israel) to the due date; negative = past. */
  days: number;
  /** Days past the due date with money still owed (0 otherwise). */
  daysLate: number;
  /** Days left to the due date (0 on the day and after). */
  daysLeft: number;
  paid: number;
  outstanding: number;
  /** Something came in but not all of it. */
  partial: boolean;
}

const statusOf = (days: number, outstanding: number, partial: boolean): PaymentStatus => {
  if (outstanding <= 0) return 'paid';
  if (days < 0) return 'late';
  if (partial) return 'partial';
  return days <= PAYMENT_DUE_SOON_DAYS ? 'due_soon' : 'scheduled';
};

/**
 * The status of a payment on a given day. A partly paid payment whose date
 * has passed is late (the rest is owed), with partial: true; before its date
 * it is "partial".
 */
export function paymentStatus(p: Pick<Payment, 'amount' | 'paidAt' | 'paidAmount' | 'dueDate'>, now: Date = new Date()): PaymentState {
  const days = daysBetween(israelDate(now), p.dueDate);
  const paid = paidSoFar(p);
  const outstanding = outstandingOf(p);
  const partial = paid > 0 && outstanding > 0;
  return { status: statusOf(days, outstanding, partial), days, daysLate: outstanding > 0 && days < 0 ? -days : 0, daysLeft: Math.max(0, days), paid, outstanding, partial };
}

export interface PaymentRow extends PaymentState {
  payment: Payment;
  dealId: string;
  dealStage: string;
  playerId: string;
  playerName: string;
  clubId: string;
  clubName: string;
  /** Unpaid money of a deal closed as Not Relevant: out of every total and alert. */
  excluded: boolean;
}

type DealIn = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));

/** A deal's payments as stored, cleaned; unreadable entries are skipped. */
export const paymentsOf = (deal: DealIn): Payment[] =>
  (Array.isArray(deal.payments) ? deal.payments as Array<Record<string, unknown>> : [])
    .map((raw) => cleanPayment(raw, { id: () => '' }))
    .flatMap((c) => (c.ok && c.payment.id ? [c.payment] : []));

/** Every payment of every live deal, flat, with the deal, player and club names; by due date. */
export function paymentRows(deals: DealIn[] | null | undefined, now: Date = new Date()): PaymentRow[] {
  return (deals ?? [])
    .filter((d) => d && !d.deletedAt)
    .flatMap((d) => paymentsOf(d).map((p): PaymentRow => {
      const st = paymentStatus(p, now);
      return {
        ...st, payment: p, dealId: str(d.id), dealStage: str(d.stage), playerId: str(d.playerId), playerName: str(d.playerName),
        clubId: str(d.clubId), clubName: str(d.clubName), excluded: d.stage === 'Not Relevant' && st.outstanding > 0,
      };
    }))
    .sort((a, b) => a.payment.dueDate.localeCompare(b.payment.dueDate) || a.playerName.localeCompare(b.playerName));
}

export interface MoneyCell { expected: number; paid: number; late: number }
export interface CashFlowMonth { month: string; byCurrency: Partial<Record<Currency, MoneyCell>> }

const monthOf = (day: string): string => day.slice(0, MONTH_LEN);
const yearOf = (day: string): string => day.slice(0, YEAR_LEN);

/** One month's cell for a currency, from the rows that fall in it. */
const monthCell = (rows: PaymentRow[], month: string, currency: Currency): MoneyCell | null => {
  const mine = rows.filter((r) => r.payment.currency === currency);
  const due = mine.filter((r) => !r.excluded && monthOf(r.payment.dueDate) === month);
  const paidIn = mine.filter((r) => r.paid > 0 && r.payment.paidAt && monthOf(r.payment.paidAt) === month);
  if (!due.length && !paidIn.length) return null;
  return {
    expected: round2(due.reduce((n, r) => n + r.payment.amount, 0)),
    paid: round2(paidIn.reduce((n, r) => n + r.paid, 0)),
    late: round2(due.filter((r) => r.status === 'late').reduce((n, r) => n + r.outstanding, 0)),
  };
};

/**
 * The cash flow by calendar month, per currency, from `from` ('YYYY-MM') for
 * `months` months:
 *   expected  what falls due in the month (the full amounts);
 *   paid      what came in during the month (by the date it was paid);
 *   late      what fell due in the month and is still owed today.
 * Unpaid money of Not Relevant deals is left out.
 */
export function cashFlow(rows: PaymentRow[], { from, months, now = new Date() }: { from?: string; months: number; now?: Date }): CashFlowMonth[] {
  const start = from ?? monthOf(israelDate(now));
  return Array.from({ length: Math.max(0, months) }, (_, i) => addMonths(start, i)).map((month) => ({
    month,
    byCurrency: Object.fromEntries(CURRENCIES.map((c) => [c, monthCell(rows, month, c)]).filter(([, v]) => v)) as Partial<Record<Currency, MoneyCell>>,
  }));
}

export interface MoneyTotals {
  /** Still owed on payments due this calendar month (late ones of this month included). */
  expectedThisMonth: number;
  /** Still owed on every late payment. */
  lateNow: number;
  /** What came in this calendar year. */
  paidThisYear: number;
  lateCount: number;
  dueThisMonthCount: number;
}

/** "This month", "late now" and "paid this year", per currency in use. */
export function financeTotals(rows: PaymentRow[], now: Date = new Date()): Partial<Record<Currency, MoneyTotals>> {
  const today = israelDate(now);
  const totalsFor = (c: Currency): MoneyTotals => {
    const mine = rows.filter((r) => r.payment.currency === c);
    const owed = mine.filter((r) => !r.excluded && r.outstanding > 0);
    const thisMonth = owed.filter((r) => monthOf(r.payment.dueDate) === monthOf(today));
    const late = owed.filter((r) => r.status === 'late');
    const paidThisYear = mine.filter((r) => r.paid > 0 && r.payment.paidAt && yearOf(r.payment.paidAt) === yearOf(today));
    return {
      expectedThisMonth: round2(thisMonth.reduce((n, r) => n + r.outstanding, 0)),
      lateNow: round2(late.reduce((n, r) => n + r.outstanding, 0)),
      paidThisYear: round2(paidThisYear.reduce((n, r) => n + r.paid, 0)),
      lateCount: late.length,
      dueThisMonthCount: thisMonth.length,
    };
  };
  return Object.fromEntries(currenciesIn(rows).map((c) => [c, totalsFor(c)])) as Partial<Record<Currency, MoneyTotals>>;
}

/** The currencies that appear in the rows, in the fixed order of CURRENCIES. */
export const currenciesIn = (rows: PaymentRow[]): Currency[] =>
  CURRENCIES.filter((c) => rows.some((r) => r.payment.currency === c));

/** Whether a deal has a late payment that counts (for the mark on its card). */
export const hasLatePayment = (deal: DealIn, now: Date = new Date()): boolean =>
  !deal.deletedAt && deal.stage !== 'Not Relevant' && paymentsOf(deal).some((p) => paymentStatus(p, now).status === 'late');

export const PAYMENT_FILTERS = ['late', 'month', 'upcoming', 'paid', 'all'] as const;
export type PaymentFilter = typeof PAYMENT_FILTERS[number];

const FILTERS: Record<PaymentFilter, (r: PaymentRow, month: string) => boolean> = {
  late: (r) => !r.excluded && r.status === 'late',
  month: (r, month) => !r.excluded && monthOf(r.payment.dueDate) === month,
  upcoming: (r) => !r.excluded && r.outstanding > 0 && r.days >= 0,
  paid: (r) => r.paid > 0,
  all: () => true,
};

/**
 * The rows a filter chip shows:
 *   late      owed and past its date;
 *   month     due this calendar month (paid or not);
 *   upcoming  owed and not yet due;
 *   paid      something came in;
 *   all       everything (unpaid money of Not Relevant deals included, marked).
 */
export function filterPayments(rows: PaymentRow[], filter: PaymentFilter, now: Date = new Date()): PaymentRow[] {
  const month = monthOf(israelDate(now));
  const keep = FILTERS[filter] ?? FILTERS.all;
  return rows.filter((r) => keep(r, month));
}

const daysHe = (n: number): string => (n === 1 ? 'יום אחד' : `${n} ימים`);
/** "ממכבי חיפה", but "מ-FC Porto": the prefix is not glued to a name in another script. */
// The test: a name that starts with a Hebrew letter. Matches "מכבי חיפה"; rejects "FC Porto".
// https://regex101.com/?regex=%5E%5B%5Cu0590-%5Cu05FF%5D&flavor=javascript
const fromHe = (name: string): string => (/^[\u0590-\u05FF]/.test(name) ? `מ${name}` : `מ-${name}`);
const daysEn = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** One line about a payment, Hebrew and English: "€5,000 ממכבי חיפה באיחור של 3 ימים". */
export function describePayment(r: Pick<PaymentRow, 'payment' | 'status' | 'days' | 'outstanding' | 'partial'>): { he: string; en: string } {
  const p = r.payment;
  const money = formatMoney(r.status === 'paid' ? p.amount : r.outstanding, p.currency);
  const what = p.label ? ` (${p.label})` : '';
  const head = {
    he: `${money}${r.partial ? ' (יתרה)' : ''}${p.payer.name ? ` ${fromHe(p.payer.name)}` : ''}${what}`,
    en: `${money}${r.partial ? ' (balance)' : ''}${p.payer.name ? ` from ${p.payer.name}` : ''}${what}`,
  };
  const d = r.days;
  if (r.status === 'paid') return { he: `${head.he} שולם`, en: `${head.en} paid` };
  if (d < 0) return { he: `${head.he} באיחור של ${daysHe(-d)}`, en: `${head.en} ${daysEn(-d)} late` };
  if (d === 0) return { he: `${head.he} צפוי היום`, en: `${head.en} due today` };
  return { he: `${head.he} צפוי בעוד ${d === 1 ? 'יום' : daysHe(d)}`, en: `${head.en} due in ${daysEn(d)}` };
}

// ── What-ifs ─────────────────────────────────────────────────────────────────
// "What would we earn if…" and "what would this schedule do to the months
// ahead". Pure arithmetic on the numbers the caller gives: nothing is read
// from a record, nothing is saved, and a missing number is named, never
// assumed. One calculation is one currency: amounts in another currency are a
// separate line, never added and never converted.

export const SALARY_PERIODS = ['month', 'year', 'season'] as const;
export type SalaryPeriod = typeof SALARY_PERIODS[number];

const MONTHS_PER_YEAR = 12;
const PERCENT = 100;
/** The longest what-if window: five years of months. */
const WHATIF_MAX_MONTHS = 60;
const WHATIF_MAX_PAYMENTS = 60;
/** Length of 'YYYY-MM-DD', and of the 'DD' in it. */
const DAY_LEN = 10;
const DAY_DIGITS = 2;

export const isSalaryPeriod = (v: unknown): v is SalaryPeriod => (SALARY_PERIODS as readonly string[]).includes(String(v));
const given = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/** A salary per period as a salary per month: a year and a season are twelve months. */
export const perMonth = (amount: number, period: SalaryPeriod): number =>
  round2(period === 'month' ? amount : amount / MONTHS_PER_YEAR);

export interface CommissionInput {
  /** The agency's share, in percent: 10 = 10%. */
  percent?: unknown;
  currency?: unknown;
  /** The player's salary per `salaryPeriod`. */
  salary?: unknown;
  salaryPeriod?: unknown;
  /** The length of the contract: months, or years. */
  months?: unknown;
  years?: unknown;
  /** A one-off sum the same percent is taken on (a transfer fee, a signing fee), in the same currency. */
  fee?: unknown;
}

export type CommissionResult =
  | {
    ok: true; currency: Currency; percent: number;
    /** The contract's length in months (null when only a fee was given). */
    months: number | null;
    /** The salary over the whole contract. */
    salaryTotal: number | null;
    /** The commission on the salary over the whole contract. */
    onSalary: number | null;
    /** The commission on one year of salary. */
    perYear: number | null;
    fee: number | null;
    onFee: number | null;
    total: number;
  }
  | { ok: false; missing: string[] };

const readMonths = (months: unknown, years: unknown): number | null => {
  const m = given(months) ? toAmount(months) : null;
  if (m !== null && m > 0) return m;
  const y = given(years) ? toAmount(years) : null;
  return y !== null && y > 0 ? round2(y * MONTHS_PER_YEAR) : null;
};

/**
 * The commission for a percent on a salary over a contract's length and/or on
 * a one-off fee. Every number must be given: what is absent or unreadable is
 * listed in `missing`, and nothing is calculated.
 */
export function commissionWhatIf(input: CommissionInput): CommissionResult {
  const percent = given(input.percent) ? toAmount(input.percent) : null;
  const currency = toCurrency(input.currency);
  const hasSalary = given(input.salary);
  const hasFee = given(input.fee);
  const salary = hasSalary ? toAmount(input.salary) : null;
  const fee = hasFee ? toAmount(input.fee) : null;
  const months = readMonths(input.months, input.years);
  const period = isSalaryPeriod(input.salaryPeriod) ? input.salaryPeriod : null;
  const missing = [
    percent === null || percent <= 0 || percent > PERCENT ? 'percent' : '',
    currency ? '' : 'currency',
    !hasSalary && !hasFee ? 'salary or fee' : '',
    hasSalary && (salary === null || salary <= 0) ? 'salary' : '',
    hasSalary && !period ? 'salaryPeriod' : '',
    hasSalary && months === null ? 'months' : '',
    hasFee && (fee === null || fee <= 0) ? 'fee' : '',
  ].filter(Boolean);
  if (missing.length) return { ok: false, missing };
  const share = (percent as number) / PERCENT;
  // Not rounded here: the totals below are rounded once, from the exact monthly figure.
  const monthly = hasSalary ? (salary as number) / (period === 'month' ? 1 : MONTHS_PER_YEAR) : null;
  const salaryTotal = monthly === null ? null : round2(monthly * (months as number));
  const onSalary = salaryTotal === null ? null : round2(salaryTotal * share);
  const perYear = monthly === null ? null : round2(monthly * MONTHS_PER_YEAR * share);
  const onFee = hasFee ? round2((fee as number) * share) : null;
  return {
    ok: true, currency: currency as Currency, percent: percent as number, months: hasSalary ? months : null,
    salaryTotal, onSalary, perYear, fee: hasFee ? fee : null, onFee, total: round2((onSalary ?? 0) + (onFee ?? 0)),
  };
}

export interface WhatIfPayment { amount: number; currency: Currency; dueDate: string; label: string }

/** 'YYYY-MM-DD' plus `n` months, on the same day of the month or on its last day. */
const addMonthsToDay = (day: string, n: number): string => {
  const month = addMonths(monthOf(day), n);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(Number(day.slice(MONTH_LEN + 1, DAY_LEN)), last)).padStart(DAY_DIGITS, '0')}`;
};

export type InstallmentsResult = { ok: true; payments: WhatIfPayment[] } | { ok: false; missing: string[] };

/**
 * A total split into equal payments, one every `everyMonths` months from
 * `firstDue`. The cents that do not divide go on the last payment, so the
 * payments always add up to the total.
 */
export function installments(input: { total?: unknown; currency?: unknown; count?: unknown; firstDue?: unknown; everyMonths?: unknown; label?: unknown }): InstallmentsResult {
  const total = given(input.total) ? toAmount(input.total) : null;
  const currency = toCurrency(input.currency);
  const count = given(input.count) ? Number(input.count) : 1;
  const every = given(input.everyMonths) ? Number(input.everyMonths) : 1;
  const firstDue = toDateStr(input.firstDue);
  const missing = [
    total === null || total <= 0 ? 'total' : '',
    currency ? '' : 'currency',
    Number.isInteger(count) && count >= 1 && count <= WHATIF_MAX_PAYMENTS ? '' : 'count',
    Number.isInteger(every) && every >= 1 ? '' : 'everyMonths',
    firstDue && isDay(firstDue) ? '' : 'firstDue',
  ].filter(Boolean);
  if (missing.length) return { ok: false, missing };
  const sum = total as number;
  const part = Math.floor((sum * CENTS) / count) / CENTS;
  const label = String(input.label ?? '').trim();
  return {
    ok: true,
    payments: Array.from({ length: count }, (_, i) => ({
      amount: i === count - 1 ? round2(sum - part * (count - 1)) : part,
      currency: currency as Currency,
      dueDate: addMonthsToDay(firstDue as string, i * every),
      label,
    })),
  };
}

/** One month and one currency: what is already expected, what the what-if adds, and both together. */
export interface WhatIfCell { expected: number; added: number; withWhatIf: number }
export interface WhatIfMonth { month: string; byCurrency: Partial<Record<Currency, WhatIfCell>> }
export type ScheduleWhatIfResult =
  | {
    ok: true; from: string; months: WhatIfMonth[];
    totals: Partial<Record<Currency, WhatIfCell>>;
    /** Payments of the what-if that fall outside the months shown. */
    outside: WhatIfPayment[];
    payments: WhatIfPayment[];
  }
  | { ok: false; errors: string[] };

const readWhatIfPayment = (raw: unknown, i: number): { payment?: WhatIfPayment; errors: string[] } => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const amount = toAmount(r.amount);
  const currency = toCurrency(r.currency);
  const dueDate = toDateStr(r.dueDate);
  const n = i + 1;
  const errors = [
    amount === null || amount <= 0 ? `payment ${n}: amount must be a number above 0` : '',
    currency ? '' : `payment ${n}: currency must be one of ${CURRENCIES.join(', ')}`,
    dueDate && isDay(dueDate) ? '' : `payment ${n}: dueDate must be YYYY-MM-DD`,
  ].filter(Boolean);
  if (errors.length) return { errors };
  return { errors, payment: { amount: amount as number, currency: currency as Currency, dueDate: dueDate as string, label: String(r.label ?? '').trim() } };
};

const monthsApart = (from: string, to: string): number => {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * MONTHS_PER_YEAR + (tm - fm);
};

const sumCells = (cells: WhatIfCell[]): WhatIfCell | null => {
  if (!cells.length) return null;
  const expected = round2(cells.reduce((n, x) => n + x.expected, 0));
  const added = round2(cells.reduce((n, x) => n + x.added, 0));
  return { expected, added, withWhatIf: round2(expected + added) };
};

const perCurrency = (cellOf: (c: Currency) => WhatIfCell | null): Partial<Record<Currency, WhatIfCell>> =>
  Object.fromEntries(CURRENCIES.map((c) => [c, cellOf(c)]).filter(([, v]) => v)) as Partial<Record<Currency, WhatIfCell>>;

/**
 * What a payment schedule would do to the cash flow that is already expected,
 * month by month and per currency, from `from` ('YYYY-MM', this month when
 * absent) for `months` months (to the schedule's last payment when absent).
 * `rows` are the payments on record (paymentRows); they are read, never
 * changed. A currency of the schedule never touches another currency's line.
 */
export function scheduleWhatIf(rows: PaymentRow[], schedule: unknown, opts: { from?: string; months?: number; now?: Date } = {}): ScheduleWhatIfResult {
  const list = Array.isArray(schedule) ? schedule : [];
  if (!list.length) return { ok: false, errors: ['the schedule is empty'] };
  if (list.length > WHATIF_MAX_PAYMENTS) return { ok: false, errors: [`at most ${WHATIF_MAX_PAYMENTS} payments in one what-if`] };
  const read = list.map(readWhatIfPayment);
  const errors = read.flatMap((r) => r.errors);
  if (errors.length) return { ok: false, errors };
  const payments = read.flatMap((r) => (r.payment ? [r.payment] : [])).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const from = opts.from ?? monthOf(israelDate(opts.now ?? new Date()));
  if (!isDay(`${from}-01`)) return { ok: false, errors: ['from must be YYYY-MM'] };
  const span = opts.months ?? monthsApart(from, monthOf(payments[payments.length - 1].dueDate)) + 1;
  const count = Math.min(WHATIF_MAX_MONTHS, Math.max(1, Math.floor(span)));
  const window = Array.from({ length: count }, (_, i) => addMonths(from, i));
  const cellOf = (month: string, currency: Currency): WhatIfCell | null => {
    const expected = monthCell(rows, month, currency)?.expected ?? 0;
    const added = round2(payments.filter((p) => p.currency === currency && monthOf(p.dueDate) === month).reduce((n, p) => n + p.amount, 0));
    return expected || added ? { expected, added, withWhatIf: round2(expected + added) } : null;
  };
  const months = window.map((month): WhatIfMonth => ({ month, byCurrency: perCurrency((c) => cellOf(month, c)) }));
  return {
    ok: true, from, months,
    totals: perCurrency((c) => sumCells(months.flatMap((m) => (m.byCurrency[c] ? [m.byCurrency[c] as WhatIfCell] : [])))),
    outside: payments.filter((p) => !window.includes(monthOf(p.dueDate))),
    payments,
  };
}
