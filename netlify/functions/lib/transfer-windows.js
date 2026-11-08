// Transfer windows (FIFA registration periods) of the leagues the agency
// works with, so Golda can say what is open, what opens soon and what closes
// soon, and warn ahead of a deadline. Dates are each league's own, as
// published for 2026/27 (source: thetransferclock.com, checked 2026-11-08,
// which itself asks to verify a deadline with the league before a transfer).
// Israel's dates are not published there yet: Golda says so and checks the
// web when asked. Add a season's dates here when they are announced.
const { israelDate, daysBetween } = require('@goldas/domain');

const SOURCE = 'thetransferclock.com (2026-11-08)';
const W = (league, country, kind, opens, closes, closesAt = '') => ({ league, country, kind, opens, closes, closesAt });
const WINDOWS = [
  W('Premier League', 'England', 'summer', '2026-06-15', '2026-09-01', '23:00'),
  W('Serie A', 'Italy', 'summer', '2026-06-29', '2026-09-01', '20:00'),
  W('La Liga', 'Spain', 'summer', '2026-07-01', '2026-09-01', '23:59'),
  W('Bundesliga', 'Germany', 'summer', '2026-07-01', '2026-08-31', '20:00'),
  W('Ligue 1', 'France', 'summer', '2026-06-15', '2026-09-01', '19:59'),
  W('Primeira Liga', 'Portugal', 'summer', '2026-07-01', '2026-09-15', '23:59'),
  W('Belgian Pro League', 'Belgium', 'summer', '2026-06-17', '2026-09-03', '23:59'),
  W('Eredivisie', 'Netherlands', 'summer', '2026-06-22', '2026-09-02', '23:59'),
  W('Süper Lig', 'Turkey', 'summer', '2026-06-22', '2026-09-04', '23:59'),
  W('Saudi Pro League', 'Saudi Arabia', 'summer', '2026-07-22', '2026-10-12', '23:59'),
  W('MLS', 'USA', 'summer', '2026-07-13', '2026-09-02', '23:59'),
  W('Premier League', 'England', 'winter', '2027-01-01', '2027-02-01', '23:00'),
  W('Serie A', 'Italy', 'winter', '2027-01-02', '2027-02-01', '20:00'),
  W('La Liga', 'Spain', 'winter', '2027-01-02', '2027-02-02', '23:59'),
  W('Bundesliga', 'Germany', 'winter', '2027-01-01', '2027-02-01', '20:00'),
  W('Ligue 1', 'France', 'winter', '2027-01-01', '2027-02-01', '19:59'),
  W('Primeira Liga', 'Portugal', 'winter', '2027-01-04', '2027-02-06', '23:59'),
  W('Belgian Pro League', 'Belgium', 'winter', '2027-01-02', '2027-02-03', '23:59'),
  W('Eredivisie', 'Netherlands', 'winter', '2027-01-04', '2027-02-02', '23:59'),
  W('Süper Lig', 'Turkey', 'winter', '2027-01-01', '2027-02-05', '23:59'),
  W('Saudi Pro League', 'Saudi Arabia', 'winter', '2027-01-03', '2027-01-31', '23:59'),
];
const MISSING = ['Israel (Ligat HaAl and the lower leagues): dates not published in the source yet; check the IFA site or the news'];

// Days before an opening or a closing that are worth a message.
const OPEN_MARKS = [14, 0];
const CLOSE_MARKS = [14, 7, 3, 1];

/** What is open now, what opens in the next 60 days, and what closes in the next 30. */
function windowStatus(now = new Date(), windows = WINDOWS) {
  const today = israelDate(now);
  const open = []; const opening = []; const closingSoon = [];
  for (const w of windows) {
    const toOpen = daysBetween(today, w.opens);
    const toClose = daysBetween(today, w.closes);
    if (toOpen <= 0 && toClose >= 0) {
      open.push({ ...w, daysLeft: toClose });
      if (toClose <= 30) closingSoon.push({ ...w, daysLeft: toClose });
    } else if (toOpen > 0 && toOpen <= 60) opening.push({ ...w, daysToOpen: toOpen });
  }
  return { today, open, opening, closingSoon, notCovered: MISSING, source: SOURCE };
}

/**
 * Today's deadline marks, grouped into one line per kind of event:
 * [{ key, kind: 'opens'|'closes', days, leagues: [..], date }]. Each key is
 * sent once (the briefing's sent-state keeps it).
 */
function windowMarks(now = new Date(), windows = WINDOWS) {
  const today = israelDate(now);
  const groups = new Map();
  for (const w of windows) {
    const toOpen = daysBetween(today, w.opens);
    const toClose = daysBetween(today, w.closes);
    let ev = null;
    if (OPEN_MARKS.includes(toOpen)) ev = { kind: 'opens', days: toOpen, date: w.opens };
    else if (toOpen <= 0 && CLOSE_MARKS.includes(toClose)) ev = { kind: 'closes', days: toClose, date: w.closes };
    if (!ev) continue;
    const k = `${ev.kind}|${ev.days}`;
    if (!groups.has(k)) groups.set(k, { ...ev, leagues: [], key: `tw|${w.kind}|${today}|${k}` });
    groups.get(k).leagues.push(`${w.league}${ev.kind === 'closes' && w.closesAt ? ` (${w.closes.slice(8, 10)}/${w.closes.slice(5, 7)} ${w.closesAt})` : ''}`);
  }
  return [...groups.values()];
}

/** One WhatsApp message for the day's marks. */
function buildWindowMessage(first, marks) {
  if (!marks.length) return '';
  const lines = [`*חלונות העברות, ${first}* 🔁`];
  for (const m of marks.sort((a, b) => a.days - b.days)) {
    const when = m.days === 0 ? 'נפתח היום' : m.kind === 'opens' ? `נפתח בעוד ${m.days} ימים` : m.days === 1 ? 'נסגר מחר' : `נסגר בעוד ${m.days} ימים`;
    lines.push(`• ${when}: ${m.leagues.join(', ')}`);
  }
  lines.push('', 'כדאי לבדוק עכשיו מי מהשחקנים צריך מועדון לפני הסגירה. אפשר לשאול אותי "מי מתאים לחלון".');
  return lines.join('\n');
}

const TRANSFER_TOOL_DEF = {
  name: 'transfer_windows', description: 'Which transfer windows are open now, which open in the next 60 days and which close in the next 30, with exact dates and deadline times, for the main European leagues, Turkey, Saudi Arabia and MLS. Israel is not covered yet: say so and check the web.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

module.exports = { WINDOWS, windowStatus, windowMarks, buildWindowMessage, TRANSFER_TOOL_DEF, SOURCE };
