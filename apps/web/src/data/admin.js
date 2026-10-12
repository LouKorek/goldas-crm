// The admin area's data: the night jobs and their runs, quotas, backups,
// the full audit log and the errors the app itself reported. Everything is
// read straight from the collections the functions already write; the one
// write here (the TM Watch credit budget) is an admin-only setting.
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
  { name: 'nightly-engines', he: 'מנועי הלילה (התראות, ציונים)', when: 'יומי 03:00 UTC', run: 'nightly-engines' },
  { name: 'send-alerts', he: 'תקציר התראות באימייל', when: 'יומי 05:30 UTC', run: 'send-alerts' },
  { name: 'golda-briefing', he: 'תדריך גולדה והתראות', when: 'כל שעה ב-:30', run: 'golda-briefing' },
  { name: 'tm-watch', he: 'מעקב Transfermarkt', when: 'יומי 04:30 UTC', run: 'tm-watch' },
  { name: 'ig-watch', he: 'אינסטגרם הסוכנות', when: 'יומי 03:50 UTC', run: 'ig-watch' },
  { name: 'backup-weekly', he: 'גיבוי שבועי', when: 'ראשון 01:30 UTC', run: 'backup' },
  { name: 'golda-queue', he: 'תור הודעות גולדה (ניסיונות חוזרים)', when: 'כל 10 דקות', run: null },
  { name: 'migrate', he: 'מיגרציות נתונים', when: 'אחרי כל פריסה', run: null },
];

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
      screen: screen || window.location.pathname,
      source,
      version: typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev', // eslint-disable-line no-undef
      userAgent: navigator.userAgent.slice(0, 300),
      email: email || null,
      at: serverTimestamp(),
    });
  } catch (e) { console.warn('could not report error:', e?.message); }
}
