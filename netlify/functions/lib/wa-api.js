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

// Which number Golda writes from, and with which key. Since she can move to her
// own number by herself (lib/meta-onboard.js), both can change at run time:
//   app_meta/whatsapp.primaryPhoneId   the default sending number (else WA_PHONE_ID)
//   app_meta/whatsapp.managedPhoneIds  numbers whose account only the server's
//                                      own Meta token reaches (lib/meta-auth.js);
//                                      every other number uses WA_TOKEN.
// Read from Firestore at most once a minute; any failure falls back to env.
let _routing = null;
async function routing(now = Date.now()) {
  if (_routing && now - _routing.at < 60000) return _routing;
  let primary = null, managed = [], metaToken = null;
  try {
    const { getDb } = require('./firestore.js');
    const db = getDb();
    const wa = (await db.collection('app_meta').doc('whatsapp').get()).data() || {};
    primary = /^\d+$/.test(wa.primaryPhoneId || '') ? wa.primaryPhoneId : null;
    managed = Array.isArray(wa.managedPhoneIds) ? wa.managedPhoneIds.map(String) : [];
    if (managed.length) metaToken = await require('./meta-auth.js').getToken(db);
  } catch (e) { console.warn('[wa] routing fallback to env:', e.message); }
  _routing = { at: now, primary, managed, metaToken };
  return _routing;
}
const defaultPhoneId = async () => (await routing()).primary || process.env.WA_PHONE_ID;
async function tokenFor(phoneId) {
  const r = await routing();
  return phoneId && r.metaToken && r.managed.includes(String(phoneId)) ? r.metaToken : process.env.WA_TOKEN;
}

async function graph(path, opts = {}, phoneId = null) {
  const token = await tokenFor(phoneId || String(path).split('/')[0]);
  const res = await fetch(`${GRAPH}/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// WhatsApp caps a text message at 4096 characters.
// `via` is the phone_number_id the message came in on, so Golda answers from
// the same number; the default number (above) is the fallback.
// Returns Meta's message ids (one per part), so delivery statuses coming back
// through the webhook can be matched to what was sent (lib/wa-outbox.js).
// Long replies (a report, a briefing) are split between paragraphs, else
// between lines, else between words, so no part ends mid-sentence.
function splitText(body, max = 4000) {
  const parts = [];
  let s = String(body ?? '');
  while (s.length > max) {
    const head = s.slice(0, max);
    let cut = head.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = head.lastIndexOf('\n');
    if (cut < max * 0.5) cut = head.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    parts.push(s.slice(0, cut).trimEnd());
    s = s.slice(cut).replace(/^\s+/, '');
  }
  if (s.length || !parts.length) parts.push(s);
  return parts;
}

async function sendText(to, body, via) {
  const from = via || await defaultPhoneId();
  const parts = splitText(body);
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
  const from = via || await defaultPhoneId();
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

// Marks the message read; with typing=true the writer also sees "typing…"
// until Golda answers (WhatsApp keeps it up to 25 seconds). A number or API
// version that refuses the indicator still gets the plain read receipt.
async function markRead(messageId, via, { typing = false } = {}) {
  const from = via || await defaultPhoneId();
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
  try {
    await graph(`${from}/messages`, { method: 'POST', body: JSON.stringify(typing ? { ...body, typing_indicator: { type: 'text' } } : body) });
  } catch (e) {
    if (typing) return markRead(messageId, via);
    console.warn('[wa] markRead failed:', e.message);
  }
}

// WhatsApp's limits for interactive messages.
const BUTTON_TITLE_MAX = 20;
const INTERACTIVE_BODY_MAX = 1024;
const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A long text before buttons: the last paragraph that fits rides with the buttons. */
function splitForButtons(text, max = INTERACTIVE_BODY_MAX) {
  const cut = text.lastIndexOf('\n\n');
  if (cut > 0 && text.length - cut - 2 <= max && text.slice(cut + 2).trim()) return { head: text.slice(0, cut).trimEnd(), tail: text.slice(cut + 2).trim() };
  return { head: text, tail: '👇' };
}

/**
 * Reply buttons: up to three taps under a message. A tap comes back as an
 * ordinary message whose text is the button's title. A body longer than an
 * interactive message allows goes first as text, the buttons follow under
 * its last paragraph.
 */
async function sendButtons(to, body, buttons, via) {
  const from = via || await defaultPhoneId();
  const titles = [...new Set((buttons || []).map((b) => clip(b, BUTTON_TITLE_MAX)).filter(Boolean))].slice(0, 3);
  if (!titles.length) return sendText(to, body, via);
  const ids = [];
  let text = String(body || '').trim();
  if (text.length > INTERACTIVE_BODY_MAX) {
    const { head, tail } = splitForButtons(text);
    ids.push(...await sendText(to, head, via));
    text = tail;
  }
  const res = await graph(`${from}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: digits(to), type: 'interactive',
      interactive: { type: 'button', body: { text: text || '…' }, action: { buttons: titles.map((title, i) => ({ type: 'reply', reply: { id: `b${i}`, title } })) } },
    }),
  });
  const json = await res.json().catch(() => ({}));
  ids.push(json.messages?.[0]?.id || null);
  return ids;
}

/** A list menu (one button that opens up to ten rows). A choice comes back as its row title. */
async function sendList(to, body, button, rows, via) {
  const from = via || await defaultPhoneId();
  const res = await graph(`${from}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: digits(to), type: 'interactive',
      interactive: {
        type: 'list', body: { text: clip(body, INTERACTIVE_BODY_MAX) },
        action: { button: clip(button, 20), sections: [{ title: clip(button, 24), rows: rows.slice(0, 10).map((r, i) => ({ id: r.id || `r${i}`, title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })) }] },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  return [json.messages?.[0]?.id || null];
}

/**
 * A file Golda made (a PDF), sent as a WhatsApp document: uploaded to Meta
 * first, then sent by its media id. Returns [message id].
 */
async function sendDocument(to, { buffer, filename, mimeType = 'application/pdf', caption = '' }, via) {
  const from = via || await defaultPhoneId();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const up = await fetch(`${GRAPH}/${from}/media`, { method: 'POST', headers: { Authorization: `Bearer ${await tokenFor(from)}` }, body: form });
  if (!up.ok) throw new Error(`WhatsApp media upload ${up.status}: ${(await up.text()).slice(0, 300)}`);
  const { id } = await up.json();
  const res = await graph(`${from}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'document', document: { id, filename, ...(caption ? { caption: clip(caption, 1024) } : {}) } }),
  });
  const json = await res.json().catch(() => ({}));
  return [json.messages?.[0]?.id || null];
}

// Media arrives as an id: one call for the short-lived URL, one for the bytes.
// `via` is the number the media arrived on, which decides the key.
async function downloadMedia(mediaId, via = null) {
  const meta = await (await graph(mediaId, {}, via)).json();
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${await tokenFor(via)}` } });
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
          text: m.text?.body || m.document?.caption || m.image?.caption || m.video?.caption || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '',
          // A tap on a template's quick-reply button, an interactive button or a menu row.
          payload: m.button?.payload || m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || null,
          // Forwarded from another chat (WhatsApp marks it; "frequently" = forwarded many times).
          forwarded: Boolean(m.context?.forwarded || m.context?.frequently_forwarded),
          voice: Boolean(m.audio?.voice),
          // A reaction names the message it is on; an empty emoji means it was removed.
          reaction: m.reaction ? { messageId: m.reaction.message_id || '', emoji: m.reaction.emoji || '' } : null,
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

module.exports = { defaultPhoneId, tokenFor, _resetRoutingForTests: () => { _routing = null; }, isAllowed, senderName, validSignature, sendText, splitText, sendTemplate, markRead, sendButtons, sendList, sendDocument, splitForButtons, BUTTON_TITLE_MAX, downloadMedia, extractMessages, extractStatuses, digits };
