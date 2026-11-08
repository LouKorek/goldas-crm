// Lou's Google calendar ("Gold A&S Player Schedule") and the server's sync
// with it (netlify/functions/calendar-sync-background.js).
//
// The server reads and writes the calendar as the Firebase service account,
// so the calendar has to be shared with that account once. connectCalendar()
// does it from Lou's own browser: one Google sign-in popup with the calendar
// sharing scope (and, when the server could not switch the Calendar API on by
// itself, the Cloud scope that does it), then it shares the calendar with the
// service account and starts the first sync. No token leaves the browser.
import { doc, onSnapshot } from 'firebase/firestore';
import { GoogleAuthProvider, reauthenticateWithPopup } from 'firebase/auth';
import { db, auth } from 'lib/firebase';
import { callFunctionJson } from 'lib/api';

export const CALENDAR_ID = '5d6f4890e0c176670656fdbd875703d81565708942bb1f4ada0922702210d66b@group.calendar.google.com';
export const CALENDAR_URL = 'https://calendar.google.com/calendar/u/0/r';

/** app_meta/calendarSync: state, serviceAccount, lastResult, problem (no secrets). */
export const listenCalendarSync = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'calendarSync'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('calendarSync error:', e); callback({}); });

/** Ask the server to sync now (it returns at once; the result lands in app_meta). */
export const runCalendarSync = (force = true) =>
  callFunctionJson('calendar-sync-background', { method: 'POST', body: { force, reason: 'manual' } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function googleFetch(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Share the calendar with the server and start the first sync.
 * Returns { ok, step, message } for the screen.
 */
export async function connectCalendar({ serviceAccount, needsApi, calendarId = CALENDAR_ID }) {
  if (!serviceAccount) return { ok: false, step: 'prepare', message: 'השרת עוד לא מוכן. נסה שוב בעוד דקה.' };
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/calendar.acls');
  if (needsApi) provider.addScope('https://www.googleapis.com/auth/cloud-platform');
  if (auth.currentUser?.email) provider.setCustomParameters({ login_hint: auth.currentUser.email });
  const result = await reauthenticateWithPopup(auth.currentUser, provider);
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) return { ok: false, step: 'signin', message: 'Google לא החזיר הרשאה. נסה שוב.' };

  if (needsApi) {
    const en = await googleFetch(token, 'https://serviceusage.googleapis.com/v1/projects/gold-as-crm/services/calendar-json.googleapis.com:enable', { method: 'POST', body: '{}' });
    if (!en.ok && en.status !== 409) return { ok: false, step: 'api', message: en.data?.error?.message || `הפעלת Google Calendar API נכשלה (${en.status})` };
    await sleep(8000);   // the switch takes a few seconds to reach the Calendar API
  }

  const acl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl?sendNotifications=false`;
  let share = { ok: false };
  for (let i = 0; i < 4 && !share.ok; i++) {
    share = await googleFetch(token, acl, { method: 'POST', body: JSON.stringify({ role: 'writer', scope: { type: 'user', value: serviceAccount } }) });
    if (!share.ok && share.status === 403 && i < 3) await sleep(6000); else break;
  }
  if (!share.ok) return { ok: false, step: 'share', message: share.data?.error?.message || `שיתוף לוח השנה נכשל (${share.status})` };

  await runCalendarSync(true).catch(() => {});
  return { ok: true, step: 'done', message: 'לוח השנה חובר. הסנכרון הראשון רץ עכשיו.' };
}
