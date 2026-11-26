import { describe, it, expect } from 'vitest';
import { commissionWhatIf, installments, scheduleWhatIf, perMonth, paymentRows } from '../engines/finance';

// 12:00 in Israel on 25 Nov 2026 (UTC+2 in winter).
const NOON = new Date('2026-11-25T10:00:00Z');

// The numbers the cases use, named so every expected figure reads as arithmetic.
const TEN_PERCENT = 10;
const SALARY_MONTH = 8000;
const SALARY_YEAR = 96000;
const MONTHS_24 = 24;
const YEARS_2 = 2;
const FEE = 200000;
const SALARY_OVER_24 = 192000;
const COMMISSION_ON_SALARY = 19200;
const COMMISSION_PER_YEAR = 9600;
const COMMISSION_ON_FEE = 20000;
const COMMISSION_BOTH = 39200;
const OVER_100 = 120;
const TOTAL = 10000;
const THREE = 3;
const THIRD = 3333.33;
const LAST_THIRD = 3333.34;
const EVERY_2 = 2;
const EXISTING_DEC = 5000;
const EXISTING_JAN_USD = 1200;
const ADDED = 4000;
const DEC_WITH = 9000;
const TOO_MANY = 61;
const WINDOW_2 = 2;

const deal = (id: string, payments: unknown[]) => ({ id, stage: 'Contract Signed', playerId: 'pl1', playerName: 'דנה כהן', clubId: 'c1', clubName: 'מכבי חיפה', payments });
const pay = (id: string, amount: number, currency: string, dueDate: string) => ({
  id, label: '', amount, currency, dueDate, payer: { kind: 'club', name: 'מכבי חיפה' }, paidAt: null, paidAmount: null, note: '', createdBy: 'a@x.com', createdAt: '2026-11-01T00:00:00Z',
});
const rows = () => paymentRows([deal('d1', [pay('p1', EXISTING_DEC, 'EUR', '2026-12-10'), pay('p2', EXISTING_JAN_USD, 'USD', '2027-01-05')])], NOON);

describe('commissionWhatIf', () => {
  it('takes the percent on a monthly salary over the contract', () => {
    const r = commissionWhatIf({ percent: TEN_PERCENT, currency: 'EUR', salary: SALARY_MONTH, salaryPeriod: 'month', months: MONTHS_24 });
    expect(r).toMatchObject({ ok: true, currency: 'EUR', months: MONTHS_24, salaryTotal: SALARY_OVER_24, onSalary: COMMISSION_ON_SALARY, perYear: COMMISSION_PER_YEAR, onFee: null, total: COMMISSION_ON_SALARY });
  });

  it('reads a yearly salary and a length in years the same way', () => {
    const r = commissionWhatIf({ percent: '10', currency: 'יורו', salary: SALARY_YEAR, salaryPeriod: 'year', years: YEARS_2 });
    expect(r).toMatchObject({ ok: true, months: MONTHS_24, salaryTotal: SALARY_OVER_24, onSalary: COMMISSION_ON_SALARY });
  });

  it('adds the commission on a one-off fee in the same currency', () => {
    const r = commissionWhatIf({ percent: TEN_PERCENT, currency: 'EUR', salary: SALARY_MONTH, salaryPeriod: 'month', months: MONTHS_24, fee: FEE });
    expect(r).toMatchObject({ ok: true, onFee: COMMISSION_ON_FEE, total: COMMISSION_BOTH });
  });

  it('works on a fee alone, with no contract length', () => {
    const r = commissionWhatIf({ percent: TEN_PERCENT, currency: 'USD', fee: FEE });
    expect(r).toMatchObject({ ok: true, months: null, salaryTotal: null, onSalary: null, onFee: COMMISSION_ON_FEE, total: COMMISSION_ON_FEE });
  });

  it('names every missing number and calculates nothing', () => {
    expect(commissionWhatIf({})).toEqual({ ok: false, missing: ['percent', 'currency', 'salary or fee'] });
    expect(commissionWhatIf({ percent: TEN_PERCENT, currency: 'EUR', salary: SALARY_MONTH })).toEqual({ ok: false, missing: ['salaryPeriod', 'months'] });
    expect(commissionWhatIf({ percent: OVER_100, currency: 'EUR', fee: FEE })).toEqual({ ok: false, missing: ['percent'] });
    expect(commissionWhatIf({ percent: TEN_PERCENT, currency: 'bitcoin', fee: 'a lot' })).toEqual({ ok: false, missing: ['currency', 'fee'] });
  });

  it('turns a salary per year or season into a salary per month', () => {
    expect(perMonth(SALARY_YEAR, 'year')).toBe(SALARY_MONTH);
    expect(perMonth(SALARY_YEAR, 'season')).toBe(SALARY_MONTH);
    expect(perMonth(SALARY_MONTH, 'month')).toBe(SALARY_MONTH);
  });
});

describe('installments', () => {
  it('splits a total so the payments add up to it exactly', () => {
    const r = installments({ total: TOTAL, currency: 'EUR', count: THREE, firstDue: '2027-01-31' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payments.map((p) => p.amount)).toEqual([THIRD, THIRD, LAST_THIRD]);
    expect(r.payments.reduce((n, p) => n + p.amount, 0)).toBeCloseTo(TOTAL);
    // The 31st does not exist in February: the last day of the month is used.
    expect(r.payments.map((p) => p.dueDate)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('spaces the payments by the months asked', () => {
    const r = installments({ total: TOTAL, currency: 'ILS', count: THREE, firstDue: '2026-12-15', everyMonths: EVERY_2 });
    expect(r.ok && r.payments.map((p) => p.dueDate)).toEqual(['2026-12-15', '2027-02-15', '2027-04-15']);
  });

  it('names what is missing', () => {
    expect(installments({ count: 0 })).toEqual({ ok: false, missing: ['total', 'currency', 'count', 'firstDue'] });
    expect(installments({ total: TOTAL, currency: 'EUR', count: TOO_MANY, firstDue: '2027-01-01' })).toEqual({ ok: false, missing: ['count'] });
  });
});

describe('scheduleWhatIf', () => {
  it('lays the what-if over what is already expected, month by month', () => {
    const r = scheduleWhatIf(rows(), [{ amount: ADDED, currency: 'EUR', dueDate: '2026-12-20' }, { amount: ADDED, currency: 'EUR', dueDate: '2027-02-20' }], { now: NOON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toBe('2026-11');
    expect(r.months.map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(r.months[1].byCurrency).toEqual({ EUR: { expected: EXISTING_DEC, added: ADDED, withWhatIf: DEC_WITH } });
    expect(r.months[THREE].byCurrency).toEqual({ EUR: { expected: 0, added: ADDED, withWhatIf: ADDED } });
    expect(r.outside).toEqual([]);
  });

  it('never adds or converts across currencies', () => {
    const r = scheduleWhatIf(rows(), [{ amount: ADDED, currency: 'EUR', dueDate: '2027-01-10' }], { now: NOON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // January holds dollars on record and euros in the what-if: two lines, never one sum.
    expect(r.months[WINDOW_2].byCurrency).toEqual({
      EUR: { expected: 0, added: ADDED, withWhatIf: ADDED },
      USD: { expected: EXISTING_JAN_USD, added: 0, withWhatIf: EXISTING_JAN_USD },
    });
    expect(r.totals).toEqual({
      EUR: { expected: EXISTING_DEC, added: ADDED, withWhatIf: DEC_WITH },
      USD: { expected: EXISTING_JAN_USD, added: 0, withWhatIf: EXISTING_JAN_USD },
    });
  });

  it('reports the payments that fall outside the months shown', () => {
    const r = scheduleWhatIf(rows(), [{ amount: ADDED, currency: 'EUR', dueDate: '2026-12-20' }, { amount: ADDED, currency: 'EUR', dueDate: '2027-06-20' }], { now: NOON, months: WINDOW_2 });
    expect(r.ok && r.months.length).toBe(WINDOW_2);
    expect(r.ok && r.outside.map((p) => p.dueDate)).toEqual(['2027-06-20']);
  });

  it('refuses an empty or unreadable schedule and says why', () => {
    expect(scheduleWhatIf(rows(), [], { now: NOON })).toEqual({ ok: false, errors: ['the schedule is empty'] });
    const bad = scheduleWhatIf(rows(), [{ amount: 'x', currency: 'EUR', dueDate: '2027-01-10' }, { amount: ADDED, dueDate: 'soon' }], { now: NOON });
    expect(bad).toEqual({ ok: false, errors: ['payment 1: amount must be a number above 0', 'payment 2: currency must be one of ILS, EUR, USD, GBP', 'payment 2: dueDate must be YYYY-MM-DD'] });
    expect(scheduleWhatIf(rows(), [{ amount: ADDED, currency: 'EUR', dueDate: '2027-01-10' }], { from: 'January' })).toEqual({ ok: false, errors: ['from must be YYYY-MM'] });
  });

  it('leaves the rows it read untouched', () => {
    const before = rows();
    const snapshot = JSON.stringify(before);
    scheduleWhatIf(before, [{ amount: ADDED, currency: 'EUR', dueDate: '2026-12-20' }], { now: NOON });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
