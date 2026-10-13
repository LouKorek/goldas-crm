// 008 — the 2025/26 history of "מכבי כשרונות חדרה" is not ours.
//
// After 007 ran, a read of the calendar found 27 matches of מכבי כשרונות
// חדרה (7.9.2025 – 24.5.2026, all imported from the IFA by the old sync)
// linked to Eyal Prashizky, Alon Mahlev and Almog Iluz, each one on the same
// day and hour as another match of the same player. The IFA player pages
// for 2025/26 put Eyal at גדנע ת"א רוני, Almog at מכבי עירוני אשדוד and
// Alon at הפועל חדרה: none of them was at כשרונות חדרה. The old club
// matching collapsed "חדרה" clubs into one. Lou approved the delete on
// 13.10.2026 ("מחק 27").
//
// Checked against the live data first: exactly 27 live matches of that club
// in that date range (the last one is stored as 25.5, the UTC date of a late
// 24.5 kickoff), all from the IFA, and no match of the club outside the range.
// The first run (13.10 06:02) refused because it also required one of them to
// carry Eyal's current player id; the old sync linked them under player ids
// that migration 001 has since folded, so the report lists the ids instead. One mismatch and the plan
// throws, so nothing is written. Deletes are recycle-bin deletes (deletedAt),
// restorable from the app.
const { OWNER_EMAIL } = require('../firestore.js');

const id = '008-kishronot-hadera';
const title = '27 משחקי מכבי כשרונות חדרה 2025/26 שקושרו בטעות לשחקנים שלנו';

const CLUB_RE = /כשרונות\s*חדרה/;
const EXPECTED = 27;
const FROM = '2025-09-07', TO = '2026-05-25';

const live = (m) => m && !m.deletedAt;
const linked = (m) => (Array.isArray(m.linkedPlayers) ? m.linkedPlayers : []);
const ofClub = (m) => CLUB_RE.test(`${m.homeTeam || ''} ${m.awayTeam || ''}`);

function planA(matches) {
  const problems = [], notes = [];
  const all = matches.filter((m) => live(m) && ofClub(m));
  const rows = all.filter((m) => m.date >= FROM && m.date <= TO);
  const outside = all.filter((m) => !rows.includes(m));
  if (rows.length !== EXPECTED) problems.push(`נמצאו ${rows.length} משחקים של כשרונות חדרה בין ${FROM} ל-${TO}, צפויים ${EXPECTED}`);
  if (outside.length) problems.push(`${outside.length} משחקים של כשרונות חדרה מחוץ לטווח (${outside.map((m) => `${m.id} ${m.date}`).join(', ')}), לא נוגעים בכלום`);
  const notIfa = rows.filter((m) => m.source !== 'ifa');
  if (notIfa.length) problems.push(`${notIfa.length} משחקים לא הגיעו מההתאחדות (${notIfa.map((m) => m.id).join(', ')})`);
  if (problems.length) return { problems, notes, writes: [], recycled: [], players: {} };

  const players = {};
  const writes = [], recycled = [];
  for (const m of rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    for (const p of linked(m)) players[p] = (players[p] || 0) + 1;
    writes.push(['matches', m.id, { deletedAt: 'SERVER_NOW', deletedBy: OWNER_EMAIL, deletedVia: id, updatedAt: new Date().toISOString() }, true]);
    recycled.push(m.id);
    notes.push(`${m.id}: ${m.date} ${m.time || ''} ${m.homeTeam} - ${m.awayTeam} (${linked(m).length ? linked(m).join(', ') : 'בלי שחקן'}) → סל המחזור`);
  }
  return { problems, notes, writes, recycled, players };
}

async function plan(store) {
  const matches = await store.load('matches');
  const a = planA(matches);
  if (a.problems.length) throw new Error(`לא שונה כלום. ${a.problems.join('; ')}`);
  const writes = a.writes.map(([col, docId, data, merge]) => [col, docId, { ...data, deletedAt: store.serverNow() }, merge]);
  const report = {
    summary: `${a.recycled.length} משחקי מכבי כשרונות חדרה 2025/26 הועברו לסל המחזור (היו מקושרים ל-${Object.keys(a.players).length} שחקנים).`,
    counts: { recycled: a.recycled.length, players: Object.keys(a.players).length },
    players: a.players,
    recycled: a.recycled,
    notes: a.notes,
  };
  return { report, writes };
}

module.exports = { id, title, plan, _internal: { planA, EXPECTED, FROM, TO } };
