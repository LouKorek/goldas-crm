// Golda's brain, run in the background (up to 15 minutes) so the webhook can
// answer Meta immediately. Reads one queued message, runs the agent, replies
// on WhatsApp. Messages from the same number are handled one at a time, in
// order, through a lock on the session document.
const crypto = require('crypto');
const admin = require('firebase-admin');
const wa = require('./lib/wa-api.js');
const { runAgent, MAIN_TOPIC, _internal: { norm } } = require('./lib/wa-agent.js');

const ASSISTANT_NAME = process.env.WA_ASSISTANT_NAME || 'גולדה';
const LOCK_MS = 5 * 60 * 1000;

function getDb() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)) });
  return admin.firestore();
}

function internalOk(event) {
  const want = process.env.WA_APP_SECRET || '';
  const got = (event.headers || {})['x-wa-internal'] || '';
  const a = Buffer.from(String(got)), b = Buffer.from(want);
  return want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

exports.handler = async (event) => {
  if (!internalOk(event)) return { statusCode: 403, body: 'forbidden' };
  const { messageId } = JSON.parse(event.body || '{}');
  const db = getDb();
  const inboxRef = db.collection('wa_inbox').doc(String(messageId));
  const msg = (await inboxRef.get()).data();
  if (!msg) return { statusCode: 404, body: 'unknown message' };
  const phone = wa.digits(msg.from);
  const sessRef = db.collection('wa_sessions').doc(phone);

  // Take the per-number lock; wait while another message is being handled.
  for (let i = 0; ; i++) {
    const got = await db.runTransaction(async (tx) => {
      const s = (await tx.get(sessRef)).data() || {};
      if (s.lockUntil && s.lockUntil > Date.now() && s.lockedBy !== messageId) return false;
      tx.set(sessRef, { lockUntil: Date.now() + LOCK_MS, lockedBy: messageId }, { merge: true });
      return true;
    });
    if (got) break;
    if (i > 120) { console.warn('[wa] lock wait gave up'); break; }
    await sleep(2000);
  }

  await wa.markRead(messageId, msg.phoneId);
  try {
    const session = (await sessRef.get()).data() || {};
    session.turn = (session.turn || 0) + 1;
    let media = null;
    if (msg.mediaId) {
      try {
        const m = await wa.downloadMedia(msg.mediaId);
        media = { ...m, filename: msg.filename || `file_${String(messageId).slice(-6)}` };
      } catch (e) { console.error('[wa] media download failed:', e.message); }
    }
    let text = msg.text;
    if (['audio', 'sticker', 'location', 'contacts'].includes(msg.type) && !text) text = `(sent a ${msg.type} message, which you can't read; ask them to write it as text)`;

    const sender = wa.senderName(phone);
    const topics = { ...(session.topics || {}) };
    let current = session.topic && topics[session.topic] ? session.topic : MAIN_TOPIC;
    const cmd = topicCommand(text);
    let direct = null;   // a reply that needs no model call
    if (cmd?.kind === 'main') { current = MAIN_TOPIC; direct = `חזרנו לנושא המערכת, ${sender}. במה לעזור?`; }
    else if (cmd?.kind === 'switch') {
      const found = findTopic(topics, cmd.name);
      if (found) { current = found; direct = `חזרנו לנושא *${found}*. ממשיכות מאיפה שעצרנו.`; }
      else direct = `לא מצאתי נושא בשם "${cmd.name}". הנושאים שיש: ${[MAIN_TOPIC, ...Object.keys(topics)].join(', ')}.`;
    } else if (cmd?.kind === 'new') {
      current = findTopic(topics, cmd.name) || cmd.name;
      topics[current] = { purpose: cmd.purpose, history: topics[current]?.history || [], createdAt: topics[current]?.createdAt || Date.now() };
    }

    const topic = current === MAIN_TOPIC ? null : { name: current, ...topics[current] };
    let reply, pendingDelete = session.pendingDelete || null, changed = false, userText = text || '';
    if (direct) reply = direct;
    else {
      const out = await runAgent({ db, admin, phone, text, media, session, assistantName: ASSISTANT_NAME, sender, topic, topics: Object.keys(topics) });
      ({ reply, pendingDelete, changed, userText } = out);
    }
    await wa.sendText(phone, reply, msg.phoneId);

    const turn = [{ role: 'user', text: userText, at: Date.now() }, { role: 'assistant', text: reply, at: Date.now() }];
    const patch = { topic: current, turn: session.turn, pendingDelete: pendingDelete || null, lastAt: Date.now(), lockUntil: 0, lockedBy: null };
    if (direct) { /* switching is not part of any topic's history */ }
    else if (topic) topics[current] = { ...topics[current], history: [...(topics[current].history || []), ...turn].slice(-30) };
    else patch.history = [...(session.history || []), ...turn].slice(-30);
    if (Object.keys(topics).length) patch.topics = topics;
    await sessRef.set(patch, { merge: true });
    await inboxRef.update({ state: 'done', reply, changed, topic: current, doneAt: admin.firestore.FieldValue.serverTimestamp() });
  } catch (e) {
    console.error('[wa] agent failed:', e);
    await inboxRef.update({ state: 'error', error: String(e.message || e) }).catch(() => {});
    await sessRef.set({ lockUntil: 0, lockedBy: null }, { merge: true }).catch(() => {});
    await wa.sendText(phone, `${wa.senderName(phone)}, נתקלתי בתקלה ולא ביצעתי את הבקשה. אפשר לנסות שוב בעוד דקה.`, msg.phoneId).catch(() => {});
  }
  return { statusCode: 200, body: 'ok' };
};
