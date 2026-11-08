// Meetings: Lou's agency calendar "Gold A&S" (meetings with players,
// business meetings, everything of the agency that is not a game or a
// training). Each record is one event in that Google calendar; the server
// keeps both sides the same (netlify/functions/lib/agency-calendar.js), so a
// change here reaches Google within a minute and one there arrives here
// within ten. Guests, the Meet link and the calendar link come from Google.
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, restoreDoc_, PATHS, currentUserMeta } from 'lib/db';
import { callFunctionJson } from 'lib/api';

export const listenMeetings = (callback) => listenCollection(PATHS.MEETINGS, callback);

// The sync runs every ten minutes; after a change here, ask for it now.
let kicked = 0;
const kick = () => {
  if (Date.now() - kicked < 4000) return;
  kicked = Date.now();
  callFunctionJson('calendar-sync-background', { method: 'POST', body: { reason: 'app' } }).catch(() => {});
};
const after = (p) => p.then((r) => { kick(); return r; });

export const addMeeting = (data) => {
  const { email } = currentUserMeta();
  return after(addDoc_(PATHS.MEETINGS, {
    title: '', date: '', time: '', endTime: '', endDate: '', allDay: false, location: '', notes: '', linkedPlayers: [],
    owner: email, source: 'manual', ...data,
  }));
};
export const updateMeeting = (id, patch) => after(updateDoc_(PATHS.MEETINGS, id, patch));
export const deleteMeeting = (id) => after(deleteDoc_(PATHS.MEETINGS, id));
export const restoreMeeting = (id) => after(restoreDoc_(PATHS.MEETINGS, id));
