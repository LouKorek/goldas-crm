// 06 · Analytics. One pure engine behind the Snapshot dashboard: it turns the
// CRM's records into groups a chart can draw, applies the drill-down path
// and the filter bar, and lists the records of the current slice. Nothing
// here touches React or Firestore, so the same engine answers Golda and the
// Excel/PDF report. Every dimension and measure is declared once, with its
// Hebrew and English labels, and the drill state serialises to a URL string.
import { toDateStr, israelDate, daysBetween, daysAway } from './dates.js';
import { STAGES, STAGE_LABELS, CATEGORIES, CATEGORY_LABELS, DEAL_STAGES, DEAL_STAGE_LABELS, playerName, categoryFromPlayer } from '../stages.js';
import { AGE_GROUPS, resolveAgeGroup, seasonStartYear } from '../ageGroups.js';
import { POSITIONS, LEAGUE_TIERS, CONTRACT_STATUS } from '../constants.js';
import { daysInStage, type DealLike } from './deals.js';

export type Row = Record<string, unknown>;
export type Source = 'players' | 'deals' | 'matches' | 'requirements' | 'tasks' | 'trainings' | 'interactions';
export const SOURCES: Source[] = ['players', 'deals', 'matches', 'requirements', 'tasks', 'trainings', 'interactions'];
export const SOURCE_LABELS: Record<Source, { he: string; en: string }> = {
  players: { he: 'שחקנים', en: 'Players' },
  deals: { he: 'עסקאות', en: 'Deals' },
  matches: { he: 'משחקים', en: 'Matches' },
  requirements: { he: 'דרישות מועדונים', en: 'Club requirements' },
  tasks: { he: 'משימות', en: 'Tasks' },
  trainings: { he: 'אימונים', en: 'Trainings' },
  interactions: { he: 'פעילות', en: 'Activity' },
};

export interface Label { he: string; en: string }
const L = (he: string, en: string = he): Label => ({ he, en });
const str = (v: unknown): string => (v == null ? '' : String(v).trim());

export interface AnalyticsInput {
  players?: Row[]; deals?: Row[]; matches?: Row[]; requirements?: Row[];
  tasks?: Row[]; trainings?: Row[]; interactions?: Row[];
  now?: Date;
}

/** Everything a dimension may need beyond the row itself. */
export interface Ctx {
  now: Date;
  today: string;
  playersById: Map<string, Row>;
  /** Lower-cased club name -> the represented players there (for matches). */
  playersByClub: Map<string, Row[]>;
}

export interface Dimension {
  id: string;
  label: Label;
  sources: Source[];
  /** One key, several keys (multi-valued rows count once per key) or null (not applicable). */
  keyOf: (row: Row, source: Source, ctx: Ctx) => string | string[] | null;
  labelOf?: (key: string, ctx: Ctx) => Label;
  /** Enum-like dimensions have a natural order; the rest sort by count. */
  order?: (a: string, b: string) => number;
  /** Set when the dimension is a date bucket, so the chart knows to draw a timeline. */
  temporal?: boolean;
}

export interface Measure {
  id: string;
  label: Label;
  sources: Source[];
  agg: 'count' | 'sum' | 'avg';
  pick?: (row: Row, ctx: Ctx) => number | null;
  format: 'int' | 'money' | 'years' | 'days' | 'percent';
}

export interface Filter { dim: string; value: string }
export type PeriodKind = 'all' | 'season' | 'quarter' | 'month' | 'next90' | 'last12m' | 'custom';
export interface Period { kind: PeriodKind; from?: string; to?: string }

export interface Group {
  key: string;
  label: Label;
  count: number;
  value: number;
  share: number;
  rows: Row[];
}

export interface SliceResult {
  source: Source;
  dim: Dimension;
  measure: Measure;
  groups: Group[];
  total: number;
  totalCount: number;
}

// ── helpers ────────────────────────────────────────────────────────
const enumOrder = (list: readonly string[]) => (a: string, b: string) => {
  const ia = list.indexOf(a), ib = list.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
};
const chrono = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const monthKey = (v: unknown): string | null => { const d = toDateStr(v); return d ? d.slice(0, 7) : null; };
const quarterKey = (v: unknown): string | null => {
  const d = toDateStr(v);
  if (!d) return null;
  const [y, m] = d.split('-').map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
};
const monthLabel = (k: string): Label => { const [y, m] = k.split('-'); return L(`${m}/${y}`); };
const quarterLabel = (k: string): Label => { const [y, q] = k.split('-Q'); return L(`רבעון ${q} ${y}`, `Q${q} ${y}`); };
const WEEKDAYS: Label[] = [L('ראשון', 'Sun'), L('שני', 'Mon'), L('שלישי', 'Tue'), L('רביעי', 'Wed'), L('חמישי', 'Thu'), L('שישי', 'Fri'), L('שבת', 'Sat')];
const weekdayKey = (v: unknown): string | null => {
  const d = toDateStr(v);
  if (!d) return null;
  const [y, m, dd] = d.split('-').map(Number);
  return String(new Date(Date.UTC(y, m - 1, dd)).getUTCDay());
};
/** "19:00" / "19:30" / "7:05" -> "19" / "07"; anything else -> null. */
const hourKey = (v: unknown): string | null => {
  const m = /^\s*(\d{1,2})[:.]?(\d{2})?/.exec(str(v));
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h < 24 ? String(h).padStart(2, '0') : null;
};
/** "50,000 €" / "₪120000" / "1.2M" -> number; empty -> null. */
export const parseMoney = (v: unknown): number | null => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = str(v).toLowerCase().replace(/,/g, '');
  if (!s) return null;
  const m = /(-?\d+(?:\.\d+)?)\s*(k|m)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'k' ? n * 1000 : m[2] === 'm' ? n * 1e6 : n;
};
const ageOf = (dob: unknown, today: string): number | null => {
  const d = toDateStr(dob);
  if (!d) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let a = ty - y;
  if (tm < m || (tm === m && td < dd)) a -= 1;
  return a >= 0 && a < 80 ? a : null;
};
const stageOf = (p: Row): string => str(p.stage) || 'represented';
const categoryOf = (p: Row): string => categoryFromPlayer(p as { gender?: unknown; currentClubIsYouth?: unknown; category?: unknown });
const nameOf = (p: Row | undefined): string => (p ? playerName(p as { name?: unknown }) : '');
const linkedIds = (m: Row): string[] => (Array.isArray(m.linkedPlayers) ? m.linkedPlayers.map(str).filter(Boolean) : []);
const uniq = (xs: string[]) => Array.from(new Set(xs));

const yesNo = (k: string): Label => (k === 'yes' ? L('כן', 'Yes') : L('לא', 'No'));
const ageGroupLabel = (k: string): Label => {
  const g = AGE_GROUPS.find((x) => x.id === k);
  return g ? L(g.he, g.en) : L('בוגרים', 'Seniors');
};

// Players linked to a match: by id, else by the represented players whose
// current club is one of the two teams (older imports carry no ids).
const matchPlayers = (m: Row, ctx: Ctx): Row[] => {
  const byId = linkedIds(m).map((id) => ctx.playersById.get(id)).filter((p): p is Row => !!p);
  if (byId.length) return byId;
  const home = ctx.playersByClub.get(str(m.homeTeam).toLowerCase()) ?? [];
  const away = ctx.playersByClub.get(str(m.awayTeam).toLowerCase()) ?? [];
  return [...home, ...away];
};

// ── dimensions ─────────────────────────────────────────────────────
export const DIMENSIONS: Dimension[] = [
  { id: 'stage', label: L('שלב', 'Stage'), sources: ['players'], keyOf: (p) => stageOf(p),
    labelOf: (k) => (STAGE_LABELS as Record<string, Label>)[k] ?? L(k), order: enumOrder(STAGES) },
  { id: 'category', label: L('קטגוריה', 'Category'), sources: ['players', 'deals', 'matches', 'trainings'],
    keyOf: (r, s, ctx) => {
      if (s === 'players') return categoryOf(r);
      if (s === 'deals') return str(r.category) || null;
      if (s === 'matches') return uniq(matchPlayers(r, ctx).map(categoryOf));
      const p = ctx.playersById.get(str(r.playerId)); return p ? categoryOf(p) : null;
    },
    labelOf: (k) => (CATEGORY_LABELS as Record<string, Label>)[k] ?? L(k), order: enumOrder(CATEGORIES) },
  { id: 'ageGroup', label: L('קבוצת גיל', 'Age group'), sources: ['players', 'matches', 'trainings'],
    keyOf: (r, s, ctx) => {
      const of = (p: Row) => resolveAgeGroup(p as Parameters<typeof resolveAgeGroup>[0], ctx.now)?.id ?? 'senior';
      if (s === 'players') return of(r);
      if (s === 'matches') return uniq(matchPlayers(r, ctx).map(of));
      const p = ctx.playersById.get(str(r.playerId)); return p ? of(p) : null;
    },
    labelOf: ageGroupLabel, order: enumOrder([...AGE_GROUPS.map((g) => g.id), 'senior']) },
  { id: 'position', label: L('עמדה', 'Position'), sources: ['players', 'requirements'],
    keyOf: (r, s) => str(s === 'players' ? r.primaryPosition : r.requiredPosition) || null, order: enumOrder(POSITIONS) },
  { id: 'foot', label: L('רגל', 'Foot'), sources: ['players'], keyOf: (p) => str(p.foot) || null,
    labelOf: (k) => ({ Right: L('ימין', 'Right'), Left: L('שמאל', 'Left'), Both: L('שתיהן', 'Both') } as Record<string, Label>)[k] ?? L(k) },
  { id: 'club', label: L('מועדון', 'Club'), sources: ['players', 'deals', 'matches', 'requirements'],
    keyOf: (r, s) => {
      if (s === 'matches') return uniq([str(r.homeTeam), str(r.awayTeam)].filter(Boolean));
      return str(s === 'players' ? r.currentClub : r.clubName) || null;
    } },
  { id: 'country', label: L('מדינה', 'Country'), sources: ['players', 'requirements'],
    keyOf: (r, s) => str(s === 'players' ? r.leagueCountry : r.country) || null },
  { id: 'leagueTier', label: L('דרג ליגה', 'League tier'), sources: ['players', 'requirements'],
    keyOf: (r) => str(r.leagueTier) || null, order: enumOrder(LEAGUE_TIERS) },
  { id: 'nationality', label: L('אזרחות', 'Nationality'), sources: ['players'],
    keyOf: (p) => (Array.isArray(p.nationalities) ? uniq(p.nationalities.map(str).filter(Boolean)) : null) },
  { id: 'contractStatus', label: L('סטטוס חוזה', 'Contract status'), sources: ['players'],
    keyOf: (p) => str(p.contractStatus) || null,
    labelOf: (k) => ({ 'Under Contract': L('בחוזה', 'Under contract'), Free: L('חופשי', 'Free'), Loan: L('בהשאלה', 'On loan') } as Record<string, Label>)[k] ?? L(k),
    order: enumOrder(CONTRACT_STATUS) },
  { id: 'contractEndQ', label: L('סיום חוזה', 'Contract end'), sources: ['players'], temporal: true,
    keyOf: (p) => quarterKey(p.contractEnd), labelOf: quarterLabel, order: chrono },
  { id: 'reprEndQ', label: L('סיום ייצוג', 'Representation end'), sources: ['players'], temporal: true,
    keyOf: (p) => quarterKey(p.reprEnd), labelOf: quarterLabel, order: chrono },
  { id: 'passportQ', label: L('תוקף דרכון', 'Passport expiry'), sources: ['players'], temporal: true,
    keyOf: (p) => quarterKey(p.passportExpiry), labelOf: quarterLabel, order: chrono },
  { id: 'natTeam', label: L('נבחרת', 'National team'), sources: ['players'], keyOf: (p) => str(p.natTeamStatus) || null },
  { id: 'source', label: L('מקור הרשומה', 'Record source'), sources: ['players', 'matches', 'deals'],
    keyOf: (r) => str(r.source) || 'manual',
    labelOf: (k) => ({ manual: L('ידני', 'Manual'), ifa: L('ההתאחדות', 'IFA'), tm_watch: L('TM Watch'), migration: L('הסבה', 'Migration'), golda: L('גולדה', 'Golda') } as Record<string, Label>)[k] ?? L(k) },
  { id: 'addedMonth', label: L('חודש הוספה', 'Month added'), sources: ['players', 'deals', 'requirements', 'interactions', 'tasks'], temporal: true,
    keyOf: (r, s) => monthKey(s === 'interactions' ? r.at : r.createdAt), labelOf: monthLabel, order: chrono },
  { id: 'agent', label: L('סוכן', 'Agent'), sources: ['players'], keyOf: (p) => str(p.agentName) || null },
  { id: 'player', label: L('שחקן', 'Player'), sources: ['players', 'deals', 'matches', 'trainings'],
    keyOf: (r, s) => (s === 'players' ? str(r.id) : s === 'matches' ? linkedIds(r) : str(r.playerId) || null),
    labelOf: (k, ctx) => L(nameOf(ctx.playersById.get(k)) || k) },
  { id: 'dealStage', label: L('שלב עסקה', 'Deal stage'), sources: ['deals'], keyOf: (d) => str(d.stage) || null,
    labelOf: (k) => L((DEAL_STAGE_LABELS as Record<string, string>)[k] ?? k, k), order: enumOrder(DEAL_STAGES) },
  { id: 'owner', label: L('אחראי', 'Owner'), sources: ['deals', 'tasks', 'trainings', 'interactions'],
    keyOf: (r, s) => str(s === 'interactions' ? r.by : r.owner) || null },
  { id: 'closedMonth', label: L('חודש סגירה', 'Month closed'), sources: ['deals'], temporal: true,
    keyOf: (d) => (d.closedAt ? monthKey(d.closedAt) : null), labelOf: monthLabel, order: chrono },
  { id: 'stageAge', label: L('זמן בשלב', 'Time in stage'), sources: ['deals'],
    keyOf: (d, _s, ctx) => {
      const n = daysInStage(d as unknown as DealLike, ctx.now);
      return n == null ? null : n <= 7 ? 'w1' : n <= 14 ? 'w2' : n <= 30 ? 'm1' : 'm1+';
    },
    labelOf: (k) => ({ w1: L('עד שבוע', '≤ 1 week'), w2: L('1–2 שבועות', '1–2 weeks'), m1: L('2–4 שבועות', '2–4 weeks'), 'm1+': L('מעל חודש', '> 1 month') } as Record<string, Label>)[k] ?? L(k),
    order: enumOrder(['w1', 'w2', 'm1', 'm1+']) },
  { id: 'month', label: L('חודש', 'Month'), sources: ['matches', 'trainings', 'tasks', 'interactions'], temporal: true,
    keyOf: (r, s) => monthKey(s === 'tasks' ? r.dueDate : s === 'interactions' ? r.at : r.date), labelOf: monthLabel, order: chrono },
  { id: 'weekday', label: L('יום בשבוע', 'Weekday'), sources: ['matches', 'trainings', 'tasks', 'interactions'],
    keyOf: (r, s) => weekdayKey(s === 'tasks' ? r.dueDate : s === 'interactions' ? r.at : r.date),
    labelOf: (k) => WEEKDAYS[Number(k)] ?? L(k), order: enumOrder(['0', '1', '2', '3', '4', '5', '6']) },
  { id: 'hour', label: L('שעה', 'Hour'), sources: ['matches', 'trainings'],
    keyOf: (r) => hourKey(r.time), labelOf: (k) => L(`${k}:00`), order: chrono },
  { id: 'homeAway', label: L('בית / חוץ', 'Home / away'), sources: ['matches'],
    keyOf: (m, _s, ctx) => {
      const ours = matchPlayers(m, ctx).map((p) => str(p.currentClub).toLowerCase()).filter(Boolean);
      if (!ours.length) return null;
      const home = str(m.homeTeam).toLowerCase();
      return uniq(ours.map((c) => (home.includes(c) || c.includes(home) ? 'home' : 'away')));
    },
    labelOf: (k) => (k === 'home' ? L('בית', 'Home') : L('חוץ', 'Away')), order: enumOrder(['home', 'away']) },
  { id: 'when', label: L('עבר / עתיד', 'Past / upcoming'), sources: ['matches', 'tasks'],
    keyOf: (r, s, ctx) => { const d = daysAway(s === 'tasks' ? r.dueDate : r.date, ctx.now); return d == null ? null : d < 0 ? 'past' : 'upcoming'; },
    labelOf: (k) => (k === 'past' ? L('שוחק', 'Played') : L('קרוב', 'Upcoming')), order: enumOrder(['upcoming', 'past']) },
  { id: 'reqStatus', label: L('סטטוס', 'Status'), sources: ['requirements'],
    keyOf: (r) => (str(r.status) || 'open'),
    labelOf: (k) => ({ open: L('פתוחה', 'Open'), filled: L('מולאה', 'Filled'), closed: L('סגורה', 'Closed') } as Record<string, Label>)[k] ?? L(k),
    order: enumOrder(['open', 'filled', 'closed']) },
  { id: 'validQ', label: L('תוקף', 'Valid until'), sources: ['requirements'], temporal: true,
    keyOf: (r) => quarterKey(r.validUntil), labelOf: quarterLabel, order: chrono },
  { id: 'taskStatus', label: L('סטטוס', 'Status'), sources: ['tasks'],
    keyOf: (x, _s, ctx) => (x.done ? 'done' : (daysAway(x.dueDate, ctx.now) ?? 0) < 0 ? 'overdue' : 'open'),
    labelOf: (k) => ({ done: L('בוצעה', 'Done'), overdue: L('באיחור', 'Overdue'), open: L('פתוחה', 'Open') } as Record<string, Label>)[k] ?? L(k),
    order: enumOrder(['overdue', 'open', 'done']) },
  { id: 'kind', label: L('סוג', 'Kind'), sources: ['interactions'], keyOf: (r) => str(r.kind) || 'note',
    labelOf: (k) => ({ note: L('הערה', 'Note'), call: L('שיחה', 'Call'), meeting: L('פגישה', 'Meeting'), message: L('הודעה', 'Message'), stage_change: L('שינוי שלב', 'Stage change'), promotion: L('קידום', 'Promotion'), system: L('מערכת', 'System') } as Record<string, Label>)[k] ?? L(k) },
  { id: 'hasVideo', label: L('וידאו', 'Video'), sources: ['players'], keyOf: (p) => (str(p.videoLink) ? 'yes' : 'no'), labelOf: yesNo, order: enumOrder(['yes', 'no']) },
];
export const dimension = (id: string): Dimension | undefined => DIMENSIONS.find((d) => d.id === id);
export const dimensionsFor = (source: Source): Dimension[] => DIMENSIONS.filter((d) => d.sources.includes(source));

// ── measures ───────────────────────────────────────────────────────
export const MEASURES: Measure[] = [
  { id: 'count', label: L('כמות', 'Count'), sources: SOURCES, agg: 'count', format: 'int' },
  { id: 'avgAge', label: L('גיל ממוצע', 'Average age'), sources: ['players'], agg: 'avg', format: 'years', pick: (p, ctx) => ageOf(p.dob, ctx.today) },
  { id: 'free', label: L('ללא חוזה', 'Without contract'), sources: ['players'], agg: 'sum', format: 'int', pick: (p) => (str(p.contractStatus) === 'Free' ? 1 : 0) },
  { id: 'commission', label: L('עמלות', 'Commission'), sources: ['deals'], agg: 'sum', format: 'money', pick: (d) => parseMoney(d.commission) },
  { id: 'fee', label: L('דמי העברה', 'Transfer fee'), sources: ['deals'], agg: 'sum', format: 'money', pick: (d) => parseMoney(d.transferFee) },
  { id: 'avgDaysInStage', label: L('ימים בשלב (ממוצע)', 'Avg days in stage'), sources: ['deals'], agg: 'avg', format: 'days',
    pick: (d, ctx) => daysInStage(d as unknown as DealLike, ctx.now) },
  { id: 'overdue', label: L('באיחור', 'Overdue'), sources: ['tasks'], agg: 'sum', format: 'int',
    pick: (x, ctx) => (!x.done && (daysAway(x.dueDate, ctx.now) ?? 0) < 0 ? 1 : 0) },
];
export const measure = (id: string): Measure | undefined => MEASURES.find((m) => m.id === id);
export const measuresFor = (source: Source): Measure[] => MEASURES.filter((m) => m.sources.includes(source));

// ── context + periods ──────────────────────────────────────────────
export const buildCtx = (input: AnalyticsInput): Ctx => {
  const now = input.now ?? new Date();
  const playersById = new Map<string, Row>();
  const playersByClub = new Map<string, Row[]>();
  for (const p of input.players ?? []) {
    if (p.deletedAt) continue;
    playersById.set(str(p.id), p);
    if (stageOf(p) !== 'represented') continue;
    const c = str(p.currentClub).toLowerCase();
    if (!c) continue;
    if (!playersByClub.has(c)) playersByClub.set(c, []);
    playersByClub.get(c)!.push(p);
  }
  return { now, today: israelDate(now), playersById, playersByClub };
};

/** The date a record belongs to, per source, for the period filter. */
export const dateOf = (row: Row, source: Source): string | null => {
  switch (source) {
    case 'matches': case 'trainings': return toDateStr(row.date);
    case 'tasks': return toDateStr(row.dueDate);
    case 'interactions': return toDateStr(row.at);
    default: return toDateStr(row.createdAt);
  }
};

export const periodRange = (period: Period | undefined, now: Date): { from: string; to: string } | null => {
  if (!period || period.kind === 'all') return null;
  const today = israelDate(now);
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  switch (period.kind) {
    case 'season': { const sy = seasonStartYear(now); return { from: `${sy}-07-01`, to: `${sy + 1}-06-30` }; }
    case 'quarter': { const q0 = Math.floor((m - 1) / 3) * 3 + 1; return { from: `${y}-${pad(q0)}-01`, to: `${y}-${pad(q0 + 2)}-${pad(lastDay(y, q0 + 2))}` }; }
    case 'month': return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
    case 'next90': { const d = new Date(now.getTime() + 90 * 86400000); return { from: today, to: israelDate(d) }; }
    case 'last12m': { const d = new Date(Date.UTC(y, m - 13, 1)); return { from: d.toISOString().slice(0, 10), to: today }; }
    case 'custom': return period.from || period.to ? { from: period.from || '0000-01-01', to: period.to || '9999-12-31' } : null;
  }
  return null;
};

export const PERIOD_LABELS: Record<PeriodKind, Label> = {
  all: L('כל הזמן', 'All time'), season: L('העונה', 'This season'), quarter: L('הרבעון', 'This quarter'),
  month: L('החודש', 'This month'), next90: L('90 הימים הקרובים', 'Next 90 days'), last12m: L('12 חודשים אחרונים', 'Last 12 months'), custom: L('טווח', 'Range'),
};

// ── filtering ──────────────────────────────────────────────────────
const keysOf = (dim: Dimension, row: Row, source: Source, ctx: Ctx): string[] => {
  const k = dim.keyOf(row, source, ctx);
  if (k == null) return [];
  return Array.isArray(k) ? k : [k];
};

/**
 * Rows of `source` that survive the filters and the period. A filter whose
 * dimension does not apply to the source is translated through the players
 * where possible (a deal or match "belongs" to its player), else ignored.
 */
export const applyFilters = (rows: Row[], source: Source, filters: Filter[], ctx: Ctx, period?: Period): Row[] => {
  const range = periodRange(period, ctx.now);
  const active = filters.map((f) => ({ f, dim: dimension(f.dim) })).filter((x): x is { f: Filter; dim: Dimension } => !!x.dim);
  return rows.filter((row) => {
    if (row.deletedAt) return false;
    if (range) {
      const d = dateOf(row, source);
      if (!d || d < range.from || d > range.to) return false;
    }
    for (const { f, dim } of active) {
      if (dim.sources.includes(source)) {
        if (!keysOf(dim, row, source, ctx).includes(f.value)) return false;
        continue;
      }
      if (dim.sources.includes('players')) {
        // Translate through the record's players.
        const ps = source === 'matches' ? matchPlayers(row, ctx) : [ctx.playersById.get(str(row.playerId))].filter((p): p is Row => !!p);
        if (!ps.length) return false;
        if (!ps.some((p) => keysOf(dim, p, 'players', ctx).includes(f.value))) return false;
      }
    }
    return true;
  });
};

// ── slicing ────────────────────────────────────────────────────────
export interface SliceOptions {
  sort?: 'natural' | 'count' | 'label';
  dir?: 'asc' | 'desc';
  topN?: number;
  lang?: 'he' | 'en';
  /** Rows that map to no key are listed under this label when true. */
  includeUnknown?: boolean;
}

export const slice = (rows: Row[], source: Source, dimId: string, measureId: string, ctx: Ctx, opts: SliceOptions = {}): SliceResult => {
  const dim = dimension(dimId);
  const ms = measure(measureId) ?? MEASURES[0];
  if (!dim) throw new Error(`unknown dimension ${dimId}`);
  const buckets = new Map<string, Row[]>();
  let unknown: Row[] = [];
  for (const row of rows) {
    const keys = keysOf(dim, row, source, ctx);
    if (!keys.length) { unknown.push(row); continue; }
    for (const k of keys) { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k)!.push(row); }
  }
  const agg = (list: Row[]): number => {
    if (ms.agg === 'count' || !ms.pick) return list.length;
    const vals = list.map((r) => ms.pick!(r, ctx)).filter((v): v is number => typeof v === 'number' && isFinite(v));
    if (!vals.length) return 0;
    const sum = vals.reduce((a, b) => a + b, 0);
    return ms.agg === 'sum' ? sum : Math.round((sum / vals.length) * 10) / 10;
  };
  let groups: Group[] = Array.from(buckets.entries()).map(([key, list]) => ({
    key, label: dim.labelOf ? dim.labelOf(key, ctx) : L(key), count: list.length, value: agg(list), share: 0, rows: list,
  }));
  if (opts.includeUnknown && unknown.length) groups.push({ key: '', label: L('לא ידוע', 'Unknown'), count: unknown.length, value: agg(unknown), share: 0, rows: unknown });
  const lang = opts.lang ?? 'he';
  const sortMode = opts.sort ?? (dim.order ? 'natural' : 'count');
  const dir = opts.dir ?? (sortMode === 'count' ? 'desc' : 'asc');
  const sign = dir === 'desc' ? -1 : 1;
  groups.sort((a, b) => {
    if (sortMode === 'natural' && dim.order) return sign * dim.order(a.key, b.key);
    if (sortMode === 'label') return sign * a.label[lang].localeCompare(b.label[lang], lang === 'he' ? 'he' : 'en');
    return sign * (a.value - b.value) || a.label[lang].localeCompare(b.label[lang]);
  });
  if (opts.topN && groups.length > opts.topN) {
    const head = groups.slice(0, opts.topN);
    const tail = groups.slice(opts.topN);
    const rest = tail.flatMap((g) => g.rows);
    head.push({ key: '__other', label: L(`אחר (${tail.length})`, `Other (${tail.length})`), count: rest.length, value: agg(rest), share: 0, rows: rest });
    groups = head;
  }
  const total = ms.agg === 'avg' ? agg(rows) : groups.filter((g) => g.key !== '__other').reduce((s, g) => s + g.value, 0) + (groups.find((g) => g.key === '__other')?.value ?? 0);
  const base = ms.agg === 'avg' ? 0 : total;
  for (const g of groups) g.share = base ? g.value / base : 0;
  return { source, dim, measure: ms, groups, total, totalCount: rows.length };
};

// ── trend (monthly series) ─────────────────────────────────────────
export interface TrendPoint { key: string; label: Label; value: number }
export const monthly = (rows: Row[], source: Source, ctx: Ctx, months = 12, pick: (r: Row) => unknown = (r) => dateOf(r, source)): TrendPoint[] => {
  const [y, m] = ctx.today.split('-').map(Number);
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = monthKey(pick(r));
    if (k && counts.has(k)) counts.set(k, counts.get(k)! + 1);
  }
  return keys.map((k) => ({ key: k, label: monthLabel(k), value: counts.get(k) ?? 0 }));
};

// ── KPIs ───────────────────────────────────────────────────────────
export interface Kpi {
  id: string;
  label: Label;
  value: number;
  format: Measure['format'];
  /** Which source + filters the tile drills into. */
  drill: { source: Source; filters?: Filter[]; dim?: string };
  tone?: 'good' | 'warning' | 'critical' | 'gold' | 'neutral';
}

export interface KpiInput extends AnalyticsInput { filters?: Filter[]; period?: Period }

export const kpis = (input: KpiInput): Kpi[] => {
  const ctx = buildCtx(input);
  const f = input.filters ?? [];
  const P = applyFilters(input.players ?? [], 'players', f, ctx, input.period);
  const D = applyFilters(input.deals ?? [], 'deals', f, ctx, input.period);
  const M = applyFilters(input.matches ?? [], 'matches', f, ctx, input.period);
  const R = applyFilters(input.requirements ?? [], 'requirements', f, ctx, input.period);
  const T = applyFilters(input.tasks ?? [], 'tasks', f, ctx, input.period);
  const sy = seasonStartYear(ctx.now);
  const season = { from: `${sy}-07-01`, to: `${sy + 1}-06-30` };
  const within = (v: unknown, days: number) => { const d = daysAway(v, ctx.now); return d != null && d >= 0 && d <= days; };
  const represented = P.filter((p) => stageOf(p) === 'represented');
  const inProcess = P.filter((p) => stageOf(p) === 'in_process');
  const tracking = P.filter((p) => stageOf(p) === 'tracking');
  const openDeals = D.filter((d) => !d.closedAt && str(d.stage) !== 'Not Relevant' && str(d.stage) !== 'Contract Signed');
  const signedSeason = D.filter((d) => str(d.stage) === 'Contract Signed' && (() => { const c = toDateStr(d.closedAt) ?? toDateStr(d.enteredStageAt); return !!c && c >= season.from && c <= season.to; })());
  const commission = openDeals.map((d) => parseMoney(d.commission) ?? 0).reduce((a, b) => a + b, 0);
  const contracts90 = represented.filter((p) => within(p.contractEnd, 90));
  const repr90 = represented.filter((p) => within(p.reprEnd, 90));
  const matchesWeek = M.filter((m) => !m.deletedAt && within(m.date, 7));
  const overdue = T.filter((x) => !x.done && (daysAway(x.dueDate, ctx.now) ?? 0) < 0);
  const openReqs = R.filter((r) => !r.status || r.status === 'open');
  return [
    { id: 'represented', label: L('שחקנים מיוצגים', 'Represented players'), value: represented.length, format: 'int', tone: 'good', drill: { source: 'players', filters: [{ dim: 'stage', value: 'represented' }], dim: 'category' } },
    { id: 'in_process', label: L('בתהליך', 'In process'), value: inProcess.length, format: 'int', tone: 'gold', drill: { source: 'players', filters: [{ dim: 'stage', value: 'in_process' }], dim: 'category' } },
    { id: 'tracking', label: L('במעקב', 'Tracking'), value: tracking.length, format: 'int', tone: 'neutral', drill: { source: 'players', filters: [{ dim: 'stage', value: 'tracking' }], dim: 'category' } },
    { id: 'open_deals', label: L('עסקאות פתוחות', 'Open deals'), value: openDeals.length, format: 'int', tone: 'gold', drill: { source: 'deals', dim: 'dealStage' } },
    { id: 'commission', label: L('עמלות צפויות', 'Expected commission'), value: commission, format: 'money', tone: 'gold', drill: { source: 'deals', dim: 'dealStage' } },
    { id: 'signed_season', label: L('חוזים שנחתמו העונה', 'Signed this season'), value: signedSeason.length, format: 'int', tone: 'good', drill: { source: 'deals', filters: [{ dim: 'dealStage', value: 'Contract Signed' }], dim: 'club' } },
    { id: 'contracts90', label: L('חוזים מסתיימים ב-90 יום', 'Contracts ending in 90 days'), value: contracts90.length, format: 'int', tone: contracts90.length ? 'warning' : 'neutral', drill: { source: 'players', filters: [{ dim: 'stage', value: 'represented' }], dim: 'contractEndQ' } },
    { id: 'repr90', label: L('ייצוג מסתיים ב-90 יום', 'Representation ending in 90 days'), value: repr90.length, format: 'int', tone: repr90.length ? 'warning' : 'neutral', drill: { source: 'players', filters: [{ dim: 'stage', value: 'represented' }], dim: 'reprEndQ' } },
    { id: 'matches_week', label: L('משחקים השבוע', 'Matches this week'), value: matchesWeek.length, format: 'int', tone: 'neutral', drill: { source: 'matches', filters: [{ dim: 'when', value: 'upcoming' }], dim: 'player' } },
    { id: 'open_reqs', label: L('דרישות פתוחות', 'Open requirements'), value: openReqs.length, format: 'int', tone: 'neutral', drill: { source: 'requirements', filters: [{ dim: 'reqStatus', value: 'open' }], dim: 'position' } },
    { id: 'overdue_tasks', label: L('משימות באיחור', 'Overdue tasks'), value: overdue.length, format: 'int', tone: overdue.length ? 'critical' : 'neutral', drill: { source: 'tasks', filters: [{ dim: 'taskStatus', value: 'overdue' }], dim: 'owner' } },
    { id: 'no_contract', label: L('מיוצגים ללא חוזה', 'Represented without contract'), value: represented.filter((p) => str(p.contractStatus) === 'Free').length, format: 'int', tone: 'warning', drill: { source: 'players', filters: [{ dim: 'stage', value: 'represented' }, { dim: 'contractStatus', value: 'Free' }], dim: 'ageGroup' } },
  ];
};

// ── drill state <-> URL ────────────────────────────────────────────
export interface DrillState {
  source: Source;
  dim: string;
  measure: string;
  filters: Filter[];
  period: Period;
  sort?: SliceOptions['sort'];
  dir?: SliceOptions['dir'];
}

export const DEFAULT_STATE: DrillState = { source: 'players', dim: 'category', measure: 'count', filters: [], period: { kind: 'all' } };

/** `source=players&dim=club&f=stage:represented|category:youth&period=season` */
export const encodeState = (s: DrillState): string => {
  const q = new URLSearchParams();
  if (s.source !== DEFAULT_STATE.source) q.set('source', s.source);
  if (s.dim !== DEFAULT_STATE.dim) q.set('dim', s.dim);
  if (s.measure !== DEFAULT_STATE.measure) q.set('measure', s.measure);
  if (s.filters.length) q.set('f', s.filters.map((f) => `${f.dim}:${encodeURIComponent(f.value)}`).join('|'));
  if (s.period.kind !== 'all') q.set('period', s.period.kind === 'custom' ? `custom:${s.period.from ?? ''}:${s.period.to ?? ''}` : s.period.kind);
  if (s.sort) q.set('sort', s.sort);
  if (s.dir) q.set('dir', s.dir);
  return q.toString();
};

export const decodeState = (search: string): DrillState => {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const source = (SOURCES as string[]).includes(q.get('source') ?? '') ? (q.get('source') as Source) : DEFAULT_STATE.source;
  const dims = dimensionsFor(source);
  const dim = dims.some((d) => d.id === q.get('dim')) ? q.get('dim')! : (dims[0]?.id ?? DEFAULT_STATE.dim);
  const ms = measuresFor(source);
  const measureId = ms.some((m) => m.id === q.get('measure')) ? q.get('measure')! : 'count';
  const filters: Filter[] = (q.get('f') ?? '').split('|').filter(Boolean).map((part) => {
    const i = part.indexOf(':');
    return i < 0 ? null : { dim: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)) };
  }).filter((f): f is Filter => !!f && !!dimension(f.dim));
  const p = q.get('period') ?? 'all';
  let period: Period = { kind: 'all' };
  if (p.startsWith('custom:')) { const [, from, to] = p.split(':'); period = { kind: 'custom', from, to }; }
  else if ((Object.keys(PERIOD_LABELS) as string[]).includes(p)) period = { kind: p as PeriodKind };
  const sort = (['natural', 'count', 'label'] as const).find((x) => x === q.get('sort'));
  const dir = (['asc', 'desc'] as const).find((x) => x === q.get('dir'));
  return { source, dim, measure: measureId, filters, period, ...(sort ? { sort } : {}), ...(dir ? { dir } : {}) };
};

/** Push a filter: clicking a slice. The same dimension replaces its earlier value. */
export const drillInto = (s: DrillState, dimId: string, value: string, nextDim?: string): DrillState => {
  const filters = s.filters.filter((f) => f.dim !== dimId).concat([{ dim: dimId, value }]);
  const dims = dimensionsFor(s.source).filter((d) => !filters.some((f) => f.dim === d.id));
  const dim = nextDim && dims.some((d) => d.id === nextDim) ? nextDim : (dims.find((d) => d.id === s.dim) ? s.dim : (dims[0]?.id ?? s.dim));
  return { ...s, filters, dim };
};

/** Pop filters back to (and excluding) index `i`; -1 clears all. */
export const drillUp = (s: DrillState, i: number): DrillState => ({ ...s, filters: s.filters.slice(0, Math.max(0, i)) });

/** Breadcrumb labels for the current path, with the count at each level. */
export const breadcrumbs = (s: DrillState, rows: Row[], ctx: Ctx, lang: 'he' | 'en' = 'he'): Array<{ label: string; count: number }> => {
  const out: Array<{ label: string; count: number }> = [];
  for (let i = 0; i <= s.filters.length; i++) {
    const part = s.filters.slice(0, i);
    const n = applyFilters(rows, s.source, part, ctx, s.period).length;
    if (i === 0) out.push({ label: lang === 'he' ? 'הכל' : 'All', count: n });
    else {
      const f = s.filters[i - 1];
      const d = dimension(f.dim);
      const lbl = d?.labelOf ? d.labelOf(f.value, ctx)[lang] : f.value;
      out.push({ label: lbl, count: n });
    }
  }
  return out;
};

// ── matrix (heat-map: dimension × dimension) ───────────────────────
export interface MatrixAxis { key: string; label: Label; total: number }
export interface MatrixCell { row: string; col: string; count: number; rows: Row[] }
export interface MatrixResult {
  source: Source; rowDim: Dimension; colDim: Dimension;
  rowsAxis: MatrixAxis[]; colsAxis: MatrixAxis[];
  /** cells[rowKey][colKey]; absent = 0 */
  cells: Record<string, Record<string, MatrixCell>>;
  max: number; total: number;
}
/**
 * Count rows by two dimensions at once. A row with several keys on an axis
 * (a match with two clubs) counts once per combination. Axes keep the
 * dimensions' natural order, else by total descending; `topN` trims each axis.
 */
export const matrix = (rows: Row[], source: Source, rowDimId: string, colDimId: string, ctx: Ctx, opts: { topRows?: number; topCols?: number } = {}): MatrixResult => {
  const rowDim = dimension(rowDimId), colDim = dimension(colDimId);
  if (!rowDim || !colDim) throw new Error(`unknown dimension ${!rowDim ? rowDimId : colDimId}`);
  const cells: Record<string, Record<string, MatrixCell>> = {};
  const rowTot = new Map<string, number>(), colTot = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const rk = keysOf(rowDim, r, source, ctx), ck = keysOf(colDim, r, source, ctx);
    for (const a of rk) for (const b of ck) {
      const line = (cells[a] ??= {});
      const cell = (line[b] ??= { row: a, col: b, count: 0, rows: [] });
      cell.count += 1; cell.rows.push(r); total += 1;
      rowTot.set(a, (rowTot.get(a) ?? 0) + 1); colTot.set(b, (colTot.get(b) ?? 0) + 1);
    }
  }
  const axis = (dim: Dimension, tot: Map<string, number>, top?: number): MatrixAxis[] => {
    let keys = Array.from(tot.keys());
    keys.sort(dim.order ? dim.order : (a, b) => (tot.get(b)! - tot.get(a)!) || a.localeCompare(b));
    if (top && keys.length > top) keys = (dim.order ? [...keys].sort((a, b) => tot.get(b)! - tot.get(a)!).slice(0, top).sort(dim.order) : keys.slice(0, top));
    return keys.map((k) => ({ key: k, label: dim.labelOf ? dim.labelOf(k, ctx) : L(k), total: tot.get(k) ?? 0 }));
  };
  const rowsAxis = axis(rowDim, rowTot, opts.topRows), colsAxis = axis(colDim, colTot, opts.topCols);
  let max = 0;
  for (const a of rowsAxis) for (const b of colsAxis) max = Math.max(max, cells[a.key]?.[b.key]?.count ?? 0);
  return { source, rowDim, colDim, rowsAxis, colsAxis, cells, max, total };
};

// ── deal funnel ────────────────────────────────────────────────────
export interface FunnelStep { key: string; label: Label; at: number; reached: number; commission: number; rows: Row[]; share: number }
/** The pipeline stages in order, 'Not Relevant' aside. */
export const FUNNEL_STAGES: string[] = DEAL_STAGES.filter((s) => s !== 'Not Relevant');
/**
 * Deals by pipeline stage, in order. `at` = deals sitting in the stage now;
 * `reached` = deals at this stage or any later one (the funnel's width);
 * `share` = reached / reached of the first step.
 */
export const dealFunnel = (deals: Row[]): FunnelStep[] => {
  const idx = (d: Row) => FUNNEL_STAGES.indexOf(str(d.stage));
  const live = deals.filter((d) => !d.deletedAt && idx(d) >= 0);
  const steps = FUNNEL_STAGES.map((key, i) => {
    const rows = live.filter((d) => idx(d) === i);
    const reachedRows = live.filter((d) => idx(d) >= i);
    return { key, label: L((DEAL_STAGE_LABELS as Record<string, string>)[key] ?? key, key), at: rows.length, reached: reachedRows.length,
      commission: rows.reduce((s, d) => s + (parseMoney(d.commission) ?? 0), 0), rows, share: 0 };
  });
  const top = steps[0]?.reached ?? 0;
  for (const s of steps) s.share = top ? s.reached / top : 0;
  return steps;
};

// ── contract timeline (represented players, soonest expiry first) ──
export type Urgency = 'expired' | 'critical' | 'warning' | 'ok';
export interface TimelineItem { id: string; name: string; club: string; end: string; daysLeft: number; urgency: Urgency; row: Row }
export const urgencyOf = (daysLeft: number): Urgency => (daysLeft < 0 ? 'expired' : daysLeft <= 90 ? 'critical' : daysLeft <= 180 ? 'warning' : 'ok');
/**
 * Represented players with a contract end date, soonest first, within the
 * next `months` (expired contracts in the last 3 months included so they
 * are not forgotten). `field` switches to the representation agreement.
 */
export const contractTimeline = (players: Row[], ctx: Ctx, opts: { months?: number; field?: 'contractEnd' | 'reprEnd' } = {}): TimelineItem[] => {
  const months = opts.months ?? 24, field = opts.field ?? 'contractEnd';
  const horizon = months * 30.5, floor = -92;
  const out: TimelineItem[] = [];
  for (const p of players) {
    if (p.deletedAt || stageOf(p) !== 'represented') continue;
    const end = toDateStr(p[field]);
    const days = daysAway(p[field], ctx.now);
    if (!end || days == null || days > horizon || days < floor) continue;
    out.push({ id: str(p.id), name: nameOf(p), club: str(p.currentClub), end, daysLeft: days, urgency: urgencyOf(days), row: p });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name, 'he'));
};

// ── trends (several monthly series side by side) ───────────────────
export interface TrendSeries { id: string; label: Label; points: TrendPoint[]; total: number }
export const TREND_SERIES: Array<{ id: string; label: Label; source: Source; pick?: (r: Row) => unknown }> = [
  { id: 'players', label: L('שחקנים חדשים', 'New players'), source: 'players' },
  { id: 'deals', label: L('עסקאות שנפתחו', 'Deals opened'), source: 'deals' },
  { id: 'signed', label: L('חוזים שנחתמו', 'Contracts signed'), source: 'deals', pick: (d) => (str(d.stage) === 'Contract Signed' ? d.closedAt ?? d.enteredStageAt : null) },
  { id: 'matches', label: L('משחקים', 'Matches'), source: 'matches' },
  { id: 'interactions', label: L('פעילות', 'Activity'), source: 'interactions' },
];
/** Monthly counts for the trend chart, over the already-filtered rows per source. */
export const trends = (rows: Partial<Record<Source, Row[]>>, ctx: Ctx, months = 12): TrendSeries[] =>
  TREND_SERIES.map((s) => {
    const list = (rows[s.source] ?? []).filter((r) => !r.deletedAt);
    const points = monthly(list, s.source, ctx, months, s.pick ?? ((r) => dateOf(r, s.source)));
    return { id: s.id, label: s.label, points, total: points.reduce((a, p) => a + p.value, 0) };
  }).filter((s) => s.total > 0 || s.id === 'players');

// ── record columns for the slice table / export ────────────────────
export interface Column { key: string; label: Label; get: (row: Row, ctx: Ctx) => string | number; numeric?: boolean }
const col = (key: string, he: string, en: string, get: Column['get'], numeric = false): Column => ({ key, label: L(he, en), get, numeric });
const date = (v: unknown) => toDateStr(v) ?? '';
const dealName = (d: Row, ctx: Ctx) => str(d.playerName) || nameOf(ctx.playersById.get(str(d.playerId)));

export const COLUMNS: Record<Source, Column[]> = {
  players: [
    col('name', 'שם', 'Name', (p) => nameOf(p)),
    col('stage', 'שלב', 'Stage', (p) => (STAGE_LABELS as Record<string, Label>)[stageOf(p)]?.he ?? stageOf(p)),
    col('category', 'קטגוריה', 'Category', (p) => (CATEGORY_LABELS as Record<string, Label>)[categoryOf(p)]?.he ?? categoryOf(p)),
    col('age', 'גיל', 'Age', (p, ctx) => ageOf(p.dob, ctx.today) ?? '', true),
    col('ageGroup', 'קבוצת גיל', 'Age group', (p, ctx) => ageGroupLabel(resolveAgeGroup(p as Parameters<typeof resolveAgeGroup>[0], ctx.now)?.id ?? 'senior').he),
    col('position', 'עמדה', 'Position', (p) => str(p.primaryPosition)),
    col('club', 'מועדון', 'Club', (p) => str(p.currentClub)),
    col('country', 'מדינה', 'Country', (p) => str(p.leagueCountry)),
    col('contractStatus', 'חוזה', 'Contract', (p) => str(p.contractStatus)),
    col('contractEnd', 'סיום חוזה', 'Contract end', (p) => date(p.contractEnd)),
    col('reprEnd', 'סיום ייצוג', 'Repr. end', (p) => date(p.reprEnd)),
  ],
  deals: [
    col('player', 'שחקן', 'Player', dealName),
    col('club', 'מועדון', 'Club', (d) => str(d.clubName)),
    col('stage', 'שלב', 'Stage', (d) => (DEAL_STAGE_LABELS as Record<string, string>)[str(d.stage)] ?? str(d.stage)),
    col('days', 'ימים בשלב', 'Days in stage', (d, ctx) => daysInStage(d as unknown as DealLike, ctx.now) ?? '', true),
    col('fee', 'דמי העברה', 'Fee', (d) => parseMoney(d.transferFee) ?? '', true),
    col('commission', 'עמלה', 'Commission', (d) => parseMoney(d.commission) ?? '', true),
    col('owner', 'אחראי', 'Owner', (d) => str(d.owner)),
    col('opened', 'נפתחה', 'Opened', (d) => date(d.createdAt)),
  ],
  matches: [
    col('date', 'תאריך', 'Date', (m) => date(m.date)),
    col('time', 'שעה', 'Time', (m) => str(m.time)),
    col('home', 'בית', 'Home', (m) => str(m.homeTeam)),
    col('away', 'חוץ', 'Away', (m) => str(m.awayTeam)),
    col('players', 'שחקנים', 'Players', (m, ctx) => matchPlayers(m, ctx).map(nameOf).join(', ')),
    col('stadium', 'אצטדיון', 'Stadium', (m) => str(m.stadiumName)),
  ],
  requirements: [
    col('club', 'מועדון', 'Club', (r) => str(r.clubName)),
    col('position', 'עמדה', 'Position', (r) => str(r.requiredPosition)),
    col('country', 'מדינה', 'Country', (r) => str(r.country)),
    col('status', 'סטטוס', 'Status', (r) => str(r.status) || 'open'),
    col('validUntil', 'תוקף', 'Valid until', (r) => date(r.validUntil)),
  ],
  tasks: [
    col('title', 'משימה', 'Task', (x) => str(x.title) || str(x.text)),
    col('owner', 'אחראי', 'Owner', (x) => str(x.owner)),
    col('due', 'יעד', 'Due', (x) => date(x.dueDate)),
    col('done', 'בוצעה', 'Done', (x) => (x.done ? 'כן' : 'לא')),
  ],
  trainings: [
    col('player', 'שחקן', 'Player', (x, ctx) => nameOf(ctx.playersById.get(str(x.playerId))) || str(x.title)),
    col('date', 'תאריך', 'Date', (x) => date(x.date)),
    col('time', 'שעה', 'Time', (x) => str(x.time)),
    col('rule', 'חוזר', 'Recurring', (x) => (x.rule ? 'כן' : 'לא')),
  ],
  interactions: [
    col('at', 'מתי', 'When', (x) => date(x.at)),
    col('kind', 'סוג', 'Kind', (x) => str(x.kind)),
    col('player', 'שחקן', 'Player', (x, ctx) => nameOf(ctx.playersById.get(str(x.playerId)))),
    col('text', 'תוכן', 'Text', (x) => str(x.text)),
    col('by', 'מי', 'By', (x) => str(x.by)),
  ],
};

/** The record link each source opens in the app. */
export const recordPath = (source: Source, row: Row): string | null => {
  const id = str(row.id);
  switch (source) {
    case 'players': return id ? `/players/${id}` : null;
    case 'deals': return '/market/deals';
    case 'matches': return '/calendar';
    case 'requirements': return '/market/requirements';
    case 'tasks': return '/tasks';
    case 'trainings': return '/calendar';
    case 'interactions': return row.playerId ? `/players/${str(row.playerId)}` : null;
  }
};

export const formatValue = (v: number, format: Measure['format'], lang: 'he' | 'en' = 'he'): string => {
  const loc = lang === 'he' ? 'he-IL' : 'en-GB';
  switch (format) {
    case 'money': return v.toLocaleString(loc, { maximumFractionDigits: 0 }) + ' €';
    case 'years': return v.toLocaleString(loc, { maximumFractionDigits: 1 });
    case 'days': return v.toLocaleString(loc, { maximumFractionDigits: 0 });
    case 'percent': return Math.round(v * 100) + '%';
    default: return v.toLocaleString(loc);
  }
};
