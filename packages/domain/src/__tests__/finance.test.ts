import { describe, it, expect } from 'vitest';
import {
  cleanPayment, paymentStatus, paymentRows, cashFlow, financeTotals, filterPayments, hasLatePayment,
  toCurrency, toAmount, formatMoney, addMonths, currenciesIn, describePayment, PAYMENT_DUE_SOON_DAYS,
} from '../engines/finance';
import { computeAlerts } from '../engines/alerts';
import { can } from '../permissions';
import { dealSchema } from '../schemas';

// 12:00 in Israel on 25 Nov 2026 (UTC+2 in winter).
const NOON = new Date('2026-11-25T10:00:00Z');
// 23:30 UTC on the 25th is already 01:30 on the 26th in Israel.
const LATE_UTC = new Date('2026-11-25T23:30:00Z');
// Two days later, still late.
const TWO_DAYS_ON = new Date('2026-11-27T10:00:00Z');

// The amounts the fixtures use, named so every expected total reads as a sum.
const FULL = 5000;
const TYPED_DECIMAL = 1250.5;
const SHEKELS_DECIMAL = 12500.5;
const PART = 2000;
const A2 = 3000;
const A3 = 1000;
const A3_PART = 400;
const B1 = 20000;
const B2 = 10000;
const B3 = 7000;
const C1 = 9999;
const C2 = 100;
const D1 = 777;
const USD = 1200;
const ILS_TODAY = 800;
const PARTIAL_PAID = 1000;
const NEGATIVE = -5;

// Day counts from NOON (25 Nov).
const TO_DEC_15 = 20;
const LATE_3 = 3;
const LATE_5 = 5;
const LATE_7 = 7;
const LATE_24 = 24;
const IN_6 = 6;
const MONTHS_3 = 3;

const pay = (over: Record<string, unknown> = {}) => ({
  id: 'p1', label: 'עמלה', amount: FULL, currency: 'EUR', dueDate: '2026-11-30',
  payer: { kind: 'club', name: 'מכבי חיפה' }, paidAt: null, paidAmount: null, note: '', createdBy: 'lou@x.com', createdAt: '2026-11-01T00:00:00Z', ...over,
});
const deal = (id: string, payments: unknown[], over: Record<string, unknown> = {}) => ({
  id, playerId: `pl-${id}`, playerName: `Player ${id}`, clubId: `cl-${id}`, clubName: `Club ${id}`, stage: 'Contract Signed', payments, ...over,
});

describe('cleanPayment', () => {
  it('reads amounts, currencies and dates the way people type them', () => {
    expect(toAmount('5,000')).toBe(FULL);
    expect(toAmount('€ 1,250.50')).toBe(TYPED_DECIMAL);
    expect(toAmount('abc')).toBeNull();
    expect(toAmount('')).toBeNull();
    expect(toCurrency('יורו')).toBe('EUR');
    expect(toCurrency('€')).toBe('EUR');
    expect(toCurrency('ש"ח')).toBe('ILS');
    expect(toCurrency('ש׳ח')).toBe('ILS');
    expect(toCurrency('usd')).toBe('USD');
    expect(toCurrency('bitcoin')).toBeNull();
    expect(formatMoney(FULL, 'EUR')).toBe('€5,000');
    expect(formatMoney(SHEKELS_DECIMAL, 'ILS')).toBe('₪12,500.5');
  });
  it('fills the id and the stamp, and keeps the payer', () => {
    const r = cleanPayment({ amount: '5,000', currency: 'EUR', dueDate: '2027-01-31', payer: { kind: 'club', name: 'מכבי' } }, { now: NOON, by: 'lou@x.com', id: () => 'new1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payment).toMatchObject({ id: 'new1', amount: FULL, currency: 'EUR', dueDate: '2027-01-31', payer: { kind: 'club', name: 'מכבי' }, paidAt: null, paidAmount: null, createdBy: 'lou@x.com', createdAt: NOON.toISOString() });
  });
  it('never invents an amount, a currency or a date', () => {
    const r = cleanPayment({ payer: { kind: 'club' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(['amount must be a number above 0', 'currency must be one of ILS, EUR, USD, GBP', 'dueDate must be YYYY-MM-DD']);
    expect(cleanPayment(pay({ dueDate: '2027-02-30' })).ok).toBe(false);
    expect(cleanPayment(pay({ amount: NEGATIVE })).ok).toBe(false);
    expect(cleanPayment(pay({ payer: { kind: 'agent', name: 'x' } })).ok).toBe(false);
  });
  it('a paid amount needs its date; paying it all is a full payment', () => {
    expect(cleanPayment(pay({ paidAmount: PART })).ok).toBe(false);
    const full = cleanPayment(pay({ paidAt: '2026-11-20', paidAmount: FULL }));
    expect(full.ok && full.payment.paidAmount).toBeNull();
    const part = cleanPayment(pay({ paidAt: '2026-11-20', paidAmount: '2,000' }));
    expect(part.ok && part.payment.paidAmount).toBe(PART);
  });
  it('the deal schema takes payments', () => {
    const base = { playerId: 'x', playerName: 'X', category: 'men', clubName: 'C', stage: 'Contract Signed' };
    expect(dealSchema.parse({ ...base, payments: [pay()] }).payments).toHaveLength(1);
    expect(() => dealSchema.parse({ ...base, payments: [pay({ currency: 'BTC' })] })).toThrow();
  });
});

describe('paymentStatus on the Israeli calendar', () => {
  it('scheduled, due soon, due today, late', () => {
    expect(paymentStatus(pay({ dueDate: '2026-12-15' }), NOON)).toMatchObject({ status: 'scheduled', days: TO_DEC_15, daysLeft: TO_DEC_15, daysLate: 0 });
    expect(paymentStatus(pay({ dueDate: '2026-12-02' }), NOON)).toMatchObject({ status: 'due_soon', days: PAYMENT_DUE_SOON_DAYS });
    expect(paymentStatus(pay({ dueDate: '2026-12-03' }), NOON).status).toBe('scheduled');
    expect(paymentStatus(pay({ dueDate: '2026-11-25' }), NOON)).toMatchObject({ status: 'due_soon', days: 0, daysLeft: 0 });
    expect(paymentStatus(pay({ dueDate: '2026-11-22' }), NOON)).toMatchObject({ status: 'late', days: -LATE_3, daysLate: LATE_3, outstanding: FULL });
  });
  it('the day turns at midnight in Israel, not in UTC', () => {
    // Due on the 25th: due today at noon, a day late at 01:30 Israel (still the 25th in UTC).
    expect(paymentStatus(pay({ dueDate: '2026-11-25' }), NOON).status).toBe('due_soon');
    expect(paymentStatus(pay({ dueDate: '2026-11-25' }), LATE_UTC)).toMatchObject({ status: 'late', daysLate: 1 });
  });
  it('paid and partial', () => {
    expect(paymentStatus(pay({ paidAt: '2026-11-20' }), NOON)).toMatchObject({ status: 'paid', paid: FULL, outstanding: 0 });
    expect(paymentStatus(pay({ paidAt: '2026-11-20', paidAmount: PART }), NOON)).toMatchObject({ status: 'partial', paid: PART, outstanding: FULL - PART, partial: true });
    // Partly paid and past its date: the rest is late.
    expect(paymentStatus(pay({ dueDate: '2026-11-01', paidAt: '2026-11-01', paidAmount: PART }), NOON)).toMatchObject({ status: 'late', outstanding: FULL - PART, partial: true, daysLate: LATE_24 });
  });
});

describe('rows, cash flow and totals', () => {
  const deals = [
    deal('a', [
      pay({ id: 'a1', dueDate: '2026-11-10', paidAt: '2026-11-12' }),                              // paid, Nov
      pay({ id: 'a2', dueDate: '2026-11-20', amount: A2 }),                                         // late, Nov
      pay({ id: 'a3', dueDate: '2026-12-01', amount: A3, paidAt: '2026-11-24', paidAmount: A3_PART }), // partial, Dec
    ]),
    deal('b', [
      pay({ id: 'b1', currency: 'ILS', amount: B1, dueDate: '2026-11-28', payer: { kind: 'player', name: 'Player b' } }), // due soon, ILS
      pay({ id: 'b2', currency: 'ILS', amount: B2, dueDate: '2026-03-01', paidAt: '2026-03-03' }),                      // paid this year
      pay({ id: 'b3', currency: 'ILS', amount: B3, dueDate: '2025-12-01', paidAt: '2025-12-02' }),                      // paid last year
    ]),
    // Closed as Not Relevant: the unpaid one is out of everything, the paid one still counts.
    deal('c', [pay({ id: 'c1', dueDate: '2026-11-01', amount: C1 }), pay({ id: 'c2', dueDate: '2026-11-02', amount: C2, paidAt: '2026-11-02' })], { stage: 'Not Relevant', closedAt: '2026-11-05' }),
    // In the recycle bin: nothing.
    deal('d', [pay({ id: 'd1', dueDate: '2026-11-01', amount: D1 })], { deletedAt: 'x' }),
    { id: 'e', playerName: 'No payments', clubName: 'X', stage: 'Negotiation' },
  ];
  const rows = paymentRows(deals, NOON);

  it('flat rows carry the deal, player and club, sorted by date', () => {
    expect(rows.map((r) => r.payment.id)).toEqual(['b3', 'b2', 'c1', 'c2', 'a1', 'a2', 'b1', 'a3']);
    expect(rows.find((r) => r.payment.id === 'a2')).toMatchObject({ dealId: 'a', playerName: 'Player a', clubName: 'Club a', status: 'late' });
    expect(rows.find((r) => r.payment.id === 'c1')?.excluded).toBe(true);
    expect(rows.find((r) => r.payment.id === 'c2')?.excluded).toBe(false);
    expect(currenciesIn(rows)).toEqual(['ILS', 'EUR']);
  });

  it('totals per currency, never added across currencies', () => {
    const t = financeTotals(rows, NOON);
    expect(Object.keys(t).sort()).toEqual(['EUR', 'ILS']);
    // EUR: this month only a2 is owed (a1 paid, c1 out). Paid this year: a1 + a3's part + c2.
    expect(t.EUR).toEqual({ expectedThisMonth: A2, lateNow: A2, paidThisYear: FULL + A3_PART + C2, lateCount: 1, dueThisMonthCount: 1 });
    // ILS: b1 due this month; nothing late; paid this year b2 only (b3 was last year).
    expect(t.ILS).toEqual({ expectedThisMonth: B1, lateNow: 0, paidThisYear: B2, lateCount: 0, dueThisMonthCount: 1 });
  });

  it('cash flow by month: expected, paid (by the day it came in), late', () => {
    const cf = cashFlow(rows, { from: '2026-10', months: MONTHS_3, now: NOON });
    expect(cf.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(cf[0].byCurrency).toEqual({});
    // Nov EUR: due a1 + a2 + c2 (c1 out); came in a1 + a3's part + c2; late a2.
    expect(cf[1].byCurrency.EUR).toEqual({ expected: FULL + A2 + C2, paid: FULL + A3_PART + C2, late: A2 });
    expect(cf[1].byCurrency.ILS).toEqual({ expected: B1, paid: 0, late: 0 });
    expect(cf[2].byCurrency.EUR).toEqual({ expected: A3, paid: 0, late: 0 });
    expect(addMonths('2026-11', MONTHS_3)).toBe('2027-02');
    expect(addMonths('2026-01', -MONTHS_3)).toBe('2025-10');
  });

  it('filter chips', () => {
    const ids = (f: Parameters<typeof filterPayments>[1]) => filterPayments(rows, f, NOON).map((r) => r.payment.id);
    expect(ids('late')).toEqual(['a2']);
    expect(ids('month')).toEqual(['c2', 'a1', 'a2', 'b1']);
    expect(ids('upcoming')).toEqual(['b1', 'a3']);
    expect(ids('paid')).toEqual(['b3', 'b2', 'c2', 'a1', 'a3']);
    expect(ids('all')).toEqual(rows.map((r) => r.payment.id));
  });

  it('the late mark on a deal card', () => {
    expect(hasLatePayment(deals[0], NOON)).toBe(true);
    expect(hasLatePayment(deals[1], NOON)).toBe(false);
    expect(hasLatePayment(deals[2], NOON)).toBe(false);
  });

  it('one line about a payment', () => {
    const late = rows.find((r) => r.payment.id === 'a2')!;
    expect(late.days).toBe(-LATE_5);
    expect(describePayment(late)).toEqual({ he: '€3,000 ממכבי חיפה (עמלה) באיחור של 5 ימים', en: '€3,000 from מכבי חיפה (עמלה) 5 days late' });
    const partial = rows.find((r) => r.payment.id === 'a3')!;
    expect(partial.days).toBe(IN_6);
    expect(describePayment(partial).he).toBe('€600 (יתרה) ממכבי חיפה (עמלה) צפוי בעוד 6 ימים');
  });
});

describe('payment alerts', () => {
  const deals = [
    deal('a', [
      pay({ id: 'late', dueDate: '2026-11-20' }),
      pay({ id: 'week', dueDate: '2026-12-02', currency: 'USD', amount: USD }),
      pay({ id: 'today', dueDate: '2026-11-25', currency: 'ILS', amount: ILS_TODAY }),
      pay({ id: 'far', dueDate: '2026-12-03' }),
      pay({ id: 'paid', dueDate: '2026-11-01', paidAt: '2026-11-01' }),
      pay({ id: 'part', dueDate: '2026-11-15', paidAt: '2026-11-15', paidAmount: PARTIAL_PAID }),
    ]),
    deal('nr', [pay({ id: 'nr1', dueDate: '2026-11-01' })], { stage: 'Not Relevant' }),
  ];

  it('are off unless the reader may see money', () => {
    const r = computeAlerts({ deals, now: NOON });
    expect(r.byType.payment_late).toEqual([]);
    expect(r.byType.payment_due).toEqual([]);
    expect(can('admin', 'money')).toBe(true);
    expect(can('manager', 'money')).toBe(false);
    expect(can('viewer', 'money')).toBe(false);
  });

  it('late every day until paid (critical), due a week before and on the day', () => {
    const r = computeAlerts({ deals, now: NOON, money: true });
    expect(r.byType.payment_late.map((a) => a.payment?.id).sort()).toEqual(['late', 'part']);
    const late = r.byType.payment_late.find((a) => a.payment?.id === 'late')!;
    expect(late).toMatchObject({ severity: 'critical', days: -LATE_5, overdue: true, dueDate: '2026-11-20', subject: { kind: 'deal', id: 'a', name: 'Player a ↔ Club a' } });
    expect(late.proof.he).toBe('€5,000 ממכבי חיפה (עמלה) באיחור של 5 ימים');
    // The partial one alerts for what is left, with its currency.
    expect(r.byType.payment_late.find((a) => a.payment?.id === 'part')?.payment?.outstanding).toBe(FULL - PARTIAL_PAID);
    expect(r.byType.payment_due.map((a) => [a.payment?.id, a.severity, a.days])).toEqual([['today', 'warning', 0], ['week', 'info', PAYMENT_DUE_SOON_DAYS]]);
    expect(r.byType.payment_due[1].proof.en).toBe('$1,200 from מכבי חיפה (עמלה) due in 7 days');
    // Not Relevant: nothing. Paid: nothing. Eight days out: nothing yet.
    expect(r.alerts.some((a) => a.subject.id === 'nr')).toBe(false);
    expect(r.total).toBe(r.byType.payment_late.length + r.byType.payment_due.length);
    expect(r.byType.payment_due.some((a) => a.payment?.id === 'far')).toBe(false);
    // Still late two days later.
    const later = computeAlerts({ deals, now: TWO_DAYS_ON, money: true });
    expect(later.byType.payment_late.find((a) => a.payment?.id === 'late')?.days).toBe(-LATE_7);
  });
});
