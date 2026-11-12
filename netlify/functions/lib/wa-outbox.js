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
//     Meta's message id (state 'sent'); window closed → keep the full text in
//     wa_outbox (state 'queued') and send a template instead: golda_brief
//     carries the update's title and its three main lines (briefOf),
//     golda_digest (for shorter updates, or while the brief awaits review)
//     the title and a one-line summary (digestOf), both with a button for the
//     full text; before they are approved, the pointer template
//     golda_update or Meta's hello_world (at most one of those per
//     RE_ENGAGE_GAP_MS per person, since they carry nothing).
//   onStatuses(db, statuses)   webhook: 'delivered' / 'read' / 'failed' on the
//     outbox row; a 131047 failure turns the row into 'queued' and re-engages.
//   onInbound(db, phone, via, {release})  webhook: the person wrote, so the
//     window is open for 24 hours: remember it (wa_contacts/{phone}.lastInbound)
//     and send what waited, oldest first. A text whose content already went out
//     in a template (row.teaser) waits for the template's button (release:
//     true) and is never sent as the answer to an unrelated message; it expires
//     after TEASER_TTL_MS. A text the person never saw goes out on any message.
//
// wa_contacts/{phone}: lastInbound, lastReengageAt, lastReengageTemplate,
//   lastDelivered, lastFailure {at, code, message}.
// wa_outbox/{id}: to, via, body, kind, state, queuedAt | sentAt, error, flushedAt.
const wa = require('./wa-api.js');
const { digits } = require('./golda-identity.js');
const { BRIEF, DIGEST, UPDATE, approvedSomewhere } = require('./wa-templates.js');

const WINDOW_MS = 24 * 3600000;
const SAFE_MS = WINDOW_MS - 10 * 60000;  // a few minutes' margin; a late 131047 still re-queues (onStatuses)
const TEASER_TTL_MS = 20 * 3600000;      // a brief's full text waits for its button this long
const RE_ENGAGE_GAP_MS = 12 * 3600000;   // one template per person per half day
const WINDOW_ERRORS = new Set([131047]); // "Re-engagement message": outside the window
const TEMPLATE_MISSING = new Set([132001, 132000, 132012, 132015, 132016]); // template not found / not approved / wrong parameters / paused / disabled
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
 * Which template goes out when the window is closed. Preference: the digest
 * (carries the content), then the pointer, then Meta's hello_world. Status
 * comes from app_meta/whatsapp.templates (lib/wa-templates.js) — but the
 * server's token may not be allowed to read it at all (#200), and Meta's
 * review can be long over before we notice. So a template whose status is
 * unknown, pending or unreadable is still TRIED (`optimistic`): Meta answers
 * 132001 for one that does not exist or is not approved yet, and reengage()
 * falls through to the next. Only a template Meta itself has rejected,
 * paused or disabled is skipped up front.
 */
const SKIP = new Set(['REJECTED', 'PAUSED', 'DISABLED', 'DELETED']);
const knownBad = (t) => {
  const known = Object.values(t?.accounts || {}).map((a) => a.status).filter((st) => st && st !== 'error');
  return known.length > 0 && known.every((st) => SKIP.has(st));
};
/**
 * Every template worth trying, best first. With a body that has three lines
 * to show, the brief leads; otherwise the digest.
 */
function templateChain(meta, body = '') {
  const all = meta?.templates || (meta?.template ? { [meta.template.name]: meta.template } : {});
  const order = [[DIGEST, 'digest'], [UPDATE, null]];
  if (body && briefOf(body)) order.unshift([BRIEF, 'brief']);
  const chain = [];
  for (const [t, carries] of order) {
    if (knownBad(all[t.name])) continue;
    chain.push({ name: t.name, language: t.language, own: true, digest: !!carries, ...(carries === 'brief' ? { brief: true } : {}), ...(approvedSomewhere(all[t.name]) ? {} : { optimistic: true }) });
  }
  chain.push({ ...FALLBACK_TEMPLATE, own: false, digest: false });
  return chain;
}
function templateFor(meta, body = '') { return templateChain(meta, body)[0]; }

/** The next template after `tpl` failed as missing / not approved on this account. */
function nextTemplate(tpl, meta, body = '') {
  const chain = templateChain(meta, body);
  const i = chain.findIndex((t) => t.name === tpl.name);
  return chain[i + 1] || { ...FALLBACK_TEMPLATE, own: false, digest: false };
}

const MD = /[*_~`]/g;
const URL_RE = /https?:\/\/\S+/g;
const DIGEST_MAX = 640;

/**
 * The full WhatsApp text as two template parameters: its first line as the
 * title, the rest flattened into one line. Template parameters may not hold
 * newlines, tabs or runs of spaces, and the whole body stays under 1024 chars.
 */
function digestOf(body) {
  const clean = (s) => String(s || '').replace(MD, '').replace(URL_RE, '').replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ').replace(/^[•\-–]\s*/, '').trim();
  const lines = String(body || '').split('\n').map(clean).filter((l) => l && !/^(הכל בבית|פרטים)\s*:?$/.test(l));
  const title = (lines.shift() || 'עדכון מגולדה').replace(/\s*:\s*$/, '');
  const parts = [];
  let header = '';
  for (const l of lines) {
    if (/:$/.test(l)) { if (header) parts.push(header); header = l; continue; }   // "היום:" joins the line after it
    parts.push(header ? `${header} ${l}` : l);
    header = '';
  }
  if (header) parts.push(header.replace(/\s*:\s*$/, ''));
  let summary = parts.join(' · ');
  if (!summary) summary = 'יש עדכון חדש בשבילך.';
  if (summary.length > DIGEST_MAX) summary = `${summary.slice(0, DIGEST_MAX - 1).replace(/\s+\S*$/, '')}…`;
  return { title: title.slice(0, 120), summary };
}
const digestComponents = ({ title, summary }) => [{ type: 'body', parameters: [{ type: 'text', text: title }, { type: 'text', text: summary }] }];

const BRIEF_LINE_MAX = 140;
/**
 * The update as golda_brief shows it: its title and three lines, each on its
 * own line in the template. The lines are the first section's items (the
 * briefing puts "the most important today" first), then the next sections'.
 * Null when the text has fewer than three lines to show (the digest fits it).
 */
function briefOf(body) {
  const clean = (s) => String(s || '').replace(MD, '').replace(URL_RE, '').replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ').replace(/^[•\-–·]\s*/, '').trim();
  const lines = String(body || '').split('\n').map(clean).filter((l) => l && !/^(הכל בבית|פרטים)\s*:?$/.test(l));
  const title = (lines.shift() || 'עדכון מגולדה').replace(/\s*:\s*$/, '');
  const items = lines.filter((l) => !/:$/.test(l));   // section headers ("היום:") are not lines of their own
  if (items.length < 3) return null;
  const cut = (l) => (l.length > BRIEF_LINE_MAX ? `${l.slice(0, BRIEF_LINE_MAX - 1).replace(/\s+\S*$/, '')}…` : l);
  return { title: title.slice(0, 120), lines: items.slice(0, 3).map(cut) };
}
const briefComponents = ({ title, lines }) => [{ type: 'body', parameters: [title, ...lines].map((text) => ({ type: 'text', text })) }];
const componentsFor = (t, body) => {
  if (!body || !t.digest) return [];
  if (t.brief) { const b = briefOf(body); if (b) return briefComponents(b); }
  return digestComponents(digestOf(body));
};

async function contactRef(db, phone) { return db.collection('wa_contacts').doc(digits(phone)); }
async function readContact(db, phone) {
  const snap = await (await contactRef(db, phone)).get();
  return snap.exists ? (snap.data() || {}) : {};
}

/**
 * Reach the person outside the window. With `body`, and the digest template
 * approved, the message carries the update itself and goes out every time;
 * a content-free template (pointer / hello_world) is rate-limited instead.
 */
async function reengage(db, phone, via, contact, { now = Date.now(), api = wa, log = console.log, body = '' } = {}) {
  const meta = (await db.collection('app_meta').doc('whatsapp').get()).data() || {};
  let tpl = templateFor(meta, body);
  // A content-free template is rate-limited; the digest carries the update, so it always goes.
  const recently = now - ms(contact.lastReengageAt) < RE_ENGAGE_GAP_MS;
  if (!(tpl.digest && body) && recently) return { skipped: 'recently' };
  const ref = await contactRef(db, phone);
  const send = (t) => api.sendTemplate(phone, t.name, t.language, via, componentsFor(t, body));
  try {
    let id;
    for (;;) {
      try {
        id = await send(tpl);
        break;
      } catch (e) {
        if (!tpl.own || !TEMPLATE_MISSING.has(errorCode(e.message))) throw e;
        // Not on this number's account, or not approved yet: the next one down.
        const tried = tpl;
        tpl = nextTemplate(tpl, meta, body);
        if (!(tpl.digest && body) && recently) {
          log(`[wa-outbox] ${tried.name} not usable yet (${errorCode(e.message)}); a content-free template already went out recently`);
          return { skipped: 'recently', tried: tried.name };
        }
      }
    }
    await ref.set({ lastReengageAt: now, lastReengageTemplate: tpl.name, lastReengageError: null }, { merge: true });
    if (tpl.optimistic) {
      // Meta accepted it, so it is approved on the account behind `via`; remember that, since the token may not be allowed to ask.
      await db.collection('app_meta').doc('whatsapp').set({ templates: { [tpl.name]: { name: tpl.name, language: tpl.language, accounts: { [`sent:${via || 'default'}`]: { status: 'APPROVED', observedAt: now } } } } }, { merge: true });
    }
    log(`[wa-outbox] re-engagement template ${tpl.name}${tpl.optimistic ? ' (first success)' : ''} → …${digits(phone).slice(-4)}`);
    return { template: tpl.name, id, carried: !!(tpl.digest && body) };
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
  const re = await reengage(db, phone, via, contact, { now, api, log, body });
  if (re.carried) await ref.set({ teaser: re.template, teasedAt: now }, { merge: true });
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
      if (closed) {
        const re = await reengage(db, row.to, row.via || s.phoneId, contact, { now, api, log, body: row.body });
        if (re.carried) await ref.set({ teaser: re.template, teasedAt: now }, { merge: true });
      }
      continue;
    }
    if (s.status === 'delivered' || s.status === 'read') {
      if (row.state === 'sent' || row.state === 'delivered') await ref.set({ state: s.status, [`${s.status}At`]: now }, { merge: true });
      await (await contactRef(db, row.to)).set({ lastDelivered: now }, { merge: true });
    }
  }
  return handled;
}

/**
 * Webhook: the person wrote; the window is open, so release what waited.
 * `release` is true for a tap on a template's button: only then does a text
 * the template already summed up (row.teaser) follow.
 */
async function onInbound(db, phone, via, { now = Date.now(), api = wa, log = console.log, release = false } = {}) {
  const p = digits(phone);
  await (await contactRef(db, p)).set({ lastInbound: now }, { merge: true });
  const snap = await db.collection('wa_outbox').where('to', '==', p).where('state', '==', 'queued').get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.queuedAt) - ms(b.queuedAt));
  const rows = [];
  for (const r of all) {
    if (!r.teaser) { rows.push(r); continue; }
    if (now - ms(r.teasedAt || r.queuedAt) > TEASER_TTL_MS) {
      await db.collection('wa_outbox').doc(r.id).set({ state: 'expired', expiredAt: now }, { merge: true });
      continue;
    }
    if (release) rows.push(r);
  }
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

module.exports = { deliver, onStatuses, onInbound, windowState, templateFor, templateChain, nextTemplate, digestOf, briefOf, isWindowError, reengage, PENDING_BUTTON, FALLBACK_TEMPLATE, WINDOW_MS, SAFE_MS, TEASER_TTL_MS, RE_ENGAGE_GAP_MS, _internal: { errorCode } };
