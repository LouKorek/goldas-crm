// Golda's brain, run in the background (up to 15 minutes) so the webhook can
// answer Meta immediately. Reads one queued message, runs the agent, replies
// on WhatsApp. Messages from the same number are handled one at a time, in
// order, through a lock on the session document.
const crypto = require('crypto');
const admin = require('firebase-admin');
const wa = require('./lib/wa-api.js');
const { runAgent } = require('./lib/wa-agent.js');

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

  await wa.markRead(messageId);
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
    if (['audio', 'sticker', 'location', 'contacts'].includes(msg.type) && !text) text = `(Lou sent a ${msg.type} message, which you can't read; ask Lou to write it as text)`;

    const out = await runAgent({ db, admin, phone, text, media, session, assistantName: ASSISTANT_NAME });
    await wa.sendText(phone, out.reply);

    const history = [...(session.history || []), { role: 'user', text: out.userText, at: Date.now() }, { role: 'assistant', text: out.reply, at: Date.now() }].slice(-30);
    await sessRef.set({ history, turn: session.turn, pendingDelete: out.pendingDelete || null, lastAt: Date.now(), lockUntil: 0, lockedBy: null }, { merge: true });
    await inboxRef.update({ state: 'done', reply: out.reply, changed: out.changed, doneAt: admin.firestore.FieldValue.serverTimestamp() });
  } catch (e) {
    console.error('[wa] agent failed:', e);
    await inboxRef.update({ state: 'error', error: String(e.message || e) }).catch(() => {});
    await sessRef.set({ lockUntil: 0, lockedBy: null }, { merge: true }).catch(() => {});
    await wa.sendText(phone, 'לו, נתקלתי בתקלה ולא ביצעתי את הבקשה. תנסה שוב בעוד דקה.').catch(() => {});
  }
  return { statusCode: 200, body: 'ok' };
};
