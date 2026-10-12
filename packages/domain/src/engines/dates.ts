// Calendar arithmetic in Israel time. Every engine counts whole days on the
// Israeli calendar, so a server in UTC and a phone in Tel Aviv agree on what
// "today" and "in 7 days" mean. Dates are 'YYYY-MM-DD' strings.

export const ISRAEL_TZ = 'Asia/Jerusalem';

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ISRAEL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Israeli calendar date of `now`, as 'YYYY-MM-DD'. */
export const israelDate = (now: Date = new Date()): string => fmt.format(now);

/** Normalise a date-like value to 'YYYY-MM-DD' or null. */
export const toDateStr = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : israelDate(v);
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return toDateStr((v as { toDate: () => Date }).toDate());
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : israelDate(d);
};

const utcMidnight = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Whole days from `fromStr` to `toStr` (both 'YYYY-MM-DD'). */
export const daysBetween = (fromStr: string, toStr: string): number =>
  Math.round((utcMidnight(toStr) - utcMidnight(fromStr)) / 86400000);

/** Whole days from today (Israel) to `date`; 0 = today, negative = past. */
export const daysAway = (date: unknown, now: Date = new Date()): number | null => {
  const s = toDateStr(date);
  return s ? daysBetween(israelDate(now), s) : null;
};

/** 'YYYY-MM-DD' plus `n` days. */
export const addDays = (s: string, n: number): string => {
  const d = new Date(utcMidnight(s) + n * 86400000);
  return d.toISOString().slice(0, 10);
};

/** Days to the next birthday (0 on the day) and the age reached then. */
export const nextBirthday = (dob: unknown, now: Date = new Date()): { days: number; age: number } | null => {
  const b = toDateStr(dob);
  if (!b) return null;
  const today = israelDate(now);
  const [ty] = today.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let next = `${ty}-${String(bm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`;
  // Feb 29 in a non-leap year falls on Mar 1.
  if (isNaN(utcMidnight(next))) next = `${ty}-03-01`;
  let year = ty;
  if (daysBetween(today, next) < 0) { year = ty + 1; next = `${year}-${String(bm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`; }
  return { days: daysBetween(today, next), age: year - by };
};

/** Day of week (0 = Sunday) of a 'YYYY-MM-DD'. */
export const weekday = (s: string): number => new Date(utcMidnight(s)).getUTCDay();
