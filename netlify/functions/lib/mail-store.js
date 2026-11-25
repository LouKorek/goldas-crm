// The agency's mail inside the CRM: which messages belong to which contact,
// club and deal, the sync that brings them in, and the reads the screens and
// Golda make.
//
// Privacy is the rule everything here follows. A mailbox holds far more than
// agency business, so the server asks Gmail ONLY for mail to or from the
// addresses the CRM knows: a contact's own address (contactEmail) and a club's
// e-mail domain (emailDomain; never a free mail domain). With none filled in,
// nothing is read at all. A message Gmail's own search returned is read in
// full once, in memory, to see who it is with and which player it names; only
// a message that matches a contact or a club is stored, and then only:
//   the Gmail id and thread id, the date, the names and addresses of the
//   sender and recipients, the subject, Gmail's short snippet, whether it has
//   attachments and their names (never the files), the ids of the players it
//   names, and the records it is linked to.
// The body text is NOT kept: the subject, the snippet and a link that opens
// the message in Gmail answer "what did we last write" without a second copy
// of the agency's correspondence in the database.
//
// Matching: a contact by its address; a club by the contact's club or by its
// domain; a deal when the mail is with a contact or the club of the deal AND
// names the deal's player (Latin or Hebrew spelling, the calendar sync's
// sound matching), open deals before closed ones. Otherwise the message stays
// on the club and contact only.
//
// A wrong link is corrected by hand (override): moved to another deal, taken
// off a deal, or marked "not agency mail" (hidden: its content is dropped and
// only the id stays, so the sync never brings it back). The sync recomputes
// only the automatic links (auto); the correction always wins.
//
// Storage: mail_messages/{gmailId} and mail_state/sync, both read and written
// only by functions (admin SDK); the browser never reads them directly.
const crypto = require('crypto');
const { clubKey, playerName, normalizeEmail, normalizeMailDomain, isFreeMailDomain, emailDomainOf, addressInDomain } = require('@goldas/domain');
const { normName, wordVariants, nearWord } = require('./gcal-sync.js');
const auth = require('./gmail-auth.js');

const MESSAGES = 'mail_messages';
const STATE = ['mail_state', 'sync'];
const FIRST_DAYS = 90;              // a first connection (or a newly added address) reads back this far
const MAX_FETCH = 300;              // full messages read in one run; the rest wait for the next
const TERMS_PER_QUERY = 20;         // addresses and domains in one Gmail search
const MAX_LIST_PAGES = 20;          // 100 ids a page
const SUBJECT_MAX = 300;
const SNIPPET_MAX = 300;
const ATTACH_MAX = 20;
const NAME_MAX = 120;
const SCAN_CHARS = 6000;            // of the body, read in memory for player names, never stored
const DAY = 864e5;

const live = (x) => x && !x.deletedAt;
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const uniq = (a) => [...new Set(a.filter(Boolean))];
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24);

// ── the address book ────────────────────────────────────────────────────────

/** The key a deal's player is known by: the player id, or the name when the deal has none. */
const whoOf = (deal) => deal.playerId || `n:${normName(deal.playerName)}`;

/**
 * Everything the matching needs, built from the CRM's records.
 *   own   the mailbox's own address (never a match by itself)
 */
function buildBook({ contacts = [], clubs = [], deals = [], players = [], own = '' }) {
  const ownAddr = normalizeEmail(own);
  const ownDomain = emailDomainOf(ownAddr);
  const clubRows = clubs.filter(live);
  const clubById = new Map(clubRows.map((c) => [c.id, c]));
  const clubByKey = new Map();
  for (const c of clubRows) {
    for (const n of [c.key, c.name, ...(c.aliases || [])]) {
      const k = clubKey(n);
      if (k && !clubByKey.has(k)) clubByKey.set(k, c.id);
    }
  }
  const clubOf = (id, name) => (id && clubById.has(id) ? id : clubByKey.get(clubKey(name)) || null);

  const emails = new Map();          // address → [{ contactId, clubId }]
  for (const c of contacts.filter(live)) {
    const e = normalizeEmail(c.contactEmail);
    if (!e || e === ownAddr) continue;
    if (!emails.has(e)) emails.set(e, []);
    emails.get(e).push({ contactId: c.id, clubId: clubOf(c.clubId, c.clubName) });
  }
  const domains = new Map();         // domain → [clubId]
  for (const c of clubRows) {
    const d = normalizeMailDomain(c.emailDomain);
    // A free mail domain is never a club's, and the agency's own domain would match every message.
    if (!d || isFreeMailDomain(d) || (ownDomain && (ownDomain === d || ownDomain.endsWith(`.${d}`)))) continue;
    if (!domains.has(d)) domains.set(d, []);
    domains.get(d).push(c.id);
  }
  const byPlayer = new Map(players.map((p) => [p.id, p]));
  const dealRows = deals.filter(live).map((d) => {
    const name = String(d.playerName || playerName(byPlayer.get(d.playerId) || {}) || '').trim();
    return { id: d.id, clubId: clubOf(d.clubId, d.clubName), who: whoOf({ playerId: d.playerId, playerName: name }), name, open: !d.closedAt };
  }).filter((d) => d.clubId && d.name);
  const targets = new Map();         // who → name, the players whose names are looked for
  for (const d of dealRows) if (!targets.has(d.who)) targets.set(d.who, d.name);
  const terms = [...emails.keys(), ...domains.keys()].sort();
  const hash = sha({ e: [...emails].sort(), d: [...domains].sort(), deals: dealRows.map((d) => [d.id, d.clubId, d.who, d.open]).sort() });
  return { own: ownAddr, emails, domains, deals: dealRows, targets, terms, hash };
}

/** The contacts and clubs a message is with (its participants other than the mailbox itself). */
function matchParticipants(addresses, book) {
  const contactIds = new Set();
  const clubIds = new Set();
  for (const a of uniq(addresses.map(normalizeEmail))) {
    if (a === book.own) continue;
    for (const hit of book.emails.get(a) || []) {
      contactIds.add(hit.contactId);
      if (hit.clubId) clubIds.add(hit.clubId);
    }
    for (const [d, ids] of book.domains) if (addressInDomain(a, d)) ids.forEach((id) => clubIds.add(id));
  }
  return { contactIds: [...contactIds].sort(), clubIds: [...clubIds].sort() };
}

/** Name words as sound skeletons, null when a word is too short to compare by sound. */
const nameForms = (name) => {
  const words = normName(name).split(' ').filter(Boolean).map(wordVariants);
  return words.length && words.every((forms) => forms.some((f) => f.length >= 2)) ? words : null;
};

// Hebrew glues one or two short words to the front of a name: ו (and), ה (the),
// ל (to), ב (in), מ (from), ש (that), כ (as): "לאסף", "ולאסף".
const HEBREW_PREFIX = new Set([...'והלבמשכ']);
/** The sound forms of one word of the text, with and without a Hebrew prefix. */
function textForms(w) {
  const chars = [...w];
  const out = [...wordVariants(w)];
  for (let cut = 1; cut <= 2 && chars.length - cut >= 2 && HEBREW_PREFIX.has(chars[cut - 1]); cut++) out.push(...wordVariants(chars.slice(cut).join('')));
  return [...new Set(out)];
}

/**
 * The players (by who key) a text names: the name as written (Latin, any
 * case), or every word of it in a row, in either order, sounding like the
 * name (so "אסף אקרמן" and "לאסף אקרמן" find Assaf Ackerman).
 */
function mentions(text, targets) {
  const flat = ` ${normName(text)} `;
  const words = flat.trim().split(' ').filter(Boolean);
  const forms = words.map(textForms);
  const near = (wf, nf) => wf.some((w) => nf.some((n) => nearWord(w, n)));
  const found = [];
  for (const [who, name] of targets) {
    const n = normName(name);
    if (n && flat.includes(` ${n} `)) { found.push(who); continue; }
    const nf = nameForms(name);
    if (!nf) continue;
    const k = nf.length;
    const orders = k > 1 ? [nf, [...nf].reverse()] : [nf];
    let hit = false;
    for (let i = 0; i + k <= words.length && !hit; i++) {
      hit = orders.some((o) => o.every((f, j) => near(forms[i + j], f)));
    }
    if (hit) found.push(who);
  }
  return found.sort();
}

/** The deals of a message: with one of its clubs and naming the deal's player; open ones first. */
function dealsFor(clubIds, who, book) {
  const clubs = new Set(clubIds);
  const names = new Set(who);
  const hits = book.deals.filter((d) => clubs.has(d.clubId) && names.has(d.who));
  const open = hits.filter((d) => d.open);
  return (open.length ? open : hits).map((d) => d.id).sort();
}

/** The automatic links of a stored or fresh message. */
function autoLinks(m, book) {
  const people = [m.from && m.from.email, ...(m.to || []).map((x) => x.email), ...(m.cc || []).map((x) => x.email)];
  const { contactIds, clubIds } = matchParticipants(people, book);
  return { contactIds, clubIds, dealIds: clubIds.length ? dealsFor(clubIds, m.mentions || [], book) : [] };
}

/** What the screens use: the automatic links with the hand correction applied. */
function effective(auto, override) {
  const a = auto || { contactIds: [], clubIds: [], dealIds: [] };
  if (override && override.hidden) return { contactIds: [], clubIds: [], dealIds: [] };
  const o = override || {};
  return {
    contactIds: a.contactIds || [],
    clubIds: uniq([...(a.clubIds || []), ...(o.clubIds || [])]).sort(),
    dealIds: Array.isArray(o.dealIds) ? uniq(o.dealIds).sort() : a.dealIds || [],
  };
}
const linked = (l) => l.contactIds.length + l.clubIds.length + l.dealIds.length > 0;

// ── reading one Gmail message ───────────────────────────────────────────────

/** "Dana Levi <dana@x.com>, \"Levi, Dana\" <d2@x.com>, bare@x.com" → [{ name, email }]. */
function parseAddressList(value) {
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of String(value || '')) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (ch === ',' && !quoted && !angle) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((part) => {
    const email = normalizeEmail(part);
    if (!email) return null;
    const lt = part.lastIndexOf('<');
    const name = (lt >= 0 ? part.slice(0, lt) : '').trim().replace(/^"|"$/g, '').trim().slice(0, NAME_MAX);
    return { name, email };
  }).filter(Boolean);
}

const b64 = (data) => Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const unescape = (s) => String(s || '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m);
const htmlText = (h) => unescape(String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));

/** The plain text of a message (in memory only) and the names of its attachments. */
function walkParts(payload) {
  const plain = [];
  const html = [];
  const files = [];
  const visit = (p) => {
    if (!p) return;
    if (p.filename) files.push(String(p.filename).slice(0, NAME_MAX));
    else if (p.mimeType === 'text/plain' && p.body && p.body.data) plain.push(b64(p.body.data));
    else if (p.mimeType === 'text/html' && p.body && p.body.data) html.push(b64(p.body.data));
    (p.parts || []).forEach(visit);
  };
  visit(payload);
  const text = plain.length ? plain.join('\n') : html.map(htmlText).join('\n');
  return { text: text.slice(0, SCAN_CHARS), files: files.slice(0, ATTACH_MAX), hasAttachments: files.length > 0 };
}

/** A Gmail message (format=full) → the fields that may be kept, plus the text to scan (not kept). */
function readMessage(msg) {
  const headers = new Map(((msg.payload && msg.payload.headers) || []).map((h) => [String(h.name || '').toLowerCase(), h.value]));
  const from = parseAddressList(headers.get('from'))[0] || null;
  const { text, files, hasAttachments } = walkParts(msg.payload);
  const subject = String(headers.get('subject') || '').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX);
  const at = Number(msg.internalDate) || Date.parse(headers.get('date') || '') || 0;
  return {
    fields: {
      gmailId: msg.id, threadId: msg.threadId || msg.id, at,
      from, to: parseAddressList(headers.get('to')), cc: parseAddressList(headers.get('cc')),
      subject, snippet: unescape(msg.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
      hasAttachments, attachments: files,
    },
    scan: `${subject}\n${text}`,
  };
}

/** The document kept for a matched message. */
function recordFor(fields, who, book, now) {
  const m = { ...fields, mentions: who };
  const auto = autoLinks(m, book);
  return { ...m, direction: fields.from && fields.from.email === book.own ? 'out' : 'in', auto, ...effective(auto, null), hidden: false, syncedAt: now };
}

// ── the sync ────────────────────────────────────────────────────────────────

/** Gmail searches for these addresses and domains since `afterMs`, a few terms at a time. */
function searches(terms, afterMs) {
  const out = [];
  for (let i = 0; i < terms.length; i += TERMS_PER_QUERY) {
    const chunk = terms.slice(i, i + TERMS_PER_QUERY);
    // Gmail reads {a b c} as "a OR b OR c".
    const any = chunk.map((t) => `from:${t} to:${t} cc:${t}`).join(' ');
    out.push(`{${any}} after:${Math.floor(afterMs / 1000)} -in:chats -in:drafts`);
  }
  return out;
}

async function listIds(get, q, into) {
  let pageToken = '';
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const qs = new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
    const r = await get(`messages?${qs}`);
    for (const m of r.messages || []) into.set(m.id, m.threadId || m.id);
    pageToken = r.nextPageToken || '';
    if (!pageToken) break;
  }
}

/** How many messages arrived since a history id (ids only, no content); null when that id is too old. */
async function addedSince(get, startHistoryId) {
  let pageToken = '';
  let added = 0;
  try {
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const qs = new URLSearchParams({ startHistoryId: String(startHistoryId), historyTypes: 'messageAdded', maxResults: '500', ...(pageToken ? { pageToken } : {}) });
      const r = await get(`history?${qs}`);
      for (const h of r.history || []) added += (h.messagesAdded || []).length;
      pageToken = r.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  return added;
}

async function loadRecords(db) {
  const [contacts, clubs, deals, players] = await Promise.all(['contacts', 'clubs', 'deals', 'players'].map((c) => db.collection(c).get().then(rows)));
  return { contacts, clubs, deals, players };
}

async function countLinked(db) {
  const q = db.collection(MESSAGES).where('hidden', '==', false);
  if (typeof q.count === 'function') return (await q.count().get()).data().count;
  return (await q.get()).docs.length;
}

/** Recompute the automatic links of every stored message; drop the ones that match nothing now. */
async function rematch(db, book, now) {
  const snap = await db.collection(MESSAGES).where('hidden', '==', false).get();
  let changed = 0;
  let dropped = 0;
  for (const d of snap.docs) {
    const m = d.data();
    const auto = autoLinks(m, book);
    const eff = effective(auto, m.override);
    if (!linked(eff)) { await d.ref.delete(); dropped += 1; continue; }
    if (sha([auto, eff]) !== sha([m.auto, { contactIds: m.contactIds, clubIds: m.clubIds, dealIds: m.dealIds }])) {
      await d.ref.set({ auto, ...eff, syncedAt: now }, { merge: true });
      changed += 1;
    }
  }
  return { changed, dropped };
}

/**
 * One sync run. Returns a small summary; throws on a real failure.
 *   enable()   switches the Gmail API on (the service account), tried at most once a day
 */
async function syncMailbox(db, { fetchImpl = fetch, now = Date.now(), job = { note() {} }, enable = null, firstDays = FIRST_DAYS, maxFetch = MAX_FETCH, env = process.env } = {}) {
  const pub = await auth.publicStatus(db);
  if (!pub.connected) return { skipped: 'not connected' };
  const token = await auth.accessToken(db, { env, fetchImpl, now });
  if (!token) return { skipped: 'no key' };
  const get = (path) => auth.gmailGet(token, path, fetchImpl);
  const stRef = db.collection(STATE[0]).doc(STATE[1]);
  const st = (await stRef.get()).data() || {};
  try {
    const profile = await get('profile');
    const own = String(profile.emailAddress || pub.address || '').toLowerCase();
    const book = buildBook({ ...(await loadRecords(db)), own });
    const counts = { emails: book.emails.size, domains: book.domains.size };
    const status = { address: own, api: { state: 'on', at: now }, book: counts, lastError: null };
    if (!book.terms.length) {
      // No address and no domain in the CRM: nothing is asked of Gmail at all.
      const r = st.bookHash && st.bookHash !== book.hash ? await rematch(db, book, now) : { changed: 0, dropped: 0 };
      await stRef.set({ terms: [], bookHash: book.hash, historyId: String(profile.historyId || ''), lastSyncAt: now, backlog: [] }, { merge: true });
      await auth.savePublic(db, { ...status, state: 'no_addresses', lastSyncAt: now, linkedCount: await countLinked(db) });
      job.note('no contact e-mail and no club domain in the CRM: nothing read');
      return { read: 0, stored: 0, ...r, terms: 0 };
    }

    const known = new Set(st.terms || []);
    const fresh = book.terms.filter((t) => !known.has(t));
    const kept = book.terms.filter((t) => known.has(t));
    const ids = new Map((st.backlog || []).map((b) => [b.id, b.threadId]));
    for (const q of searches(fresh, now - firstDays * DAY)) await listIds(get, q, ids);
    if (kept.length) {
      const added = st.historyId ? await addedSince(get, st.historyId) : null;
      // Something arrived since the last run (or the last point is too old to ask about):
      // search the known addresses over the days since then.
      if (added === null || added > 0) {
        const since = added === null ? Math.max(now - firstDays * DAY, (st.lastSyncAt || 0) - 7 * DAY) : (st.lastSyncAt || now) - 2 * DAY;
        for (const q of searches(kept, since)) await listIds(get, q, ids);
      }
    }

    const todo = [];
    for (const [id, threadId] of ids) {
      if (!(await db.collection(MESSAGES).doc(id).get()).exists) todo.push({ id, threadId });
    }
    const now1 = todo.slice(0, maxFetch);
    const backlog = todo.slice(maxFetch);
    let stored = 0;
    let skipped = 0;
    for (const { id } of now1) {
      let msg;
      try { msg = await get(`messages/${encodeURIComponent(id)}?format=full`); } catch (e) { if (e.status === 404) continue; throw e; }
      const { fields, scan } = readMessage(msg);
      const who = mentions(scan, book.targets);
      const rec = recordFor(fields, who, book, now);
      if (!linked(rec)) { skipped += 1; continue; }        // matches nothing: not kept
      await db.collection(MESSAGES).doc(id).set(rec);
      stored += 1;
    }
    const r = st.bookHash !== book.hash ? await rematch(db, book, now) : { changed: 0, dropped: 0 };
    await stRef.set({ terms: book.terms, bookHash: book.hash, historyId: String(profile.historyId || st.historyId || ''), lastSyncAt: now, backlog }, { merge: true });
    const linkedCount = await countLinked(db);
    await auth.savePublic(db, { ...status, state: 'ok', lastSyncAt: now, linkedCount, backlog: backlog.length });
    if (backlog.length) job.note(`${backlog.length} messages wait for the next run`);
    return { read: now1.length, stored, skipped, ...r, backlog: backlog.length, terms: book.terms.length, linked: linkedCount };
  } catch (e) {
    if (e instanceof auth.GmailError && e.apiOff) {
      const last = (pub.api && pub.api.triedAt) || 0;
      let api = { state: 'off', at: now, triedAt: last };
      if (enable && now - last > DAY) {
        const en = await enable();
        api = en.ok ? { state: 'switched_on', at: now, triedAt: now } : { state: 'off', at: now, triedAt: now, status: en.status, message: en.message };
        job.note(en.ok ? 'switched the Gmail API on by itself; the next run continues' : `could not switch the Gmail API on by itself: ${en.status} ${en.message}`);
      }
      await auth.savePublic(db, { state: 'needs_api', api, lastError: { at: now, message: 'The Gmail API is off on the Google project' } });
      return { blocked: 'needs_api' };
    }
    await auth.savePublic(db, { state: 'error', lastError: { at: now, message: String(e.message || e).slice(0, 240) } }).catch(() => {});
    throw e;
  }
}

// ── reading and correcting, for the screens and Golda ───────────────────────

const FIELD = { deal: 'dealIds', club: 'clubIds', contact: 'contactIds' };

/** The messages linked to one record, newest first. money=false leaves out mail linked to any deal. */
async function messagesFor(db, kind, id, { money = false } = {}) {
  if (!FIELD[kind] || !id) return [];
  const snap = await db.collection(MESSAGES).where(FIELD[kind], 'array-contains', String(id)).get();
  return rows(snap).filter((m) => !m.hidden && (money || !(m.dealIds || []).length)).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** A stored message as the browser gets it (no internal fields). */
const forScreen = (m) => ({
  id: m.id, threadId: m.threadId, at: m.at, direction: m.direction, from: m.from, to: m.to || [], cc: m.cc || [],
  subject: m.subject, snippet: m.snippet, hasAttachments: !!m.hasAttachments, attachments: m.attachments || [],
  dealIds: m.dealIds || [], clubIds: m.clubIds || [], contactIds: m.contactIds || [], corrected: !!m.override,
});

/** Messages grouped into threads, the thread with the newest message first. */
function threadsOf(messages, own = '') {
  const by = new Map();
  for (const m of messages) {
    if (!by.has(m.threadId)) by.set(m.threadId, []);
    by.get(m.threadId).push(forScreen(m));
  }
  return [...by.entries()].map(([threadId, list]) => {
    list.sort((a, b) => (b.at || 0) - (a.at || 0));
    // Each person once, by address, with a name when any message gave one.
    const named = new Map();
    for (const p of list.flatMap((m) => [m.from, ...m.to])) {
      if (p && p.email && p.email !== own && !named.get(p.email)) named.set(p.email, p.name || '');
    }
    const people = [...named].map(([email, name]) => name || email);
    return { threadId, subject: list[0].subject, lastAt: list[0].at, count: list.length, people: people.slice(0, 6), messages: list };
  }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

async function readOne(db, id) {
  const ref = db.collection(MESSAGES).doc(String(id || ''));
  const snap = await ref.get();
  if (!snap.exists) throw new Error('message not found');
  return { ref, m: snap.data() };
}

/** Put a message on these deals (and their clubs) by hand; an empty list takes it off every deal. */
async function setDeals(db, id, dealIds, { clubIds = [], by = '', now = Date.now() } = {}) {
  const { ref, m } = await readOne(db, id);
  if (m.hidden) throw new Error('message not found');
  const override = { ...(m.override || {}), dealIds: uniq(dealIds.map(String)), clubIds: uniq([...((m.override || {}).clubIds || []), ...clubIds.map(String)]), by, at: now };
  const eff = effective(m.auto, override);
  await ref.set({ override, ...eff }, { merge: true });
  return eff;
}

/** "Not agency mail": drop what was kept and remember only the id, so the sync never brings it back. */
async function hide(db, id, { by = '', now = Date.now() } = {}) {
  const { ref, m } = await readOne(db, id);
  await ref.set({ gmailId: m.gmailId || id, threadId: m.threadId || id, hidden: true, override: { hidden: true, by, at: now }, contactIds: [], clubIds: [], dealIds: [] });
  return { hidden: true };
}

/** Undo a hand correction: the automatic links again. */
async function resetLinks(db, id) {
  const { ref, m } = await readOne(db, id);
  if (m.hidden) throw new Error('this message was removed; it comes back only if it is marked again in Gmail');
  const eff = effective(m.auto, null);
  await ref.set({ override: null, ...eff }, { merge: true });
  return eff;
}

/** Disconnect: the key, every stored message and the sync's state are deleted. */
async function disconnect(db, { by = '', now = Date.now() } = {}) {
  await auth.forget(db);
  let deleted = 0;
  for (;;) {
    const snap = await db.collection(MESSAGES).limit(400).get();
    if (!snap.docs.length) break;
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
    deleted += snap.docs.length;
  }
  await db.collection(STATE[0]).doc(STATE[1]).delete();
  await db.collection(auth.PUBLIC[0]).doc(auth.PUBLIC[1]).set({ connected: false, disconnectedAt: now, disconnectedBy: by, linkedCount: 0 });
  return { deleted };
}

module.exports = {
  MESSAGES, STATE, FIRST_DAYS, MAX_FETCH,
  buildBook, matchParticipants, mentions, dealsFor, autoLinks, effective, parseAddressList, readMessage, recordFor, searches,
  syncMailbox, rematch, messagesFor, threadsOf, forScreen, setDeals, hide, resetLinks, disconnect, countLinked,
};
