// Golda's outgoing mail on WhatsApp, and why it needs one.
//
// WhatsApp lets a business write freely only inside the 24 hours after the
// person last wrote (the "customer-service window"). Outside it, a free-form
// text is accepted (HTTP 200) and then fails quietly with status error 131047;
// the only thing allowed is an approved template. Golda's briefing used to
// call that a success, so when Lou was quiet for a day she went silent too.
//
// This module makes every proactive message accountable:
//   deliver(db, {to, body, via, kind})
//     window open or unknown → send the text, record it in wa_outbox under
//     Meta's message id (state 'sent'); window closed → keep the text in
//     wa_outbox (state 'queued') and send one re-engagement template instead
//     (at most one per RE_ENGAGE_GAP_MS per person).
//   onStatuses(db, statuses)   webhook: 'delivered' / 'read' / 'failed' on the
//     outbox row; a 131047 failure turns the row into 'queued' and re-engages.
//   onInbound(db, phone, via)  webhook: the person wrote, so the window is open
//     for 24 hours: remember it (wa_contacts/{phone}.lastInbound) and send
//     every queued text, oldest first.
//
// wa_contacts/{phone}: lastInbound, lastReengageAt, lastReengageTemplate,
//   lastDelivered, lastFailure {at, code, message}.
// wa_outbox/{id}: to, via, body, kind, state, queuedAt | sentAt, error, flushedAt.
const wa = require('./wa-api.js');
const { digits } = require('./golda-identity.js');

const WINDOW_MS = 24 * 3600000;
const SAFE_MS = 23 * 3600000;            // treat the window as closed an hour early
const RE_ENGAGE_GAP_MS = 12 * 3600000;   // one template per person per half day
const WINDOW_ERRORS = new Set([131047]); // "Re-engagement message": outside the window
const TEMPLATE_MISSING = new Set([132001, 132000, 132012]); // template not found / wrong parameters
const FALLBACK_TEMPLATE = { name: 'hello_world', language: 'en_US' }; // pre-approved on every Meta test account
const PENDING_BUTTON = 'golda_send_pending';

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : v ? new Date(v).getTime() || 0 : 0);

/** 'open' | 'closed' | 'unknown' — unknown until the person wrote once after this shipped. */
function windowState(contact, now = Date.now()) {
  const last = ms(contact?.lastInbound);
  if (!last) return 'unknown';
  return now - last < SAFE_MS ? 'open' : 'closed';
}

const isWindowError = (errors) => (errors || []).some((e) => WINDOW_ERRORS.has(Number(e.code)));
const errorCode = (message) => Number((String(message || '').match(/"code"\s*:\s*(\d+)/) || [])[1]) || 0;

/**
 * Which template re-opens the conversation. Preference: Golda's own approved
 * utility template (created by lib/wa-templates.js, status in app_meta/whatsapp);
 * otherwise Meta's hello_world.
 */
function templateFor(meta) {
  const t = meta?.template;
  const approved = t && Object.values(t.accounts || {}).some((a) => a.status === 'APPROVED');
  return approved ? { name: t.name, language: t.language || 'he', own: true } : { ...FALLBACK_TEMPLATE, own: false };
}

async function contactRef(db, phone) { return db.collection('wa_contacts').doc(digits(phone)); }
async function readContact(db, phone) {
  const snap = await (await contactRef(db, phone)).get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function reengage(db, phone, via, contact, { now = Date.now(), api = wa, log = console.log } = {}) {
  if (now - ms(contact.lastReengageAt) < RE_ENGAGE_GAP_MS) return { skipped: 'recently' };
  const meta = (await db.collection('app_meta').doc('whatsapp').get()).data() || {};
  let tpl = templateFor(meta);
  const ref = await contactRef(db, phone);
  try {
    let id;
    try {
      id = await api.sendTemplate(phone, tpl.name, tpl.language, via);
    } catch (e) {
      if (!tpl.own || !TEMPLATE_MISSING.has(errorCode(e.message))) throw e;
      tpl = { ...FALLBACK_TEMPLATE, own: false };   // our template is not on this number's account (yet)
      id = await api.sendTemplate(phone, tpl.name, tpl.language, via);
    }
    await ref.set({ lastReengageAt: now, lastReengageTemplate: tpl.name, lastReengageError: null }, { merge: true });
    log(`[wa-outbox] re-engagement template ${tpl.name} → …${digits(phone).slice(-4)}`);
    return { template: tpl.name, id };
  } catch (e) {
    await ref.set({ lastReengageAt: now, lastReengageTemplate: tpl.name, lastReengageError: String(e.message).slice(0, 300) }, { merge: true });
    log(`[wa-outbox] re-engagement failed: ${e.message}`);
    return { error: e.message };
  }
}

/** Send a proactive text, or hold it until the person writes. */
async function deliver(db, { to, body, via = null, kind = 'text' }, { now = Date.now(), api = wa, log = console.log } = {}) {
  const phone = digits(to);
  const contact = await readContact(db, phone);
  const state = windowState(contact, now);
  if (state !== 'closed') {
    const ids = await api.sendText(phone, body, via);
    for (const id of ids.filter(Boolean)) {
      await db.collection('wa_outbox').doc(id).set({ to: phone, via, body, kind, state: 'sent', sentAt: now, window: state });
    }
    return { state: 'sent', ids };
  }
  const ref = db.collection('wa_outbox').doc();
  await ref.set({ to: phone, via, body, kind, state: 'queued', queuedAt: now, reason: 'window closed' });
  const re = await reengage(db, phone, via, contact, { now, api, log });
  return { state: 'queued', id: ref.id, reengage: re };
}

/** Webhook: delivery statuses for what was sent. */
async function onStatuses(db, statuses, { now = Date.now(), api = wa, log = console.log } = {}) {
  let handled = 0;
  for (const s of statuses || []) {
    if (!s.id) continue;
    const ref = db.collection('wa_outbox').doc(s.id);
    const snap = await ref.get();
    if (!snap.exists) continue;   // a reply inside a conversation, not tracked
    const row = snap.data() || {};
    handled++;
    if (s.status === 'failed') {
      const err = s.errors?.[0] || {};
      const closed = isWindowError(s.errors);
      await ref.set({ state: closed ? 'queued' : 'failed', queuedAt: closed ? now : row.queuedAt || null, error: `${err.code || ''} ${err.title || ''} ${err.message || ''}`.trim(), reason: closed ? 'window closed' : 'failed', failedAt: now }, { merge: true });
      const cref = await contactRef(db, row.to);
      const contact = (await cref.get()).data() || {};
      await cref.set({ lastFailure: { at: now, code: err.code || 0, message: (err.message || err.title || '').slice(0, 200) } }, { merge: true });
      if (closed) await reengage(db, row.to, row.via || s.phoneId, contact, { now, api, log });
      continue;
    }
    if (s.status === 'delivered' || s.status === 'read') {
      if (row.state === 'sent' || row.state === 'delivered') await ref.set({ state: s.status, [`${s.status}At`]: now }, { merge: true });
      await (await contactRef(db, row.to)).set({ lastDelivered: now }, { merge: true });
    }
  }
  return handled;
}

/** Webhook: the person wrote; the window is open, so release what waited. */
async function onInbound(db, phone, via, { now = Date.now(), api = wa, log = console.log } = {}) {
  const p = digits(phone);
  await (await contactRef(db, p)).set({ lastInbound: now }, { merge: true });
  const snap = await db.collection('wa_outbox').where('to', '==', p).where('state', '==', 'queued').get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.queuedAt) - ms(b.queuedAt));
  let flushed = 0;
  for (const r of rows) {
    try {
      const ids = await api.sendText(p, r.body, via || r.via);
      await db.collection('wa_outbox').doc(r.id).set({ state: 'sent', sentAt: now, flushedAt: now, messageIds: ids.filter(Boolean), window: 'open' }, { merge: true });
      flushed++;
    } catch (e) {
      await db.collection('wa_outbox').doc(r.id).set({ error: String(e.message).slice(0, 300), attempts: (r.attempts || 0) + 1 }, { merge: true });
      log(`[wa-outbox] flush failed: ${e.message}`);
      break;   // keep the order; the next inbound message tries again
    }
  }
  return { pending: rows.length, flushed };
}

module.exports = { deliver, onStatuses, onInbound, windowState, templateFor, isWindowError, reengage, PENDING_BUTTON, FALLBACK_TEMPLATE, WINDOW_MS, SAFE_MS, RE_ENGAGE_GAP_MS, _internal: { errorCode } };
