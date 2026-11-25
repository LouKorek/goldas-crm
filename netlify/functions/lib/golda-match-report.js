// Per-match player data through Golda: how a represented player did in one
// match (minutes, goals, assists, a 1-10 rating, one line), stored on the match
// itself in matches/{id}.playerStats[playerId] (shape and summaries:
// packages/domain/src/engines/matchStats.ts).
//
// 1. She records it. The writer says "אתמול X שיחק 70 דקות, גול אחד, 7"; the
//    agent finds the player, and match_report finds his match (by id, or by
//    date) and saves his line through wa-agent's own `update`, one field path
//    (playerStats.<playerId>), so it is audited and undo_last reverses exactly
//    that line. Permission: whoever may edit (the same as editing a match).
// 2. She asks. The morning after a represented player's match that has no
//    numbers for him, she asks the owner how it went: one message for all of
//    yesterday's such matches, naming who from the team watched when the match
//    says so (matches/{id}.watchedBy). Hung on the hourly owner block of
//    golda-briefing.js, after his briefing, from MORNING_FROM to MORNING_TO.
//    Each match is asked about once (state.asked). On a day she asks this, the
//    daily question (lib/golda-daily-question.js) waits for the next day.
// 3. On and off: he tells her ("בלי שאלות על משחקים" / "תחזירי"), and the
//    agent calls match_questions.
// State: app_meta/goldaMatchQuestions { enabled, lastAskedOn, asked: { matchId: 'YYYY-MM-DD' } }.
const { israelDate, addDays, daysBetween, playerName, cleanStat, hasStat, playerMatchRows, summarizeStats, currentSeason } = require('@goldas/domain');
const { chatOf, nudge } = require('./golda-nudge.js');
const { awaitsAnswer } = require('./golda-effort.js');

const APP = 'https://goldas-crm.netlify.app';
const META = ['app_meta', 'goldaMatchQuestions'];
const MORNING_FROM = 8;          // Israel time; the owner block also waits for his briefing
const MORNING_TO = 12;
const KEEP_ASKED_DAYS = 30;
const WAIT_FOR_ANSWER_MS = 2 * 3600000;
const LOOKBACK_DAYS = 10;        // match_report by date looks this far back when the date is off

const fmtDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${Number(m[3])}/${Number(m[2])}` : String(s || ''); };
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';

async function readState(db) {
  const snap = await db.collection(META[0]).doc(META[1]).get();
  return snap.exists ? (snap.data() || {}) : {};
}

/** True when the match question went out on `today` (the daily question then waits). */
async function askedMatchesOn(db, today) {
  return (await readState(db)).lastAskedOn === today;
}

/**
 * Yesterday's matches of represented players that have no numbers for them
 * and were not asked about yet. [{ match, players: [player…] }], by time.
 */
function matchesToAsk(matches, players, state = {}, today) {
  const yesterday = addDays(today, -1);
  const asked = state.asked || {};
  const byId = new Map((players || []).filter((p) => p && !p.deletedAt).map((p) => [p.id, p]));
  return (matches || [])
    .filter((m) => m && !m.deletedAt && m.date === yesterday && !asked[m.id])
    .map((m) => ({
      match: m,
      players: (m.linkedPlayers || []).map((id) => byId.get(id)).filter((p) => p && !hasStat((m.playerStats || {})[p.id])),
    }))
    .filter((x) => x.players.length)
    .sort((a, b) => String(a.match.time || '').localeCompare(String(b.match.time || '')) || String(a.match.id).localeCompare(String(b.match.id)));
}

/** "Dani" / "Dani ו-Noa", from the match's watchedBy (a string or a list of names or emails). */
function watchersOf(m, users = []) {
  const raw = Array.isArray(m.watchedBy) ? m.watchedBy : String(m.watchedBy || '').split(/[,،;]|\sו(?=\S)/);
  const names = raw.map((w) => String(w || '').trim()).filter(Boolean).map((w) => {
    const u = /@/.test(w) ? users.find((x) => String(x.email || '').toLowerCase() === w.toLowerCase()) : null;
    return u ? firstName(u.name) || w : (/@/.test(w) ? w.split('@')[0] : w);
  });
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`;
}

/** The one message, in Hebrew. */
function questionText(first, items, users = [], { firstEver = false } = {}) {
  const lines = [`*איך היה אתמול, ${first}?* ⚽`];
  for (const { match: m, players } of items) {
    const who = players.map((p) => playerName(p)).join(', ');
    const watch = watchersOf(m, users);
    lines.push(`• ${m.homeTeam} – ${m.awayTeam}${m.time ? ` (${m.time})` : ''}: ${who}${watch ? ` · ראו: ${watch}` : ''}`);
  }
  const one = items.length === 1 && items[0].players.length === 1;
  lines.push('', one
    ? 'כמה דקות, גולים, בישולים וציון 1-10? אפשר בשורה אחת, למשל: "70 דקות, גול, 7, משחק טוב בהגנה".'
    : 'לכל שחקן: דקות, גולים, בישולים וציון 1-10, בשורה אחת. למשל: "דני 70 דקות גול 7".');
  lines.push('לא שיחק? "לא שיחק". לא ראינו? "דלג".');
  if (firstEver) lines.push('ואם לא צריך את השאלה הזאת, מספיק לכתוב לי "בלי שאלות על משחקים".');
  return lines.join('\n');
}

/**
 * askMatches(db, owner, { matches, players, users }, now, { hour, send, job })
 * Asks about yesterday's matches when it is time. Returns { sent, matches } or { skipped: why }.
 */
async function askMatches(db, owner, { matches = [], players = [], users = [] } = {}, now = new Date(), { hour, send = null, job = { note: () => {} } } = {}) {
  if (!(hour >= MORNING_FROM && hour <= MORNING_TO)) return { skipped: 'not the hour' };
  const state = await readState(db);
  if (state.enabled === false) return { skipped: 'off' };
  const today = israelDate(now);
  if (state.lastAskedOn === today) return { skipped: 'asked today' };
  const items = matchesToAsk(matches, players, state, today);
  if (!items.length) return { skipped: 'nothing to ask' };

  // Not on top of a question of hers that he has not answered yet: an hour later instead.
  const { threadRef } = await chatOf(db, owner);
  const thread = await threadRef.get();
  const history = thread.exists && Array.isArray(thread.data().history) ? thread.data().history : [];
  const last = history[history.length - 1];
  if (last && now.getTime() - (Number(last.at) || 0) < WAIT_FOR_ANSWER_MS && awaitsAnswer(history)) return { skipped: 'waiting for an answer' };

  const first = firstName(owner.name) || 'לו';
  const body = questionText(first, items, users, { firstEver: !state.lastAskedOn });
  await nudge(db, owner, { body, kind: 'question', remember: true }, { now: now.getTime(), send, job });
  const asked = Object.fromEntries(Object.entries(state.asked || {}).filter(([, on]) => daysBetween(on, today) < KEEP_ASKED_DAYS));
  for (const { match } of items) asked[match.id] = today;
  // merge: "enabled" belongs to the match_questions tool and is never written from here
  await db.collection(META[0]).doc(META[1]).set({ lastAskedOn: today, asked, updatedAt: now.getTime() }, { merge: true });
  job.note(`match question → ${owner.email}: ${items.length} match(es)`);
  return { sent: 1, matches: items.map((x) => x.match.id) };
}

// ── the agent's tools ────────────────────────────────────────────────────────
const MATCH_REPORT_TOOL_DEFS = [
  {
    name: 'match_report',
    description: "Record how a represented player did in one match: minutes (0 = did not play), goals, assists, rating 1-10, a one-line note, who watched. Find the player first (search); pass matchId when you know it, otherwise the match date and the tool finds his match that day (if none, it lists his recent matches to choose from). Saves only what you pass; an existing line for him in that match is updated. Audited, and undo_last reverses it.",
    input_schema: {
      type: 'object',
      properties: {
        playerId: { type: 'string' },
        matchId: { type: 'string', description: 'The match id, when known.' },
        date: { type: 'string', description: 'YYYY-MM-DD of the match ("אתמול" = yesterday in Israel), when matchId is not known.' },
        minutes: { type: 'number' }, goals: { type: 'number' }, assists: { type: 'number' },
        rating: { type: 'number', description: '1-10; halves allowed.' },
        note: { type: 'string', description: 'One short sentence, in the words of the writer.' },
        watchedBy: { type: 'string', description: 'Who saw the game, when said.' },
      },
      required: ['playerId'], additionalProperties: false,
    },
  },
  {
    name: 'match_questions',
    description: "Your morning question to Lou about yesterday's matches of represented players that have no numbers yet. Turn it off or on when he asks, or check whether it is on. Admin only.",
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'status'] } }, required: ['action'], additionalProperties: false },
  },
];

/**
 * matchReportTools({ db, admin, identity, role, channel, update })
 *   update  wa-agent's own update tool, so the write is audited and undoable like any other.
 */
function matchReportTools({ db, admin, identity = {}, role, channel = 'whatsapp', update }) {
  const live = (d) => d.exists && !d.data().deletedAt;
  async function findMatch({ playerId, matchId, date }) {
    if (matchId) {
      const s = await db.collection('matches').doc(matchId).get();
      if (!live(s)) throw new Error('match not found');
      return { id: s.id, ...s.data() };
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('pass matchId, or the date of the match as YYYY-MM-DD');
    const snap = await db.collection('matches').where('linkedPlayers', 'array-contains', playerId).get();
    const mine = snap.docs.filter(live).map((d) => ({ id: d.id, ...d.data() }));
    const that = mine.filter((m) => m.date === date);
    if (that.length === 1) return that[0];
    const recent = (that.length ? that : mine.filter((m) => m.date && Math.abs(daysBetween(m.date, date)) <= LOOKBACK_DAYS))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map((m) => ({ matchId: m.id, date: m.date, time: m.time || '', homeTeam: m.homeTeam, awayTeam: m.awayTeam }));
    return { choose: recent };
  }

  return {
    match_report: async (input = {}) => {
      if (typeof update !== 'function') throw new Error('match_report is not wired');
      const { playerId } = input;
      const ps = await db.collection('players').doc(String(playerId || '-')).get();
      if (!live(ps)) throw new Error('player not found');
      const m = await findMatch(input);
      if (m.choose) {
        return m.choose.length
          ? { needsChoice: true, matches: m.choose, instruction: 'No match of his on that date. Ask the writer which of these it was (or whether to add the match), then call match_report again with matchId.' }
          : { notFound: true, instruction: 'He has no match on that date in the CRM. Offer to add the match (create in matches) and then record it.' };
      }
      const prev = (m.playerStats || {})[playerId] || {};
      const typed = {};
      for (const k of ['minutes', 'goals', 'assists', 'rating', 'note', 'watchedBy']) if (input[k] !== undefined && input[k] !== null && input[k] !== '') typed[k] = input[k];
      if (!Object.keys(typed).length) throw new Error('nothing to record: pass minutes, goals, assists, rating or note');
      if (typed.rating !== undefined && !(Number(typed.rating) >= 1 && Number(typed.rating) <= 10)) throw new Error('rating is 1 to 10');
      const watchedBy = typed.watchedBy || prev.watchedBy || (Array.isArray(m.watchedBy) ? m.watchedBy.join(', ') : m.watchedBy) || '';
      const entry = cleanStat({ ...prev, ...typed, watchedBy });
      if (!entry) throw new Error('nothing usable to record');
      entry.by = identity.email || '';
      entry.at = new Date().toISOString();
      const r = await update({ collection: 'matches', id: m.id, data: { [`playerStats.${playerId}`]: entry } });
      // The season so far, so she can say it in one line.
      const theirs = await db.collection('matches').where('linkedPlayers', 'array-contains', playerId).get().catch(() => null);
      const rows = theirs ? playerMatchRows(theirs.docs.map((d) => ({ id: d.id, ...d.data() })), playerId) : [];
      const season = currentSeason();
      return {
        recorded: true, matchId: m.id, match: `${m.homeTeam} – ${m.awayTeam}`, date: m.date,
        player: playerName({ id: ps.id, ...ps.data() }), entry, replaced: hasStat(prev) ? prev : null,
        season, seasonSoFar: summarizeStats(rows.filter((x) => x.season === season)),
        link: `${APP}/players/${playerId}`, updated: !!(r && r.updated),
      };
    },

    match_questions: async ({ action } = {}) => {
      if (role !== 'admin') throw new Error('only an admin can change the match questions');
      const state = await readState(db);
      const was = state.enabled !== false;
      if (action === 'status') return { on: was, lastAskedOn: state.lastAskedOn || null };
      if (action !== 'on' && action !== 'off') throw new Error('action is on, off or status');
      const on = action === 'on';
      if (on === was) return { on, unchanged: true };
      await db.collection(META[0]).doc(META[1]).set({ enabled: on, changedBy: identity.email || '', changedAt: Date.now() }, { merge: true });
      if (admin?.firestore?.FieldValue) {
        await db.collection('audit').add({
          action: 'update', collection: 'settings', docId: META[1], name: 'השאלות של גולדה על משחקים', summary: `match questions: ${on ? 'on' : 'off'}`, fields: ['enabled'],
          by: identity.email || '', byName: `${identity.name || ''} (Golda)`.trim(), via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '',
          sender: identity.name || '', phone: identity.phone || '', at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
        }).catch((e) => console.error('[golda-match-report] audit failed:', e.message));
      }
      return { on, note: on ? "The morning question about yesterday's matches is back." : 'No more questions about matches until he asks for them again.' };
    },
  };
}

module.exports = {
  matchesToAsk, watchersOf, questionText, askMatches, askedMatchesOn, matchReportTools, MATCH_REPORT_TOOL_DEFS,
  MORNING_FROM, MORNING_TO,
};
