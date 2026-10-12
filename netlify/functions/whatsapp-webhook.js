// Meta calls this for every WhatsApp event on Golda's number.
// GET  = one-time webhook verification (echo hub.challenge).
// POST = new messages: check Meta's signature, drop senders who are not CRM
// users (lib/golda-identity.js: the number on their Team record, or the legacy
// allow list) and duplicate deliveries, then hand each message to the
// background function and answer 200 at once (Meta retries anything slower).
// A hand-off that fails leaves the message queued; golda-queue-cron retries it.
const { admin, getDb } = require('./lib/firestore.js');
const { internalHeaders } = require('./lib/auth.js');
const wa = require('./lib/wa-api.js');
const { resolveSender } = require('./lib/golda-identity.js');

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
  const msgs = wa.extractMessages(payload);
  if (!msgs.length) return { statusCode: 200, body: 'ok' };   // delivery/read receipts

  const db = getDb();
  // Hand off to the background function of the same deploy Meta called (its
  // host), so a webhook pointed at a specific deploy never reaches an older one.
  const host = h.host || h.Host;
  const base = host ? `https://${host}` : (process.env.URL || 'https://goldas-crm.netlify.app');
  for (const m of msgs) {
    const who = await resolveSender(db, m.from).catch((e) => { console.error('[wa] identity lookup failed:', e.message); return null; });
    if (!who) { console.warn('[wa] ignored sender who is not a CRM user'); continue; }
    // Meta can deliver the same message more than once; create() fails on a repeat.
    try {
      await db.collection('wa_inbox').doc(m.id).create({ ...m, channel: 'whatsapp', email: who.email || '', receivedAt: admin.firestore.FieldValue.serverTimestamp(), state: 'queued', attempts: 0 });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) continue;
      throw e;
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
