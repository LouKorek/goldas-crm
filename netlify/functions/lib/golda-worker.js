// Golda's brain, shared by both doors: a WhatsApp message handed over by the
// webhook, and a message typed in the app's Golda screen. One queued message
// in (wa_inbox/{id}), one reply out, in the sender's name.
//
// Conversation state lives in wa_sessions/{key} (key: the person's WhatsApp
// number, or u_<email> for an app user without one): the current topic, the
// per-number lock, the pending delete and the day's usage. Each topic's
// history is its own document under wa_sessions/{key}/threads/{topic}, so a
// long chat never pushes the session over Firestore's 1 MB document limit.
//
// Reliability: a message is processing while this runs (attempts counted);
// if the reply cannot be sent after the change was made, the message is left
// in state reply_pending and golda-queue-cron sends it later, so a change is
// never silently done without an answer. Messages from one person are handled
// one at a time through the lock, which lasts as long as a background run can.
const { admin, getDb } = require('./firestore.js');
const wa = require('./wa-api.js');
const { runAgent, MAIN_TOPIC, MODEL, _internal: { norm } } = require('./wa-agent.js');
const { resolveSender, userForApp, sessionKey } = require('./golda-identity.js');

const ASSISTANT_NAME = process.env.WA_ASSISTANT_NAME || 'גולדה';
const LOCK_MS = 15 * 60 * 1000;               // a background function's whole budget
const DAILY_LIMIT = Number(process.env.GOLDA_DAILY_LIMIT) || 150;
const HISTORY_KEEP = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const threadKey = (topic) => (topic === MAIN_TOPIC ? 'main' : `t_${norm(topic).replace(/\s+/g, '_').slice(0, 80)}`);

// Topic commands, handled here so switching never depends on the model:
//   "גולדה, נושא חדש: <name>. <what it's for>"  "גולדה, חזרה לנושא <name>"  "גולדה, חזרה למערכת"
function topicCommand(text) {
  const t = String(text || '').trim().replace(/^גולדה\s*[,:]?\s*/, '');
  let m = /^נושא חדש\s*[:\-–]?\s*(.+)$/s.exec(t);
  if (m) {
    const rest = m[1].trim();
    const name = rest.split(/[.\n!?]/)[0].replace(/[.$#[\]/]/g, '').trim().slice(0, 60);
    return name ? { kind: 'new', name, purpose: rest } : null;
  }
  if (/^(חזרה|חזרי|תחזרי)\s+ל(נושא\s+)?(ה)?מערכת\s*[.!]?$/.test(t)) return { kind: 'main' };
  m = /^(?:חזרה|חזרי|תחזרי)\s+לנושא\s+(.+?)\s*[.!]?$/s.exec(t);
  if (m) return { kind: 'switch', name: m[1].trim() };
  return null;
}

function findTopic(topics, name) {
  const n = norm(name);
  const names = Object.keys(topics || {});
  return names.find((k) => norm(k) === n) || names.find((k) => norm(k).includes(n) || n.includes(norm(k))) || null;
}

/** Today's message count per person, reset by Israel date. */
function nextUsage(session, today) {
  const u = session.usage && session.usage.date === today ? session.usage : { date: today, count: 0, inputTokens: 0, outputTokens: 0 };
  return { ...u, count: u.count + 1 };
}

// The thread document of a topic, with a one-time move of the history that
// older sessions kept inline.
async function loadThread(sessRef, session, topic) {
  const ref = sessRef.collection('threads').doc(threadKey(topic));
  const snap = await ref.get();
  if (snap.exists) return { ref, history: snap.data().history || [] };
  const legacy = topic === MAIN_TOPIC ? session.history : session.topics?.[topic]?.history;
  return { ref, history: Array.isArray(legacy) ? legacy : [] };
}

async function identityFor(db, msg) {
  if (msg.channel === 'app') {
    const id = await userForApp(db, { email: msg.email, name: msg.name || msg.email, role: msg.role || 'viewer' });
    return id;
  }
  return resolveSender(db, msg.from);
}

/** Deliver a reply on the message's channel. Throws when WhatsApp refuses. */
async function deliver(msg, reply) {
  if (msg.channel === 'app') return;                       // the app reads the reply from the inbox document
  await wa.sendText(msg.from, reply, msg.phoneId);
}

async function processMessage(messageId) {
  const db = getDb();
  const inboxRef = db.collection('wa_inbox').doc(String(messageId));
  const msg = (await inboxRef.get()).data();
  if (!msg) return { status: 404, body: 'unknown message' };
  if (msg.state === 'done') return { status: 200, body: 'already handled' };
  if (msg.state === 'reply_pending') return resendReply(db, inboxRef, msg);

  const identity = await identityFor(db, msg);
  if (!identity) {
    await inboxRef.update({ state: 'dropped', error: 'unknown sender', doneAt: admin.firestore.FieldValue.serverTimestamp() });
    return { status: 200, body: 'unknown sender' };
  }
  const key = sessionKey(identity);
  const sessRef = db.collection('wa_sessions').doc(key);

  // Take the per-person lock; wait while another message is being handled.
  for (let i = 0; ; i++) {
    const got = await db.runTransaction(async (tx) => {
      const s = (await tx.get(sessRef)).data() || {};
      if (s.lockUntil && s.lockUntil > Date.now() && s.lockedBy !== messageId) return false;
      tx.set(sessRef, { lockUntil: Date.now() + LOCK_MS, lockedBy: messageId }, { merge: true });
      return true;
    });
    if (got) break;
    if (i > 120) { console.warn('[golda] lock wait gave up'); break; }
    await sleep(2000);
  }
  await inboxRef.update({ state: 'processing', attempts: admin.firestore.FieldValue.increment(1), startedAt: admin.firestore.FieldValue.serverTimestamp(), sessionKey: key, email: identity.email || '' });
  if (msg.channel !== 'app') await wa.markRead(messageId, msg.phoneId);

  const t0 = Date.now();
  let reply = '';
  try {
    const session = (await sessRef.get()).data() || {};
    session.turn = (session.turn || 0) + 1;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const usage = nextUsage(session, today);
    const sender = identity.name;
    const first = sender.split(' ')[0] || sender;

    let media = null;
    if (msg.mediaId) {
      try {
        const m = await wa.downloadMedia(msg.mediaId);
        media = { ...m, filename: msg.filename || `file_${String(messageId).slice(-6)}` };
      } catch (e) { console.error('[golda] media download failed:', e.message); }
    }
    let text = msg.text;
    if (['audio', 'sticker', 'location', 'contacts'].includes(msg.type) && !text) text = `(sent a ${msg.type} message, which you can't read; ask them to write it as text)`;

    const topics = { ...(session.topics || {}) };
    let current = session.topic && topics[session.topic] ? session.topic : MAIN_TOPIC;
    const cmd = topicCommand(text);
    let direct = null;   // a reply that needs no model call
    if (usage.count > DAILY_LIMIT) direct = `${first}, הגענו למכסת ההודעות היומית (${DAILY_LIMIT}). נמשיך מחר, או שלו יכול להגדיל אותה.`;
    else if (cmd?.kind === 'main') { current = MAIN_TOPIC; direct = `חזרנו לנושא המערכת, ${first}. במה לעזור?`; }
    else if (cmd?.kind === 'switch') {
      const found = findTopic(topics, cmd.name);
      if (found) { current = found; direct = `חזרנו לנושא *${found}*. ממשיכות מאיפה שעצרנו.`; }
      else direct = `לא מצאתי נושא בשם "${cmd.name}". הנושאים שיש: ${[MAIN_TOPIC, ...Object.keys(topics)].join(', ')}.`;
    } else if (cmd?.kind === 'new') {
      current = findTopic(topics, cmd.name) || cmd.name;
      topics[current] = { purpose: cmd.purpose, createdAt: topics[current]?.createdAt || Date.now() };
    }

    const thread = await loadThread(sessRef, session, current);
    const topic = current === MAIN_TOPIC ? null : { name: current, ...topics[current], history: thread.history };
    let pendingDeletes = Array.isArray(session.pendingDeletes) ? session.pendingDeletes : (session.pendingDelete ? [session.pendingDelete] : []), changed = false, userText = text || '', agentUsage = null;
    if (direct) reply = direct;
    else {
      const out = await runAgent({ db, admin, identity, text, media, session: { ...session, history: thread.history }, assistantName: ASSISTANT_NAME, topic, topics: Object.keys(topics), channel: msg.channel || 'whatsapp' });
      ({ reply, pendingDeletes, changed, userText } = out);
      agentUsage = out.usage;
    }

    // Record the turn before sending, so a failed send never loses the history.
    const now = Date.now();
    const turn = [{ role: 'user', text: userText, at: now, channel: msg.channel || 'whatsapp' }, { role: 'assistant', text: reply, at: now + 1 }];
    const patch = {
      topic: current, turn: session.turn, pendingDeletes: pendingDeletes || [], pendingDelete: admin.firestore.FieldValue.delete(), lastAt: now, lockUntil: 0, lockedBy: null,
      email: identity.email || '', name: identity.name, phone: identity.phone || '',
      usage: { ...usage, inputTokens: usage.inputTokens + (agentUsage?.inputTokens || 0), outputTokens: usage.outputTokens + (agentUsage?.outputTokens || 0) },
      history: admin.firestore.FieldValue.delete(),
    };
    for (const k of Object.keys(topics)) delete topics[k].history;
    if (Object.keys(topics).length) patch.topics = topics;
    if (!direct) await thread.ref.set({ topic: current, history: [...thread.history, ...turn].slice(-HISTORY_KEEP), updatedAt: now }, { merge: true });
    await sessRef.set(patch, { merge: true });

    const done = { reply, changed, topic: current, doneAt: admin.firestore.FieldValue.serverTimestamp(), durationMs: Date.now() - t0,
      usage: agentUsage ? { ...agentUsage, model: MODEL } : null };
    try {
      await deliver(msg, reply);
      await inboxRef.update({ ...done, state: 'done' });
    } catch (e) {
      console.error('[golda] reply delivery failed:', e.message);
      await inboxRef.update({ ...done, state: 'reply_pending', error: String(e.message || e) });
    }
    await db.collection('jobs').add({ name: 'golda', status: 'ok', startedAt: admin.firestore.Timestamp.fromMillis(t0), finishedAt: admin.firestore.Timestamp.now(), durationMs: Date.now() - t0,
      notes: [], summary: { sender: identity.email || identity.name, channel: msg.channel || 'whatsapp', changed, steps: agentUsage?.steps || 0, inputTokens: agentUsage?.inputTokens || 0, outputTokens: agentUsage?.outputTokens || 0, model: agentUsage ? MODEL : null } }).catch(() => {});
    return { status: 200, body: 'ok' };
  } catch (e) {
    console.error('[golda] agent failed:', e);
    const first = (identity.name || 'לו').split(' ')[0];
    await inboxRef.update({ state: 'error', error: String(e.message || e), doneAt: admin.firestore.FieldValue.serverTimestamp(), reply: `${first}, נתקלתי בתקלה ולא ביצעתי את הבקשה. אפשר לנסות שוב בעוד דקה.` }).catch(() => {});
    await sessRef.set({ lockUntil: 0, lockedBy: null }, { merge: true }).catch(() => {});
    if (msg.channel !== 'app') await wa.sendText(msg.from, `${first}, נתקלתי בתקלה ולא ביצעתי את הבקשה. אפשר לנסות שוב בעוד דקה.`, msg.phoneId).catch(() => {});
    return { status: 200, body: 'failed' };
  }
}

/** A reply that was computed but never delivered. */
async function resendReply(db, inboxRef, msg) {
  try {
    await deliver(msg, msg.reply || '');
    await inboxRef.update({ state: 'done', error: admin.firestore.FieldValue.delete(), resentAt: admin.firestore.FieldValue.serverTimestamp() });
    return { status: 200, body: 'resent' };
  } catch (e) {
    await inboxRef.update({ attempts: admin.firestore.FieldValue.increment(1), error: String(e.message || e) });
    return { status: 200, body: 'resend failed' };
  }
}

/**
 * Which queued messages the cron should push again: never handed off, stuck
 * in processing past a run's budget, failed on a transient error, or with a
 * reply still to send. Pure, so it is tested.
 */
function pickRetries(rows, now = Date.now(), { maxAttempts = 3, staleMs = LOCK_MS + 60000, queuedMs = 90000 } = {}) {
  const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : 0);
  return rows.filter((m) => {
    const attempts = m.attempts || 0;
    if (m.state === 'queued') return now - ms(m.receivedAt) > queuedMs && attempts < maxAttempts;
    if (m.state === 'processing') return now - ms(m.startedAt) > staleMs && attempts < maxAttempts;
    if (m.state === 'reply_pending') return attempts < maxAttempts + 3;
    if (m.state === 'error') return attempts < maxAttempts && /ECONN|ETIMEDOUT|fetch failed|overloaded|529|503|rate limit|timeout/i.test(String(m.error || ''));
    return false;
  });
}

module.exports = { processMessage, pickRetries, topicCommand, findTopic, nextUsage, threadKey, ASSISTANT_NAME, DAILY_LIMIT };
