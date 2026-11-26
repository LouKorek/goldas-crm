// A tap on a button, tied back to the card that carried it.
//
// WhatsApp returns a tap as an ordinary message whose text is the button's
// title, so "כן" under one card looks exactly like "כן" under another. What
// tells them apart is the message the tap answers: WhatsApp names it
// (messages[].context.id, kept as contextId by lib/wa-api.js extractMessages),
// and lib/wa-outbox.js keeps, on the row of every message sent with a
// `ref: { type, id }`, the WhatsApp id the send returned. So:
//
//   resolveTap(db, { contextId, payload, title }) → { ref, button } | null
//     the card the tap is on and which of its buttons (0, 1 or 2) it was.
//     Null when the message answers nothing we sent with a ref, or is not one
//     of its buttons (a typed reply to the card is a message for the model).
//
//   onTap(type, handler)    a feature registers what a tap on its cards does
//   handleTap(db, msg, ctx) the worker asks before it calls the model:
//     { handled: true, reply? } → the reply is sent (when there is one) and
//     no model call is made; { handled: false } → everything goes on as before.
//
// A handler gets ({ db, msg, ref, button, title, row, ctx }) and returns
// { handled, reply? } (a bare string counts as a handled reply). `button` is
// the button's place in the list the card was sent with, `title` what it
// said, `row` the outbox row, `ctx` what the worker knows (identity, first,
// admin, now). A handler that throws, or answers handled: false, hands the
// message to the model as if no handler existed: a tap is never lost.
//
// Nothing is registered here. Only messages sent through the outbox with a
// ref can be resolved: Golda's ordinary replies carry none, so their buttons
// keep working as they always did.
const { buttonTitles, BUTTON_TITLE_MAX } = require('./wa-api.js');
const { digits } = require('./golda-identity.js');

const handlers = new Map();

/** Registers what a tap on a card of this type does. The last registration wins. */
function onTap(type, handler) {
  if (!type || typeof handler !== 'function') throw new TypeError('onTap(type, handler): a type and a function');
  handlers.set(String(type), handler);
}

const clip = (s) => { const t = String(s || '').trim(); return t.length > BUTTON_TITLE_MAX ? `${t.slice(0, BUTTON_TITLE_MAX - 1)}…` : t; };

/** The outbox row of the message with this WhatsApp id: sent at once (the row's own id) or released later (messageIds). */
async function rowOf(db, contextId) {
  const id = String(contextId || '');
  if (!id) return null;
  const snap = await db.collection('wa_outbox').doc(id).get();
  if (snap.exists) return { id, ...(snap.data() || {}) };
  const later = await db.collection('wa_outbox').where('messageIds', 'array-contains', id).get();
  const d = later.docs[0];
  return d ? { id: d.id, ...(d.data() || {}) } : null;
}

/** Which of the row's buttons was tapped: by the id it was sent with (b0, b1, b2), else by its title. -1 when neither fits. */
function buttonOf(row, { payload, title }) {
  const titles = buttonTitles(row.buttons);
  const m = /^b(\d)$/.exec(String(payload || ''));
  if (m && Number(m[1]) < titles.length) return Number(m[1]);
  return titles.indexOf(clip(title));
}

async function find(db, { contextId, payload, title }) {
  const row = await rowOf(db, contextId);
  if (!row || !row.ref || !row.ref.type || !row.ref.id) return null;
  const button = buttonOf(row, { payload, title });
  if (button < 0) return null;
  return { ref: { type: String(row.ref.type), id: String(row.ref.id) }, button, row };
}

/** resolveTap(db, { contextId, payload, title }) → { ref: { type, id }, button } | null */
async function resolveTap(db, { contextId, payload = null, title = '' } = {}) {
  const hit = await find(db, { contextId, payload, title });
  return hit ? { ref: hit.ref, button: hit.button } : null;
}

/**
 * handleTap(db, msg, ctx) → { handled, reply? }
 * msg is the inbound message as the webhook stored it (contextId, payload, text, from).
 * Never throws: whatever goes wrong, the answer is { handled: false }.
 */
async function handleTap(db, msg, ctx = {}) {
  if (!msg || !msg.contextId || !handlers.size) return { handled: false };
  try {
    const hit = await find(db, { contextId: msg.contextId, payload: msg.payload, title: msg.text });
    if (!hit) return { handled: false };
    // A card belongs to the person it was sent to.
    if (hit.row.to && msg.from && digits(hit.row.to) !== digits(msg.from)) return { handled: false };
    const handler = handlers.get(hit.ref.type);
    if (!handler) return { handled: false };
    const out = await handler({ db, msg, ref: hit.ref, button: hit.button, title: buttonTitles(hit.row.buttons)[hit.button] || '', row: hit.row, ctx });
    if (typeof out === 'string') return { handled: true, reply: out };
    if (!out || !out.handled) return { handled: false };
    const reply = typeof out.reply === 'string' ? out.reply.trim() : '';
    return reply ? { handled: true, reply } : { handled: true };
  } catch (e) {
    console.error('[golda-taps] the tap was not handled:', e && e.message);
    return { handled: false };
  }
}

module.exports = { resolveTap, onTap, handleTap, _internal: { handlers, rowOf, buttonOf } };
