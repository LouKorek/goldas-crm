// WhatsApp Cloud API (Meta Graph) helpers for Golda.
// Env: WA_TOKEN (permanent system-user token), WA_PHONE_ID (the bot number's
// phone-number id), WA_APP_SECRET (signs Meta's webhook calls), WA_VERIFY_TOKEN
// (chosen by us, echoed during webhook setup), WA_ALLOWED_NUMBERS (comma list,
// international digits with an optional name, e.g. 972501234567:לו,972521112233:דני).
const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com/v21.0';

const digits = (s) => String(s || '').replace(/\D/g, '');
const allowedEntries = () => (process.env.WA_ALLOWED_NUMBERS || '').split(',')
  .map((e) => { const [num, ...name] = e.split(':'); return { num: digits(num), name: name.join(':').trim() }; })
  .filter((e) => e.num);
const isAllowed = (from) => allowedEntries().some((e) => e.num === digits(from));
// The sender's name from the allow list; entries without a name are Lou's.
const senderName = (from) => (allowedEntries().find((e) => e.num === digits(from)) || {}).name || 'לו';

function validSignature(rawBody, header) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret || !header) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graph(path, opts = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.WA_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// WhatsApp caps a text message at 4096 characters.
// `via` is the phone_number_id the message came in on, so Golda answers from
// the same number; WA_PHONE_ID is the fallback.
// Returns Meta's message ids (one per part), so delivery statuses coming back
// through the webhook can be matched to what was sent (lib/wa-outbox.js).
async function sendText(to, body, via) {
  const from = via || process.env.WA_PHONE_ID;
  const parts = [];
  for (let s = String(body); s.length; s = s.slice(4000)) parts.push(s.slice(0, 4000));
  const ids = [];
  for (const text of parts) {
    const res = await graph(`${from}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text, preview_url: false } }),
    });
    const json = await res.json().catch(() => ({}));
    ids.push(json.messages?.[0]?.id || null);
  }
  return ids;
}

// An approved message template: the only thing a business may send once 24
// hours passed since the person last wrote (WhatsApp's customer-service
// window; a free-form text is accepted with HTTP 200 and then fails with
// status error 131047). `components` carries parameters when the template has any.
async function sendTemplate(to, name, language, via, components = []) {
  const from = via || process.env.WA_PHONE_ID;
  const res = await graph(`${from}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: digits(to), type: 'template',
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    }),
  });
  const json = await res.json().catch(() => ({}));
  return json.messages?.[0]?.id || null;
}

async function markRead(messageId, via) {
  try {
    await graph(`${via || process.env.WA_PHONE_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
  } catch (e) { console.warn('[wa] markRead failed:', e.message); }
}

// Media arrives as an id: one call for the short-lived URL, one for the bytes.
async function downloadMedia(mediaId) {
  const meta = await (await graph(mediaId)).json();
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.WA_TOKEN}` } });
  if (!res.ok) throw new Error(`media download ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: meta.mime_type || 'application/octet-stream' };
}

// Flatten one webhook payload into the messages we act on.
function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const phoneId = change.value?.metadata?.phone_number_id || null;
      for (const m of change.value?.messages || []) {
        const media = m.document || m.image || m.video || m.audio;
        out.push({
          id: m.id,
          from: m.from,
          type: m.type,
          text: m.text?.body || m.document?.caption || m.image?.caption || m.video?.caption || m.button?.text || m.interactive?.button_reply?.title || '',
          // A tap on a template's quick-reply button or an interactive button.
          payload: m.button?.payload || m.interactive?.button_reply?.id || null,
          mediaId: media?.id || null,
          filename: m.document?.filename || (m.image ? `photo_${m.id.slice(-6)}.jpg` : null),
          timestamp: Number(m.timestamp) || 0,
          phoneId,
        });
      }
    }
  }
  return out;
}

// Delivery statuses in one webhook payload: sent / delivered / read / failed,
// each with the id of the message it is about and Meta's error list on a failure.
function extractStatuses(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const phoneId = change.value?.metadata?.phone_number_id || null;
      for (const s of change.value?.statuses || []) {
        out.push({
          id: s.id, status: s.status, recipient: s.recipient_id || '', timestamp: Number(s.timestamp) || 0, phoneId,
          errors: (s.errors || []).map((e) => ({ code: Number(e.code) || 0, title: e.title || '', message: e.message || e.error_data?.details || '' })),
        });
      }
    }
  }
  return out;
}

module.exports = { isAllowed, senderName, validSignature, sendText, sendTemplate, markRead, downloadMedia, extractMessages, extractStatuses, digits };
