// Meta calls this for every WhatsApp event on Golda's number.
// GET  = one-time webhook verification (echo hub.challenge).
// POST = new messages: check Meta's signature, drop senders who are not CRM
// users (lib/golda-identity.js: the number on their Team record, or the legacy
// allow list) and duplicate deliveries, then hand each message to the
// background function and answer 200 at once (Meta retries anything slower).
// A hand-off that fails leaves the message queued; golda-queue-cron retries it.
// Delivery statuses (sent / delivered / read / failed) go to lib/wa-outbox.js,
// which is how Golda learns that a proactive text was refused outside
// WhatsApp's 24-hour window; every inbound message re-opens that window and
// releases the texts that waited.
const { admin, getDb } = require('./lib/firestore.js');
const { internalHeaders } = require('./lib/auth.js');
const wa = require('./lib/wa-api.js');
const outbox = require('./lib/wa-outbox.js');
const { resolveSender } = require('./lib/golda-identity.js');
const feedback = require('./lib/golda-feedback.js');

const PENDING_WORDS = /^(שלחי את העדכון|שלחי את הפירוט|שלחי לי את העדכון|שלחי|send the update)$/i;

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && process.env.WA_VERIFY_TOKEN && q['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'forbidden' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const h = event.headers || {};
  if (!wa.validSignature(raw, h['x-hub-signature-256'] || h['X-Hub-Signature-256'])) {
    console.warn('[wa] bad signature');
    return { statusCode: 401, body: 'bad signature' };
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return { statusCode: 400, body: 'bad json' }; }
  const db = getDb();
  const statuses = wa.extractStatuses(payload);
  if (statuses.length) {
    await outbox.onStatuses(db, statuses).catch((e) => console.error('[wa] status handling failed:', e.message));
  }
  const msgs = wa.extractMessages(payload);
  if (!msgs.length) return { statusCode: 200, body: 'ok' };

  // Hand off to the background function of the same deploy Meta called (its
  // host), so a webhook pointed at a specific deploy never reaches an older one.
  const host = h.host || h.Host;
  const base = host ? `https://${host}` : (process.env.URL || 'https://goldas-crm.netlify.app');
  for (const m of msgs) {
    const who = await resolveSender(db, m.from).catch((e) => { console.error('[wa] identity lookup failed:', e.message); return null; });
    if (!who) { console.warn('[wa] ignored sender who is not a CRM user'); continue; }
    // A reaction on Golda's answer is a 👍/👎, not a request: record it and move on.
    if (m.type === 'reaction') {
      try {
        const inbox = m.reaction?.messageId ? await feedback.inboxForSentId(db, m.reaction.messageId) : null;
        if (inbox) await feedback.recordFeedback(db, { who: m.from, email: who.email || '', name: who.name || '', answerId: m.reaction.messageId, inbox, rating: feedback.ratingOf(m.reaction.emoji), emoji: m.reaction.emoji, channel: 'whatsapp' });
      } catch (e) { console.error('[wa] reaction failed:', e.message); }
      continue;
    }
    // Meta can deliver the same message more than once; create() fails on a repeat.
    try {
      await db.collection('wa_inbox').doc(m.id).create({ ...m, channel: 'whatsapp', email: who.email || '', receivedAt: admin.firestore.FieldValue.serverTimestamp(), state: 'queued', attempts: 0 });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) continue;
      throw e;
    }
    // The person wrote: the 24-hour window is open again, so what they never saw goes out first.
    // A tap on a template's button asks for what it summed up; any other message only opens the window.
    const asked = m.payload === outbox.PENDING_BUTTON || (m.type === 'button' && !m.mediaId) || PENDING_WORDS.test((m.text || '').trim());
    const released = await outbox.onInbound(db, m.from, m.phoneId, { release: asked }).catch((e) => { console.error('[wa] release failed:', e.message); return { pending: 0, flushed: 0 }; });
    if (asked) {
      // A tap on the re-engagement template's button is not a request for Golda.
      await db.collection('wa_inbox').doc(m.id).set({ state: 'done', note: `released ${released.flushed} queued`, doneAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      if (!released.pending) await wa.sendText(m.from, `${(who.name || 'לו').split(' ')[0]}, אין עדכונים שמחכים כרגע. אכתוב כשיהיה משהו חדש 🙂`, m.phoneId).catch(() => {});
      await wa.markRead(m.id, m.phoneId);
      continue;
    }
    await fetch(`${base}/.netlify/functions/whatsapp-agent-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await internalHeaders('wa-handoff')) },
      body: JSON.stringify({ messageId: m.id }),
    }).then((r) => { if (!r.ok) console.error('[wa] handoff failed:', r.status, base); })
      .catch((e) => console.error('[wa] handoff failed:', e.message));
  }
  return { statusCode: 200, body: 'ok' };
};
