// 007 — the fixes Lou ordered on 13.10.2026 after reading the matches data:
//
//   A. Eyal Prashizky (players/lQKfyOZsaFHSKkn7JkFO) plays for Ironi Modi'in,
//      but the IFA lookup of 12.10 put him in Hevel Modi'in's נערים ג' squad
//      (team_id 6522) and linked him to its 25 fixtures. The IFA player page
//      (player_id 256780, season 2026/27) says: עירוני מודיעין "צו פיוס",
//      נערים א' לאומית דרום, team_id 6249. So: point autoFetch.ifa at 6249
//      (the next browser sync links his real fixtures), unlink him from the
//      25 Hevel Modi'in matches, and recycle the ones left with no player.
//      His 2025/26 history at Gadna Tel Aviv Roni (team 4004) is not touched.
//   B. Two duplicate pairs from 10.10.2026 (Hapoel Hadera): keep the copy
//      that carries the IFA game id, add the missing player to it, recycle
//      the old copy.
//   C. The failed migrate job of 12.10 (51 instead of 74) is marked handled,
//      so its alert leaves the Home screen; 006 was already rerun with 51.
//
// Everything is checked against the live data first. One mismatch and the
// plan throws, so nothing is written and the error is the report. An id that
// is already gone is skipped and reported, not an error. Deletes are
// recycle-bin deletes (deletedAt), restorable from the app.
const { OWNER_EMAIL } = require('../firestore.js');

const id = '007-eyal-and-hadera-dupes';
const title = 'אייל פרשיצקי לעירוני מודיעין, שתי כפילויות של חדרה, סימון עבודת migrate';

const EYAL = 'lQKfyOZsaFHSKkn7JkFO';
const WRONG_TEAM = '6522';
const WRONG_TEAM_RE = /team_id=6522(?!\d)/;
const HISTORY_TEAM_RE = /team_id=4004(?!\d)/;
const A_EXPECTED = 25;
const A_FROM = '2026-09-19', A_TO = '2027-05-01';
const RIGHT_TEAM = {
  playerId: '256780', teamId: '6249', clubId: '',
  teamName: 'עירוני מודיעין "צו פיוס"', ageGroup: 'נערים א', league: "נערים א' לאומית דרום",
  seasonLabel: '2026/2027', via: 'migration-007',
};

// Part B: keep → { gameId, addPlayer }, drop → the old copy.
const B_PAIRS = [
  { label: 'הפועל חדרה - הפועל ק"ש 10.10 17:30', keep: 'CKyrQU414uoxQrueBhk5', gameId: '1121923', addPlayer: 'fbN4jQ4OGD5u5V8NDYrm', drop: 'XALTePkYxX5YWO1Eu926', date: '2026-10-10' },
  { label: 'הפועל חדרה מתי - הפועל ב"ש 10.10 13:30', keep: 'ghMi4dRvNe8enUKmvdT7', gameId: '1123327', addPlayer: null, drop: 'Zz8U7hU6TEdC5zErwfDl', date: '2026-10-10' },
];

const JOB = 'UHluG6hbVT8aO5mNLGZA';

const live = (m) => m && !m.deletedAt;
const linked = (m) => (Array.isArray(m.linkedPlayers) ? m.linkedPlayers : []);
const mentionsHadera = (m) => /חדרה/.test(`${m.homeTeam || ''} ${m.awayTeam || ''}`);

function planA(player, matches) {
  const problems = [], skipped = [], writes = [], notes = [];
  let unlinked = [], recycled = [];
  if (!live(player)) {
    skipped.push({ id: `players/${EYAL}`, reason: 'כבר לא קיים' });
    return { problems, skipped, writes, notes, unlinked, recycled };
  }
  const club = `${player.currentClub || ''} ${player.clubId || ''}`;
  if (!/modi.?in|מודיעין/i.test(club)) problems.push(`אייל: currentClub הוא "${player.currentClub}", לא עירוני מודיעין`);
  const cur = player.autoFetch && player.autoFetch.ifa;
  if (String(cur && cur.teamId || '') !== WRONG_TEAM) problems.push(`אייל: autoFetch.ifa.teamId הוא ${cur && cur.teamId || 'ריק'}, לא ${WRONG_TEAM}`);

  const rows = matches.filter((m) => live(m) && m.source === 'ifa' && WRONG_TEAM_RE.test(String(m.sourceTeamId || '')) && linked(m).includes(EYAL));
  if (rows.length !== A_EXPECTED) problems.push(`נמצאו ${rows.length} משחקים של חבל מודיעין (team 6522) עם אייל, צפויים ${A_EXPECTED}`);
  const outOfRange = rows.filter((m) => !m.date || m.date < A_FROM || m.date > A_TO);
  if (outOfRange.length) problems.push(`${outOfRange.length} משחקי חבל מודיעין מחוץ לטווח ${A_FROM}–${A_TO}`);
  const history = matches.filter((m) => live(m) && HISTORY_TEAM_RE.test(String(m.sourceTeamId || '')) && linked(m).includes(EYAL));
  notes.push(`היסטוריית גדנע ת"א רוני 2025/26 (team 4004): ${history.length} משחקים, לא נגענו`);
  if (problems.length) return { problems, skipped, writes, notes, unlinked, recycled };

  writes.push(['players', EYAL, {
    autoFetch: { ifa: { ...RIGHT_TEAM, clubId: (cur && cur.clubId) || '', forClub: player.currentClub || '', resolvedAt: new Date().toISOString() }, ifaFail: null },
    updatedAt: new Date().toISOString(),
  }, true]);
  for (const m of rows) {
    const rest = linked(m).filter((x) => x !== EYAL);
    const data = { linkedPlayers: rest, updatedAt: new Date().toISOString() };
    if (rest.length === 0) {
      Object.assign(data, { deletedAt: 'SERVER_NOW', deletedBy: OWNER_EMAIL, deletedVia: id });
      recycled.push(m.id);
    } else unlinked.push(m.id);
    writes.push(['matches', m.id, data, true]);
  }
  return { problems, skipped, writes, notes, unlinked, recycled };
}

function planB(matches) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const problems = [], skipped = [], writes = [], notes = [], updated = [], recycled = [];
  for (const pr of B_PAIRS) {
    const keep = byId.get(pr.keep), drop = byId.get(pr.drop);
    if (!live(keep)) { skipped.push({ id: pr.keep, reason: 'כבר לא קיים' }); }
    else {
      if (String(keep.sourceMatchId) !== pr.gameId) problems.push(`${pr.keep}: sourceMatchId הוא ${keep.sourceMatchId}, לא ${pr.gameId}`);
      if (keep.date !== pr.date) problems.push(`${pr.keep}: התאריך הוא ${keep.date}, לא ${pr.date}`);
      if (!mentionsHadera(keep)) problems.push(`${pr.keep}: לא משחק של חדרה`);
    }
    if (!live(drop)) { skipped.push({ id: pr.drop, reason: 'כבר לא קיים' }); }
    else {
      if (drop.date !== pr.date) problems.push(`${pr.drop}: התאריך הוא ${drop.date}, לא ${pr.date}`);
      if (!mentionsHadera(drop)) problems.push(`${pr.drop}: לא משחק של חדרה`);
      if (live(keep)) {
        // The old copy must be the same match: same two teams (same order).
        const same = (a, b) => String(a || '').trim() === String(b || '').trim();
        if (!same(keep.homeTeam, drop.homeTeam) || !same(keep.awayTeam, drop.awayTeam)) {
          problems.push(`${pr.drop}: הקבוצות (${drop.homeTeam} - ${drop.awayTeam}) שונות מהעותק שנשאר (${keep.homeTeam} - ${keep.awayTeam})`);
        }
      }
    }
  }
  if (problems.length) return { problems, skipped, writes, notes, updated, recycled };
  for (const pr of B_PAIRS) {
    const keep = byId.get(pr.keep), drop = byId.get(pr.drop);
    if (live(keep)) {
      const players = new Set(linked(keep));
      if (live(drop)) for (const p of linked(drop)) players.add(p);
      if (pr.addPlayer) players.add(pr.addPlayer);
      const before = linked(keep).length;
      if (players.size !== before) {
        writes.push(['matches', pr.keep, { linkedPlayers: [...players], updatedAt: new Date().toISOString() }, true]);
        updated.push(pr.keep);
        notes.push(`${pr.keep} (${pr.label}): שחקנים מקושרים ${before} → ${players.size}`);
      } else notes.push(`${pr.keep} (${pr.label}): השחקנים כבר מקושרים`);
    }
    if (live(drop)) {
      writes.push(['matches', pr.drop, { deletedAt: 'SERVER_NOW', deletedBy: OWNER_EMAIL, deletedVia: id, updatedAt: new Date().toISOString() }, true]);
      recycled.push(pr.drop);
    }
  }
  return { problems, skipped, writes, notes, updated, recycled };
}

function planC(jobs) {
  const job = jobs.find((j) => j.id === JOB);
  const problems = [], skipped = [], writes = [];
  if (!job) { skipped.push({ id: `jobs/${JOB}`, reason: 'כבר לא קיים' }); return { problems, skipped, writes }; }
  if (job.status === 'handled') { skipped.push({ id: `jobs/${JOB}`, reason: 'כבר מסומן כטופל' }); return { problems, skipped, writes }; }
  if (job.status !== 'error') problems.push(`jobs/${JOB}: הסטטוס הוא ${job.status}, לא error`);
  if (!/51/.test(String(job.error || ''))) problems.push(`jobs/${JOB}: השגיאה לא מזכירה 51 (${String(job.error || '').slice(0, 80)})`);
  if (!problems.length) {
    writes.push(['jobs', JOB, {
      status: 'handled', handledAt: new Date().toISOString(), handledBy: OWNER_EMAIL,
      handledNote: 'משחקי חבל מודיעין היו מקושרים לאייל פרשיצקי; 006 רצה מחדש עם 51 באישור לו (13.10, מיגרציה 007)',
    }, true]);
  }
  return { problems, skipped, writes };
}

async function plan(store) {
  const [players, matches, jobs] = await Promise.all(['players', 'matches', 'jobs'].map((c) => store.load(c)));
  const eyal = players.find((p) => p.id === EYAL) || null;
  const a = planA(eyal, matches);
  const b = planB(matches);
  const c = planC(jobs);
  const problems = [...a.problems, ...b.problems, ...c.problems];
  if (problems.length) throw new Error(`לא שונה כלום. ${problems.join('; ')}`);

  const stamp = (w) => {
    const [col, docId, data, merge] = w;
    const out = { ...data };
    if (out.deletedAt === 'SERVER_NOW') out.deletedAt = store.serverNow();
    return [col, docId, out, merge];
  };
  const writes = [...a.writes, ...b.writes, ...c.writes].map(stamp);
  const skipped = [...a.skipped, ...b.skipped, ...c.skipped];
  const report = {
    summary: `אייל: autoFetch → team 6249, הוסר מ-${a.unlinked.length + a.recycled.length} משחקי חבל מודיעין (${a.recycled.length} לסל המחזור). חדרה: ${b.updated.length} עודכנו, ${b.recycled.length} לסל המחזור. עבודת migrate: ${c.writes.length ? 'סומנה כטופלה' : 'לא שונתה'}.${skipped.length ? ` ${skipped.length} דולגו.` : ''}`,
    counts: { aUnlinked: a.unlinked.length, aRecycled: a.recycled.length, bUpdated: b.updated.length, bRecycled: b.recycled.length, jobHandled: c.writes.length, skipped: skipped.length },
    eyal: { registeredAt: 'עירוני מודיעין "צו פיוס", נערים א\' לאומית דרום, team_id 6249 (עונת 2026/27)', wrongTeam: WRONG_TEAM },
    aUnlinked: a.unlinked, aRecycled: a.recycled,
    bUpdated: b.updated, bRecycled: b.recycled,
    skipped,
    notes: [
      ...a.notes, ...b.notes,
      ...a.recycled.map((x) => `${x}: אייל הוסר, לא נשאר שחקן → סל המחזור`),
      ...a.unlinked.map((x) => `${x}: אייל הוסר, נשארו שחקנים אחרים`),
      ...b.recycled.map((x) => `${x}: עותק ישן → סל המחזור`),
      ...skipped.map((s) => `${s.id} דולג: ${s.reason}`),
    ],
  };
  return { report, writes };
}

module.exports = { id, title, plan, _internal: { planA, planB, planC, EYAL, B_PAIRS, JOB, RIGHT_TEAM } };
