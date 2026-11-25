// Highlights: the moments of a match video that are cut into one short video.
//
// The owner writes the moments to Golda as times in the video file ("12:30-12:50,
// 44:10-44:40, 71:05"). This file reads them, puts them in order and checks
// them. The same check runs where the moments are stored on the upload job
// and again where the upload page receives them, so the page never cuts
// something the server did not accept.
//
// A time is a position in the VIDEO FILE (what the player's clock shows),
// not the match clock: a recording that starts before kick-off is offset.
//
//   "12:30"        12 minutes 30 seconds
//   "71:05"        71 minutes 5 seconds (minutes may pass 59)
//   "1:12:30"      1 hour 12 minutes 30 seconds
//   "12:30-12:50"  from … to …  (also "–", "—", "to", "עד")
//   "71:05"        a single time: from HIGHLIGHT_LIMITS.before seconds before
//                  it to HIGHLIGHT_LIMITS.after seconds after it

/** One moment, in seconds from the start of the video file. */
export interface HighlightMoment {
  start: number;
  end: number;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

const SECONDS_BEFORE_A_SINGLE_TIME = 6;
const SECONDS_AFTER_A_SINGLE_TIME = 12;
const SHORTEST_MOMENT_SECONDS = 2;
const LONGEST_MOMENT_MINUTES = 3;
const MOST_MOMENTS = 30;
const LONGEST_VIDEO_MINUTES = 15;
const LATEST_TIME_HOURS = 6;

export const HIGHLIGHT_LIMITS = {
  /** A single time keeps this many seconds before it … */
  before: SECONDS_BEFORE_A_SINGLE_TIME,
  /** … and this many after it (what follows matters more than the run-up). */
  after: SECONDS_AFTER_A_SINGLE_TIME,
  /** The shortest moment worth cutting. */
  minLength: SHORTEST_MOMENT_SECONDS,
  /** The longest single moment. Longer than that is not a highlight. */
  maxLength: LONGEST_MOMENT_MINUTES * SECONDS_PER_MINUTE,
  /** How many moments one video may hold. */
  maxMoments: MOST_MOMENTS,
  /** All the moments together. */
  maxTotal: LONGEST_VIDEO_MINUTES * SECONDS_PER_MINUTE,
  /** No time later than this into a file. */
  maxAt: LATEST_TIME_HOURS * SECONDS_PER_HOUR,
} as const;

export type HighlightProblem =
  | { code: 'empty' }
  | { code: 'unreadable'; text: string }
  | { code: 'backwards'; text: string }
  | { code: 'too_short'; text: string; seconds: number }
  | { code: 'too_long'; text: string; seconds: number }
  | { code: 'too_late'; text: string }
  | { code: 'too_many'; count: number }
  | { code: 'total_too_long'; seconds: number }
  | { code: 'out_of_order' };

export type HighlightParse =
  | { ok: true; moments: HighlightMoment[]; total: number; merged: number; reordered: boolean }
  | { ok: false; problem: HighlightProblem };

export type HighlightCheck =
  | { ok: true; moments: HighlightMoment[]; total: number }
  | { ok: false; problem: HighlightProblem };

const MAX_HOURS = 9;
const MAX_MINUTES_ALONE = 599;
const CLOCK_DIGITS = 2;

// One time, alone: minutes:seconds or hours:minutes:seconds.
// Matches "12:30", "71:05", "1:12:30"; rejects "12:3", "12:75", "12.30", "1230".
// https://regex101.com/?regex=%5E(%5Cd%7B1%2C3%7D)%3A(%5B0-5%5D%5Cd)(%3F%3A%3A(%5B0-5%5D%5Cd))%3F%24&testString=71%3A05
const CLOCK = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/;
// Every time written inside a longer text, to check where Golda's times came from.
// Matches "12:30" in "at 12:30 please" and "1:12:30" in "(1:12:30)"; rejects "12:3" and the "2:30" inside "112:305".
// https://regex101.com/?regex=(%3F%3C!%5B%5Cd%3A%5D)(%5Cd%7B1%2C3%7D)%3A(%5B0-5%5D%5Cd)(%3F%3A%3A(%5B0-5%5D%5Cd))%3F(%3F!%5B%5Cd%3A%5D)&testString=at%2012%3A30%20please
const CLOCK_ANYWHERE = /(?<![\d:])(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?![\d:])/g;
// The two ends of a range and what stands between them.
// Matches "12:30-12:50", "12:30 – 12:50", "12:30 to 12:50", "12:30 עד 12:50"; rejects "12:30" and "12:30 12:50".
// https://regex101.com/?regex=%5E(.%2B%3F)%5Cs*(%3F%3A-%7C%E2%80%93%7C%E2%80%94%7C%5Cbto%5Cb%7C%D7%A2%D7%93)%5Cs*(.%2B)%24&testString=12%3A30%20-%2012%3A50
const RANGE = /^(.+?)\s*(?:-|–|—|\bto\b|עד)\s*(.+)$/i;
// What stands between two moments written in one line.
// Matches "," and ";" and a line break in "12:30, 44:10; 71:05"; rejects "-" and ":".
// https://regex101.com/?regex=%5B%2C%3B%5Cn%D8%8C%5D%2B&testString=12%3A30%2C%2044%3A10%3B%2071%3A05
const BETWEEN = /[,;\n،]+/;

const two = (n: number): string => String(n).padStart(CLOCK_DIGITS, '0');

function clockParts(a: string, b: string, c: string | undefined): number | null {
  if (c === undefined) {
    const minutes = Number(a);
    return minutes > MAX_MINUTES_ALONE ? null : minutes * SECONDS_PER_MINUTE + Number(b);
  }
  const hours = Number(a);
  const minutes = Number(b);
  if (hours > MAX_HOURS || minutes >= SECONDS_PER_MINUTE) return null;
  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + Number(c);
}

/** "12:30" → 750, "1:12:30" → 4350. Null when it is not a time. */
export function parseClock(text: unknown): number | null {
  const m = CLOCK.exec(String(text ?? '').trim());
  return m ? clockParts(m[1] as string, m[2] as string, m[3]) : null;
}

/**
 * 750 → "12:30", 4265 → "71:05". Always minutes:seconds, the way the moments
 * are written in football (minutes pass 59). Whole seconds; a fraction is dropped.
 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / SECONDS_PER_MINUTE)}:${two(s % SECONDS_PER_MINUTE)}`;
}

/** "12:30–12:50" */
export const formatMoment = (m: HighlightMoment): string => `${formatClock(m.start)}–${formatClock(m.end)}`;

/** The seconds of every time written in a text ("at 12:30 and 44:10" → [750, 2650]). */
export function clockTimesIn(text: unknown): number[] {
  return [...String(text ?? '').matchAll(CLOCK_ANYWHERE)]
    .map((m) => clockParts(m[1] as string, m[2] as string, m[3]))
    .filter((s): s is number => s !== null);
}

const lengthOf = (m: HighlightMoment): number => m.end - m.start;
export const highlightsTotal = (moments: readonly HighlightMoment[]): number => moments.reduce((sum, m) => sum + lengthOf(m), 0);

const isProblem = (v: HighlightMoment | HighlightProblem): v is HighlightProblem => 'code' in v;

function problemOfOne(m: HighlightMoment, text: string): HighlightProblem | null {
  const seconds = lengthOf(m);
  if (m.end > HIGHLIGHT_LIMITS.maxAt) return { code: 'too_late', text };
  if (seconds < HIGHLIGHT_LIMITS.minLength) return { code: 'too_short', text, seconds };
  if (seconds > HIGHLIGHT_LIMITS.maxLength) return { code: 'too_long', text, seconds };
  return null;
}

/** One written piece → its moment, or what is wrong with it. */
function readOne(raw: string): HighlightMoment | HighlightProblem {
  const text = raw.trim();
  const single = parseClock(text);
  if (single !== null) {
    const m = { start: Math.max(0, single - HIGHLIGHT_LIMITS.before), end: single + HIGHLIGHT_LIMITS.after };
    return problemOfOne(m, text) ?? m;
  }
  const range = RANGE.exec(text);
  const start = range ? parseClock(range[1]) : null;
  const end = range ? parseClock(range[2]) : null;
  if (start === null || end === null) return { code: 'unreadable', text };
  if (end <= start) return { code: 'backwards', text };
  return problemOfOne({ start, end }, text) ?? { start, end };
}

/** In order of time; moments that overlap or touch become one. */
function inOrder(moments: readonly HighlightMoment[]): { moments: HighlightMoment[]; merged: number; reordered: boolean } {
  const sorted = [...moments].sort((a, b) => a.start - b.start || a.end - b.end);
  const joined = sorted.reduce<HighlightMoment[]>((out, m) => {
    const last = out[out.length - 1];
    if (last && m.start <= last.end) return [...out.slice(0, -1), { start: last.start, end: Math.max(last.end, m.end) }];
    return [...out, { start: m.start, end: m.end }];
  }, []);
  return { moments: joined, merged: sorted.length - joined.length, reordered: sorted.some((m, i) => m !== moments[i]) };
}

function problemOfAll(moments: readonly HighlightMoment[]): HighlightProblem | null {
  if (!moments.length) return { code: 'empty' };
  if (moments.length > HIGHLIGHT_LIMITS.maxMoments) return { code: 'too_many', count: moments.length };
  const total = highlightsTotal(moments);
  return total > HIGHLIGHT_LIMITS.maxTotal ? { code: 'total_too_long', seconds: total } : null;
}

/**
 * Reads the moments as the owner wrote them: a list of pieces ("12:30-12:50",
 * "71:05"), or one line holding several. Returns them in order of time, with
 * overlapping moments joined, or the first problem.
 */
export function parseHighlightMoments(input: unknown): HighlightParse {
  const pieces = (Array.isArray(input) ? input : [input])
    .flatMap((p) => String(p ?? '').split(BETWEEN))
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pieces.length) return { ok: false, problem: { code: 'empty' } };
  if (pieces.length > HIGHLIGHT_LIMITS.maxMoments) return { ok: false, problem: { code: 'too_many', count: pieces.length } };
  const read = pieces.map(readOne);
  const firstProblem = read.find(isProblem);
  if (firstProblem) return { ok: false, problem: firstProblem };
  const { moments, merged, reordered } = inOrder(read.filter((r): r is HighlightMoment => !isProblem(r)));
  const problem = problemOfAll(moments);
  if (problem) return { ok: false, problem };
  return { ok: true, moments, total: highlightsTotal(moments), merged, reordered };
}

const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** One stored moment → itself, clean, or what is wrong with it. */
function checkOne(raw: unknown): HighlightMoment | HighlightProblem {
  const start: unknown = (raw as HighlightMoment | null)?.start;
  const end: unknown = (raw as HighlightMoment | null)?.end;
  if (!isSeconds(start) || !isSeconds(end)) return { code: 'unreadable', text: JSON.stringify(raw ?? null) };
  const m = { start, end };
  if (end <= start) return { code: 'backwards', text: formatMoment(m) };
  const problem = problemOfOne(m, formatMoment(m));
  // A joined moment may be longer than one written moment is allowed to be; the total still bounds it.
  return problem && problem.code !== 'too_long' ? problem : m;
}

/**
 * Checks moments that are already numbers (as stored on the upload job): how
 * many, each one's length, their order and the total. Returns the clean list
 * or the problem. Stricter than reading: stored moments must already be in
 * order and apart.
 */
export function checkHighlightMoments(input: unknown): HighlightCheck {
  if (!Array.isArray(input)) return { ok: false, problem: { code: 'empty' } };
  const checked = input.map(checkOne);
  const firstProblem = checked.find(isProblem);
  if (firstProblem) return { ok: false, problem: firstProblem };
  const moments = checked.filter((c): c is HighlightMoment => !isProblem(c));
  const apart = moments.every((m, i) => i === 0 || m.start > (moments[i - 1] as HighlightMoment).end);
  if (!apart) return { ok: false, problem: { code: 'out_of_order' } };
  const problem = problemOfAll(moments);
  if (problem) return { ok: false, problem };
  return { ok: true, moments, total: highlightsTotal(moments) };
}

type ProblemOf<C extends HighlightProblem['code']> = Extract<HighlightProblem, { code: C }>;
const L = HIGHLIGHT_LIMITS;
const PROBLEM_TEXT: { [C in HighlightProblem['code']]: (p: ProblemOf<C>) => string } = {
  empty: () => 'no moments were given: ask for the times in the video file, like 12:30-12:50 or 71:05',
  unreadable: (p) => `"${p.text}" is not a time I can read; a moment is written like 12:30-12:50 (from-to) or 71:05 (a single time), in minutes:seconds of the video file`,
  backwards: (p) => `"${p.text}" ends before it starts`,
  too_short: (p) => `"${p.text}" is only ${p.seconds} seconds; a moment is at least ${L.minLength} seconds`,
  too_long: (p) => `"${p.text}" is ${formatClock(p.seconds)} long; one moment is at most ${formatClock(L.maxLength)}`,
  too_late: (p) => `"${p.text}" is later than ${L.maxAt / SECONDS_PER_HOUR} hours into the video, which no file here reaches`,
  too_many: (p) => `${p.count} moments are too many for one video; the most is ${L.maxMoments}`,
  total_too_long: (p) => `the moments add up to ${formatClock(p.seconds)}; a highlights video is at most ${formatClock(L.maxTotal)}`,
  out_of_order: () => 'the stored moments are not in order',
};

/** The problem as a plain English sentence (Golda reads it and tells the writer in their language). */
export function highlightProblemText(p: HighlightProblem): string {
  return (PROBLEM_TEXT[p.code] as (problem: HighlightProblem) => string)(p);
}
