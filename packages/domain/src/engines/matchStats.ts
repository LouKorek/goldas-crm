// Per-match player data: what a represented player did in one match, as told
// by whoever from the agency watched it (Golda asks the owner the morning
// after, or someone types it on the Matches page).
//
// The data lives on the match document itself, in a map keyed by player id:
//   matches/{id}.playerStats = { [playerId]: PlayerMatchStat }
// Every number is optional; a match he did not play is `minutes: 0`.
//
// These functions are pure (no Firestore, no clock unless one is passed) and
// are shared by the Matches page, the player page, the CV, Golda, the monthly
// report and the public player page.

import { toDateStr } from './dates.js';

/** One player's numbers in one match. */
export interface PlayerMatchStat {
  /** Minutes on the pitch; 0 = he did not play (an unused sub, injured, left out). */
  minutes?: number | null;
  goals?: number | null;
  assists?: number | null;
  /** 1 to 10. */
  rating?: number | null;
  /** One short sentence. */
  note?: string | null;
  /** Free text: who saw the game (a scout's name, "Lou", "the father"). */
  watchedBy?: string | null;
  /** Email or name of the user who recorded it. */
  by?: string | null;
  /** When it was recorded (ISO string or a Firestore timestamp). */
  at?: unknown;
}

/** The parts of a match document these functions read. */
export interface MatchLike {
  id?: string;
  date?: unknown;
  time?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  linkedPlayers?: string[] | null;
  deletedAt?: unknown;
  playerStats?: Record<string, PlayerMatchStat | null | undefined> | null;
  [k: string]: unknown;
}

/** One row of a player's season: the match and his numbers in it. */
export interface PlayerMatchRow {
  matchId: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  /** Season label, e.g. '2026/27'. */
  season: string;
  homeTeam: string;
  awayTeam: string;
  stat: PlayerMatchStat;
}

/** Season totals. `avgRating` is null when no match was rated. */
export interface StatsSummary {
  /** Matches he played in (minutes > 0, or numbers without minutes). */
  apps: number;
  minutes: number;
  goals: number;
  assists: number;
  /** Mean of the rated matches, one decimal; null when none was rated. */
  avgRating: number | null;
  /** How many matches carry a rating. */
  rated: number;
}

/** The month a season starts in (July). */
const SEASON_START_MONTH = 7;
const YEAR_LEN = 4;
const MONTH_FROM = 5;
const MONTH_TO = 7;
const CENTURY = 100;
const SHORT_YEAR_DIGITS = 2;
/** Caps that only catch typing mistakes. */
const MAX_MINUTES = 130;
const MAX_GOALS = 20;
const MAX_ASSISTS = 20;
export const RATING_MIN = 1;
export const RATING_MAX = 10;
/** Ratings are stored to the half point (7.5). */
const RATING_STEPS = 2;
/** The average rating keeps one decimal. */
const ONE_DECIMAL = 10;
export const NOTE_MAX = 160;
const WATCHED_BY_MAX = 80;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** True when the entry holds at least one number or a note. */
export const hasStat = (s: PlayerMatchStat | null | undefined): s is PlayerMatchStat =>
  !!s && (num(s.minutes) !== null || num(s.goals) !== null || num(s.assists) !== null
    || num(s.rating) !== null || !!(s.note && String(s.note).trim()));

/** True when the entry says he played (minutes above 0, or goals/assists/rating without minutes). */
export const playedIn = (s: PlayerMatchStat | null | undefined): boolean => {
  if (!hasStat(s)) return false;
  const m = num(s.minutes);
  if (m !== null) return m > 0;
  return (num(s.goals) ?? 0) > 0 || (num(s.assists) ?? 0) > 0 || num(s.rating) !== null;
};

/**
 * The football season a date falls in. A season runs July to June, so
 * 2026-08-15 and 2027-05-01 are both '2026/27'. Null for an unreadable date.
 */
export function seasonOf(date: unknown): string | null {
  const d = toDateStr(date);
  if (!d) return null;
  const y = Number(d.slice(0, YEAR_LEN));
  const m = Number(d.slice(MONTH_FROM, MONTH_TO));
  const start = m >= SEASON_START_MONTH ? y : y - 1;
  return `${start}/${String((start + 1) % CENTURY).padStart(SHORT_YEAR_DIGITS, '0')}`;
}

/** The season `now` is in, e.g. '2026/27' in November 2026. */
export const currentSeason = (now: Date = new Date()): string => seasonOf(now) as string;

/**
 * A player's matches that carry his numbers, newest first. Matches in the
 * recycle bin and matches without a readable date are left out. A match where
 * the stats name him counts even if he is no longer in `linkedPlayers`.
 */
export function playerMatchRows(matches: readonly MatchLike[] | null | undefined, playerId: string): PlayerMatchRow[] {
  if (!playerId) return [];
  const rows = (matches || []).flatMap((m): PlayerMatchRow[] => {
    if (!m || m.deletedAt) return [];
    const stat = m.playerStats?.[playerId];
    const date = toDateStr(m?.date);
    if (!hasStat(stat) || !date) return [];
    return [{
      matchId: String(m.id ?? ''),
      date,
      season: seasonOf(date) as string,
      homeTeam: String(m.homeTeam ?? ''),
      awayTeam: String(m.awayTeam ?? ''),
      stat,
    }];
  });
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.matchId.localeCompare(b.matchId));
}

/** Seasons present in the rows, newest first. */
export const seasonsOf = (rows: readonly PlayerMatchRow[]): string[] =>
  [...new Set(rows.map((r) => r.season))].sort((a, b) => b.localeCompare(a));

/** Totals over rows (filter them by season first if you want one season). */
export function summarizeStats(rows: readonly PlayerMatchRow[] | null | undefined): StatsSummary {
  const pos = (v: unknown): number => Math.max(0, num(v) ?? 0);
  const t = (rows || []).reduce((acc, { stat: s }) => {
    const rt = num(s.rating);
    return {
      apps: acc.apps + (playedIn(s) ? 1 : 0),
      minutes: acc.minutes + pos(s.minutes),
      goals: acc.goals + pos(s.goals),
      assists: acc.assists + pos(s.assists),
      rated: acc.rated + (rt === null ? 0 : 1),
      ratingSum: acc.ratingSum + (rt ?? 0),
    };
  }, { apps: 0, minutes: 0, goals: 0, assists: 0, rated: 0, ratingSum: 0 });
  return {
    apps: t.apps, minutes: t.minutes, goals: t.goals, assists: t.assists, rated: t.rated,
    avgRating: t.rated ? Math.round((t.ratingSum / t.rated) * ONE_DECIMAL) / ONE_DECIMAL : null,
  };
}

/**
 * Cleans what a person or Golda typed into a stored entry: numbers are whole
 * and non-negative, the rating is 1 to 10 (halves allowed), the note is one
 * short line. Unknown or empty values are dropped, not stored as zero.
 * Returns null when nothing usable is left.
 */
export function cleanStat(input: Partial<Record<keyof PlayerMatchStat, unknown>> | null | undefined): PlayerMatchStat | null {
  if (!input) return null;
  const out: PlayerMatchStat = {};
  const whole = (v: unknown, max: number): number | null => {
    const n = num(v);
    return n === null || n < 0 ? null : Math.min(max, Math.round(n));
  };
  const minutes = whole(input.minutes, MAX_MINUTES);
  if (minutes !== null) out.minutes = minutes;
  const goals = whole(input.goals, MAX_GOALS);
  if (goals !== null) out.goals = goals;
  const assists = whole(input.assists, MAX_ASSISTS);
  if (assists !== null) out.assists = assists;
  const r = num(input.rating);
  if (r !== null && r >= RATING_MIN && r <= RATING_MAX) out.rating = Math.round(r * RATING_STEPS) / RATING_STEPS;
  // Any run of whitespace, newlines included ("a \n  b" becomes "a b"; "ab" is left alone).
  const note = input.note == null ? '' : String(input.note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (note) out.note = note;
  if (!hasStat(out)) return null;
  const watchedBy = input.watchedBy == null ? '' : String(input.watchedBy).trim().slice(0, WATCHED_BY_MAX);
  if (watchedBy) out.watchedBy = watchedBy;
  return out;
}
