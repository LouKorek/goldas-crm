// Meta calls this for every WhatsApp event on Golda's number.
// GET  = one-time webhook verification (echo hub.challenge).
// POST = new messages: check Meta's signature, drop senders not on the allow
// list and duplicate deliveries, then hand each message to the background
// function and answer 200 at once (Meta retries anything slower).
const admin = require('firebase-admin');
const wa = require('./lib/wa-api.js');

function getDb() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)) });
  return admin.firestore();
}

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
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  for (const m of msgs) {
    if (!wa.isAllowed(m.from)) { console.warn('[wa] ignored sender not on allow list'); continue; }
    // Meta can deliver the same message more than once; create() fails on a repeat.
    try {
      await db.collection('wa_inbox').doc(m.id).create({ ...m, receivedAt: admin.firestore.FieldValue.serverTimestamp(), state: 'queued' });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) continue;
      throw e;
    }
    await fetch(`${base}/.netlify/functions/whatsapp-agent-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wa-internal': process.env.WA_APP_SECRET },
      body: JSON.stringify({ messageId: m.id }),
    }).catch((e) => console.error('[wa] handoff failed:', e.message));
  }
  return { statusCode: 200, body: 'ok' };
};
