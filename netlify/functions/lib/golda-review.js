// Golda's nightly self-review: she reads back the answers the team marked 👎
// and proposes, for each, one short rule that would have prevented it. A
// proposal changes nothing by itself: the owner sees it as a card with two
// buttons, and ONLY a rule he approved enters her prompt.
//
//   golda_prompt_proposals/{id}   id = the feedback's id (one document per reviewed 👎)
//     feedbackId, diagnosis, proposedRule (one short Hebrew rule),
//     state: proposed | approved | rejected | dropped, createdAt,
//     offeredAt? (the card was sent), queuedAt? (it waits for WhatsApp's window), decidedAt?, decidedBy?
//     reason? (dropped: a code only, never the text the model wrote)
//   Read and written by functions only (admin SDK); the browser never reads it.
//   A dropped document is never offered and never reviewed again.
//
// Night (reviewNightly, a step of the hourly run): the night is claimed in a
//   transaction, so two runs of the same hour review once. runSelfReview reads
//   the 👎 of the last seven days that have no document yet, oldest first, at
//   most five, and asks the day's cost ceiling (gate 'review') before EACH
//   model call. The model sees that one question and that one answer and
//   nothing else, and the proposal keeps none of the question: a diagnosis of
//   the answer and a general rule, with no number, no money, no name of the
//   CRM and no word about permissions or sending.
// Day (offerProposal, in the owner's chain of the hourly run): at most one
//   proposal a day goes to the owner, as a card with ref { type: 'proposal', id }.
// Tap (lib/golda-taps.js): "לאשר" / "לדחות" are handled here, with no model call.
// Typed answer (prompt_rules): the owner only, the latest card only, within a day of it.
// Prompt: approvedRules + rulesSection, next to the 👎 cases, the ten newest,
//   followed by a fixed line that they lose to every other instruction.
const { israelDate } = require('@goldas/domain');
const { effortForTask } = require('./golda-effort.js');
const cost = require('./golda-cost.js');
const { nudge } = require('./golda-nudge.js');
const { onTap } = require('./golda-taps.js');
const { OWNER_EMAIL } = require('./firestore.js');
const { carriesNumber } = require('./golda-deal.js');

const { model: MODEL, effort: EFFORT } = effortForTask('review');
const MAX_TOKENS = 2000;
const PROPOSALS = 'golda_prompt_proposals';
const META = ['app_meta', 'goldaReview'];
const DAY_MS = 86400000;
const REVIEW_HOUR = 2;          // 02:00 in Israel, when nobody is waiting for her
const REVIEW_WINDOW = 3;        // the hours of the night it may still start in
const LOOK_BACK_MS = 7 * DAY_MS;  // a 👎 not reviewed one night is reviewed on a later one, for a week
const ANSWER_WITHIN_MS = DAY_MS;  // a typed approval counts for a day after the card
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
// An address or a link: none belongs in a rule. (Any digit is refused on its own, below.)
const PRIVATE = /https?:\/\/|www\.|@/i;
// Words about who may do or see what, or about sending: a rule is about how she answers, never about that.
const PERMISSION_WORDS = new Set(['הרשאה', 'הרשאות', 'מותר', 'מותרת', 'להתעלם', 'תתעלמי', 'התעלמי', 'לעקוף', 'תעקפי', 'עקפי', 'לשלוח', 'תשלחי', 'שלחי', 'שולחת',
  'ignore', 'permission', 'permissions', 'bypass', 'override', 'send', 'sending', 'admin']);
const PERMISSION_PHRASES = ['בלי טיוטה', 'ללא טיוטה', 'בלי אישור', 'ללא אישור', 'כל משתמש', 'מנהל המערכת', 'לשלוח ישירות', 'מותר לשלוח'];
const PREFIXES = 'והבכלמש';
/** A word, and the same word without one to three one-letter Hebrew prefixes ("ולשלוח" → "לשלוח"). */
function forms(word) {
  const out = [word];
  for (let i = 1; i <= 3 && i < word.length - 1 && PREFIXES.includes(word[i - 1]); i++) out.push(word.slice(i));
  return out;
}
const letters = (s) => (String(s ?? '').toLowerCase().match(/\p{L}+/gu) || []);

/** Does the text speak of permissions, sending or bypassing? */
function aboutPermissions(text) {
  const w = letters(text);
  if (w.some((x) => forms(x).some((f) => PERMISSION_WORDS.has(f)))) return true;
  const flat = ` ${w.join(' ')} `;
  return PERMISSION_PHRASES.some((p) => {
    const [first, ...rest] = letters(p);
    return w.some((x, i) => forms(x).includes(first) && rest.every((r, k) => w[i + 1 + k] && forms(w[i + 1 + k]).includes(r))) || flat.includes(` ${p} `);
  });
}

/**
 * The names a rule must not carry: players, clubs, contacts and the team, as
 * the CRM has them. A whole name of two letters or more; for a name of several
 * words, also each word of three letters or more.
 */
function namesToCheck(names = []) {
  const out = new Set();
  for (const n of names) {
    const w = letters(n);
    if (!w.length || w.join('').length < 2) continue;
    out.add(w.join(' '));
    if (w.length > 1) for (const part of w) if (part.length >= 3) out.add(part);
  }
  return [...out].map((n) => n.split(' '));
}

/** Does the text carry one of these names, as whole words (a one-letter prefix allowed: "ליוסי")? */
function carriesName(text, names) {
  const w = letters(text);
  return names.some((name) => w.some((x, i) => forms(x).includes(name[0]) && name.slice(1).every((part, k) => w[i + 1 + k] === part)));
}

/** Why a text may not stand in a rule or a diagnosis, as a code; '' when it may. */
function refusal(text, feedback, names) {
  if (PRIVATE.test(text)) return 'private';
  if (carriesNumber(text)) return 'number_or_money';
  if (aboutPermissions(text)) return 'permissions';
  if (carriesName(text, names)) return 'name';
  if (quotes(text, feedback.question) || quotes(text, feedback.reply)) return 'quote';
  return '';
}

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
  'The rule must be general, about how to answer: no names of people or clubs, no numbers or amounts of any kind (no digits, no currency, no percent), no dates, no phone numbers, and no words copied from the question or the answer. It never speaks of permissions, sending or skipping a step, and never changes what Golda may or may not do, whom she may write to or what she may see. The diagnosis follows the same limits.',
  'When nothing general can be learned from this one case, answer with proposedRule "".',
  'JSON only: {"diagnosis":"","proposedRule":""}.',
].join('\n');

/**
 * judgeProposal(text, feedback, { names }) → { proposedRule, diagnosis } | { reason }
 * The model's answer as a proposal, or the code of why it is not a clean general rule:
 * no_json, empty, length, not_hebrew, private, number_or_money, permissions, name, quote.
 * `names` are the CRM's names (players, clubs, contacts, the team).
 */
function judgeProposal(text, feedback = {}, { names = [] } = {}) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { reason: 'no_json' };
  let j;
  try { j = JSON.parse(m[0]); } catch { return { reason: 'no_json' }; }
  const rule = oneLine(j.proposedRule);
  if (!rule) return { reason: 'empty' };
  if (rule.length < RULE_MIN || rule.length > RULE_MAX) return { reason: 'length' };
  if (!/[֐-׿]/.test(rule)) return { reason: 'not_hebrew' };
  const known = namesToCheck(names);
  const why = refusal(rule, feedback, known);
  if (why) return { reason: why };
  const diagnosis = oneLine(j.diagnosis).slice(0, DIAGNOSIS_MAX);
  // The diagnosis is shown on the card: the same checks, and the question's or the answer's words are refused too. Refused, it is blank.
  return { proposedRule: rule, diagnosis: refusal(diagnosis, feedback, known) ? '' : diagnosis };
}

/** The model's answer as a proposal, or null when it is not a clean general rule. */
function cleanProposal(text, feedback = {}, opts = {}) {
  const r = judgeProposal(text, feedback, opts);
  return r.reason ? null : r;
}

async function proposeFor(anthropic, feedback, names) {
  const res = await anthropic.beta.messages.stream({
    model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
    system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify({ question: String(feedback.question || ''), answer: String(feedback.reply || '') }) }],
  }).finalMessage();
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { usage: res.usage, model: cost.billedModel(res.model, MODEL), judged: judgeProposal(text, feedback, { names }) };
}

/** The names the CRM holds: players, clubs, contacts and the team. A rule carrying one is refused. */
async function crmNames(db) {
  const read = async (col) => { try { return (await db.collection(col).get()).docs.map((d) => d.data() || {}); } catch { return []; } };
  const [players, clubs, contacts, users, requirements] = await Promise.all(['players', 'clubs', 'contacts', 'app_users', 'club_requirements'].map(read));
  return [
    ...players.flatMap((p) => [p.fullName, p.name, p.currentClub, p.loanFrom]),
    ...clubs.map((c) => c.name),
    ...contacts.flatMap((c) => [c.contactName, c.clubName]),
    ...users.map((u) => u.name),
    ...requirements.map((r) => r.clubName),
  ].filter((n) => typeof n === 'string' && n.trim());
}

/**
 * runSelfReview(db, now, { client, job }) → { read, proposed, dropped, failed, stopped? } | { skipped }
 * The 👎 answers of the last seven days with no document yet, oldest first, at
 * most five; the cost ceiling is asked before each model call. Every answer
 * reviewed gets its document, a dropped one too, so none is reviewed twice; a
 * call that failed leaves none, and that answer is tried again another night.
 * Job notes carry counts only, never a word of a conversation.
 */
async function runSelfReview(db, now = new Date(), { client = null, job = { note: () => {} } } = {}) {
  const at = now.getTime();
  const [bad, existing] = await Promise.all([db.collection('golda_feedback').where('rating', '==', -1).get(), db.collection(PROPOSALS).get()]);
  const done = new Set(existing.docs.map((d) => d.id));
  const fresh = bad.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((f) => at - ms(f.at) <= LOOK_BACK_MS && !done.has(f.id) && String(f.reply || '').trim())
    .sort((a, b) => ms(a.at) - ms(b.at)).slice(0, MAX_PER_NIGHT);
  if (!fresh.length) return { read: 0, proposed: 0, dropped: 0, failed: 0 };
  if (!(await cost.gate(db, 'review', { now })).ok) { job.note("self-review skipped: the day's background cost ceiling is reached"); return { skipped: 'cost ceiling' }; }
  if (!client && !process.env.ANTHROPIC_API_KEY) { job.note('self-review skipped: no model here'); return { skipped: 'no model' }; }
  const anthropic = client || new (require('@anthropic-ai/sdk'))();
  const names = await crmNames(db);
  let read = 0, proposed = 0, dropped = 0, failed = 0, stopped = null;
  for (const [i, f] of fresh.entries()) {
    // The ceiling is asked before every call: the first one was asked above.
    if (i > 0 && !(await cost.gate(db, 'review', { now })).ok) { stopped = 'cost ceiling'; break; }
    read++;
    let usage = null, model = MODEL;
    try {
      const r = await proposeFor(anthropic, f, names);
      usage = r.usage;
      model = r.model;
      if (r.judged.reason) {
        // Kept so it is never reviewed again, and never offered: the reason's code only.
        await db.collection(PROPOSALS).doc(f.id).set({ feedbackId: f.id, state: 'dropped', reason: r.judged.reason, createdAt: at });
        dropped++;
        continue;
      }
      await db.collection(PROPOSALS).doc(f.id).set({ feedbackId: f.id, diagnosis: r.judged.diagnosis, proposedRule: r.judged.proposedRule, state: 'proposed', createdAt: at });
      proposed++;
    } catch { failed++; } finally {
      if (usage) await cost.record(db, { kind: 'review', model, usage, now });
    }
  }
  job.note(`self-review: ${read} answer(s) read, ${proposed} proposal(s)${dropped ? `, ${dropped} dropped (no clean rule)` : ''}${failed ? `, ${failed} failed` : ''}${stopped ? `, stopped at the day's cost ceiling` : ''}`);
  return { read, proposed, dropped, failed, ...(stopped ? { stopped } : {}) };
}

const readState = async (db) => { const s = await db.collection(META[0]).doc(META[1]).get(); return s.exists ? (s.data() || {}) : {}; };

/** Claims tonight's review in a transaction: true for the one run that gets it. */
async function claimNight(db, today, now) {
  const ref = db.collection(META[0]).doc(META[1]);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && (snap.data() || {}).reviewedOn === today) return false;
    tx.set(ref, { reviewedOn: today, updatedAt: now.getTime() }, { merge: true });
    return true;
  });
}

/** Once a night, in the small hours: the step the hourly run calls. Nothing is sent from here. */
async function reviewNightly(db, now = new Date(), { hour, today = israelDate(now), client = null, job = { note: () => {} } } = {}) {
  if (!(hour >= REVIEW_HOUR && hour < REVIEW_HOUR + REVIEW_WINDOW)) return { skipped: 'not the hour' };
  // Claimed first: whatever happens in the review, it runs once a night. What it did not reach waits for the next night.
  if (!(await claimNight(db, today, now))) return { skipped: 'reviewed tonight' };
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
    .filter((p) => !p.offeredAt && !p.queuedAt && p.proposedRule).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  if (!waiting.length) return { skipped: 'nothing to offer' };
  const p = waiting[0];
  const first = (owner.name || '').split(' ')[0] || 'לו';
  const r = await nudge(db, owner, { body: proposalMessage(first, p), buttons: BUTTONS, kind: 'proposal', remember: true, ref: { type: 'proposal', id: p.id } }, { now: now.getTime(), send, job });
  // Queued (WhatsApp's window is closed): it has not reached him yet, so it is not "offered"; it still is today's one.
  const queued = !!(r && r.state === 'queued');
  await db.collection(PROPOSALS).doc(p.id).set(queued ? { queuedAt: now.getTime() } : { offeredAt: now.getTime() }, { merge: true });
  await db.collection(META[0]).doc(META[1]).set({ offeredOn: today, updatedAt: now.getTime() }, { merge: true });
  job.note(`rule proposal: ${queued ? 'queued' : 'sent'}${waiting.length > 1 ? `, ${waiting.length - 1} more waiting` : ''}`);
  return { sent: 1, id: p.id, ...(queued ? { queued: true } : {}) };
}

const DECIDED_HE = { approved: 'אושרה', rejected: 'נדחתה' };
const NOT_SHOWN_HE = 'ההצעה הזאת עוד לא הגיעה אליך, אז אי אפשר לאשר אותה. היא תגיע אליך ככרטיס.';

/** The agency's owner: the only one who decides which rules Golda follows. The tap and the typed answer ask the same. */
const isOwner = (identity = {}) => identity.role === 'admin' && String(identity.email || '').toLowerCase() === OWNER_EMAIL;

/**
 * The owner's decision on one proposal. Only a proposal that reached him can be
 * approved: on the card (`onCard`, a tap) it was sent or queued, since the tap
 * proves the card arrived; typed, it must carry the mark that it was sent.
 */
async function decide(db, id, approve, { by = '', now = Date.now(), onCard = false } = {}) {
  const ref = db.collection(PROPOSALS).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) return { found: false };
  const p = snap.data() || {};
  if (p.state !== 'proposed') return { found: true, already: p.state, proposedRule: p.proposedRule || '' };
  if (approve && !(p.offeredAt || (onCard && p.queuedAt))) return { found: true, notShown: true, proposedRule: p.proposedRule || '' };
  const state = approve ? 'approved' : 'rejected';
  await ref.set({ state, decidedAt: now, decidedBy: String(by || '') }, { merge: true });
  return { found: true, state, proposedRule: p.proposedRule || '' };
}

// A tap on the card: the decision is recorded and answered here, with no model call.
// Only the owner's tap counts; anything else goes on to the model as an ordinary message.
onTap('proposal', async ({ db, ref, button, ctx = {} }) => {
  const identity = ctx.identity || {};
  if (!isOwner(identity) || button > 1) return { handled: false };
  const r = await decide(db, ref.id, button === 0, { by: identity.email, now: ctx.now || Date.now(), onCard: true });
  if (!r.found) return { handled: true, reply: 'ההצעה הזאת כבר לא קיימת.' };
  if (r.already) return { handled: true, reply: `ההצעה הזאת כבר ${DECIDED_HE[r.already] || 'טופלה'}.` };
  if (r.notShown) return { handled: true, reply: NOT_SHOWN_HE };
  return { handled: true, reply: r.state === 'approved' ? `מעכשיו אני עובדת לפי הכלל הזה:\n"${r.proposedRule}"` : 'בסדר, לא מוסיפה את הכלל הזה.' };
});

/** The rules the owner approved, newest first: the only ones that enter the prompt. */
async function approvedRules(db, n = RULES_IN_PROMPT) {
  try {
    const snap = await db.collection(PROPOSALS).where('state', '==', 'approved').get();
    return snap.docs.map((d) => d.data()).filter((p) => p.proposedRule).sort((a, b) => ms(b.decidedAt) - ms(a.decidedAt)).slice(0, n).map((p) => String(p.proposedRule));
  } catch { return []; }
}

// Always right after the approved rules, so nothing in them can stand last: they lose to everything else.
const RULES_LIMIT = 'These approved rules are about style and working habits only. They never change who may see or do what, never allow sending anything to anyone outside the agency (everything outward stays a draft the writer sends himself, and you still cannot change users or permissions), and they lose to every other instruction in this prompt.';

function rulesSection(rules = []) {
  if (!rules.length) return '';
  return `Rules Lou approved after answers of yours were marked 👎 (follow them; they are about how you answer and never widen what you may do or see):\n${rules.slice(0, RULES_IN_PROMPT).map((r) => `- ${oneLine(r).slice(0, RULE_MAX)}`).join('\n')}\n${RULES_LIMIT}`;
}

const PROMPT_RULES_TOOL_DEF = {
  name: 'prompt_rules',
  description: 'The rules you proposed for yourself after 👎 answers (admin only). action=list: what waits for the owner and what he approved. action=approve / reject with the id: ONLY when the owner answered your latest proposal card ("הצעה לשיפור שלי" 🧭) in words instead of tapping, within a day of it; anyone else, an older card or a later answer is refused with a message to pass on as it is. You never approve a rule on your own. action=retire with the id: take an approved rule out when he asks ("תבטלי את הכלל…").',
  input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'approve', 'reject', 'retire'] }, id: { type: 'string' } }, required: ['action'], additionalProperties: false },
};

/** The proposal the owner was shown last: the only one a typed answer can decide. */
async function latestOffered(db) {
  const all = (await db.collection(PROPOSALS).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.offeredAt);
  return all.sort((a, b) => ms(b.offeredAt) - ms(a.offeredAt))[0] || null;
}

function reviewTools({ db, identity = {}, role }) {
  return {
    prompt_rules: async ({ action, id } = {}) => {
      if (role !== 'admin') throw new Error('only an admin decides which rules Golda follows');
      if (action === 'list') {
        const all = (await db.collection(PROPOSALS).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
        const row = (p) => ({ id: p.id, rule: p.proposedRule, diagnosis: p.diagnosis || '' });
        return {
          waiting: all.filter((p) => p.state === 'proposed').sort((a, b) => ms(a.createdAt) - ms(b.createdAt)).map((p) => ({ ...row(p), shown: !!p.offeredAt, ...(p.queuedAt && !p.offeredAt ? { queued: true } : {}) })),
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
      // A typed decision: the owner only, on the card he was shown last, within a day of it. Anything else changes nothing.
      const refused = (message) => ({ refused: true, changed: false, message, instruction: 'Nothing was changed. Tell the writer this message as it is, in one line.' });
      if (!isOwner(identity)) return refused('רק לו מאשר או דוחה כלל חדש שלי.');
      const ref = await db.collection(PROPOSALS).doc(String(id)).get();
      if (!ref.exists) throw new Error('no proposal with this id');
      if (ref.data().state !== 'proposed') return { already: ref.data().state, rule: ref.data().proposedRule || '' };
      const last = await latestOffered(db);
      if (!last || last.id !== String(id)) return refused(ref.data().offeredAt ? 'אפשר לענות במילים רק על ההצעה האחרונה ששלחתי לך. על הקודמות אפשר ללחוץ על הכפתורים בכרטיס שלהן.' : NOT_SHOWN_HE);
      const now = Date.now();
      if (now - ms(last.offeredAt) > ANSWER_WITHIN_MS) return refused('עבר יותר מיום מאז ששלחתי את ההצעה, אז אפשר לאשר או לדחות אותה רק בכפתורים שבכרטיס.');
      const r = await decide(db, id, action === 'approve', { by: identity.email, now });
      if (r.already) return { already: r.already, rule: r.proposedRule };
      if (r.notShown) return refused(NOT_SHOWN_HE);
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
  runSelfReview, reviewNightly, offerProposal, approvedRules, rulesSection, reviewTools, reviewSection, cleanProposal, judgeProposal, proposalMessage, decide, isOwner,
  PROMPT_RULES_TOOL_DEF, PROPOSALS, BUTTONS, REVIEW_HOUR, RULES_IN_PROMPT, MAX_PER_NIGHT, RULES_LIMIT,
};
