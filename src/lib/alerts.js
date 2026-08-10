// Single source of truth for notification alerts.
// Both the Dashboard and the Notifications page use this, so they always
// show exactly the same set. The send-alerts Netlify function uses the same
// thresholds (stored in Firestore settings/notifications) and the same date
// arithmetic, so email, Dashboard and Notifications stay in sync.

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { canEditNow } from './db';

export const DEFAULT_SETTINGS = {
  contractDays: [7, 30, 60],
  reprDays:     [7, 30, 60],
  passportDays: [30, 90, 180],
  birthdayDays: [0, 3, 7],
};

const SETTINGS_COL = 'settings';
const SETTINGS_ID  = 'notifications';

// ── Calendar arithmetic ─────────────────────────────────────────
// Everything here counts whole calendar days in the user's own timezone.
// The obvious `new Date(str) - new Date()` does not: 'YYYY-MM-DD' parses as
// UTC midnight, so from 03:00 Israel time onwards today's date already looks
// like the past. That single detail was hiding today's matches and every
// birthday on the morning of the birthday itself.
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function parseLocalDate(s) {
  if (!s) return null;
  if (s instanceof Date) return isNaN(s) ? null : startOfDay(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d) ? null : startOfDay(d);
}

// Whole days from today to `dateStr`. 0 = today, negative = already past.
export function daysAway(dateStr, now = new Date()) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  return Math.round((d - startOfDay(now)) / 86400000);
}

// Days to the next occurrence of a birthday (0 on the day itself).
export function daysUntilBirthday(dob, now = new Date()) {
  const b = parseLocalDate(dob);
  if (!b) return null;
  const today = startOfDay(now);
  const next = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  if (next < today) next.setFullYear(now.getFullYear() + 1);
  return Math.round((next - today) / 86400000);
}

// How old they turn on that next birthday — 18 on the morning of the 18th,
// not 19. Mirrors ageOnNextBirthday() in send-alerts.js exactly.
export function ageOnNextBirthday(dob, now = new Date()) {
  const b = parseLocalDate(dob);
  if (!b) return null;
  let age = now.getFullYear() - b.getFullYear();
  if (new Date(now.getFullYear(), b.getMonth(), b.getDate()) < startOfDay(now)) age += 1;
  return age;
}

// "today" / "1 day" / "3 days" / "2 days ago" — one phrasing everywhere.
export function dayLabel(d) {
  if (d === 0) return 'today';
  if (d === 1) return '1 day';
  if (d === -1) return '1 day ago';
  return d > 0 ? `${d} days` : `${Math.abs(d)} days ago`;
}

// ── Settings ────────────────────────────────────────────────────
// Save the user's settings to Firestore (read by the email job) + cache.
// An empty array is a real choice — "never alert me about this" — so it is
// stored as-is and must survive the round trip.
export async function persistSettings(s) {
  if (!canEditNow()) throw new Error('View-only access: you do not have permission to make changes.');
  try { localStorage.setItem('notif_settings', JSON.stringify(s)); } catch (e) {}
  await setDoc(doc(db, SETTINGS_COL, SETTINGS_ID), s, { merge: true });
}

// Firestore is the source of truth; fall back to localStorage, then defaults.
export async function loadSettings() {
  const clean = (raw) => {
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (Array.isArray(raw?.[k])) out[k] = raw[k].map(Number).filter(n => !isNaN(n));
    }
    return out;
  };
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

// ── The alert set ───────────────────────────────────────────────
// Compute the full alert set from players + matches + settings.
// Returns categorised arrays of { id, player, days, ... } plus a total.
export function computeAlerts(players = [], matches = [], settings = DEFAULT_SETTINGS, now = new Date()) {
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (Array.isArray(settings?.[k])) s[k] = settings[k];
  }

  // A date that has already passed is not "not due yet" — it is the most
  // urgent thing on the screen, so it stays until the record is updated.
  // An empty threshold list switches the category off entirely, overdue
  // included: that is what unticking every chip is for.
  const due = (d, thresholds) =>
    d !== null && (thresholds || []).length > 0 && (d < 0 || thresholds.some(t => d <= t));

  const contract = [];
  const repr = [];
  const passport = [];
  const birthday = [];

  players.forEach(p => {
    if (p.contractEnd && p.contractStatus !== 'Free') {
      const d = daysAway(p.contractEnd, now);
      if (due(d, s.contractDays))
        contract.push({ id: p.id, player: p, days: d, overdue: d < 0, date: p.contractEnd,
          urgency: d <= 7 ? 'critical' : d <= 30 ? 'warning' : 'info' });
    }
    if (p.reprEnd) {
      const d = daysAway(p.reprEnd, now);
      if (due(d, s.reprDays))
        repr.push({ id: p.id, player: p, days: d, overdue: d < 0, date: p.reprEnd,
          urgency: d <= 7 ? 'critical' : d <= 30 ? 'warning' : 'info' });
    }
    if (p.passportExpiry) {
      const d = daysAway(p.passportExpiry, now);
      if (due(d, s.passportDays))
        passport.push({ id: p.id, player: p, days: d, overdue: d < 0, date: p.passportExpiry,
          urgency: d <= 30 ? 'critical' : d <= 90 ? 'warning' : 'info' });
    }
    if (p.dob) {
      const bd = daysUntilBirthday(p.dob, now);
      if (bd !== null && s.birthdayDays.some(t => bd <= t)) {
        const age = ageOnNextBirthday(p.dob, now);
        birthday.push({
          id: p.id, player: p, days: bd, age,
          turning18: age === 18,
          urgency: age === 18 ? 'gold' : bd === 0 ? 'critical' : 'info',
        });
      }
    }
  });

  [contract, repr, passport, birthday].forEach(a => a.sort((x, y) => x.days - y.days));

  // Today's fixtures count as upcoming right up to midnight.
  const upcomingMatches = (matches || [])
    .map(m => ({ ...m, daysAway: daysAway(m.date, now) }))
    .filter(m => m.daysAway !== null && m.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway);

  const total = contract.length + repr.length + passport.length + birthday.length;
  return { contract, repr, passport, birthday, matches: upcomingMatches, total };
}
