// Golda's nightly self-review: she reads back the answers the team marked 👎
// and proposes, for each, one short rule that would have prevented it. A
// proposal changes nothing by itself: the owner sees it as a card with two
// buttons, and ONLY a rule he approved enters her prompt.
//
//   golda_prompt_proposals/{id}   id = the feedback's id (one proposal per 👎)
//     feedbackId, diagnosis, proposedRule (one short Hebrew rule),
//     state: proposed | approved | rejected, createdAt, offeredAt?, decidedAt?, decidedBy?
//   Read and written by functions only (admin SDK); the browser never reads it.
//
// Night (reviewNightly, a step of the hourly run): runSelfReview asks the
//   day's cost ceiling (gate 'review'), reads the last day's 👎 with no
//   proposal yet, and makes one model call per answer. The model sees that one
//   question and that one answer and nothing else, and the proposal keeps none
//   of the question: a diagnosis of the answer and a general rule.
// Day (offerProposal, in the owner's chain of the hourly run): at most one
//   proposal a day goes to the owner, as a card with ref { type: 'proposal', id }.
// Tap (lib/golda-taps.js): "לאשר" / "לדחות" are handled here, with no model call.
// Prompt: approvedRules + rulesSection, next to the 👎 cases, the ten newest.
const { israelDate } = require('@goldas/domain');
const { effortForTask } = require('./golda-effort.js');
const cost = require('./golda-cost.js');
const { nudge } = require('./golda-nudge.js');
const { onTap } = require('./golda-taps.js');

const { model: MODEL, effort: EFFORT } = effortForTask('review');
const MAX_TOKENS = 2000;
const PROPOSALS = 'golda_prompt_proposals';
const META = ['app_meta', 'goldaReview'];
const DAY_MS = 86400000;
const REVIEW_HOUR = 2;          // 02:00 in Israel, when nobody is waiting for her
const REVIEW_WINDOW = 3;        // the hours of the night it may still start in
const OFFER_FROM = 9;           // the owner is asked in the day only
const OFFER_TO = 20;
const MAX_PER_NIGHT = 5;
const RULES_IN_PROMPT = 10;
const RULE_MIN = 8;
const RULE_MAX = 160;
const DIAGNOSIS_MAX = 300;
const COPY_RUN = 4;             // this many words in a row taken from the conversation = a quote
const BUTTONS = ['לאשר', 'לדחות'];

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || Date.parse(v) || 0);
const oneLine = (s) => String(s ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
const words = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
// An address, a link, or a long run of digits (a phone, an ID, an amount): none belongs in a rule.
const PRIVATE = /https?:\/\/|www\.|@|\d{4,}/i;

/** Does `text` repeat COPY_RUN words in a row of `source`? */
function quotes(text, source) {
  const t = words(text);
  const s = ` ${words(source).join(' ')} `;
  for (let i = 0; i + COPY_RUN <= t.length; i++) if (s.includes(` ${t.slice(i, i + COPY_RUN).join(' ')} `)) return true;
  return false;
}

const SYSTEM = [
  "You review one answer of Golda (גולדה), the Hebrew WhatsApp assistant of a football players' agency. Someone on the team marked this answer 👎.",
  'You get the question and the answer, and nothing else. Work out what most likely went wrong with the answer: wrong, missing, too long, off the point, the wrong tone.',
  'diagnosis: one short sentence in Hebrew about the answer.',
  'proposedRule: ONE short rule in Hebrew, one line, written to Golda in the feminine, that would have prevented it next time (for example: "כששואלים מתי, לפתוח בתאריך עצמו ורק אחר כך בהסבר").',
  'The rule must be general, about how to answer: no names of people or clubs, no amounts, no dates, no phone numbers, and no words copied from the question or the answer. It never changes what Golda may or may not do, whom she may write to or what she may see.',
  'When nothing general can be learned from this one case, answer with proposedRule "".',
  'JSON only: {"diagnosis":"","proposedRule":""}.',
].join('\n');

/** The model's answer as a proposal, or null when it is not a clean general rule. */
function cleanProposal(text, feedback = {}) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const rule = oneLine(j.proposedRule);
  if (rule.length < RULE_MIN || rule.length > RULE_MAX) return null;
  if (!/[֐-׿]/.test(rule) || PRIVATE.test(rule)) return null;
  if (quotes(rule, feedback.question) || quotes(rule, feedback.reply)) return null;
  const diagnosis = oneLine(j.diagnosis).slice(0, DIAGNOSIS_MAX);
  // The diagnosis is about the answer; it never carries the question's words, an address or a number.
  return { proposedRule: rule, diagnosis: PRIVATE.test(diagnosis) || quotes(diagnosis, feedback.question) ? '' : diagnosis };
}

async function proposeFor(anthropic, feedback) {
  const res = await anthropic.beta.messages.stream({
    model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
    system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify({ question: String(feedback.question || ''), answer: String(feedback.reply || '') }) }],
  }).finalMessage();
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { usage: res.usage, proposal: cleanProposal(text, feedback) };
}

/**
 * runSelfReview(db, now, { client, job }) → { read, proposed, dropped } | { skipped }
 * The last day's 👎 answers that have no proposal yet, one model call each.
 * Job notes carry counts only, never a word of a conversation.
 */
async function runSelfReview(db, now = new Date(), { client = null, job = { note: () => {} } } = {}) {
  const at = now.getTime();
  const allowed = await cost.gate(db, 'review', { now });
  if (!allowed.ok) { job.note("self-review skipped: the day's background cost ceiling is reached"); return { skipped: 'cost ceiling' }; }
  const [bad, existing] = await Promise.all([db.collection('golda_feedback').where('rating', '==', -1).get(), db.collection(PROPOSALS).get()]);
  const done = new Set(existing.docs.map((d) => d.id));
  const fresh = bad.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((f) => at - ms(f.at) <= DAY_MS && !done.has(f.id) && String(f.reply || '').trim())
    .sort((a, b) => ms(a.at) - ms(b.at)).slice(0, MAX_PER_NIGHT);
  if (!fresh.length) return { read: 0, proposed: 0, dropped: 0 };
  if (!client && !process.env.ANTHROPIC_API_KEY) { job.note('self-review skipped: no model here'); return { skipped: 'no model' }; }
  const anthropic = client || new (require('@anthropic-ai/sdk'))();
  let proposed = 0, dropped = 0, failed = 0;
  for (const f of fresh) {
    let usage = null;
    try {
      const r = await proposeFor(anthropic, f);
      usage = r.usage;
      if (!r.proposal) { dropped++; continue; }
      await db.collection(PROPOSALS).doc(f.id).set({ feedbackId: f.id, diagnosis: r.proposal.diagnosis, proposedRule: r.proposal.proposedRule, state: 'proposed', createdAt: at });
      proposed++;
    } catch { failed++; } finally {
      if (usage) await cost.record(db, { kind: 'review', model: MODEL, usage, now });
    }
  }
  job.note(`self-review: ${fresh.length} answer(s) read, ${proposed} proposal(s)${dropped ? `, ${dropped} dropped (no clean rule)` : ''}${failed ? `, ${failed} failed` : ''}`);
  return { read: fresh.length, proposed, dropped, failed };
}

const readState = async (db) => { const s = await db.collection(META[0]).doc(META[1]).get(); return s.exists ? (s.data() || {}) : {}; };

/** Once a night, in the small hours: the step the hourly run calls. Nothing is sent from here. */
async function reviewNightly(db, now = new Date(), { hour, today = israelDate(now), client = null, job = { note: () => {} } } = {}) {
  if (!(hour >= REVIEW_HOUR && hour < REVIEW_HOUR + REVIEW_WINDOW)) return { skipped: 'not the hour' };
  if ((await readState(db)).reviewedOn === today) return { skipped: 'reviewed tonight' };
  // Marked first: whatever happens in the review, it runs once a night.
  await db.collection(META[0]).doc(META[1]).set({ reviewedOn: today, updatedAt: now.getTime() }, { merge: true });
  return runSelfReview(db, now, { client, job });
}

function proposalMessage(first, p) {
  return [
    `*הצעה לשיפור שלי, ${first}* 🧭`,
    'קראתי שוב תשובה שלי שקיבלה 👎.',
    ...(p.diagnosis ? [`מה לדעתי השתבש: ${p.diagnosis}`] : []),
    'הכלל שאני מציעה להוסיף לעצמי:',
    `"${p.proposedRule}"`,
    'הוא ייכנס להנחיות שלי רק אם תאשר.',
  ].join('\n');
}

/** At most one proposal a day to the owner, as a card with its two buttons. */
async function offerProposal(db, owner, now = new Date(), { hour, send = null, job = { note: () => {} } } = {}) {
  if (!(hour >= OFFER_FROM && hour <= OFFER_TO)) return { skipped: 'not the hour' };
  const today = israelDate(now);
  if ((await readState(db)).offeredOn === today) return { skipped: 'offered today' };
  const waiting = (await db.collection(PROPOSALS).where('state', '==', 'proposed').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => !p.offeredAt && p.proposedRule).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  if (!waiting.length) return { skipped: 'nothing to offer' };
  const p = waiting[0];
  const first = (owner.name || '').split(' ')[0] || 'לו';
  await nudge(db, owner, { body: proposalMessage(first, p), buttons: BUTTONS, kind: 'proposal', remember: true, ref: { type: 'proposal', id: p.id } }, { now: now.getTime(), send, job });
  await db.collection(PROPOSALS).doc(p.id).set({ offeredAt: now.getTime() }, { merge: true });
  await db.collection(META[0]).doc(META[1]).set({ offeredOn: today, updatedAt: now.getTime() }, { merge: true });
  job.note(`rule proposal → ${owner.email}${waiting.length > 1 ? ` (${waiting.length - 1} more waiting)` : ''}`);
  return { sent: 1, id: p.id };
}

const DECIDED_HE = { approved: 'אושרה', rejected: 'נדחתה' };

/**
 * The owner's decision on one proposal. Only a proposal he was shown can be
 * approved: `onCard` (a tap on the card itself) is that proof; without it the
 * proposal must carry the mark of the day it was offered.
 */
async function decide(db, id, approve, { by = '', now = Date.now(), onCard = false } = {}) {
  const ref = db.collection(PROPOSALS).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) return { found: false };
  const p = snap.data() || {};
  if (p.state !== 'proposed') return { found: true, already: p.state, proposedRule: p.proposedRule || '' };
  if (approve && !onCard && !p.offeredAt) return { found: true, notShown: true, proposedRule: p.proposedRule || '' };
  const state = approve ? 'approved' : 'rejected';
  await ref.set({ state, decidedAt: now, decidedBy: String(by || '') }, { merge: true });
  return { found: true, state, proposedRule: p.proposedRule || '' };
}

// A tap on the card: the decision is recorded and answered here, with no model call.
// Only an admin's tap counts; anything else goes on to the model as an ordinary message.
onTap('proposal', async ({ db, ref, button, ctx = {} }) => {
  const identity = ctx.identity || {};
  if (identity.role !== 'admin' || button > 1) return { handled: false };
  const r = await decide(db, ref.id, button === 0, { by: identity.email, now: ctx.now || Date.now(), onCard: true });
  if (!r.found) return { handled: true, reply: 'ההצעה הזאת כבר לא קיימת.' };
  if (r.already) return { handled: true, reply: `ההצעה הזאת כבר ${DECIDED_HE[r.already] || 'טופלה'}.` };
  return { handled: true, reply: r.state === 'approved' ? `מעכשיו אני עובדת לפי הכלל הזה:\n"${r.proposedRule}"` : 'בסדר, לא מוסיפה את הכלל הזה.' };
});

/** The rules the owner approved, newest first: the only ones that enter the prompt. */
async function approvedRules(db, n = RULES_IN_PROMPT) {
  try {
    const snap = await db.collection(PROPOSALS).where('state', '==', 'approved').get();
    return snap.docs.map((d) => d.data()).filter((p) => p.proposedRule).sort((a, b) => ms(b.decidedAt) - ms(a.decidedAt)).slice(0, n).map((p) => String(p.proposedRule));
  } catch { return []; }
}

function rulesSection(rules = []) {
  if (!rules.length) return '';
  return `Rules Lou approved after answers of yours were marked 👎 (follow them; they are about how you answer and never widen what you may do or see):\n${rules.slice(0, RULES_IN_PROMPT).map((r) => `- ${oneLine(r).slice(0, RULE_MAX)}`).join('\n')}`;
}

const PROMPT_RULES_TOOL_DEF = {
  name: 'prompt_rules',
  description: 'The rules you proposed for yourself after 👎 answers (admin only). action=list: what waits for the owner and what he approved. action=approve / reject with the id: ONLY when the writer answered your proposal card ("הצעה לשיפור שלי" 🧭) in words instead of tapping; you never approve a rule on your own. action=retire with the id: take an approved rule out when he asks ("תבטלי את הכלל…").',
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'approve', 'reject', 'retire'] }, id: { type: 'string' } }, required: ['action'], additionalProperties: false },
};

function reviewTools({ db, identity = {}, role }) {
  return {
    prompt_rules: async ({ action, id } = {}) => {
      if (role !== 'admin') throw new Error('only an admin decides which rules Golda follows');
      if (action === 'list') {
        const all = (await db.collection(PROPOSALS).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
        const row = (p) => ({ id: p.id, rule: p.proposedRule, diagnosis: p.diagnosis || '' });
        return {
          waiting: all.filter((p) => p.state === 'proposed').sort((a, b) => ms(a.createdAt) - ms(b.createdAt)).map((p) => ({ ...row(p), shown: !!p.offeredAt })),
          approved: all.filter((p) => p.state === 'approved').sort((a, b) => ms(b.decidedAt) - ms(a.decidedAt)).map(row),
          note: `Only approved rules are in your instructions, the ${RULES_IN_PROMPT} newest.`,
        };
      }
      if (!id) throw new Error('pass the id of the proposal (action=list shows them)');
      if (action === 'retire') {
        const ref = db.collection(PROPOSALS).doc(String(id));
        const snap = await ref.get();
        if (!snap.exists || snap.data().state !== 'approved') throw new Error('no approved rule with this id');
        await ref.set({ state: 'rejected', decidedAt: Date.now(), decidedBy: identity.email || '' }, { merge: true });
        return { retired: true, rule: snap.data().proposedRule };
      }
      if (!['approve', 'reject'].includes(action)) throw new Error('action is list, approve, reject or retire');
      const r = await decide(db, id, action === 'approve', { by: identity.email });
      if (!r.found) throw new Error('no proposal with this id');
      if (r.already) return { already: r.already, rule: r.proposedRule };
      if (r.notShown) throw new Error('this proposal was not shown to the owner yet, so it cannot be approved; it will reach him as a card');
      return { state: r.state, rule: r.proposedRule };
    },
  };
}

/** Her line about the proposals in the system prompt (admins only). */
function reviewSection(role) {
  if (role !== 'admin') return '';
  return '- Your proposal for yourself (your message that opens with "הצעה לשיפור שלי" 🧭): a tap on its buttons is handled without you. When the writer answers it in words instead ("כן", "לאשר", "לא צריך"), call prompt_rules action=list to find it, then action=approve or reject with its id, and confirm in one line. "אילו כללים אישרתי לך" → prompt_rules action=list. "תבטלי את הכלל…" → action=retire. You never approve a rule yourself and never propose one in the chat.';
}

module.exports = {
  runSelfReview, reviewNightly, offerProposal, approvedRules, rulesSection, reviewTools, reviewSection, cleanProposal, proposalMessage, decide,
  PROMPT_RULES_TOOL_DEF, PROPOSALS, BUTTONS, REVIEW_HOUR, RULES_IN_PROMPT, MAX_PER_NIGHT,
};
