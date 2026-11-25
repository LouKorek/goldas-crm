// The admin area's data: the night jobs and their runs, quotas, backups,
// the full audit log and the errors the app itself reported. Everything is
// read straight from the collections the functions already write; the one
// write here (the TM Watch credit budget) is an admin-only setting. What
// Golda's model calls cost comes from a function (golda-cost): the browser
// never reads that ledger itself.
import {
  collection, doc, onSnapshot, query, orderBy, limit, getDocs, setDoc, addDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from 'lib/firebase';
import { currentUserMeta } from 'lib/db';
import { callFunctionJson } from 'lib/api';

const listen = (q, callback, label) =>
  onSnapshot(q, (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error(`${label} listen error:`, err); callback([]); });

/** The night jobs and the manual runs, newest first. */
export const listenJobs = (callback, n = 200) =>
  listen(query(collection(db, 'jobs'), orderBy('startedAt', 'desc'), limit(n)), callback, 'jobs');

/** The scheduled jobs the Health tab knows, with their schedule in words. */
export const JOBS = [
  { name: 'sync-matches', he: 'סנכרון משחקים', when: 'יומי 03:10 UTC', run: 'sync-matches' },
  { name: 'ifa-server-sync', he: 'משחקי ההתאחדות (ישראל)', when: 'יומי 03:00 UTC', run: 'ifa-server-sync' },
  { name: 'nightly-engines', he: 'מנועי הלילה (התראות, ציונים)', when: 'יומי 03:00 UTC', run: 'nightly-engines' },
  { name: 'send-alerts', he: 'תקציר התראות באימייל והתראות לטלפון', when: 'יומי 06:00 UTC', run: 'send-alerts' },
  { name: 'golda-briefing', he: 'תדריך גולדה והתראות', when: 'כל שעה ב-:30', run: 'golda-briefing' },
  { name: 'tm-watch', he: 'מעקב Transfermarkt', when: 'יומי 04:30 UTC', run: 'tm-watch' },
  { name: 'ig-watch', he: 'אינסטגרם הסוכנות', when: 'יומי 03:50 UTC', run: 'ig-watch' },
  { name: 'backup-weekly', he: 'גיבוי שבועי', when: 'נבדק כל לילה 01:30 UTC, רץ כשעבר שבוע', run: 'backup' },
  { name: 'backup-restore', he: 'שחזור מגיבוי', when: 'ידני, ממסך הגיבויים', run: null },
  { name: 'meta-onboard', he: 'מעבר גולדה למספר שלה (055)', when: 'כל שעה ב-:45 עד שמסתיים', run: 'meta-onboard' },
  { name: 'golda-queue', he: 'תור הודעות גולדה (ניסיונות חוזרים)', when: 'כל 10 דקות', run: null },
  { name: 'golda-meeting-brief', he: 'הכנה של גולדה לפני פגישה', when: 'כשעה לפני כל פגישה ביומן', run: null },
  { name: 'golda-player-sends', he: 'הודעות של גולדה לשחקנים', when: 'נבדק כל 10 דקות, 08:00–22:00', run: null },
  { name: 'gmail-sync', he: 'מיילים מ-Gmail לרשומות', when: 'כל 15 דקות, כשהתיבה מחוברת', run: 'gmail-sync' },
  { name: 'golda-radar', he: 'רדאר השוק של גולדה (חדשות, פציעות, מאמנים)', when: 'כל 3 שעות, 07:00–22:00', run: 'golda-radar' },
  { name: 'migrate', he: 'מיגרציות נתונים', when: 'אחרי כל פריסה', run: null },
];

// ── WhatsApp: the server's own Meta key and Golda's move to her number ──
/** app_meta/metaConnect: connected?, scopes, onboard { stage, phone, account, ... } (no secrets). */
export const listenMetaConnect = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'metaConnect'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('metaConnect error:', e); callback({}); });
/** The Facebook sign-in address (meta-connect); the page navigates there. */
export const startMetaConnect = () => callFunctionJson('meta-connect', { method: 'POST' });

/**
 * The last run of every job (app_meta/jobStatus, written by lib/jobs.js):
 * { [name]: { last, lastError, runningSince } }. The recent list holds only
 * the newest runs, so a weekly job is read from here once it has scrolled out.
 */
export const listenJobStatus = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'jobStatus'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('jobStatus error:', e); callback({}); });

/** Start a job now (admin-run-job → the worker or ops-background). */
export const runJobNow = (job) => callFunctionJson('admin-run-job', { method: 'POST', body: { job } });

/** Group runs by job name: the latest run first in each group. */
export function groupRuns(runs) {
  const by = {};
  for (const r of runs) (by[r.name] = by[r.name] || []).push(r);
  return by;
}

// ── Quotas ──────────────────────────────────────────────────────────
export const fetchScraperStatus = () => callFunctionJson('scraper-status');

export const listenTmWatchMeta = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'tmWatch'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('tmWatch meta error:', e); callback({}); });

export const saveTmWatchBudget = ({ creditBudget, creditReserve }) => {
  const { email } = currentUserMeta();
  return setDoc(doc(db, 'app_meta', 'tmWatch'), {
    creditBudget: Math.max(0, Number(creditBudget) || 0), creditReserve: Math.max(0, Number(creditReserve) || 0),
    budgetUpdatedAt: serverTimestamp(), budgetUpdatedBy: email,
  }, { merge: true });
};

/** Production deploys per month (deploy-succeeded counts them; 15 credits each). */
export const listenDeploys = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'deploys'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('deploys meta error:', e); callback({}); });

/** Golda's usage today, summed over every conversation (wa_sessions/*.usage). */
export const listenGoldaUsage = (callback) =>
  onSnapshot(collection(db, 'wa_sessions'), (snap) => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    let count = 0, inputTokens = 0, outputTokens = 0, sessions = 0;
    snap.docs.forEach((d) => {
      const u = d.data().usage;
      if (u && u.date === today) { count += u.count || 0; inputTokens += u.inputTokens || 0; outputTokens += u.outputTokens || 0; sessions++; }
    });
    callback({ count, inputTokens, outputTokens, sessions, today });
  }, (e) => { console.error('wa_sessions error:', e); callback({ count: 0, inputTokens: 0, outputTokens: 0, sessions: 0 }); });

/**
 * What Golda's model calls cost (golda-cost, admin only): today and the last
 * 14 days in USD, per kind of work, and the daily ceiling on the work she
 * starts by herself. Numbers only.
 */
export const fetchGoldaCost = () => callFunctionJson('golda-cost');
/** Change the daily ceiling (0 to 100 USD; 0 switches her own work off). Answers the meter again. */
export const saveGoldaCostCap = (capUsd) => callFunctionJson('golda-cost', { method: 'POST', body: { capUsd: Number(capUsd) } });

// ── Backups ─────────────────────────────────────────────────────────
export const listenBackups = (callback) =>
  listen(query(collection(db, 'backups'), orderBy('startedAt', 'desc'), limit(20)), callback, 'backups');

/** Rebuild one backup from its chunks and hand it to the browser as a file. */
export async function downloadBackup(backup) {
  const snap = await getDocs(query(collection(db, 'backups', backup.id, 'chunks'), orderBy('i')));
  const text = snap.docs.map((d) => d.data().text || '').join('');
  const when = backup.startedAt?.toDate?.() || new Date();
  const name = `goldas-backup-${when.toISOString().slice(0, 10)}-${backup.id.slice(0, 6)}.jsonl`;
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return { name, chars: text.length };
}

/** Records in one backup whose name holds the words (backup-restore 'find'). */
export const findInBackup = (backupId, q) => callFunctionJson('backup-restore', { method: 'POST', body: { op: 'find', backupId, q } });
/** Put one record back as it was in that backup. Starts in the background. */
export const restoreRecord = (backupId, path) => callFunctionJson('backup-restore', { method: 'POST', body: { op: 'one', backupId, path } });
/** Put everything back, from a backup or from a copy kept outside the database. */
export const restoreEverything = ({ backupId, offsiteKey }) => callFunctionJson('backup-restore', { method: 'POST', body: { op: 'all', backupId, offsiteKey } });
/** The copies kept outside the database, newest first: [{ key, date, id }]. */
export const fetchOffsiteCopies = () => callFunctionJson('backup-restore', { method: 'POST', body: { op: 'offsite' } });

// ── Audit log ───────────────────────────────────────────────────────
export const listenAudit = (callback, n = 300) =>
  listen(query(collection(db, 'audit'), orderBy('at', 'desc'), limit(n)), callback, 'audit');

// ── Client errors ───────────────────────────────────────────────────
export const listenClientErrors = (callback, n = 200) =>
  listen(query(collection(db, 'client_errors'), orderBy('at', 'desc'), limit(n)), callback, 'client_errors');

let reported = 0;
/** Record an error the app hit in the browser. Capped per page load so a loop cannot flood the collection. */
export async function reportClientError(error, { screen, source = 'window' } = {}) {
  if (reported >= 5) return;
  reported++;
  try {
    const { email } = currentUserMeta();
    await addDoc(collection(db, 'client_errors'), {
      message: String(error?.message || error || '').slice(0, 500),
      stack: String(error?.stack || '').slice(0, 3000),
      // The pages whose address is itself a key (/p/<token>, /yt/<token>, /sign/<token>) are recorded without it.
      screen: screen || window.location.pathname.replace(/^\/(p|yt|sign)\/.*/, '/$1/…'),
      source,
      version: typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev', // eslint-disable-line no-undef
      userAgent: navigator.userAgent.slice(0, 300),
      email: email || null,
      at: serverTimestamp(),
    });
  } catch (e) { console.warn('could not report error:', e?.message); }
}
