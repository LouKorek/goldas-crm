// What Golda's own-initiative messages share: who may get them, how they are
// sent, and how the conversation remembers them.
//
// A message she starts (a brief before a meeting, the daily question, a
// website draft waiting for a yes) goes to the agency's owner only, never to
// the team and never to anyone outside the agency, and always through
// lib/wa-outbox.js so WhatsApp's 24-hour window and the templates are respected.
// The one exception: a represented player an admin connected to Golda may get
// his week, a reminder before a training and good luck before a match, each
// only when an admin switched it on (lib/golda-player-sends.js, also through here).
//
// A question she asks on her own also has to be in the chat's history: the
// owner answers with one word ("ימין", "כן, לפרסם"), and without the
// question in front of her the agent could not know what it answers. So
// nudge() writes the message as her turn into the thread of the topic the
// owner is in (the same document lib/golda-worker.js keeps the chat in).
const { OWNER_EMAIL } = require('./firestore.js');
const { sessionKey } = require('./golda-identity.js');
const outbox = require('./wa-outbox.js');

const HISTORY_KEEP = 80;   // as in lib/golda-worker.js

/** The owner, when he can be written to on WhatsApp; null otherwise. */
function ownerOf(recipients = []) {
  return recipients.find((u) => u.role === 'admin' && String(u.email || '').toLowerCase() === OWNER_EMAIL && u.phone) || null;
}

/** The owner's session: its turn counter and the thread of the topic he is in. */
async function chatOf(db, identity) {
  const sessRef = db.collection('wa_sessions').doc(sessionKey(identity));
  const snap = await sessRef.get();
  const session = snap.exists ? (snap.data() || {}) : {};
  const { threadKey } = require('./golda-worker.js');
  const { MAIN_TOPIC } = require('./wa-agent.js');
  const topic = session.topic && session.topics && session.topics[session.topic] ? session.topic : MAIN_TOPIC;
  return { sessRef, session, topic, threadRef: sessRef.collection('threads').doc(threadKey(topic)), turn: Number(session.turn) || 0 };
}

/**
 * Writes a message Golda started into the chat's history as her turn.
 * Best effort: a message that arrives in the same second can overwrite it,
 * and a failure here never stops the message itself.
 */
async function noteInChat(db, identity, { text, buttons = [], kind = 'nudge', now = Date.now() }) {
  const { threadRef, topic } = await chatOf(db, identity);
  const snap = await threadRef.get();
  const history = snap.exists && Array.isArray(snap.data().history) ? snap.data().history : [];
  const entry = { role: 'assistant', text: String(text || ''), at: now, proactive: kind, ...(buttons.length ? { buttons } : {}) };
  await threadRef.set({ topic, history: [...history, entry].slice(-HISTORY_KEEP), updatedAt: now }, { merge: true });
  return entry;
}

/**
 * nudge(db, u, { body, buttons, kind, remember, carryOnly, expiresAt, ref }, { now, send, job })
 * Sends one own-initiative message to the owner (or a connected player) and,
 * when it asks something or should be in front of her when he answers
 * (remember: true), keeps it in the chat's history.
 *   carryOnly  outside the window, only a template that carries the text itself
 *   expiresAt  ms: a text still waiting for the window after this is dropped
 *   ref        { type, id }: what the message is about, so a tap on one of its
 *              buttons can be traced back to it (lib/golda-taps.js)
 *   send  the hourly run's sender (tests inject it): (u, body, kind, buttons, ref) → { state }
 */
async function nudge(db, u, { body, buttons = [], kind = 'nudge', remember = false, carryOnly = false, expiresAt = null, ref = null }, { now = Date.now(), send = null, job = null } = {}) {
  const r = send
    ? await send(u, body, kind, buttons, ref)
    : await outbox.deliver(db, { to: u.phone, body, kind, buttons, carryOnly, expiresAt, ref }, { now });
  // Job notes hold states only: never the address, the number or an error's text, which could carry either.
  if (r && r.state === 'queued' && job) job.note(`${kind}: window closed, queued`);
  if (remember) await noteInChat(db, u, { text: body, buttons, kind, now }).catch((e) => { if (job) job.note(`${kind}: chat note failed (${(e && e.name) || 'error'})`); });
  return r;
}

module.exports = { ownerOf, chatOf, noteInChat, nudge, HISTORY_KEEP };
