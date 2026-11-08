// Harness stand-in for data/calendarSync: ?cal=ok shows a connected sync.
export const CALENDAR_URL = 'https://calendar.google.com/calendar/u/0/r';
const ok = new URLSearchParams(location.search).get('cal') === 'ok';
export const listenCalendarSync = (cb) => {
  setTimeout(() => cb(ok
    ? { state: 'ok', serviceAccount: 'firebase-adminsdk-x@gold-as-crm.iam.gserviceaccount.com', lastCheckAt: Date.now() - 4 * 60000, lastFullMs: Date.now() - 34 * 60000, lastResult: { changed: true, items: 47, insert: 31, adopt: 14, import: 6, none: 2 } }
    : { state: 'needs_share', serviceAccount: 'firebase-adminsdk-x@gold-as-crm.iam.gserviceaccount.com' }), 50);
  return () => {};
};
export const runCalendarSync = async () => ({});
export const connectCalendar = async () => ({ ok: true, message: 'ok' });
export const CALENDAR_ID = 'player-cal';
export const AGENCY_CALENDAR_ID = 'agency-cal';
export const listenAgencyCalendar = (cb) => { setTimeout(() => cb(ok ? { state: 'ok', lastCheckAt: Date.now() - 3 * 60000, lastResult: { import: 3, none: 0 } } : { state: 'needs_share' }), 50); return () => {}; };
