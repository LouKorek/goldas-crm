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
const daysEn = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** One line about a payment, Hebrew and English: "€5,000 ממכבי חיפה באיחור של 3 ימים". */
export function describePayment(r: Pick<PaymentRow, 'payment' | 'status' | 'days' | 'outstanding' | 'partial'>): { he: string; en: string } {
  const p = r.payment;
  const money = formatMoney(r.status === 'paid' ? p.amount : r.outstanding, p.currency);
  const what = p.label ? ` (${p.label})` : '';
  const head = {
    he: `${money}${r.partial ? ' (יתרה)' : ''}${p.payer.name ? ` מ${p.payer.name}` : ''}${what}`,
    en: `${money}${r.partial ? ' (balance)' : ''}${p.payer.name ? ` from ${p.payer.name}` : ''}${what}`,
  };
  const d = r.days;
  if (r.status === 'paid') return { he: `${head.he} שולם`, en: `${head.en} paid` };
  if (d < 0) return { he: `${head.he} באיחור של ${daysHe(-d)}`, en: `${head.en} ${daysEn(-d)} late` };
  if (d === 0) return { he: `${head.he} צפוי היום`, en: `${head.en} due today` };
  return { he: `${head.he} צפוי בעוד ${d === 1 ? 'יום' : daysHe(d)}`, en: `${head.en} due in ${daysEn(d)}` };
}
