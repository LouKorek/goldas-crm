// 006 — one-time cleanup of the matches collection, ordered by Lou on
// 12.10.2026 after the IFA sync left junk behind:
//
//   A. IFA matches with no linked player (squads that were read for a player
//      who was then unlinked): Lou's order said 74, from three squads, between
//      2026-09-19 and 2027-05-22. The first run (12.10 23:56) refused: it found
//      51, because the sync run earlier that evening had already taken care of
//      23 of Hevel Modi'in's. Lou then approved the 51 that are there now
//      (29 / 1 / 21), and that is what this expects.
//   B. 13 duplicate copies of Hapoel Hadera matches (the copy without a time
//      or stadium), each kept only when its twin — same match, same linked
//      players, on the twin's date, with a time — is there.
//
// Everything is checked against the live data first; one mismatch in A, or a
// missing/ambiguous twin in B, and the plan throws, so nothing is deleted and
// the error is the report. Deletes go to the recycle bin (deletedAt, like the
// app's own delete button), so each one can be restored from there.
const { OWNER_EMAIL } = require('../firestore.js');

const id = '006-clean-matches';
const title = 'ניקוי משחקי ההתאחדות: 51 בלי שחקן ו-13 עותקים כפולים';

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/["״]/g, '"').replace(/['׳]/g, "'").trim();

// Part A, as ordered: team → expected count, and the date range.
const A_TEAMS = { 'מ.כ. נהלל יזרעאל': 29, "הפ' מ.ס חבל מודיעין": 1, 'גדנע ת"א רוני': 21 };
const A_FROM = '2026-09-19', A_TO = '2027-05-22';

// Part B: the id to delete, its own date, and the date of the twin to keep.
const B_ROWS = [
  // player 7Cg7ARx3SXjzDYGlQ4NA, Hapoel Hadera (team 2429)
  { id: '5PPO0orHYC56G3pAl81G', date: '2026-08-22', twinDate: '2026-08-22', sameTime: true },
  { id: 'Ord3jUM7KOuTdgmQjp1L', date: '2026-08-25', twinDate: '2026-08-25' },
  { id: '3lWpNI7i8aK6FWfqKO1t', date: '2026-08-29', twinDate: '2026-08-29' },
  { id: 'M3PuOjMKyNzo1TV7eWGN', date: '2026-09-05', twinDate: '2026-09-05' },
  { id: 'J8f7j7RYm4BH8lkBUL1N', date: '2026-09-08', twinDate: '2026-09-08' },
  { id: 'cX3DRBz4tldHlst6yUxu', date: '2026-09-15', twinDate: '2026-09-15' },
  { id: 'bl6jZ7Z2xj8jD6oUcgMg', date: '2026-09-19', twinDate: '2026-09-19' },
  // player dNxtLA2YQj4nfgLOqwKo, Hapoel Hadera Mati (team 2724)
  { id: 'D428dQJjM7Mxlxmhad6v', date: '2026-08-25', twinDate: '2026-08-25' },
  { id: 'RwDLZfvOEI0dzn3mk64j', date: '2026-08-29', twinDate: '2026-08-29' },
  { id: '2PA2qBLbENTk2BpJ6jEN', date: '2026-09-05', twinDate: '2026-09-05' },
  { id: 'cQXzhZZUo2rkyCrMNUmg', date: '2026-09-29', twinDate: '2026-09-29' },
  { id: 'ueZUaMrbMeFdxmQFY5RF', date: '2026-09-15', twinDate: '2026-09-16', postponed: true },
  { id: 'RWOyZP8ngQ7sJDUV5Jgl', date: '2026-09-19', twinDate: '2026-09-23', postponed: true },
];

const live = (m) => !m.deletedAt;
const linkedKey = (m) => [...new Set(Array.isArray(m.linkedPlayers) ? m.linkedPlayers : [])].sort().join(',');
const hasTime = (m) => /^\d{2}:\d{2}$/.test(m.time || '') && m.time !== '00:00';
const mentionsHadera = (m) => /חדרה/.test(`${m.homeTeam || ''} ${m.awayTeam || ''}`);

function planA(matches) {
  const rows = matches.filter((m) => live(m) && m.source === 'ifa' && !linkedKey(m));
  const counts = {}; for (const t of Object.keys(A_TEAMS)) counts[t] = 0;
  let other = 0, outOfRange = 0;
  for (const m of rows) {
    const teams = [tidy(m.homeTeam), tidy(m.awayTeam)];
    const hit = Object.keys(A_TEAMS).filter((t) => teams.includes(tidy(t)));
    if (hit.length !== 1) other++; else counts[hit[0]]++;
    if (!m.date || m.date < A_FROM || m.date > A_TO) outOfRange++;
  }
  const expectedTotal = Object.values(A_TEAMS).reduce((a, b) => a + b, 0);
  const problems = [];
  if (rows.length !== expectedTotal) problems.push(`נמצאו ${rows.length} משחקים בלי שחקן, צפויים ${expectedTotal}`);
  for (const [t, n] of Object.entries(A_TEAMS)) if (counts[t] !== n) problems.push(`"${t}": ${counts[t]} במקום ${n}`);
  if (other) problems.push(`${other} משחקים לא שייכים לאף אחת משלוש הקבוצות`);
  if (outOfRange) problems.push(`${outOfRange} משחקים מחוץ לטווח ${A_FROM}–${A_TO}`);
  return { rows, counts, problems };
}

function planB(matches) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const del = [], skipped = [], problems = [];
  for (const r of B_ROWS) {
    const m = byId.get(r.id);
    if (!m || !live(m)) { skipped.push({ id: r.id, reason: 'כבר לא קיים' }); continue; }
    if (m.date !== r.date) { problems.push(`${r.id}: התאריך הוא ${m.date}, לא ${r.date}`); continue; }
    if (!mentionsHadera(m)) { problems.push(`${r.id}: לא משחק של חדרה (${m.homeTeam} - ${m.awayTeam})`); continue; }
    const key = linkedKey(m);
    if (!key) { problems.push(`${r.id}: אין שחקנים מקושרים`); continue; }
    let twins = matches.filter((t) => t.id !== m.id && live(t) && t.source === 'ifa' && linkedKey(t) === key
      && t.date === r.twinDate && mentionsHadera(t) && hasTime(t));
    if (twins.length > 1) twins = twins.filter((t) => t.stadiumName);
    if (twins.length > 1 && r.sameTime) twins = twins.filter((t) => t.time === m.time);
    if (twins.length !== 1) {
      problems.push(twins.length ? `${r.id}: ${twins.length} תאומים אפשריים` : `${r.id}: לא נמצא תאום ב-${r.twinDate}`);
      continue;
    }
    del.push({ id: r.id, twin: twins[0].id, label: `${m.date} ${m.homeTeam} - ${m.awayTeam}` });
  }
  return { del, skipped, problems };
}

async function plan(store) {
  const matches = await store.load('matches');
  const a = planA(matches);
  const b = planB(matches);
  const problems = [...a.problems, ...b.problems];
  if (problems.length) {
    throw new Error(`לא נמחק כלום. ${problems.join('; ')}`);
  }
  const stamp = { deletedAt: store.serverNow(), deletedBy: OWNER_EMAIL, deletedVia: id, updatedAt: store.serverNow() };
  const writes = [
    ...a.rows.map((m) => ['matches', m.id, stamp, true]),
    ...b.del.map((d) => ['matches', d.id, stamp, true]),
  ];
  const report = {
    summary: `נמחקו לסל המחזור ${a.rows.length} משחקים בלי שחקן ו-${b.del.length} עותקים כפולים${b.skipped.length ? ` (${b.skipped.length} דולגו)` : ''}.`,
    counts: { partA: a.rows.length, partB: b.del.length, skipped: b.skipped.length, byTeam: a.counts },
    deletedA: a.rows.map((m) => m.id),
    deletedB: b.del,
    skipped: b.skipped,
    notes: [
      ...Object.entries(a.counts).map(([t, n]) => `${t}: ${n}`),
      ...b.del.map((d) => `${d.id} נמחק; התאום ${d.twin} נשאר (${d.label})`),
      ...b.skipped.map((s) => `${s.id} דולג: ${s.reason}`),
    ],
  };
  return { report, writes };
}

module.exports = { id, title, plan, _internal: { planA, planB, A_TEAMS, B_ROWS } };
