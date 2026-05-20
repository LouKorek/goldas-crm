// Single source of truth for notification alerts.
// Both the Dashboard and the Notifications page use this, so they always
// show exactly the same set. The Apps Script email job uses the same
// thresholds (stored in Firestore settings/notifications), so email,
// Dashboard and Notifications stay in sync.

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { daysUntil, calcAge } from './constants';

export const DEFAULT_SETTINGS = {
  contractDays: [7, 30, 60],
  reprDays:     [7, 30, 60],
  passportDays: [30, 90, 180],
  birthdayDays: [0, 3, 7],
};

const SETTINGS_COL = 'settings';
const SETTINGS_ID  = 'notifications';

// Save the user's settings to Firestore (read by the email script) + cache.
export const persistSettings = (s) => {
  try { localStorage.setItem('notif_settings', JSON.stringify(s)); } catch (e) {}
  try { setDoc(doc(db, SETTINGS_COL, SETTINGS_ID), s, { merge: true }); } catch (e) {}
};

// Firestore is the source of truth; fall back to localStorage, then defaults.
export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, SETTINGS_COL, SETTINGS_ID));
    if (snap.exists()) {
      const fs = { ...DEFAULT_SETTINGS, ...snap.data() };
      try { localStorage.setItem('notif_settings', JSON.stringify(fs)); } catch (e) {}
      return fs;
    }
  } catch (e) {}
  try {
    const saved = JSON.parse(localStorage.getItem('notif_settings') || 'null');
    if (saved) return { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) {}
  return DEFAULT_SETTINGS;
}

// Days until the next occurrence of a birthday (>= 0), or null.
export function daysUntilBirthday(dob, now = new Date()) {
  if (!dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth)) return null;
  const next = new Date(now.getFullYear(), birth.getMonth(), birth.getDate());
  if (next < now) next.setFullYear(now.getFullYear() + 1);
  return Math.ceil((next - now) / (1000 * 60 * 60 * 24));
}

// Compute the full alert set from players + matches + settings.
// Returns categorised arrays of { id, player, days, ... } plus a total.
export function computeAlerts(players = [], matches = [], settings = DEFAULT_SETTINGS, now = new Date()) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const within = (d, thresholds) =>
    d !== null && d >= 0 && (thresholds || []).some(t => d <= t);

  const contract = [];
  const repr = [];
  const passport = [];
  const birthday = [];

  players.forEach(p => {
    if (p.contractEnd) {
      const d = daysUntil(p.contractEnd);
      if (within(d, s.contractDays))
        contract.push({ id: p.id, player: p, days: d, urgency: d <= 7 ? 'critical' : d <= 30 ? 'warning' : 'info' });
    }
    if (p.reprEnd) {
      const d = daysUntil(p.reprEnd);
      if (within(d, s.reprDays))
        repr.push({ id: p.id, player: p, days: d, urgency: d <= 7 ? 'critical' : d <= 30 ? 'warning' : 'info' });
    }
    if (p.passportExpiry) {
      const d = daysUntil(p.passportExpiry);
      if (within(d, s.passportDays))
        passport.push({ id: p.id, player: p, days: d, urgency: d <= 30 ? 'critical' : d <= 90 ? 'warning' : 'info' });
    }
    if (p.dob) {
      const bd = daysUntilBirthday(p.dob, now);
      if (bd !== null && bd >= 0 && s.birthdayDays.some(t => bd <= t)) {
        const age = (calcAge(p.dob) || 0) + 1;
        birthday.push({
          id: p.id, player: p, days: bd, age,
          turning18: age === 18,
          urgency: age === 18 ? 'gold' : bd === 0 ? 'critical' : 'info',
        });
      }
    }
  });

  [contract, repr, passport, birthday].forEach(a => a.sort((x, y) => x.days - y.days));

  const upcomingMatches = (matches || [])
    .filter(m => m.date && new Date(m.date) >= now)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const total = contract.length + repr.length + passport.length + birthday.length;
  return { contract, repr, passport, birthday, matches: upcomingMatches, total };
}
