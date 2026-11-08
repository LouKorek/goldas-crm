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
const speech = require('./golda-speech.js');

const ASSISTANT_NAME = process.env.WA_ASSISTANT_NAME || 'גולדה';
const LOCK_MS = 15 * 60 * 1000;               // a background function's whole budget
const DAILY_LIMIT = Number(process.env.GOLDA_DAILY_LIMIT) || 150;
const HISTORY_KEEP = 80;
const ACK_AFTER_MS = 20000;                   // a long task gets a "still on it" line after this

// Golda offers taps by ending a reply with [[כפתורים: א | ב | ג]] (up to three).
const BUTTONS_RE = /\n?\s*\[\[\s*(?:כפתורים|buttons)\s*:\s*([^\]]+)\]\]\s*$/i;
function parseButtons(reply) {
  const text = String(reply || '');
  const m = BUTTONS_RE.exec(text);
  if (!m) return { text, buttons: [] };
  const buttons = [...new Set(m[1].split('|').map((b) => b.trim()).filter(Boolean))].slice(0, 3);
  return { text: text.slice(0, m.index).trimEnd(), buttons };
}

// The menu: one word opens a list of the things people ask most.
const MENU_RE = /^\s*(?:גולדה\s*[,:]?\s*)?(?:תפריט|menu|עזרה|help|\?)\s*[.!?]?\s*$/i;
const isMenuCommand = (text) => MENU_RE.test(String(text || ''));
const MENU_ROWS = [
  { id: 'm_brief', title: 'תדריך להיום', description: 'משחקים, אימונים, משימות והתראות' },
  { id: 'm_week', title: 'מה יש השבוע', description: 'משחקים ואימונים של השחקנים' },
  { id: 'm_tasks', title: 'המשימות שלי', description: 'פתוחות ובאיחור' },
  { id: 'm_opps', title: '3 הזדמנויות', description: 'דרישות פתוחות ושחקנים שמתאימים' },
  { id: 'm_changes', title: 'מה השתנה היום', description: 'עדכונים במערכת ב־24 השעות האחרונות' },
  { id: 'm_player', title: 'ספרי לי על שחקן', description: 'תמונת מצב מלאה על שחקן' },
];
const menuText = (first) => `${first}, הנה מה שאפשר לבקש ממני בלחיצה. אפשר גם פשוט לכתוב, לשלוח הודעה קולית, צילום של לו"ז או להעביר לי הודעה.`;

/** The text Golda works on: a forwarded message is marked as such. */
function inboundText(msg, text) {
  const t = String(text || '');
  return msg.forwarded && t ? `[הודעה מועברת]\n${t}` : t;
}

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

/** Deliver a reply on the message's channel. Throws when WhatsApp refuses the text. */
async function deliver(msg, reply, { buttons = [], list = null, files = [] } = {}) {
  if (msg.channel === 'app') return [];                    // the app reads the reply (and its files) from the inbox document
  let ids;
  if (list) ids = await wa.sendList(msg.from, reply, list.button, list.rows, msg.phoneId);
  else if (buttons.length) ids = await wa.sendButtons(msg.from, reply, buttons, msg.phoneId);
  else ids = await wa.sendText(msg.from, reply, msg.phoneId);
  // Documents go right after the text. The text is what counts: a document
  // WhatsApp refuses is logged, and the text is not sent a second time for it.
  for (const f of files) {
    try { ids = [...(ids || []), ...(await wa.sendDocument(msg.from, f, msg.phoneId))]; }
    catch (e) { console.error('[golda] document delivery failed:', f.filename, e.message); }
  }
  return ids;
}

// A document Golda made is kept like any CRM file (files/{id} + chunks), so the
// app can open it and a delayed reply can still send it. Nothing points at it
// from a player, so the nightly cleanup removes it after a week.
const FILE_CHUNK = 600 * 1024;
async function storeOutFile(db, file, who) {
  const dataUrl = `data:${file.mimeType};base64,${file.buffer.toString('base64')}`;
  const fileId = `golda_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const parts = [];
  for (let i = 0; i < dataUrl.length; i += FILE_CHUNK) parts.push(dataUrl.slice(i, i + FILE_CHUNK));
  await Promise.all(parts.map((data, i) => db.collection('files').doc(fileId).collection('chunks').doc(String(i)).set({ data })));
  const uploadedAt = new Date().toISOString();
  await db.collection('files').doc(fileId).set({ name: file.filename, originalName: file.filename, type: file.mimeType, size: file.buffer.length,
    parts: parts.length, uploadedAt, uploadedBy: who.email || 'golda', madeBy: 'golda' });
  return { fileId, name: file.filename, type: file.mimeType, size: file.buffer.length, uploadedAt };
}

/** A stored document back as { buffer, filename, mimeType }, for a reply sent later. */
async function loadOutFile(db, ref) {
  const meta = await db.collection('files').doc(ref.fileId).get();
  if (!meta.exists) return null;
  const n = meta.data().parts || 1;
  const chunks = await Promise.all(Array.from({ length: n }, (_, i) => db.collection('files').doc(ref.fileId).collection('chunks').doc(String(i)).get()));
  if (chunks.some((c) => !c.exists)) return null;
  const dataUrl = chunks.map((c) => c.data().data).join('');
  return { buffer: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), filename: ref.name, mimeType: ref.type || 'application/pdf' };
}

/** A voice note in, its words out; the service state is kept for the Golda screen. */
async function transcribeVoice(db, media) {
  const ref = db.collection('app_meta').doc('whatsapp');
  try {
    const out = await speech.transcribe(media.buffer, media.mimeType);
    await ref.set({ speech: { state: 'ok', at: Date.now(), message: '' } }, { merge: true }).catch(() => {});
    return { text: out.text };
  } catch (e) {
    const state = e.state || 'error';
    console.warn('[golda] transcription failed:', state, e.message);
    // Only the service's own problems change its state; one bad recording does not.
    if (!['empty', 'bad_audio', 'unsupported'].includes(state)) {
      await ref.set({ speech: { state, at: Date.now(), message: String(e.message || '').slice(0, 300) } }, { merge: true }).catch(() => {});
    }
    return { error: state };
  }
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
  if (msg.channel !== 'app') await wa.markRead(messageId, msg.phoneId, { typing: true });

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
        const m = await wa.downloadMedia(msg.mediaId, msg.phoneId);
        media = { ...m, filename: msg.filename || `file_${String(messageId).slice(-6)}` };
      } catch (e) { console.error('[golda] media download failed:', e.message); }
    }
    let text = msg.text;
    let voiceFailed = null;
    if (msg.type === 'audio' && media) {
      const heard = await transcribeVoice(db, media);
      if (heard.text) {
        text = `🎤 ${heard.text}`;
        media = null;                                       // the words are what matters, not the recording
        await inboxRef.update({ transcript: heard.text }).catch(() => {});
      } else voiceFailed = heard.error;
    }
    text = inboundText(msg, text);
    if (['audio', 'sticker', 'location', 'contacts'].includes(msg.type) && !text) text = `(sent a ${msg.type} message, which you can't read; ask them to write it as text)`;

    const topics = { ...(session.topics || {}) };
    let current = session.topic && topics[session.topic] ? session.topic : MAIN_TOPIC;
    const cmd = topicCommand(text);
    let direct = null;   // a reply that needs no model call
    let list = null;
    if (usage.count > DAILY_LIMIT) direct = `${first}, הגענו למכסת ההודעות היומית (${DAILY_LIMIT}). נמשיך מחר, או שלו יכול להגדיל אותה.`;
    else if (voiceFailed) direct = `${first}, ${speech.excuse(voiceFailed)}. אפשר לכתוב לי את זה במילים?`;
    else if (isMenuCommand(text)) {
      direct = menuText(first);
      list = { button: 'מה לעשות?', rows: MENU_ROWS };
    }
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
    let pendingDeletes = Array.isArray(session.pendingDeletes) ? session.pendingDeletes : (session.pendingDelete ? [session.pendingDelete] : []), changed = false, userText = text || '', agentUsage = null, outFiles = [];
    if (direct) reply = direct;
    else {
      // A long task gets one "still on it" line, so the writer knows it was received.
      let ack = null;
      if (msg.channel !== 'app') {
        ack = setTimeout(() => { wa.sendText(msg.from, `רגע, ${first}, אני על זה 🔎`, msg.phoneId).catch(() => {}); }, ACK_AFTER_MS);
      }
      try {
        const out = await runAgent({ db, admin, identity, text, media, session: { ...session, history: thread.history }, assistantName: ASSISTANT_NAME, topic, topics: Object.keys(topics), channel: msg.channel || 'whatsapp' });
        ({ reply, pendingDeletes, changed, userText } = out);
        agentUsage = out.usage;
        outFiles = Array.isArray(out.files) ? out.files : [];
      } finally { if (ack) clearTimeout(ack); }
    }
    const parsed = parseButtons(reply);
    reply = parsed.text;
    const buttons = list ? list.rows.map((r) => r.title) : parsed.buttons;

    // Documents she made are stored first, so the app and a later resend can reach them.
    const fileRefs = [];
    for (const f of outFiles) {
      try { fileRefs.push(await storeOutFile(db, f, identity)); } catch (e) { console.error('[golda] storing a document failed:', e.message); }
    }

    // Record the turn before sending, so a failed send never loses the history.
    const now = Date.now();
    const turn = [{ role: 'user', text: typeof userText === 'string' ? userText : String(userText ?? ''), at: now, channel: msg.channel || 'whatsapp' }, { role: 'assistant', text: reply, at: now + 1, id: String(messageId), ...(buttons.length ? { buttons } : {}), ...(fileRefs.length ? { files: fileRefs } : {}) }];
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

    const done = { reply, buttons, menu: Boolean(list), changed, topic: current, files: fileRefs, doneAt: admin.firestore.FieldValue.serverTimestamp(), durationMs: Date.now() - t0,
      usage: agentUsage ? { ...agentUsage, model: MODEL } : null };
    try {
      const ids = await deliver(msg, reply, { buttons: parsed.buttons, list, files: outFiles });
      await inboxRef.update({ ...done, state: 'done', sentIds: (ids || []).filter(Boolean) });
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
    const files = msg.channel === 'app' ? [] : (await Promise.all((Array.isArray(msg.files) ? msg.files : []).map((r) => loadOutFile(db, r).catch(() => null)))).filter(Boolean);
    const ids = await deliver(msg, msg.reply || '', { ...(msg.menu ? { list: { button: 'מה לעשות?', rows: MENU_ROWS } } : { buttons: Array.isArray(msg.buttons) ? msg.buttons : [] }), files });
    await inboxRef.update({ state: 'done', error: admin.firestore.FieldValue.delete(), resentAt: admin.firestore.FieldValue.serverTimestamp(), sentIds: (ids || []).filter(Boolean) });
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

module.exports = { processMessage, deliver, storeOutFile, loadOutFile, pickRetries, topicCommand, findTopic, nextUsage, threadKey, parseButtons, isMenuCommand, inboundText, MENU_ROWS, ASSISTANT_NAME, DAILY_LIMIT };
