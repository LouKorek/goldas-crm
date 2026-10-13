// 01 · Alerts. One pure function feeds Home, the Notifications screen, the
// daily email and Golda's briefing. Input: players, matches, deals,
// requirements, tasks, jobs and the thresholds; output: a flat list of
// alerts with type, severity, due date and a one-line proof, plus the same
// list grouped by type. Day counts use the Israeli calendar.
import { daysAway, nextBirthday, toDateStr, israelDate, daysBetween } from './dates.js';
import { playerName, DEAL_STALE_DAYS } from '../stages.js';

export type AlertType =
  | 'contract' | 'repr' | 'passport' | 'birthday' | 'match'
  | 'deal_stale' | 'requirement_expired' | 'task_overdue' | 'job_failed' | 'sync_mismatch';
export type Severity = 'critical' | 'warning' | 'info' | 'gold';

export interface AlertSettings {
  contractDays: number[];
  reprDays: number[];
  passportDays: number[];
  birthdayDays: number[];
  matchDays: number[];
  dealStaleDays: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  contractDays: [7, 30, 60],
  reprDays: [7, 30, 60],
  passportDays: [30, 90, 180],
  birthdayDays: [0, 3, 7],
  matchDays: [0, 1, 2, 3, 4, 5, 6, 7],
  dealStaleDays: DEAL_STALE_DAYS,
};

export interface Alert {
  type: AlertType;
  severity: Severity;
  /** Whole days until the due date (negative = overdue); null when not date-based. */
  days: number | null;
  dueDate: string | null;
  overdue: boolean;
  /** Who or what the alert is about. */
  subject: { kind: 'player' | 'deal' | 'requirement' | 'task' | 'job' | 'match'; id: string; name: string };
  /** The fact behind the alert, Hebrew and English. */
  proof: { he: string; en: string };
  /** The record itself, for screens that render details. */
  record: Record<string, unknown>;
  /** Birthday: the age reached. */
  age?: number;
}

export interface AlertsInput {
  players?: Array<Record<string, unknown>>;
  matches?: Array<Record<string, unknown>>;
  deals?: Array<Record<string, unknown>>;
  requirements?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  settings?: Partial<AlertSettings> | null;
  now?: Date;
  /** Hours of job history to scan for failures (default 24). */
  jobWindowHours?: number;
}

export interface AlertsResult {
  alerts: Alert[];
  byType: Record<AlertType, Alert[]>;
  total: number;
}

export const mergeSettings = (s?: Partial<AlertSettings> | null): AlertSettings => {
  const out: AlertSettings = { ...DEFAULT_ALERT_SETTINGS };
  if (!s) return out;
  for (const k of ['contractDays', 'reprDays', 'passportDays', 'birthdayDays', 'matchDays'] as const) {
    const v = s[k];
    if (Array.isArray(v)) out[k] = v.map(Number).filter((n) => !isNaN(n));
  }
  if (typeof s.dealStaleDays === 'number' && s.dealStaleDays > 0) out.dealStaleDays = s.dealStaleDays;
  return out;
};

// A passed date is the most urgent thing on the screen, so it stays until
// the record is updated. An empty threshold list switches the type off.
const due = (d: number | null, thresholds: number[]): d is number =>
  d !== null && thresholds.length > 0 && (d < 0 || thresholds.some((t) => d <= t));

const sev = (d: number, crit: number, warn: number): Severity => (d <= crit ? 'critical' : d <= warn ? 'warning' : 'info');
const str = (v: unknown): string => (v == null ? '' : String(v));
const whenHe = (d: number) => (d === 0 ? 'היום' : d === 1 ? 'מחר' : d < 0 ? `לפני ${-d} ימים` : `בעוד ${d} ימים`);
const whenEn = (d: number) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 0 ? `${-d} days ago` : `in ${d} days`);
const millis = (v: unknown): number | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis();
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate: () => Date }).toDate().getTime();
  const n = new Date(String(v)).getTime();
  return isNaN(n) ? null : n;
};

export function computeAlerts(input: AlertsInput): AlertsResult {
  const s = mergeSettings(input.settings);
  const now = input.now ?? new Date();
  const today = israelDate(now);
  const alerts: Alert[] = [];

  for (const p of input.players ?? []) {
    if (p.deletedAt) continue;
    const id = str(p.id); const name = playerName(p as { name?: unknown; fullName?: unknown; playerName?: unknown });
    const subject = { kind: 'player' as const, id, name };
    if (p.contractEnd && p.contractStatus !== 'Free') {
      const d = daysAway(p.contractEnd, now);
      if (due(d, s.contractDays)) alerts.push({
        type: 'contract', severity: sev(d, 7, 30), days: d, dueDate: toDateStr(p.contractEnd), overdue: d < 0, subject, record: p,
        proof: { he: `החוזה${p.currentClub ? ` ב${str(p.currentClub)}` : ''} מסתיים ${whenHe(d)}`, en: `Contract${p.currentClub ? ` at ${str(p.currentClub)}` : ''} ends ${whenEn(d)}` },
      });
    }
    if (p.reprEnd) {
      const d = daysAway(p.reprEnd, now);
      if (due(d, s.reprDays)) alerts.push({
        type: 'repr', severity: sev(d, 7, 30), days: d, dueDate: toDateStr(p.reprEnd), overdue: d < 0, subject, record: p,
        proof: { he: `הסכם הייצוג מסתיים ${whenHe(d)}`, en: `Representation ends ${whenEn(d)}` },
      });
    }
    if (p.passportExpiry) {
      const d = daysAway(p.passportExpiry, now);
      if (due(d, s.passportDays)) alerts.push({
        type: 'passport', severity: sev(d, 30, 90), days: d, dueDate: toDateStr(p.passportExpiry), overdue: d < 0, subject, record: p,
        proof: { he: `הדרכון פג ${whenHe(d)}`, en: `Passport expires ${whenEn(d)}` },
      });
    }
    if (p.dob && s.birthdayDays.length) {
      const b = nextBirthday(p.dob, now);
      if (b && s.birthdayDays.some((t) => b.days <= t)) alerts.push({
        type: 'birthday', severity: b.age === 18 ? 'gold' : b.days === 0 ? 'critical' : 'info', days: b.days, dueDate: null, overdue: false,
        subject, record: p, age: b.age,
        proof: { he: `יום הולדת ${b.age} ${whenHe(b.days)}${b.age === 18 ? ' · בגיר' : ''}`, en: `Turns ${b.age} ${whenEn(b.days)}${b.age === 18 ? ' · adult' : ''}` },
      });
    }
  }

  for (const m of input.matches ?? []) {
    if (m.deletedAt || m.status === 'cancelled') continue;
    const d = daysAway(m.date, now);
    if (d === null || d < 0 || !s.matchDays.length || d > Math.max(...s.matchDays)) continue;
    const name = `${str(m.homeTeam)} – ${str(m.awayTeam)}`;
    alerts.push({
      type: 'match', severity: d === 0 ? 'warning' : 'info', days: d, dueDate: toDateStr(m.date), overdue: false,
      subject: { kind: 'match', id: str(m.id), name }, record: m,
      proof: { he: `משחק ${whenHe(d)}${m.time ? ` ב-${str(m.time)}` : ''}${m.stadiumName ? ` · ${str(m.stadiumName)}` : ''}`, en: `Match ${whenEn(d)}${m.time ? ` at ${str(m.time)}` : ''}${m.stadiumName ? ` · ${str(m.stadiumName)}` : ''}` },
    });
  }

  for (const d of input.deals ?? []) {
    if (d.deletedAt || d.closedAt) continue;
    const enteredMs = millis(d.enteredStageAt) ?? millis(d.createdAt);
    if (enteredMs == null) continue;
    const since = daysBetween(israelDate(new Date(enteredMs)), today);
    if (since < s.dealStaleDays) continue;
    const name = `${str(d.playerName)} ↔ ${str(d.clubName)}`;
    alerts.push({
      type: 'deal_stale', severity: since >= s.dealStaleDays * 2 ? 'critical' : 'warning', days: -since, dueDate: null, overdue: true,
      subject: { kind: 'deal', id: str(d.id), name }, record: d,
      proof: { he: `${since} ימים בשלב "${str(d.stage)}" בלי התקדמות`, en: `${since} days in "${str(d.stage)}" without progress` },
    });
  }

  for (const r of input.requirements ?? []) {
    if (r.deletedAt || r.status === 'filled' || r.status === 'closed') continue;
    const d = daysAway(r.validUntil, now);
    if (d === null || d > 0) continue;
    alerts.push({
      type: 'requirement_expired', severity: 'warning', days: d, dueDate: toDateStr(r.validUntil), overdue: true,
      subject: { kind: 'requirement', id: str(r.id), name: `${str(r.clubName)}${r.requiredPosition ? ` · ${str(r.requiredPosition)}` : ''}` }, record: r,
      proof: { he: `הדרישה פגה ${whenHe(d)}`, en: `Requirement expired ${whenEn(d)}` },
    });
  }

  for (const x of input.tasks ?? []) {
    if (x.deletedAt || x.done || !x.dueDate) continue;
    const d = daysAway(x.dueDate, now);
    if (d === null || d > 0) continue;
    alerts.push({
      type: 'task_overdue', severity: d < 0 ? 'critical' : 'gold', days: d, dueDate: toDateStr(x.dueDate), overdue: d < 0,
      subject: { kind: 'task', id: str(x.id), name: str(x.title) }, record: x,
      proof: { he: d === 0 ? 'משימה להיום' : `משימה באיחור של ${-d} ימים`, en: d === 0 ? 'Task due today' : `Task ${-d} days overdue` },
    });
  }

  // The IFA sync found a squad for a player that cannot be his (wrong age
  // group, or another club) and linked nothing; someone has to look. The
  // import clears autoFetch.ifaFail on the next run that passes its checks.
  for (const p of input.players ?? []) {
    const fail = (p.autoFetch as Record<string, unknown> | undefined)?.ifaFail as Record<string, unknown> | undefined;
    if (!fail || fail.reason !== 'ifa-squad-mismatch') continue;
    alerts.push({
      type: 'sync_mismatch', severity: 'warning', days: null, dueDate: null, overdue: false,
      subject: { kind: 'player', id: str(p.id), name: playerName(p) }, record: p,
      proof: { he: `הסנכרון לא קישר משחקים: ${str(fail.detail)}`, en: `Sync linked no matches: ${str(fail.detail)}` },
    });
  }

  const windowMs = (input.jobWindowHours ?? 24) * 3600000;
  for (const j of input.jobs ?? []) {
    if (j.status !== 'error') continue;
    const started = millis(j.startedAt);
    if (started == null || now.getTime() - started > windowMs) continue;
    alerts.push({
      type: 'job_failed', severity: 'critical', days: null, dueDate: null, overdue: false,
      subject: { kind: 'job', id: str(j.id), name: str(j.name) }, record: j,
      proof: { he: `עבודת הלילה "${str(j.name)}" נכשלה: ${str(j.error).slice(0, 120)}`, en: `Night job "${str(j.name)}" failed: ${str(j.error).slice(0, 120)}` },
    });
  }

  const order: Record<Severity, number> = { critical: 0, warning: 1, gold: 2, info: 3 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity] || (a.days ?? 0) - (b.days ?? 0));

  const byType = Object.fromEntries((['contract', 'repr', 'passport', 'birthday', 'match', 'deal_stale', 'requirement_expired', 'task_overdue', 'job_failed', 'sync_mismatch'] as AlertType[])
    .map((k) => [k, alerts.filter((a) => a.type === k)])) as Record<AlertType, Alert[]>;
  // Matches are information, not action; the total counts what needs doing.
  const total = alerts.filter((a) => a.type !== 'match').length;
  return { alerts, byType, total };
}
