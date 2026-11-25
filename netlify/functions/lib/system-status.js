// What the system says about its own health, for a check from outside the
// CRM (system-status.js): did the scheduled jobs run, is the mailbox being
// read, is there a good backup, how many phones take notifications.
//
// The page is open to anyone who has the address, so it holds states, times
// and counts only. Every value is either a number, a time, a yes/no or one
// word from a fixed list below: never a name, an address, an id, a file name,
// an error text or anything else a person typed. A value that is not on a
// list comes out as "unknown".
const JOB_NAME = /^[a-z][a-z0-9-]{1,40}$/;
const JOB_STATES = new Set(['ok', 'error']);
const TRIGGERS = new Set(['schedule', 'manual', 'deploy']);
const MAIL_STATES = new Set(['ok', 'no_addresses', 'needs_api', 'error']);
const API_STATES = new Set(['on', 'off', 'switched_on']);
const BACKUP_STATES = new Set(['ok', 'partial', 'error', 'running']);

const word = (v, allowed) => (allowed.has(v) ? v : v == null ? null : 'unknown');
const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : null);
/** A Firestore time, a number of milliseconds or an ISO string, as ISO; null when it is none of them. */
function when(v) {
  const ms = v == null ? NaN : typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : typeof v._seconds === 'number' ? v._seconds * 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}
const data = (snap) => (snap && snap.exists ? snap.data() || {} : {});

function jobsOf(status) {
  const out = {};
  for (const [name, j] of Object.entries(status || {})) {
    if (!JOB_NAME.test(name) || !j || typeof j !== 'object') continue;
    const last = j.last || {};
    out[name] = {
      status: word(last.status, JOB_STATES), at: when(last.startedAt), seconds: count(last.durationMs) == null ? null : Math.round(last.durationMs / 1000),
      trigger: word(last.trigger, TRIGGERS), running: !!j.runningSince, lastFailedAt: when(j.lastError && j.lastError.startedAt),
    };
  }
  return out;
}

function mailOf(m) {
  return {
    connected: !!m.connected, state: word(m.state, MAIL_STATES), api: word(m.api && m.api.state, API_STATES),
    contactAddresses: count(m.book && m.book.emails), clubDomains: count(m.book && m.book.domains),
    messagesKept: count(m.linkedCount), waiting: count(m.backlog), lastReadAt: when(m.lastSyncAt), lastFailedAt: when(m.lastError && m.lastError.at),
  };
}

function backupOf(rows) {
  const sorted = [...rows].sort((a, b) => (Date.parse(when(b.startedAt) || 0) || 0) - (Date.parse(when(a.startedAt) || 0) || 0));
  const one = (b) => (b ? { status: word(b.status, BACKUP_STATES), at: when(b.startedAt), readBackOk: b.verified === true, outsideCopy: !!b.offsite, documents: count(b.docs) } : null);
  return { latest: one(sorted[0]), latestGood: one(sorted.find((b) => (b.status === 'ok' || b.status === 'partial') && b.verified !== false)) };
}

/** The whole status. Reads four small things and never throws for one of them. */
async function readStatus(db, now = Date.now()) {
  const safe = async (read, fallback) => { try { return await read(); } catch { return fallback; } };
  const [jobs, mail, backups, phones] = await Promise.all([
    safe(() => db.collection('app_meta').doc('jobStatus').get().then(data), null),
    safe(() => db.collection('app_meta').doc('gmail').get().then(data), null),
    safe(() => db.collection('backups').orderBy('startedAt', 'desc').limit(8).get().then((s) => s.docs.map((d) => d.data() || {})), null),
    safe(() => db.collection('push_subscriptions').limit(200).get().then((s) => s.docs.length), null),
  ]);
  return {
    at: new Date(now).toISOString(),
    jobs: jobs ? jobsOf(jobs) : null,
    mail: mail ? mailOf(mail) : null,
    backup: backups ? backupOf(backups) : null,
    notifications: { devices: phones },
  };
}

module.exports = { readStatus, jobsOf, mailOf, backupOf, when };
