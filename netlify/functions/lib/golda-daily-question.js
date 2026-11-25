// One question a day. Once a day, in the afternoon, Golda asks the owner one
// question that fills the most important gap in the represented players'
// records, with reply buttons where the answer is one of a few words.
//
// Which gap: GAPS below, most important first (a contract with no end date
// comes long before a missing preferred foot). The same question is never
// asked twice in a row and not again for two weeks; with nothing important
// missing, the day is skipped.
// The answer: the owner's next message goes through the normal agent
// (lib/wa-agent.js), which finds the player and saves the field with `update`,
// so it is audited and can be undone like any change made through Golda.
// On and off: he tells her ("בלי שאלה יומית" / "תחזירי את השאלה היומית") and
// the agent calls the daily_question tool below.
// State: app_meta/goldaDailyQuestion { enabled, lastKey, lastAskedOn, recent }.
const { israelDate, daysBetween, playerName } = require('@goldas/domain');
const { chatOf, nudge } = require('./golda-nudge.js');
const { awaitsAnswer } = require('./golda-effort.js');

const APP = 'https://goldas-crm.netlify.app';
const META = ['app_meta', 'goldaDailyQuestion'];
const FROM_HOUR = 13;            // Israel time: after the morning's messages, before the evening
const TO_HOUR = 19;
const COOLDOWN_DAYS = 14;        // a question that got no answer comes back after this long
const KEEP_RECENT = 60;
const WAIT_FOR_ANSWER_MS = 3 * 3600000;

const empty = (v) => (Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim());
const HAS_CONTRACT = ['Under Contract', 'Loan'];

// What may be asked, by importance. Links, notes, the league and document
// numbers are never asked: a question a day is for what the work depends on.
const GAPS = [
  { field: 'contractEnd', weight: 100, when: (p) => HAS_CONTRACT.includes(p.contractStatus) },
  { field: 'contractStatus', weight: 95 },
  { field: 'reprEnd', weight: 90 },
  { field: 'passportExpiry', weight: 70 },
  { field: 'dob', weight: 60 },
  { field: 'primaryPosition', weight: 50 },
  { field: 'currentClub', weight: 45, when: (p) => p.contractStatus !== 'Free' },
  { field: 'foot', weight: 20 },
  { field: 'nationalities', weight: 15 },
];

/**
 * The gap to ask about today, or null when nothing important is missing.
 *   state  { lastKey, recent: [{ key, on }] }
 */
function pickDataGap(players, state = {}, today = israelDate(new Date())) {
  const askedLately = new Set((state.recent || []).filter((r) => r && r.key && daysBetween(r.on, today) < COOLDOWN_DAYS).map((r) => r.key));
  const found = [];
  for (const p of players || []) {
    if (!p || p.deletedAt) continue;
    for (const g of GAPS) {
      if ((g.when && !g.when(p)) || !empty(p[g.field])) continue;
      const key = `${p.id}|${g.field}`;
      if (key === state.lastKey || askedLately.has(key)) continue;
      found.push({ key, field: g.field, weight: g.weight, player: p });
    }
  }
  found.sort((a, b) => b.weight - a.weight || playerName(a.player).localeCompare(playerName(b.player), 'he') || a.key.localeCompare(b.key));
  return found[0] || null;
}

/** The question in Hebrew, with reply buttons when the answer is one of a few words. */
function questionFor(first, gap, { firstEver = false } = {}) {
  const p = gap.player;
  const name = playerName(p);
  const she = p.gender === 'Women';
  const club = p.currentClub ? ` (${p.currentClub})` : '';
  const date = 'אפשר לענות בתאריך, למשל 30/06/2027.';
  const q = {
    contractEnd: { ask: `עד מתי החוזה של ${name}${club}?`, hint: date },
    contractStatus: { ask: `מה מצב החוזה של ${name}?`, hint: 'או: בניסיון.', buttons: she ? ['בחוזה', 'חופשייה', 'מושאלת'] : ['בחוזה', 'חופשי', 'מושאל'] },
    reprEnd: { ask: `עד מתי הסכם הייצוג שלנו עם ${name}?`, hint: date },
    passportExpiry: { ask: `עד מתי הדרכון של ${name} בתוקף?`, hint: date },
    dob: { ask: `מה תאריך הלידה של ${name}?`, hint: 'למשל 14/03/2008.' },
    primaryPosition: { ask: `באיזו עמדה ${name} ${she ? 'משחקת' : 'משחק'}?`, hint: '' },
    currentClub: { ask: `באיזה מועדון ${name} ${she ? 'משחקת' : 'משחק'} היום?`, hint: '' },
    foot: { ask: `מה הרגל החזקה של ${name}?`, hint: '', buttons: ['ימין', 'שמאל', 'שתיהן'] },
    nationalities: { ask: `מה האזרחות של ${name}?`, hint: '' },
  }[gap.field];
  const lines = [`*שאלה יומית, ${first}* ❓`, q.ask];
  if (q.hint) lines.push(q.hint);
  lines.push('', `זה חסר בכרטיס: ${APP}/players/${p.id}`, 'לא ידוע כרגע? אפשר לענות "דלג".');
  if (firstEver) lines.push('ואם השאלה היומית מיותרת, מספיק לכתוב לי "בלי שאלה יומית".');
  return { text: lines.join('\n'), buttons: q.buttons || [] };
}

async function readState(db) {
  const snap = await db.collection(META[0]).doc(META[1]).get();
  return snap.exists ? (snap.data() || {}) : {};
}

/**
 * askDaily(db, owner, players, now, { hour, send, job })
 * Asks today's question when it is time. Returns { sent, key } or { skipped: why }.
 *   hour  the hour in Israel now
 */
async function askDaily(db, owner, players, now = new Date(), { hour, send = null, job = { note: () => {} } } = {}) {
  if (!(hour >= FROM_HOUR && hour <= TO_HOUR)) return { skipped: 'not the hour' };
  const state = await readState(db);
  if (state.enabled === false) return { skipped: 'off' };
  const today = israelDate(now);
  if (state.lastAskedOn === today) return { skipped: 'asked today' };

  // Not on top of a question of hers that he has not answered yet: an hour later instead.
  const { threadRef } = await chatOf(db, owner);
  const thread = await threadRef.get();
  const history = thread.exists && Array.isArray(thread.data().history) ? thread.data().history : [];
  const last = history[history.length - 1];
  if (last && now.getTime() - (Number(last.at) || 0) < WAIT_FOR_ANSWER_MS && awaitsAnswer(history)) return { skipped: 'waiting for an answer' };

  const gap = pickDataGap(players, state, today);
  if (!gap) return { skipped: 'nothing important is missing' };
  const first = (owner.name || '').split(' ')[0] || 'לו';
  const q = questionFor(first, gap, { firstEver: !state.lastKey });
  await nudge(db, owner, { body: q.text, buttons: q.buttons, kind: 'question', remember: true }, { now: now.getTime(), send, job });
  const recent = [...(state.recent || []).filter((r) => r && r.key !== gap.key), { key: gap.key, on: today }].slice(-KEEP_RECENT);
  // merge: "enabled" belongs to the daily_question tool and is never written from here
  await db.collection(META[0]).doc(META[1]).set({ lastKey: gap.key, lastAskedOn: today, recent, updatedAt: now.getTime() }, { merge: true });
  job.note(`daily question → ${owner.email}: ${gap.field}`);
  return { sent: 1, key: gap.key };
}

// ── the agent's tool: on, off, status ────────────────────────────────────────
const DAILY_QUESTION_TOOL_DEF = {
  name: 'daily_question',
  description: "Your daily question to Lou (once a day you ask him one question that fills an important gap in a player's record). Turn it off or on when he asks, or check whether it is on. Admin only.",
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'status'] } }, required: ['action'], additionalProperties: false },
};

function dailyQuestionTools({ db, admin, identity = {}, role, channel = 'whatsapp' }) {
  return {
    daily_question: async ({ action } = {}) => {
      if (role !== 'admin') throw new Error('only an admin can change the daily question');
      const state = await readState(db);
      const was = state.enabled !== false;
      if (action === 'status') return { on: was, lastAskedOn: state.lastAskedOn || null };
      if (action !== 'on' && action !== 'off') throw new Error('action is on, off or status');
      const on = action === 'on';
      if (on === was) return { on, unchanged: true };
      await db.collection(META[0]).doc(META[1]).set({ enabled: on, changedBy: identity.email || '', changedAt: Date.now() }, { merge: true });
      if (admin?.firestore?.FieldValue) {
        await db.collection('audit').add({
          action: 'update', collection: 'settings', docId: META[1], name: 'השאלה היומית של גולדה', summary: `daily question: ${on ? 'on' : 'off'}`, fields: ['enabled'],
          by: identity.email || '', byName: `${identity.name || ''} (Golda)`.trim(), via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '',
          sender: identity.name || '', phone: identity.phone || '', at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
        }).catch((e) => console.error('[golda-daily-question] audit failed:', e.message));
      }
      return { on, note: on ? 'The daily question is back: one question a day, in the afternoon.' : 'No more daily questions until he asks for them again.' };
    },
  };
}

module.exports = { GAPS, pickDataGap, questionFor, askDaily, dailyQuestionTools, DAILY_QUESTION_TOOL_DEF, FROM_HOUR, TO_HOUR, COOLDOWN_DAYS };
