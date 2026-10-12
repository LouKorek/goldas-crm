// Thin adapter over the domain alerts engine (packages/domain/src/engines).
// The engine is the single source of truth for Home, the Notifications
// screen, the daily email and Golda; this file keeps the settings round trip
// (Firestore + localStorage) and the shape older screens still expect.

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { canEditNow } from './db';
import {
  computeAlerts as engineAlerts, mergeSettings, DEFAULT_ALERT_SETTINGS,
  daysAway as engineDaysAway, nextBirthday, toDateStr,
} from '@goldas/domain';

export const DEFAULT_SETTINGS = {
  contractDays: DEFAULT_ALERT_SETTINGS.contractDays,
  reprDays:     DEFAULT_ALERT_SETTINGS.reprDays,
  passportDays: DEFAULT_ALERT_SETTINGS.passportDays,
  birthdayDays: DEFAULT_ALERT_SETTINGS.birthdayDays,
};

const SETTINGS_COL = 'settings';
const SETTINGS_ID  = 'notifications';

// ── Calendar arithmetic (Israel time, from the engine) ──────────────
export function parseLocalDate(s) {
  const str = toDateStr(s);
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Whole days from today to `dateStr`. 0 = today, negative = already past.
export const daysAway = (dateStr, now = new Date()) => engineDaysAway(dateStr, now);

// Days to the next occurrence of a birthday (0 on the day itself).
export const daysUntilBirthday = (dob, now = new Date()) => nextBirthday(dob, now)?.days ?? null;

// How old they turn on that next birthday.
export const ageOnNextBirthday = (dob, now = new Date()) => nextBirthday(dob, now)?.age ?? null;

// "today" / "1 day" / "3 days" / "2 days ago" — one phrasing everywhere.
export function dayLabel(d) {
  if (d === 0) return 'today';
  if (d === 1) return '1 day';
  if (d === -1) return '1 day ago';
  return d > 0 ? `${d} days` : `${Math.abs(d)} days ago`;
}

// ── Settings ────────────────────────────────────────────────────
// An empty array is a real choice — "never alert me about this" — so it is
// stored as-is and must survive the round trip.
export async function persistSettings(s) {
  if (!canEditNow()) throw new Error('View-only access: you do not have permission to make changes.');
  try { localStorage.setItem('notif_settings', JSON.stringify(s)); } catch (e) {}
  await setDoc(doc(db, SETTINGS_COL, SETTINGS_ID), s, { merge: true });
}

const clean = (raw) => {
  const m = mergeSettings(raw);
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = m[k];
  if (typeof raw?.dealStaleDays === 'number') out.dealStaleDays = raw.dealStaleDays;
  return out;
};

// Firestore is the source of truth; fall back to localStorage, then defaults.
export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, SETTINGS_COL, SETTINGS_ID));
    if (snap.exists()) {
      const fs = clean(snap.data());
      try { localStorage.setItem('notif_settings', JSON.stringify(fs)); } catch (e) {}
      return fs;
    }
  } catch (e) {}
  try {
    const saved = JSON.parse(localStorage.getItem('notif_settings') || 'null');
    if (saved) return clean(saved);
  } catch (e) {}
  return DEFAULT_SETTINGS;
}

// ── The unified alert set ───────────────────────────────────────
/**
 * Every alert the agency should act on, in one list, from the domain engine.
 * `unifiedAlerts({ players, matches, deals, requirements, tasks, jobs, settings, now })`
 * → { alerts, byType, total }. Matches are listed but not counted.
 */
export const unifiedAlerts = (input) => engineAlerts(input);

/** Where an alert leads when tapped. */
export function alertLink(a) {
  switch (a.subject.kind) {
    case 'player': return `/players/${a.subject.id}`;
    case 'deal': return `/market/deals?deal=${a.subject.id}`;
    case 'requirement': return `/market/requirements?req=${a.subject.id}`;
    case 'task': return '/tasks';
    case 'match': return '/calendar';
    default: return '/home/today';
  }
}

// Legacy shape — { contract, repr, passport, birthday, matches, total } with
// { id, player, days, overdue, date, urgency } items — for the Dashboard.
export function computeAlerts(players = [], matches = [], settings = DEFAULT_SETTINGS, now = new Date()) {
  const r = engineAlerts({ players, matches, settings, now });
  const legacy = (a) => ({
    id: a.subject.id, player: a.record, days: a.days, overdue: a.overdue, date: a.dueDate,
    urgency: a.severity, age: a.age, turning18: a.age === 18,
  });
  const contract = r.byType.contract.map(legacy);
  const repr = r.byType.repr.map(legacy);
  const passport = r.byType.passport.map(legacy);
  const birthday = r.byType.birthday.map(legacy);
  [contract, repr, passport, birthday].forEach((a) => a.sort((x, y) => x.days - y.days));
  const upcomingMatches = (matches || [])
    .map((m) => ({ ...m, daysAway: engineDaysAway(m.date, now) }))
    .filter((m) => m.daysAway !== null && m.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway);
  return { contract, repr, passport, birthday, matches: upcomingMatches, total: contract.length + repr.length + passport.length + birthday.length };
}
