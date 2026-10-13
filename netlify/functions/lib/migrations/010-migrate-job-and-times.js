// 010 — close the migrate alert of 13.10 and drop the IFA's "00:00".
//
//   A. jobs/yZpUTyRE6vA9Bw2vXbWE is the first run of migration 008, which
//      refused (26 in range + 1 on 25.5.2026). PR #27 widened the range and
//      the rerun succeeded the same morning, so the job is marked handled
//      and its alert leaves the Home screen. The report names the match
//      that was outside the range and the player record it was linked to.
//   B. The IFA shows "00:00" for a kickoff that is not set yet. Records the
//      sync stored with that time get an empty time; the sync now does the
//      same on import.
const { OWNER_EMAIL } = require('../firestore.js');

const id = '010-migrate-job-and-times';
const title = 'סגירת התראת migrate של 008 ומחיקת שעות 00:00 מההתאחדות';

const JOB = 'yZpUTyRE6vA9Bw2vXbWE';
const OUTSIDE = 'BiMQzHkjGH2HeqfsHKNP';
const LEGACY_PLAYER = 'jvuD01Xphtt2GGETEeTX';

const live = (m) => m && !m.deletedAt;

function planA(jobs, matches, players) {
  const problems = [], skipped = [], writes = [], notes = [];
  const job = jobs.find((j) => j.id === JOB);
  if (!job) skipped.push({ id: `jobs/${JOB}`, reason: 'כבר לא קיים' });
  else if (job.status === 'handled') skipped.push({ id: `jobs/${JOB}`, reason: 'כבר מסומן כטופל' });
  else {
    if (job.status !== 'error') problems.push(`jobs/${JOB}: הסטטוס הוא ${job.status}, לא error`);
    if (!/26 משחקים/.test(String(job.error || ''))) problems.push(`jobs/${JOB}: השגיאה לא מזכירה 26 משחקים (${String(job.error || '').slice(0, 80)})`);
    if (!problems.length) {
      writes.push(['jobs', JOB, {
        status: 'handled', handledAt: new Date().toISOString(), handledBy: OWNER_EMAIL,
        handledNote: 'המשחק שמחוץ לטווח היה מ-25.5.2026, אותה עונה; הטווח הורחב (PR #27) ו-008 רצה בהצלחה ב-13.10 (מיגרציה 010)',
      }, true]);
    }
  }
  const m = matches.find((x) => x.id === OUTSIDE);
  if (m) {
    notes.push(`המשחק שמחוץ לטווח: ${OUTSIDE} · ${m.date} ${m.time || ''} · ${m.homeTeam} - ${m.awayTeam} · שחקנים: ${(m.linkedPlayers || []).join(', ') || 'אין'} · ${m.deletedAt ? `בסל המחזור (${m.deletedVia || ''})` : 'פעיל'}`);
  } else notes.push(`המשחק שמחוץ לטווח (${OUTSIDE}) לא נמצא`);
  const p = players.find((x) => x.id === LEGACY_PLAYER);
  notes.push(p
    ? `רשומת השחקן ${LEGACY_PLAYER}: ${p.fullName || p.name || '(בלי שם)'} · ${p.currentClub || ''} · ${p.deletedAt ? 'מחוקה' : 'פעילה'}${p.legacy ? ` · legacy ${JSON.stringify(p.legacy)}` : ''}`
    : `רשומת השחקן ${LEGACY_PLAYER} לא קיימת ב-players`);
  return { problems, skipped, writes, notes };
}

function planB(matches, todayStr) {
  const rows = matches.filter((m) => live(m) && m.source === 'ifa' && m.time === '00:00' && (m.date || '') >= todayStr);
  const writes = rows.map((m) => ['matches', m.id, { time: '', updatedAt: new Date().toISOString() }, true]);
  return { writes, ids: rows.map((m) => m.id) };
}

async function plan(store) {
  const [jobs, matches, players] = await Promise.all(['jobs', 'matches', 'players'].map((c) => store.load(c)));
  const a = planA(jobs, matches, players);
  if (a.problems.length) throw new Error(`לא שונה כלום. ${a.problems.join('; ')}`);
  const b = planB(matches, store.now().slice(0, 10));
  const report = {
    summary: `עבודת migrate ${JOB}: ${a.writes.length ? 'סומנה כטופלה' : 'לא שונתה'}. ${b.ids.length} משחקים עתידיים עם שעה 00:00 קיבלו שעה ריקה.${a.skipped.length ? ` ${a.skipped.length} דולגו.` : ''}`,
    counts: { jobHandled: a.writes.length, timesCleared: b.ids.length, skipped: a.skipped.length },
    timesCleared: b.ids, skipped: a.skipped,
    notes: [...a.notes, ...a.skipped.map((s) => `${s.id} דולג: ${s.reason}`)],
  };
  return { report, writes: [...a.writes, ...b.writes] };
}

module.exports = { id, title, plan, _internal: { planA, planB, JOB } };
