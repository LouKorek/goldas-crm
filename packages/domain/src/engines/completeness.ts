// 07 · Completeness. What a represented player's file should hold, in one
// list read by the player page, the players list, Golda's "what is missing"
// tool and her daily question. Onboarding (a player added in the last 30
// days) and completeness (everyone else) are the same list; only the title
// differs.
//
// Each item says whether it applies to the player (`when`) and whether it is
// done (`has`). `has` returns null when the state cannot be known (the website
// card before the daily check stamped the player, the calendar without the
// match sync's report): such an item is neither done nor missing and is left
// out of the score rather than guessed.
//
// The record fields (group 'record') are the ones Golda's daily question asks
// about, in this order of importance; the daily question reads them from here.
// Weights are relative: the score is the done weight over the applicable weight.

/** A player record as stored: any fields, read through the helpers below. */
export type PlayerRecord = { [field: string]: unknown };

export interface SyncWarning { playerId?: string; reason?: string }

export interface CompletenessContext {
  /** "Now", for the 30-day onboarding window. Defaults to the current time. */
  now?: Date | string | number;
  /**
   * The last match sync's report (app_meta/syncWarnings: { list, runAt }).
   * Without it the calendar item cannot be known.
   */
  syncReport?: { list?: SyncWarning[]; runAt?: unknown } | null;
}

/** How the missing item is fixed in the app: the player's edit form, or a request to Golda. */
export type CompletenessFix = 'edit' | 'golda';

export interface CompletenessItem {
  key: string;
  group: 'onboarding' | 'record';
  /** The player field a record item is about (the daily question's field). */
  field?: string;
  label: { en: string; he: string };
  weight: number;
  fix: CompletenessFix;
  /** Whether the item applies to this player at all. Missing = always. */
  when?: (p: PlayerRecord, ctx?: CompletenessContext) => boolean;
  /** true = done, false = missing, null = cannot be known. */
  has: (p: PlayerRecord, ctx?: CompletenessContext) => boolean | null;
}

export interface Completeness {
  /** 0-100, the share of the applicable, knowable weight that is done. */
  score: number;
  done: CompletenessItem[];
  /** Most important first. */
  missing: CompletenessItem[];
  /** Applies, but its state cannot be known now; not in the score. */
  unknown: CompletenessItem[];
  /** Added in the last ONBOARDING_DAYS days. */
  onboarding: boolean;
}

export const ONBOARDING_DAYS = 30;
const DAY_MS = 86_400_000;
const SECOND_MS = 1000;
const NANOS_PER_MS = 1_000_000;
const FULL_SCORE = 100;

// Relative weights. The record weights are the daily question's order of importance.
export const COMPLETENESS_WEIGHTS = {
  reprAgreement: 100, passport: 70, photo: 50, video: 50, ifa: 40, transfermarkt: 30, siteCard: 30, calendar: 40,
  contractEnd: 100, contractStatus: 95, reprEnd: 90, passportExpiry: 70, dob: 60, primaryPosition: 50, currentClub: 45, foot: 20, nationalities: 15,
} as const;
const W = COMPLETENESS_WEIGHTS;

const blank = (v: unknown) => (Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim());
const filled = (v: unknown) => !blank(v);
const text = (v: unknown) => String(v ?? '').trim();
const HAS_CONTRACT = ['Under Contract', 'Loan'];
const isObject = (v: unknown): v is { [k: string]: unknown } => typeof v === 'object' && v !== null;

/** A Firestore Timestamp (either SDK), a Date, an ISO string or epoch ms → ms, or null. */
export function toMillis(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (!isObject(v)) return null;
  if (typeof v.toMillis === 'function') return Number(v.toMillis());
  if (typeof v.toDate === 'function') return (v.toDate() as Date).getTime();
  const s = v.seconds ?? v._seconds;
  const ns = Number(v.nanoseconds ?? v._nanoseconds ?? 0);
  return typeof s === 'number' ? s * SECOND_MS + Math.floor(ns / NANOS_PER_MS) : null;
}

/** Plays in Israel, so his games come from the IFA (the same rule as the match sync). */
export const playsInIsrael = (p: PlayerRecord) => text(p.leagueCountry).toLowerCase() === 'israel';

// Reasons in the match sync's report that mean his games cannot reach the
// calendar until something in his file changes. Anything else there is
// temporary (a page that did not load, the run's time or credits), and the
// sync tries again by itself.
export const CALENDAR_BLOCKING_REASONS = [
  'no-club', 'no-source', 'ifa-url-missing', 'ifa-url-invalid', 'ifa-url-has-no-id',
  'ifa-club-not-found', 'ifa-team-not-matched', 'no-fixtures-or-team-not-found',
];

/** The blocking sync warning for this player, if any (for the "why" next to the calendar item). */
export function calendarBlock(p: PlayerRecord, ctx?: CompletenessContext): string | null {
  const w = (ctx?.syncReport?.list || []).find((x) => x && x.playerId === p.id && CALENDAR_BLOCKING_REASONS.includes(String(x.reason)));
  return w ? String(w.reason) : null;
}

function siteCardOn(p: PlayerRecord): boolean | null {
  const card = p.siteCard;
  return isObject(card) && typeof card.on === 'boolean' ? card.on : null;
}

function calendarReached(p: PlayerRecord, ctx?: CompletenessContext): boolean | null {
  if (!ctx?.syncReport) return null;
  const ran = toMillis(ctx.syncReport.runAt);
  const added = toMillis(p.createdAt);
  if (ran !== null && added !== null && added > ran) return null;   // added after the sync last ran
  return calendarBlock(p, ctx) === null;
}

const notFree = (p: PlayerRecord) => p.contractStatus !== 'Free';
const record = (field: keyof typeof W & string, he: string, en: string, when?: (p: PlayerRecord) => boolean): CompletenessItem => ({
  key: field, group: 'record', field, weight: W[field], fix: 'edit', label: { en, he }, has: (p) => filled(p[field]), ...(when ? { when } : {}),
});

export const COMPLETENESS_ITEMS: CompletenessItem[] = [
  // ── What the owner listed for a new player ──
  { key: 'reprAgreement', group: 'onboarding', weight: W.reprAgreement, fix: 'edit', label: { en: 'Representation agreement', he: 'הסכם ייצוג' },
    has: (p) => filled(p.reprFiles) && filled(p.reprEnd) },
  { key: 'passport', group: 'onboarding', weight: W.passport, fix: 'edit', label: { en: 'Passport', he: 'דרכון' },
    has: (p) => filled(p.passportFiles) && filled(p.passportExpiry) },
  { key: 'photo', group: 'onboarding', weight: W.photo, fix: 'edit', label: { en: 'Photo', he: 'תמונה' },
    has: (p) => filled(p.photoFiles) },
  { key: 'video', group: 'onboarding', weight: W.video, fix: 'edit', label: { en: 'Video', he: 'וידאו' },
    has: (p) => filled(p.videoLink) },
  { key: 'ifa', group: 'onboarding', weight: W.ifa, fix: 'edit', label: { en: 'IFA link', he: 'קישור להתאחדות' },
    when: (p) => notFree(p) && playsInIsrael(p), has: (p) => filled(p.ifaTeamUrl) },
  // The app keeps one profile link per player; its form asks for Transfermarkt there.
  { key: 'transfermarkt', group: 'onboarding', weight: W.transfermarkt, fix: 'edit', label: { en: 'Transfermarkt', he: 'טרנספרמרקט' },
    has: (p) => filled(p.profileLink) },
  // Stamped on the player once a day by the hourly site follow (lib/golda-site-follow.js).
  { key: 'siteCard', group: 'onboarding', weight: W.siteCard, fix: 'golda', label: { en: 'Website card', he: 'כרטיס באתר' },
    has: siteCardOn },
  // His games reach the calendar: the match sync has a source for him and is
  // not stuck on something in his file.
  { key: 'calendar', group: 'onboarding', weight: W.calendar, fix: 'edit', label: { en: 'Games in the calendar', he: 'משחקים ביומן' },
    when: notFree, has: calendarReached },

  // ── The record fields Golda's daily question asks about, most important first ──
  record('contractEnd', 'תאריך סיום חוזה', 'Contract end date', (p) => HAS_CONTRACT.includes(text(p.contractStatus))),
  record('contractStatus', 'מצב חוזה', 'Contract status'),
  record('reprEnd', 'תאריך סיום ייצוג', 'Representation end date'),
  record('passportExpiry', 'תוקף דרכון', 'Passport expiry'),
  record('dob', 'תאריך לידה', 'Date of birth'),
  record('primaryPosition', 'עמדה', 'Position'),
  record('currentClub', 'מועדון', 'Club', notFree),
  record('foot', 'רגל חזקה', 'Strong foot'),
  record('nationalities', 'אזרחות', 'Nationality'),
];

export interface RecordGap { field: string; weight: number; when?: (p: PlayerRecord) => boolean }

/** The record items, for Golda's daily question: { field, weight, when }. */
export const RECORD_GAPS: RecordGap[] = COMPLETENESS_ITEMS.filter((i) => i.group === 'record')
  .map((i) => ({ field: String(i.field), weight: i.weight, ...(i.when ? { when: i.when } : {}) }));

/** Only represented players are scored; prospects are not. */
export const isScored = (p: PlayerRecord | null | undefined): p is PlayerRecord => !!p && !p.deletedAt && (text(p.stage) || 'represented') === 'represented';

/** Added in the last 30 days (by createdAt). */
export function isOnboarding(p: PlayerRecord, ctx: CompletenessContext = {}): boolean {
  const added = toMillis(p.createdAt);
  if (added === null) return false;
  const now = toMillis(ctx.now ?? Date.now()) ?? Date.now();
  return now - added < ONBOARDING_DAYS * DAY_MS;
}

const STATE: Record<'true' | 'false' | 'null', 'done' | 'missing' | 'unknown'> = { true: 'done', false: 'missing', null: 'unknown' };
const weightOf = (xs: CompletenessItem[]) => xs.reduce((n, i) => n + i.weight, 0);

/**
 * The player's checklist: score 0-100, what is done, what is missing (most
 * important first) and what cannot be known. null for a player who is not
 * represented.
 */
export function playerCompleteness(p: PlayerRecord | null | undefined, ctx: CompletenessContext = {}): Completeness | null {
  if (!isScored(p)) return null;
  const applicable = COMPLETENESS_ITEMS.filter((item) => !item.when || item.when(p, ctx));
  const states = applicable.map((item) => ({ item, state: STATE[String(item.has(p, ctx)) as 'true' | 'false' | 'null'] }));
  const of = (s: string) => states.filter((x) => x.state === s).map((x) => x.item);
  const done = of('done');
  const missing = of('missing').sort((a, b) => b.weight - a.weight);
  const total = weightOf(done) + weightOf(missing);
  const score = total ? Math.round((FULL_SCORE * weightOf(done)) / total) : FULL_SCORE;
  return { score, done, missing, unknown: of('unknown'), onboarding: isOnboarding(p, ctx) };
}
