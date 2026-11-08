// Golda takes the first step (phase B): what she notices between briefings
// and does or says without being asked. Pure functions over the CRM's data,
// so the hourly run (golda-briefing.js) and the tests share them.
//   dealFollowups      a follow-up task for a deal that sits in a stage too long
//   followupsToClose   those tasks once the deal moved on or closed
//   newRequirementFits the best players for a requirement added since the last run
//   teamDealMoves      deal stage changes made by someone else since the last run
//   weekAhead          the coming week's games, trainings and meetings (Sunday plan)
//   recapFacts         the week that was (Thursday recap)
//   feedbackStats      the team's 👍/👎 on Golda's answers
const { israelDate, addDays, daysBetween, isClosedStage, daysInStage, scoreRequirement, stageOfPlayer, playerName, expandTrainings, DEAL_STAGE_LABELS } = require('@goldas/domain');

const APP = 'https://goldas-crm.netlify.app';
const DAY = 86400000;
const live = (rows) => (rows || []).filter((r) => r && !r.deletedAt);
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) || 0 : typeof v === 'number' ? v : 0);
const label = (stage) => DEAL_STAGE_LABELS[stage] || stage || '';

// How many days in a stage before Golda opens a follow-up task.
const FOLLOW_DAYS = {
  'Not Contacted': 14, 'Waiting Response': 7, 'Initial Talks': 10, 'Mandate Received': 10,
  'Offered to Club': 7, 'Negotiation': 7, 'Draft Signed': 5,
};
const NEXT_STEP = {
  'Not Contacted': 'ליצור קשר ראשון', 'Waiting Response': 'להזכיר ולבקש תשובה', 'Initial Talks': 'לקבוע שיחה המשך',
  'Mandate Received': 'להציע את השחקן למועדון', 'Offered to Club': 'לבדוק עם המועדון מה עם ההצעה', 'Negotiation': 'לסגור את הפרטים הפתוחים',
  'Draft Signed': 'לוודא חתימה על החוזה',
};

/** Tasks to create for deals that wait too long, one per deal and stage. */
function dealFollowups({ deals = [], tasks = [], now = new Date(), owner = '' }) {
  const today = israelDate(now);
  const has = new Set(live(tasks).filter((t) => t.dealId && t.followStage).map((t) => `${t.dealId}|${t.followStage}`));
  const out = [];
  for (const d of live(deals)) {
    if (d.closedAt || isClosedStage(d.stage)) continue;
    const limit = FOLLOW_DAYS[d.stage];
    const days = daysInStage(d, now);
    if (!limit || days === null || days < limit || has.has(`${d.id}|${d.stage}`)) continue;
    const who = d.playerName || 'שחקן';
    out.push({
      title: `מעקב: ${who} ב${d.clubName || 'מועדון'} (${label(d.stage)}, ${days} ימים)`,
      dueDate: today, priority: days >= limit * 2 ? 'High' : 'Normal', done: false,
      linkedPlayers: d.playerId ? [d.playerId] : [], dealId: d.id, followStage: d.stage,
      owner: d.owner || owner, auto: 'deal_followup', _ratio: days / limit,
      notes: `גולדה פתחה את המשימה כי העסקה בשלב "${label(d.stage)}" כבר ${days} ימים. הצעד הבא: ${NEXT_STEP[d.stage] || 'לבדוק את המצב'}. ${APP}/market/deals?deal=${d.id}`,
    });
  }
  // The longest waits first (relative to the stage's limit), so a daily cap takes the most urgent.
  return out.sort((a, b) => b._ratio - a._ratio).map(({ _ratio, ...t }) => t);
}

/** Open follow-up tasks whose deal moved to another stage, closed or was removed. */
function followupsToClose({ deals = [], tasks = [] }) {
  const byId = new Map((deals || []).map((d) => [d.id, d]));
  return live(tasks).filter((t) => t.auto === 'deal_followup' && !t.done && t.dealId).filter((t) => {
    const d = byId.get(t.dealId);
    return !d || d.deletedAt || d.closedAt || isClosedStage(d.stage) || d.stage !== t.followStage;
  }).map((t) => ({ id: t.id, title: t.title, dealStage: byId.get(t.dealId)?.stage || null }));
}

/** Requirements created since `since`, each with its best eligible players and candidates. */
function newRequirementFits({ requirements = [], players = [], deals = [], since, now = new Date(), min = 60, n = 3 }) {
  const today = israelDate(now);
  const pool = live(players).filter((p) => stageOfPlayer(p) !== 'not_relevant');
  const out = [];
  for (const r of live(requirements)) {
    if (ms(r.createdAt) <= since || (r.status || 'open') !== 'open' || (r.validUntil && r.validUntil < today)) continue;
    const fits = scoreRequirement(r, pool, now).filter((m) => m.eligible && m.score >= min)
      .filter((m) => !live(deals).some((d) => d.playerId === m.playerId && (d.requirementId === r.id || d.clubName === r.clubName) && !isClosedStage(d.stage)))
      .slice(0, n)
      .map((m) => ({ playerId: m.playerId, player: m.playerName, score: m.score, why: m.reasons.map((x) => x.he).slice(0, 3).join(' · ') }));
    out.push({ id: r.id, club: r.clubName || '', position: r.requiredPosition || '', by: r.createdBy || '', fits });
  }
  return out;
}

function buildRequirementMessage(first, items) {
  const lines = [`*דרישה חדשה במערכת, ${first}* 🎯`];
  for (const r of items) {
    lines.push('', `*${r.club}*${r.position ? ` מחפשת ${r.position}` : ''}`);
    if (!r.fits.length) lines.push('• אין כרגע שחקן שמתאים מעל הסף. כדאי לחפש פרופיל חדש.');
    for (const f of r.fits) lines.push(`• ${f.player} (${f.score}): ${f.why}`);
    lines.push(`${APP}/market/requirements?req=${r.id}`);
  }
  lines.push('', 'לפתוח עסקה לאחד מהם? תכתבו לי את השם.');
  return lines.join('\n');
}

/** Deal stage changes since `since` that someone other than `email` made. */
function teamDealMoves({ deals = [], since, email = '', names = {} }) {
  const out = [];
  for (const d of live(deals)) {
    for (const h of d.history || []) {
      const at = ms(h.at);
      if (at <= since || !h.by || String(h.by).toLowerCase() === String(email).toLowerCase()) continue;
      out.push({ dealId: d.id, player: d.playerName || '', club: d.clubName || '', stage: h.stage, by: names[String(h.by).toLowerCase()] || h.by, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function buildMovesMessage(first, moves) {
  const lines = [`*עדכון עסקאות, ${first}* 📈`];
  for (const m of moves.slice(0, 12)) lines.push(`• ${m.by}: ${m.player} ב${m.club} עבר ל"${label(m.stage)}"${isClosedStage(m.stage) && m.stage === 'Contract Signed' ? ' 🎉' : ''}`);
  if (moves.length > 12) lines.push(`ועוד ${moves.length - 12}.`);
  lines.push(`${APP}/market/deals`);
  return lines.join('\n');
}

/** The next seven days of games, trainings and meetings, by day. */
function weekAhead({ matches = [], trainings = [], meetings = [], players = [] }, now = new Date()) {
  const today = israelDate(now);
  const end = addDays(today, 6);
  const nameOf = (id) => { const p = players.find((x) => x.id === id); return p ? playerName(p) : ''; };
  const names = (ids) => (ids || []).map(nameOf).filter(Boolean).join(', ');
  const days = {};
  const put = (date, item) => { (days[date] = days[date] || []).push(item); };
  for (const m of live(matches)) if (m.date >= today && m.date <= end) put(m.date, { kind: 'game', time: m.time || '', what: `${m.homeTeam || ''} נגד ${m.awayTeam || ''}`, who: names(m.linkedPlayers) });
  const tById = new Map(live(trainings).map((t) => [t.id, t]));
  for (const o of expandTrainings(live(trainings), today, end)) {
    const t = tById.get(o.trainingId) || {};
    if (!o.cancelled) put(o.date, { kind: 'training', time: o.time || '', what: t.title || 'אימון', who: names(t.linkedPlayers) });
  }
  for (const m of live(meetings)) if (m.date >= today && m.date <= end) put(m.date, { kind: 'meeting', time: m.time || '', what: m.title || 'פגישה', who: names(m.linkedPlayers) });
  return Object.keys(days).sort().map((date) => ({ date, items: days[date].sort((a, b) => (a.time || '').localeCompare(b.time || '')).slice(0, 25) }));
}

/** The week that was, for the Thursday recap. */
function recapFacts({ deals = [], requirements = [], tasks = [], matches = [], players = [], audit = [], feedback = [] }, now = new Date()) {
  const since = now.getTime() - 7 * DAY;
  const today = israelDate(now);
  const weekAgo = addDays(today, -7);
  const nameOf = (id) => { const p = players.find((x) => x.id === id); return p ? playerName(p) : ''; };
  const moves = teamDealMoves({ deals, since, email: '' }).map((m) => ({ player: m.player, club: m.club, to: label(m.stage), by: m.by }));
  return {
    dealMoves: moves.slice(0, 40),
    signed: moves.filter((m) => m.to === label('Contract Signed')).length,
    newRequirements: live(requirements).filter((r) => ms(r.createdAt) > since).map((r) => ({ club: r.clubName || '', position: r.requiredPosition || '' })).slice(0, 20),
    tasksDone: live(tasks).filter((t) => t.done && ms(t.doneAt || t.updatedAt) > since).length,
    tasksOpen: live(tasks).filter((t) => !t.done).length,
    tasksOverdue: live(tasks).filter((t) => !t.done && t.dueDate && t.dueDate < today).length,
    gamesPlayed: live(matches).filter((m) => m.date >= weekAgo && m.date < today).map((m) => ({ date: m.date, game: `${m.homeTeam || ''} נגד ${m.awayTeam || ''}`, players: (m.linkedPlayers || []).map(nameOf).filter(Boolean) })).slice(0, 30),
    teamChanges: audit.filter((a) => ms(a.at) > since).length,
    goldaChanges: audit.filter((a) => ms(a.at) > since && a.via === 'golda').length,
    quality: feedbackStats(feedback, since),
  };
}

/** 👍/👎 since a time, with the 👎 cases to learn from. */
function feedbackStats(feedback = [], since = 0) {
  const rows = (feedback || []).filter((f) => ms(f.at) > since);
  const up = rows.filter((f) => f.rating > 0).length;
  const down = rows.filter((f) => f.rating < 0);
  return { up, down: down.length, cases: down.slice(0, 5).map((f) => ({ question: String(f.question || '').slice(0, 200), answer: String(f.reply || '').slice(0, 300), by: f.name || f.email || '' })) };
}

/** Israel weekday (0 = Sunday) and hour. */
function israelClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday').value;
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour: Number(parts.find((p) => p.type === 'hour').value) };
}
const RECAP_WEEKDAY = 4;     // Thursday
const RECAP_HOUR = 18;
const isRecapTime = (now = new Date()) => { const c = israelClock(now); return c.weekday === RECAP_WEEKDAY && c.hour === RECAP_HOUR; };

module.exports = {
  dealFollowups, followupsToClose, newRequirementFits, buildRequirementMessage, teamDealMoves, buildMovesMessage,
  weekAhead, recapFacts, feedbackStats, israelClock, isRecapTime, FOLLOW_DAYS, RECAP_HOUR,
};
