// Trainings repeat ("every Sunday, Tuesday and Thursday at 17:30"). Only the
// rule is stored; the calendar expands it into occurrences for the range it
// shows, and a single occurrence can be cancelled or moved without touching
// the rule. A small RRULE: weekly, by weekday, with an optional end date.
import { addDays, daysBetween, weekday } from './dates.js';

export interface WeeklyRule {
  freq: 'weekly';
  /** 0 = Sunday … 6 = Saturday. */
  byWeekday: number[];
  /** First date the rule applies ('YYYY-MM-DD'). */
  start: string;
  /** Last date (inclusive), or null for open-ended. */
  until?: string | null;
}

export interface Exception {
  date: string;
  /** Skip this occurrence. */
  cancelled?: boolean;
  /** Move it: new date and/or time. */
  date2?: string;
  time?: string;
}

export interface TrainingLike {
  id?: string;
  date?: string;          // one-off training
  time?: string;
  rule?: WeeklyRule | null;
  exceptions?: Exception[];
  [k: string]: unknown;
}

export interface Occurrence {
  trainingId: string;
  date: string;
  time: string;
  /** The date the rule generated (differs from `date` when moved). */
  sourceDate: string;
  recurring: boolean;
  cancelled: boolean;
}

/** Expand one training into its occurrences inside [from, to] (inclusive). */
export function occurrences(tr: TrainingLike, from: string, to: string): Occurrence[] {
  const id = String(tr.id ?? '');
  const time = String(tr.time ?? '');
  const ex = new Map((tr.exceptions ?? []).map((e) => [e.date, e]));
  const out: Occurrence[] = [];
  const emit = (sourceDate: string, recurring: boolean) => {
    const e = ex.get(sourceDate);
    const date = e?.date2 ?? sourceDate;
    if (daysBetween(from, date) < 0 || daysBetween(date, to) < 0) return;
    out.push({ trainingId: id, date, time: e?.time ?? time, sourceDate, recurring, cancelled: !!e?.cancelled });
  };
  if (tr.rule && tr.rule.freq === 'weekly' && tr.rule.byWeekday?.length) {
    const r = tr.rule;
    const first = daysBetween(from, r.start) > 0 ? r.start : from;
    const last = r.until && daysBetween(r.until, to) > 0 ? r.until : to;
    // Moved occurrences may land inside the range from a source just outside
    // it, so scan a week of margin on both sides.
    for (let d = addDays(first, -7); daysBetween(d, addDays(last, 7)) >= 0; d = addDays(d, 1)) {
      if (daysBetween(r.start, d) < 0) continue;
      if (r.until && daysBetween(d, r.until) < 0) break;
      if (r.byWeekday.includes(weekday(d))) emit(d, true);
    }
  } else if (tr.date) {
    emit(tr.date, false);
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** Expand many trainings into one sorted list for the range. */
export const expandTrainings = (list: TrainingLike[], from: string, to: string): Occurrence[] =>
  list.flatMap((t) => occurrences(t, from, to)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

/** The exceptions list with `date` cancelled (idempotent). */
export const cancelOccurrence = (tr: TrainingLike, sourceDate: string): Exception[] => {
  const rest = (tr.exceptions ?? []).filter((e) => e.date !== sourceDate);
  return [...rest, { date: sourceDate, cancelled: true }];
};

/** The exceptions list with `date` moved to `date2` / `time`. */
export const moveOccurrence = (tr: TrainingLike, sourceDate: string, date2: string, time?: string): Exception[] => {
  const rest = (tr.exceptions ?? []).filter((e) => e.date !== sourceDate);
  return [...rest, { date: sourceDate, date2, ...(time ? { time } : {}) }];
};

export const WEEKDAY_LABELS: Record<'he' | 'en', string[]> = {
  he: ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
};

/** "כל א׳, ג׳, ה׳ 17:30" */
export const describeRule = (tr: TrainingLike, lang: 'he' | 'en' = 'he'): string => {
  if (!tr.rule) return '';
  const days = [...tr.rule.byWeekday].sort().map((d) => WEEKDAY_LABELS[lang][d]).join(', ');
  return lang === 'he' ? `כל ${days}${tr.time ? ` ${tr.time}` : ''}` : `Every ${days}${tr.time ? ` ${tr.time}` : ''}`;
};
