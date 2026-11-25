// The monthly report through Golda: one branded page per represented player,
// for the player and his family, with his matches of a calendar month, what
// the agency did and the next step. Lou approves the text and forwards the
// PDF himself (the page itself: apps/web/src/lib/monthlyReport.js; the pure
// parts: packages/domain/src/engines/monthlyReport.ts).
//
// 1. She prepares. "דוח חודשי ל…": monthly_report action=prepare gives her the
//    month's facts (his matches without rating, note or watcher; the month
//    and the season so far; that month's notes, meetings and tasks done for
//    him) and the saved text if there is one. She writes the two parts for a
//    parent and saves them with action=save, as a draft on the player
//    (players/{id}.monthlyReports['YYYY-MM']) through wa-agent's own audited
//    update, so undo_last takes the draft back.
// 2. He approves. action=send works only when the writer saved that text in
//    an EARLIER message than this one (the turn is kept with the draft, as the
//    website draft keeps it), or when the text is already approved. It marks
//    the text approved and the PDF goes out with her answer, to the writer
//    only. She never sends it to the player or the family.
// 3. She reminds. On the 1st of the month (the 2nd or 3rd when the 1st was
//    missed), between 9 and 12 Israel time, one message to the owner: the
//    reports for last month can be prepared for N represented players, with
//    buttons to start or skip. Once a month at most. It waits a day when the
//    match question (lib/golda-match-report.js) or the daily question
//    (lib/golda-daily-question.js) already went out that day, and on a day it
//    goes out the daily question waits for the next day. Hung on the hourly
//    owner block of golda-briefing.js; no model call there.
// 4. On and off: "בלי תזכורת לדוחות" / "תחזירי", action=reminder off / on.
// State: app_meta/goldaMonthlyReports { enabled, lastMonth, lastSentOn }.
const { israelDate, playerName, lastFullMonth, isMonthKey, monthName, monthlyReportFacts, cleanReportText, reportOf, REPORT_DID_MAX_LINES } = require('@goldas/domain');
const { chatOf, nudge } = require('./golda-nudge.js');
const { awaitsAnswer } = require('./golda-effort.js');
const { askedMatchesOn } = require('./golda-match-report.js');

const APP = 'https://goldas-crm.netlify.app';
const META = ['app_meta', 'goldaMonthlyReports'];
const DAILY_META = ['app_meta', 'goldaDailyQuestion'];
const FROM_HOUR = 9;             // Israel time, after the morning briefing
const TO_HOUR = 12;
const LAST_DAY = 3;              // the 1st, or the 2nd and 3rd when it was missed
const WAIT_FOR_ANSWER_MS = 2 * 3600000;
const MAX_FILES = 3;             // documents per answer, as for the CV

const represented = (p) => !!p && !p.deletedAt && (!p.stage || p.stage === 'represented');
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || '';

async function readState(db, [col, id] = META) {
  const snap = await db.collection(col).doc(id).get();
  return snap.exists ? (snap.data() || {}) : {};
}

/** True when the reminder went out on `today` (the daily question then waits). */
async function remindedOn(db, today) {
  return (await readState(db)).lastSentOn === today;
}

/** The represented players whose report for `month` is not approved yet. */
function playersToReport(players, month) {
  return (players || []).filter(represented).filter((p) => (reportOf(p, month) || {}).status !== 'approved');
}

/** The one message, in Hebrew, and its buttons. */
function reminderText(first, month, n, { firstEver = false } = {}) {
  const lines = [
    `*הדוחות החודשיים של ${monthName(month, 'he')}, ${first}* 📄`,
    `אפשר להכין עכשיו דוח חודשי ${n === 1 ? 'לשחקן מיוצג אחד' : `ל-${n} שחקנים מיוצגים`}: המשחקים שלו בחודש, מה עשינו והצעד הבא, בדף אחד ממותג לשחקן ולמשפחה.`,
    'אני כותבת, אתה מאשר, והקובץ מגיע אליך כדי שתעביר בעצמך.',
  ];
  if (firstEver) lines.push('', 'ואם לא צריך את התזכורת הזאת, מספיק לכתוב לי "בלי תזכורת לדוחות".');
  return { text: lines.join('\n'), buttons: ['להתחיל', 'לדלג החודש'] };
}

/**
 * askMonthlyReports(db, owner, { players }, now, { hour, send, job })
 * Reminds the owner about last month's reports when it is time. Returns
 * { sent, month, players } or { skipped: why }.
 */
async function askMonthlyReports(db, owner, { players = [] } = {}, now = new Date(), { hour, send = null, job = { note: () => {} } } = {}) {
  if (!(hour >= FROM_HOUR && hour <= TO_HOUR)) return { skipped: 'not the hour' };
  const today = israelDate(now);
  if (Number(today.slice(8, 10)) > LAST_DAY) return { skipped: 'not the day' };
  const state = await readState(db);
  if (state.enabled === false) return { skipped: 'off' };
  const month = lastFullMonth(now);
  if (state.lastMonth === month) return { skipped: 'reminded this month' };
  // One of her questions a morning: when another one went out today, tomorrow.
  if (await askedMatchesOn(db, today) || (await readState(db, DAILY_META)).lastAskedOn === today) return { skipped: 'another question went out today' };

  const { threadRef } = await chatOf(db, owner);
  const thread = await threadRef.get();
  const history = thread.exists && Array.isArray(thread.data().history) ? thread.data().history : [];
  const last = history[history.length - 1];
  if (last && now.getTime() - (Number(last.at) || 0) < WAIT_FOR_ANSWER_MS && awaitsAnswer(history)) return { skipped: 'waiting for an answer' };

  const due = playersToReport(players, month);
  if (!due.length) return { skipped: 'nothing to prepare' };
  const q = reminderText(firstName(owner.name) || 'לו', month, due.length, { firstEver: !state.lastMonth });
  await nudge(db, owner, { body: q.text, buttons: q.buttons, kind: 'question', remember: true }, { now: now.getTime(), send, job });
  // merge: "enabled" belongs to the tool and is never written from here
  await db.collection(META[0]).doc(META[1]).set({ lastMonth: month, lastSentOn: today, updatedAt: now.getTime() }, { merge: true });
  job.note(`monthly reports reminder → ${owner.email}: ${month}, ${due.length} player(s)`);
  return { sent: 1, month, players: due.length };
}

// ── the agent's tool ─────────────────────────────────────────────────────────
// What never goes into the two written parts: the report is read by a parent.
const NEVER = ['ratings', 'match notes', 'who watched a match', "the agency's internal notes on him", 'contract terms or salary',
  'deals or their stages', 'club requirements', 'names of clubs we are talking to', 'other players', 'phone numbers or emails'];

const MONTHLY_REPORT_TOOL_DEF = {
  name: 'monthly_report',
  description: "The monthly report for a represented player and his family (one branded PDF page: his month's matches and numbers, the season so far, what we did, the next step). action=prepare (playerId; month YYYY-MM, default the last full month): the facts to write from and the saved text if any. action=save (playerId, month, did: 2-5 short lines, next: one or two sentences): stores the text as a draft on the player; audited, undo_last reverses it. action=send (playerId, month, lang he|en): only after the writer approved the saved text in a LATER message; marks it approved and the PDF goes to the writer with your answer. action=reminder with reminder on|off|status: your monthly reminder to Lou (admin only).",
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['prepare', 'save', 'send', 'reminder'] },
      playerId: { type: 'string' },
      month: { type: 'string', description: 'YYYY-MM; default the last full calendar month.' },
      did: { type: 'array', items: { type: 'string' }, description: `"What we did this month": 2 to ${REPORT_DID_MAX_LINES} short lines, written for a parent.` },
      next: { type: 'string', description: '"The next step": one or two sentences, written for a parent.' },
      lang: { type: 'string', enum: ['he', 'en'], description: 'The PDF: Hebrew (default) or English when asked.' },
      reminder: { type: 'string', enum: ['on', 'off', 'status'] },
    },
    required: ['action'], additionalProperties: false,
  },
};

/**
 * monthlyReportTools({ db, admin, identity, role, channel, session, state, update })
 *   update  wa-agent's own update tool (audited, undoable); called with
 *           { monthlyReport: true } so it accepts the monthlyReports field.
 *   state   wa-agent's per-answer state: the PDF goes into state.outFiles.
 */
function monthlyReportTools({ db, admin, identity = {}, role, channel = 'whatsapp', session = {}, state = { outFiles: [] }, update }) {
  const turn = Number(session?.turn) || 0;
  const me = String(identity.email || '').toLowerCase();

  async function playerOf(playerId) {
    const s = await db.collection('players').doc(String(playerId || '-')).get();
    if (!s.exists || !represented(s.data())) throw new Error('not a represented player: the monthly report is for represented players only');
    return { id: s.id, ...s.data() };
  }
  function monthOf(month, now = new Date()) {
    const m = month || lastFullMonth(now);
    if (!isMonthKey(m)) throw new Error('month is YYYY-MM');
    if (m > israelDate(now).slice(0, 7)) throw new Error('that month has not started yet');
    return m;
  }
  const matchesOf = (playerId) => require('./golda-pdf.js').matchesOf(db, playerId);
  const rowsOf = async (col, playerId) => (await db.collection(col).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => !r.deletedAt && (r.playerId === playerId || (Array.isArray(r.linkedPlayers) && r.linkedPlayers.includes(playerId))));
  const inMonth = (v, month) => String(v || '').slice(0, 7) === month;
  const saveEntry = (playerId, month, entry) => update({ collection: 'players', id: playerId, data: { [`monthlyReports.${month}`]: entry } }, { monthlyReport: true });

  async function prepare({ playerId, month }) {
    const p = await playerOf(playerId);
    const m = monthOf(month);
    const facts = monthlyReportFacts(await matchesOf(p.id), p.id, m);
    // The month's work for him, dated. Deal moves (they name clubs and stages) are left out.
    const [interactions, meetings, tasks] = await Promise.all(['interactions', 'meetings', 'tasks'].map((c) => rowsOf(c, p.id).catch(() => [])));
    const saved = reportOf(p, m);
    return {
      player: { id: p.id, name: playerName(p), club: p.currentClub || '' }, month: m, monthName: { he: monthName(m, 'he'), en: monthName(m, 'en') },
      ...facts,
      activity: {
        notes: interactions.filter((x) => !x.dealId && inMonth(x.at, m)).map((x) => ({ date: String(x.at).slice(0, 10), kind: x.kind || 'note', text: String(x.text || '').slice(0, 400) })),
        meetings: meetings.filter((x) => inMonth(x.date, m)).map((x) => ({ date: x.date, title: x.title || '' })),
        tasksDone: tasks.filter((x) => x.done && inMonth(x.completedAt || x.doneAt || x.dueDate, m)).map((x) => ({ date: String(x.completedAt || x.doneAt || x.dueDate).slice(0, 10), title: x.title || '' })),
      },
      saved: saved ? { did: saved.did || [], next: saved.next || '', status: saved.status || 'draft' } : null,
      neverWrite: NEVER,
      instruction: 'Write "did" (2-5 short lines) and "next" (1-2 sentences) in Hebrew, warmly and factually, for a parent, from these facts only. Then save, show the writer the text and ask; send only after their yes in a later message.',
    };
  }

  async function save({ playerId, month, did, next }) {
    if (typeof update !== 'function') throw new Error('monthly_report is not wired');
    const p = await playerOf(playerId);
    const m = monthOf(month);
    const text = cleanReportText({ did, next });
    if (!text.did.length) throw new Error('did is 2 to 5 short lines of what the agency did this month');
    if (!text.next) throw new Error('next is one or two sentences: the next step');
    const entry = { ...text, status: 'draft', by: identity.email || '', at: new Date().toISOString(), turn };
    await saveEntry(p.id, m, entry);
    return { saved: true, player: playerName(p), month: m, monthName: monthName(m, 'he'), did: text.did, next: text.next, status: 'draft',
      instruction: 'Show the writer this text as it is, say nothing goes to anyone yet, and ask with buttons [[כפתורים: מאשר, לשלוח | לשנות]]. Send only after their yes in a later message.' };
  }

  async function send({ playerId, month, lang = 'he' }) {
    if (typeof update !== 'function') throw new Error('monthly_report is not wired');
    const p = await playerOf(playerId);
    const m = monthOf(month);
    const entry = reportOf(p, m);
    if (!entry || !(entry.did || []).length) throw new Error('there is no saved text for that month: prepare, write it, save it and ask the writer first');
    let final = entry;
    if (entry.status !== 'approved') {
      const mine = String(entry.by || '').toLowerCase() === me && Number.isFinite(Number(entry.turn)) && entry.turn !== '' && entry.turn !== null;
      if (!mine) {
        return { needsApproval: true, did: entry.did, next: entry.next,
          instruction: 'This text was saved in the app or by someone else. Save it (as it is or with the writer\'s changes) with action=save, show it, and send only after the writer\'s yes in a later message.' };
      }
      if (!(turn > Number(entry.turn))) throw new Error('the writer has not answered the text yet: show it, ask, and send only after their yes in a later message');
      final = { did: entry.did, next: entry.next, status: 'approved', by: identity.email || '', at: new Date().toISOString(), turn: entry.turn, approvedBy: identity.email || '', approvedAt: new Date().toISOString() };
      await saveEntry(p.id, m, final);
    }
    if ((state.outFiles || []).length >= MAX_FILES) throw new Error('at most three documents per answer');
    const file = await require('./golda-pdf.js').playerReportPdf({ ...p, monthlyReports: { ...(p.monthlyReports || {}), [m]: final } }, m, { lang: lang === 'en' ? 'en' : 'he', db });
    state.outFiles.push(file);
    return { made: true, approved: true, month: m, filename: file.filename, sizeKB: Math.round(file.buffer.length / 1024), link: `${APP}/players/${p.id}`,
      note: 'The PDF goes to the writer right after your text answer; just say it is attached and that they forward it. You never send it to the player or the family.' };
  }

  async function reminder({ reminder: what }) {
    if (role !== 'admin') throw new Error('only an admin can change the monthly reminder');
    const s = await readState(db);
    const was = s.enabled !== false;
    if (what === 'status') return { on: was, lastMonth: s.lastMonth || null };
    if (what !== 'on' && what !== 'off') throw new Error('reminder is on, off or status');
    const on = what === 'on';
    if (on === was) return { on, unchanged: true };
    await db.collection(META[0]).doc(META[1]).set({ enabled: on, changedBy: identity.email || '', changedAt: Date.now() }, { merge: true });
    if (admin?.firestore?.FieldValue) {
      await db.collection('audit').add({
        action: 'update', collection: 'settings', docId: META[1], name: 'התזכורת של גולדה לדוחות החודשיים', summary: `monthly reports reminder: ${on ? 'on' : 'off'}`, fields: ['enabled'],
        by: identity.email || '', byName: `${identity.name || ''} (Golda)`.trim(), via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '',
        sender: identity.name || '', phone: identity.phone || '', at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
      }).catch((e) => console.error('[golda-monthly-report] audit failed:', e.message));
    }
    return { on, note: on ? 'The reminder about the monthly reports is back: on the 1st of each month.' : 'No more reminders about the monthly reports until he asks for them again.' };
  }

  const actions = { prepare, save, send, reminder };
  return {
    monthly_report: async (input = {}) => {
      const fn = actions[input.action];
      if (!fn) throw new Error('action is prepare, save, send or reminder');
      return fn(input);
    },
  };
}

module.exports = {
  askMonthlyReports, remindedOn, playersToReport, reminderText, monthlyReportTools, MONTHLY_REPORT_TOOL_DEF, NEVER,
  FROM_HOUR, TO_HOUR, LAST_DAY,
};
