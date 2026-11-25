// The agency's mail on its records (netlify/functions/mail.js, lib/mail-store.js).
//
// The browser never reads the stored mail from the database: every list comes
// from the mail function, which decides by role what is shown. Only the
// connection's public status (app_meta/gmail: no secrets) is read directly,
// for System › Email.
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { callFunctionJson } from 'lib/api';

/** app_meta/gmail: connected, address, lastSyncAt, linkedCount, state, book, api, lastError (no secrets). */
export const listenGmail = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'gmail'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('gmail error:', e); callback({}); });

/** The threads of one record, newest first: { connected, address, threads }. kind: deal | club | contact. */
export const fetchRecordMail = (kind, id) => callFunctionJson('mail', { query: { [kind]: id } });

const post = (body) => callFunctionJson('mail', { method: 'POST', body });
/** Put a message on these deals (admin); an empty list takes it off every deal. */
export const setMailDeals = (id, dealIds) => post({ action: 'deals', id, dealIds });
/** "Not agency mail": the message leaves every record and never comes back. */
export const hideMail = (id) => post({ action: 'hide', id });
/** Undo a hand correction: the links go back to what the sync matched. */
export const resetMail = (id) => post({ action: 'reset', id });
/** The Google consent address; the page navigates there. */
export const startGmailConnect = () => post({ action: 'start' });
export const syncGmailNow = () => post({ action: 'sync' });
/** Forget the key and delete every stored message. */
export const disconnectGmail = () => post({ action: 'disconnect' });

/** Opens the thread in Gmail, in the connected mailbox when the browser has several. */
export const gmailThreadUrl = (address, threadId) =>
  `https://mail.google.com/mail/${address ? `?authuser=${encodeURIComponent(address)}` : ''}#all/${threadId}`;
