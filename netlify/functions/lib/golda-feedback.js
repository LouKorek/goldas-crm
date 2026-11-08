// The team's 👍/👎 on Golda's answers. On WhatsApp it is a reaction on her
// message (Meta sends it as a message of type "reaction" naming the message
// it is on); in the app it is a tap under her answer. Each one is a document
// in golda_feedback, one per person and answer, so changing the reaction
// replaces it and removing it deletes it. The worker keeps the WhatsApp ids
// of every answer it sent (wa_inbox.sentIds), which is how a reaction finds
// the question and the answer it is about. The weekly recap shows the owner
// the counts and the 👎 cases, and Golda reads the last 👎 cases before she
// answers, so she does not repeat a mistake.
const POSITIVE = ['👍', '❤️', '❤', '🙏', '👏', '🔥', '💯', '😍', '✅', '🥇'];
const NEGATIVE = ['👎', '😡', '😠', '❌', '🤦', '🤦‍♂️', '🤦‍♀️', '😕', '🙄'];
const strip = (e) => String(e || '').replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '');

/** +1, -1, or 0 (not a judgement: removed, or an emoji that says nothing). */
function ratingOf(emoji) {
  const e = strip(emoji);
  if (!e) return 0;
  if (POSITIVE.some((p) => strip(p) === e)) return 1;
  if (NEGATIVE.some((p) => strip(p) === e)) return -1;
  return 0;
}

const feedbackId = (who, answerId) => `${String(who || 'x').replace(/[^a-zA-Z0-9]/g, '_')}_${String(answerId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 300);

/** Records (or removes) one person's rating of one answer. */
async function recordFeedback(db, { who, email = '', name = '', answerId, inbox = null, rating, emoji = '', channel }) {
  const ref = db.collection('golda_feedback').doc(feedbackId(who, answerId));
  if (!rating) { await ref.delete().catch(() => {}); return { removed: true }; }
  const doc = {
    rating, emoji, channel, email, name, answerId: String(answerId), inboxId: inbox?.id || '',
    question: String(inbox?.transcript ? `🎤 ${inbox.transcript}` : inbox?.text || '').slice(0, 1000),
    reply: String(inbox?.reply || '').slice(0, 2000), at: new Date(),
  };
  await ref.set(doc);
  return { saved: true, rating };
}

/** The inbox message whose answer carried this WhatsApp message id. */
async function inboxForSentId(db, sentId) {
  const snap = await db.collection('wa_inbox').where('sentIds', 'array-contains', String(sentId)).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/** The last 👎 cases, for Golda's prompt. */
async function recentMistakes(db, n = 5) {
  try {
    const snap = await db.collection('golda_feedback').where('rating', '==', -1).get();
    return snap.docs.map((d) => d.data()).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0)).slice(0, n);
  } catch (e) { return []; }
}

function mistakesSection(rows = []) {
  if (!rows.length) return '';
  const lines = rows.map((r) => `- Asked: "${String(r.question || '').slice(0, 160)}" → you answered: "${String(r.reply || '').slice(0, 220)}"`);
  return `Answers the team marked 👎 recently (learn from them: what was wrong, missing or too long; do not repeat it):\n${lines.join('\n')}`;
}

module.exports = { ratingOf, feedbackId, recordFeedback, inboxForSentId, recentMistakes, mistakesSection };
