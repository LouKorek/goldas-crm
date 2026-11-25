// The monthly report for a represented player and his family: one page with
// his matches of a calendar month, what the agency did and the next step.
// Lou approves the text and sends the PDF himself.
//
// The text lives on the player record:
//   players/{id}.monthlyReports = { 'YYYY-MM': MonthlyReportEntry }
// and the numbers come from the matches (matches/{id}.playerStats, see
// matchStats.ts). Ratings, notes and who watched are the agency's own and
// never reach the report: the rows here do not carry them.
//
// Pure functions (no Firestore, no clock unless one is passed), shared by the
// player page, the PDF builder and Golda, so they cannot disagree.

import { israelDate, toDateStr } from './dates.js';
import { playerMatchRows, summarizeStats, seasonOf, playedIn, type MatchLike } from './matchStats.js';

/** What is stored per month on the player. */
export interface MonthlyReportEntry {
  /** "What we did this month": 2 to 5 short lines. */
  did: string[];
  /** "The next step": one or two sentences. */
  next: string;
  status: 'draft' | 'approved';
  /** Email of whoever saved or approved it last. */
  by?: string;
  /** ISO time of that. */
  at?: string;
  [k: string]: unknown;
}

/** One match of the month as the report prints it: no rating, no note, no watcher. */
export interface ReportMatchLine {
  matchId: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  /** "Home – Away", or the match's own title. */
  title: string;
  /** The competition when the match names one, else ''. */
  competition: string;
  minutes: number;
  goals: number;
  assists: number;
  /** False when he was in the squad but did not get on the pitch. */
  played: boolean;
}

/** The month's numbers (no rating: that is the agency's judgement). */
export interface ReportTotals {
  apps: number;
  minutes: number;
  goals: number;
  assists: number;
}

/** Everything the report prints except the two written parts. */
export interface MonthlyReportFacts {
  month: string;
  matches: ReportMatchLine[];
  monthTotals: ReportTotals;
  /** The season the month belongs to, up to the end of that month. */
  season: ReportTotals & { label: string };
}

/** At most this many lines of "what we did". */
export const REPORT_DID_MAX_LINES = 5;
/** Each of them at most this long. */
export const REPORT_DID_LINE_MAX = 140;
/** "The next step" at most this long. */
export const REPORT_NEXT_MAX = 300;
/** How far back the month picker goes. */
export const REPORT_MONTHS_BACK = 12;

// A month key: four digits, a dash, two digits ("2026-10" matches; "2026-1" and "2026-10-01" do not).
const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const MONTHS_A_YEAR = 12;
const YEAR_LEN = 4;
const MONTH_KEY_LEN = 7;
const MONTH_FROM = 5;
const TWO = 2;

const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  he: ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'],
} as const;

/** True for 'YYYY-MM' with a real month. */
export const isMonthKey = (s: unknown): s is string => {
  const m = MONTH_KEY.exec(String(s ?? ''));
  return !!m && Number(m[TWO]) >= 1 && Number(m[TWO]) <= MONTHS_A_YEAR;
};

/** The month a date falls in, 'YYYY-MM', or null. */
export const monthOf = (date: unknown): string | null => {
  const d = toDateStr(date);
  return d ? d.slice(0, MONTH_KEY_LEN) : null;
};

/** 'YYYY-MM' plus `n` months (n may be negative). */
export const addMonths = (month: string, n: number): string => {
  const y = Number(month.slice(0, YEAR_LEN));
  const m = Number(month.slice(MONTH_FROM, MONTH_KEY_LEN)) - 1 + n;
  const yy = y + Math.floor(m / MONTHS_A_YEAR);
  const mm = ((m % MONTHS_A_YEAR) + MONTHS_A_YEAR) % MONTHS_A_YEAR;
  return `${yy}-${String(mm + 1).padStart(TWO, '0')}`;
};

/** The last full calendar month in Israel: in November 2026, '2026-10'. */
export const lastFullMonth = (now: Date = new Date()): string => addMonths(israelDate(now).slice(0, MONTH_KEY_LEN), -1);

/** The months a report can be made for, newest first: the last full month and the ones before it. */
export const reportMonths = (now: Date = new Date(), n: number = REPORT_MONTHS_BACK): string[] => {
  const last = lastFullMonth(now);
  return Array.from({ length: Math.max(0, n) }, (_, i) => addMonths(last, -i));
};

/** "October 2026" / "אוקטובר 2026". */
export const monthName = (month: string, lang: 'he' | 'en' | string = 'he'): string => {
  if (!isMonthKey(month)) return String(month ?? '');
  const names = lang === 'en' ? MONTHS.en : MONTHS.he;
  return `${names[Number(month.slice(MONTH_FROM, MONTH_KEY_LEN)) - 1]} ${month.slice(0, YEAR_LEN)}`;
};

const totals = (rows: ReturnType<typeof playerMatchRows>): ReportTotals => {
  const s = summarizeStats(rows);
  return { apps: s.apps, minutes: Math.round(s.minutes), goals: Math.round(s.goals), assists: Math.round(s.assists) };
};

const whole = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The facts of one month for one player: his matches of that month (oldest
 * first, without rating, note or watcher), the month's totals and the
 * season so far up to the end of that month.
 */
export function monthlyReportFacts(matches: readonly MatchLike[] | null | undefined, playerId: string, month: string): MonthlyReportFacts {
  const all = playerMatchRows(matches, playerId);
  const byId = new Map((matches || []).filter(Boolean).map((m) => [String(m.id ?? ''), m]));
  const inMonth = all.filter((r) => r.date.slice(0, MONTH_KEY_LEN) === month);
  const label = seasonOf(`${month}-01`) || '';
  const end = `${month}-31`;
  const season = all.filter((r) => r.season === label && r.date <= end);
  const lines = [...inMonth].reverse().map((r): ReportMatchLine => {
    const m: MatchLike = byId.get(r.matchId) || {};
    const title = r.homeTeam || r.awayTeam ? `${r.homeTeam} – ${r.awayTeam}` : text(m.title);
    return {
      matchId: r.matchId,
      date: r.date,
      title,
      competition: text(m.competition) || text(m.league) || text(m.competitionName),
      minutes: whole(r.stat.minutes),
      goals: whole(r.stat.goals),
      assists: whole(r.stat.assists),
      played: playedIn(r.stat),
    };
  });
  return { month, matches: lines, monthTotals: totals(inMonth), season: { label, ...totals(season) } };
}

// Any run of whitespace, new lines included ("a \n  b" becomes "a b"; "ab" is left alone).
const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * Cleans the two written parts: "what we did" as at most 5 lines of at most
 * 140 characters (a string is split on new lines; bullets are dropped), "the
 * next step" as one paragraph of at most 300.
 */
export function cleanReportText(input: { did?: unknown; next?: unknown } | null | undefined): { did: string[]; next: string } {
  const raw = input?.did;
  // One line per row: splits on a new line with or without a carriage return ("a\r\nb" and "a\nb" give two; "a b" gives one).
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/);
  const did = list
    // A leading bullet or number and the space after it ("• met the coach" and "2) met the coach" lose it; "2026 season" keeps its digits).
    .map((l) => oneLine(l).replace(/^([•\-*–·]|\d+[.)])\s*/, ''))
    .filter(Boolean)
    .slice(0, REPORT_DID_MAX_LINES)
    .map((l) => cut(l, REPORT_DID_LINE_MAX));
  return { did, next: cut(oneLine(input?.next), REPORT_NEXT_MAX) };
}

/** The saved entry of a month on a player, or null. */
export const reportOf = (player: { monthlyReports?: unknown } | null | undefined, month: string): MonthlyReportEntry | null => {
  const all = player?.monthlyReports;
  if (!all || typeof all !== 'object') return null;
  const e = (all as Record<string, unknown>)[month];
  return e && typeof e === 'object' ? (e as MonthlyReportEntry) : null;
};
