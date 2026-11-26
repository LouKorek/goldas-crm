// Finding the e-mail addresses of the CRM's contacts and the mail domains of
// its clubs, so the mail sync (lib/mail-store.js) has something to read for.
//
// Privacy is the rule here too. The server looks at the mail the mailbox SENT
// in the last year and asks Gmail for each message's recipients only: the To,
// Cc and Bcc headers and the date (format=metadata, with a field mask that
// leaves even Gmail's snippet out). It never asks for a body, a subject or a
// snippet. The names and addresses it sees are counted in memory and compared
// with the contact names in the CRM; the count itself is thrown away. Only a
// result that belongs to a contact or a club of the CRM is kept
// (mail_suggestions). A club's domain comes from the website already saved on
// the club, never from the mail.
//
// An address is saved by itself only on a full, unambiguous name match:
//   the contact's name has two words or more;
//   a recipient's name, as the mail wrote it, is the same name (case,
//     punctuation, Hebrew points, spaces and word order aside);
//   one contact has that name, and one address carries it;
//   the address is not the mailbox's own, not a no-reply or shared office
//     address, not already another contact's, and fits no other contact.
// Everything weaker waits as a suggestion with a short reason: a wrong address
// would put a stranger's mail on a contact. A club's domain is saved by itself
// when mail was sent to an address at the website's domain; otherwise it is a
// suggestion. Nothing is decided before the whole year has been read.
//
// What the owner dismissed, and an automatic value he removed, is remembered
// (the same document, state 'dismissed' / 'removed') and never offered or
// filled again for that record and value.
//
// Storage: mail_suggestions/{id} (functions only) and the search's own state
// in mail_state/sync.fill, the private document of the sync. The public
// document (app_meta/gmail) gets two numbers and nothing else. Logs and job
// notes hold counts only: never a name or an address.
const crypto = require('crypto');
const { clubKey, normalizeEmail, normalizeMailDomain, isFreeMailDomain, emailDomainOf, addressInDomain } = require('@goldas/domain');
const { wordVariants, nearWord } = require('./gcal-sync.js');
const { admin } = require('./firestore.js');
const store = require('./mail-store.js');
const auth = require('./gmail-auth.js');

const COL = 'mail_suggestions';
const DAY = 864e5;
const HOUR = 36e5;
const YEAR_DAYS = 365;
const MAX_CALLS = 1200;             // Gmail calls of one run (about a minute); the rest waits for the next run
const MAX_MS = 120000;              // and never longer than this
const PARALLEL = 4;                 // messages asked for at once
const PER_TARGET = 3;               // suggestions shown for one contact
const SEEN_MAX = 5000;
const NAME_MAX = 120;

const live = (x) => x && !x.deletedAt;
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const sha = (s, n = 24) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
const idOf = (kind, targetId, value) => sha(`${kind}|${targetId}|${value}`);

// ── names ───────────────────────────────────────────────────────────────────

const QUOTES = /['’‘`´׳״"“”]/g;
/** A name as comparable words: no case, punctuation, Latin accents, Hebrew points or extra spaces. */
function nameTokens(name) {
  const s = String(name || '').normalize('NFKD').replace(/־/g, ' ').replace(/[̀-֑ͯ-ׇ]/g, '')
    .toLowerCase().replace(QUOTES, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s ? s.split(' ') : [];
}
/** The same key for the same words in any order: "Levi, Dana" and "dana levi". */
const nameKey = (tokens) => [...tokens].sort().join(' ');

/** A name ready to compare: its words, their key, and how each word sounds. */
function shapeOf(raw) {
  const tokens = nameTokens(raw);
  const forms = tokens.map(wordVariants);
  return { raw, tokens, key: nameKey(tokens), set: new Set(tokens), forms, sound: forms.every((f) => f.some((x) => x.length >= 2)) };
}

/** Every word of the shorter name is a word of the longer one (two words at least). */
function contained(a, b) {
  const [small, big] = a.tokens.length <= b.tokens.length ? [a, b] : [b, a];
  return small.tokens.length >= 2 && small.tokens.length < big.tokens.length && small.tokens.every((w) => big.set.has(w));
}

/** Every word sounds like a different word of the other name ("דנה לוי" and "Dana Levy"). */
function soundsAlike(a, b) {
  if (a.tokens.length < 2 || a.tokens.length !== b.tokens.length || !a.sound || !b.sound) return false;
  const used = new Set();
  return a.forms.every((forms) => {
    const k = b.forms.findIndex((other, i) => !used.has(i) && forms.some((w) => other.some((o) => nearWord(w, o))));
    if (k < 0) return false;
    used.add(k);
    return true;
  });
}

const LATIN = /^[a-z]+$/;
const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p])));
/**
 * The local part of an address spells the name: "dana.levi", "levi_dana",
 * "danalevi" for Dana Levi, and by sound for a name written in Hebrew
 * ("dana.levi" for דנה לוי). Names of two or three words.
 */
function localSpells(addr, c) {
  if (c.tokens.length < 2 || c.tokens.length > 3) return false;
  if (!c.tokens.every((w) => LATIN.test(w))) return soundsAlike(addr.localShape, c);
  if (addr.localShape.tokens.length >= 2 && addr.localShape.key === c.key) return true;
  return permutations(c.tokens).some((p) => p.join('') === addr.flat);
}

// Words that say nothing about who a person is.
const GENERIC = new Set(['info', 'office', 'mail', 'email', 'admin', 'contact', 'club', 'team', 'the', 'and', 'football', 'soccer', 'sport', 'sports',
  'academy', 'manager', 'director', 'coach', 'scout', 'ceo', 'press', 'media', 'מועדון', 'כדורגל', 'מנהל', 'מאמן', 'משרד', 'סקאוט', 'מנכל']);
const distinctive = (w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w);

// ── addresses ───────────────────────────────────────────────────────────────

const SYSTEM_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|unsubscribe|auto[-_.]?reply|automated|robot|daemon)([-_.+].*)?$/;
const SYSTEM_DOMAINS = ['calendar.google.com', 'googlegroups.com', 'docs.google.com', 'noreply.github.com', 'reply.github.com'];
/** An address no person reads: no-reply, a bounce address, a calendar or a list. */
function isSystemAddress(email) {
  const e = normalizeEmail(email);
  if (!e) return true;
  const local = e.slice(0, e.lastIndexOf('@'));
  const domain = e.slice(e.lastIndexOf('@') + 1);
  return SYSTEM_LOCAL.test(local) || /no[-_.]?reply|do[-_.]?not[-_.]?reply/.test(local) || /^reply\+/.test(local) || local.length > 48
    || SYSTEM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const SHARED_LOCAL = new Set(['info', 'office', 'contact', 'contactus', 'admin', 'administration', 'hello', 'mail', 'email', 'sales', 'support', 'help', 'team',
  'secretary', 'secretariat', 'press', 'media', 'marketing', 'hr', 'jobs', 'careers', 'billing', 'accounts', 'accounting', 'finance', 'reception', 'general',
  'enquiries', 'inquiries', 'service', 'club', 'academy', 'tickets', 'shop', 'webmaster', 'main', 'misrad']);
/** An address several people read (info@, office@): never saved by itself. */
const isSharedMailbox = (email) => SHARED_LOCAL.has(String(email || '').split('@')[0]);

// ── a club's own website ────────────────────────────────────────────────────

// Hosts a club's "website" field often holds that are not the club's own.
const NOT_OWN_HOSTS = ['facebook.com', 'fb.com', 'fb.me', 'm.me', 'instagram.com', 'threads.net', 'x.com', 'twitter.com', 't.co', 'youtube.com', 'youtu.be',
  'tiktok.com', 'linkedin.com', 'snapchat.com', 'pinterest.com', 'vk.com', 'ok.ru', 'twitch.tv', 'wa.me', 'whatsapp.com', 't.me', 'telegram.me', 'telegram.org',
  'linktr.ee', 'linktree.com', 'beacons.ai', 'bio.link', 'lnk.bio', 'taplink.cc', 'carrd.co', 'bit.ly', 'tinyurl.com',
  'wikipedia.org', 'wikimedia.org', 'wikidata.org', 'football.org.il', 'one.co.il', 'sport5.co.il', 'sport1.co.il', 'walla.co.il', 'ynet.co.il',
  'sofascore.com', 'soccerway.com', 'fotmob.com', 'besoccer.com', 'zerozero.pt', 'playmakerstats.com', 'fbref.com', '365scores.com', 'livescore.com',
  'worldfootball.net', 'footballdatabase.eu', 'eurosport.com', 'espn.com', 'goal.com', 'wyscout.com', 'hudl.com', 'uefa.com', 'fifa.com',
  'google.com', 'goo.gl', 'apple.com', 'wix.com', 'wixsite.com', 'wordpress.com', 'blogspot.com', 'weebly.com', 'webflow.io', 'squarespace.com',
  'github.io', 'netlify.app', 'vercel.app'];
// The same sites under any country ending (transfermarkt.co.il, flashscore.de, …).
const NOT_OWN_BRANDS = new Set(['transfermarkt', 'flashscore', 'sofascore', 'facebook', 'instagram', 'google', 'wikipedia', 'youtube', 'tiktok', 'twitter', 'linkedin']);
const SITE_PREFIX = new Set(['www', 'www2', 'm', 'he', 'en', 'ar', 'ru', 'web', 'site', 'new', 'shop', 'store', 'tickets', 'app']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'muni', 'edu']);

const notOwnHost = (host) => NOT_OWN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || host.split('.').some((label) => NOT_OWN_BRANDS.has(label));

/** The mail domain a club's website points to ("https://www.club.co.il/he" → "club.co.il"), or "" when it is not the club's own site. */
function siteDomain(website) {
  let host = normalizeMailDomain(String(website || '').includes('@') ? '' : website);
  for (;;) {
    const labels = host.split('.');
    const rest = labels.slice(1);
    const stillDomain = rest.length >= 3 || (rest.length === 2 && !SECOND_LEVEL.has(rest[0]));
    if (!SITE_PREFIX.has(labels[0]) || !stillDomain) break;
    host = rest.join('.');
  }
  return host && !notOwnHost(host) && !isFreeMailDomain(host) ? host : '';
}

/** The clubs whose domain can be found: live, a website of their own, no e-mail domain yet, a host no other club has. → Map clubId → domain */
function clubTargets({ clubs = [], own = '' }) {
  const ownDomain = emailDomainOf(own);
  const liveClubs = clubs.filter(live);
  const users = new Map();           // domain → how many clubs point at it (website or saved domain)
  const count = (d) => { if (d) users.set(d, (users.get(d) || 0) + 1); };
  for (const c of liveClubs) {
    const site = siteDomain(c.website);
    const saved = normalizeMailDomain(c.emailDomain);
    count(site);
    if (saved !== site) count(saved);
  }
  const out = new Map();
  for (const c of liveClubs) {
    const d = siteDomain(c.website);
    if (!d || normalizeMailDomain(c.emailDomain) || users.get(d) > 1) continue;
    // The agency's own domain would match every message.
    if (ownDomain && (ownDomain === d || ownDomain.endsWith(`.${d}`))) continue;
    out.set(c.id, d);
  }
  return out;
}

// ── what the sent mail says ─────────────────────────────────────────────────

/** "=?UTF-8?B?…?=" in a header, as text. */
const decodeWords = (s) => String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (m, charset, enc, text) => {
  try {
    const bytes = enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch { return m; }
});
const cleanName = (n) => { const s = decodeWords(n).replace(/\s+/g, ' ').trim(); return !s || s.includes('@') ? '' : s.slice(0, NAME_MAX); };

/** A Gmail message (format=metadata) → when it was sent and who it went to. Reads the To, Cc, Bcc and Date headers only. */
function readRecipients(msg) {
  const people = [];
  let date = '';
  for (const h of (msg && msg.payload && msg.payload.headers) || []) {
    const name = String(h.name || '').toLowerCase();
    if (name === 'to' || name === 'cc' || name === 'bcc') people.push(...store.parseAddressList(h.value));
    else if (name === 'date') date = h.value;
  }
  return { id: msg && msg.id, at: Number(msg && msg.internalDate) || Date.parse(date || '') || 0, people };
}

/** Count one message's recipients: each address once, with the name it was written with. */
function addToTally(tally, rec) {
  const once = new Set();
  for (const p of rec.people || []) {
    const email = normalizeEmail(p.email);
    if (!email || once.has(email)) continue;
    once.add(email);
    let e = tally.get(email);
    if (!e) { e = { n: 0, last: 0, names: new Map() }; tally.set(email, e); }
    e.n += 1;
    e.last = Math.max(e.last, rec.at || 0);
    const name = cleanName(p.name);
    if (name) e.names.set(name, (e.names.get(name) || 0) + 1);
  }
  return tally;
}
/** address → { n, last, names: Map(name → times) } over a list of read messages. Lives in memory only. */
const tallyRecipients = (messages) => messages.reduce(addToTally, new Map());

// ── matching ────────────────────────────────────────────────────────────────

// How a recipient fits a contact, strongest first. Only 'exact' can be saved by itself.
const RANK = { exact: 0, one_word: 1, contained: 2, sounds_alike: 3, spelled: 4, club_domain: 5, website: 6 };
const REASON = { one_word: 'one_word_name', contained: 'name_contained', sounds_alike: 'name_sounds_alike', spelled: 'address_spells_name', club_domain: 'shared_word_club_domain' };

/** What identifies a contact as a target of the search: the record and its name as it is now. */
const contactMark = (c) => sha(`c|${c.id}|${nameKey(nameTokens(c.contactName))}`, 12);
const clubMark = (clubId, domain) => sha(`k|${clubId}|${domain}`, 12);

/** The contacts an address can be looked for: live, named, no address yet. */
function fillable(contacts) {
  return contacts.filter((c) => live(c) && !normalizeEmail(c.contactEmail)).map((c) => {
    return { ...shapeOf(c.contactName), id: c.id, clubId: c.clubId, clubName: c.clubName, mark: contactMark(c) };
  }).filter((c) => c.tokens.length);
}

/** The marks of everything the search looks for now (no names: hashes only). */
function targetMarks({ contacts = [], clubs = [], own = '' }) {
  return [...fillable(contacts).map((c) => c.mark), ...[...clubTargets({ clubs, own })].map(([id, d]) => clubMark(id, d))].sort();
}

/** The domains of the club a contact belongs to (its saved domain and its own website). */
function clubDomainsOf(clubs) {
  const liveClubs = clubs.filter(live);
  const byId = new Map(liveClubs.map((c) => [c.id, c]));
  const byKey = new Map();
  for (const c of liveClubs) for (const n of [c.key, c.name, ...(c.aliases || [])]) { const k = clubKey(n); if (k && !byKey.has(k)) byKey.set(k, c); }
  return (contact) => {
    const club = (contact.clubId && byId.get(contact.clubId)) || byKey.get(clubKey(contact.clubName));
    if (!club) return [];
    return [...new Set([normalizeMailDomain(club.emailDomain), siteDomain(club.website)].filter((d) => d && !isFreeMailDomain(d)))];
  };
}

/** A word of the contact's name is a word of the address or of the name it was written with (by sound, for a Hebrew name). */
const sharesWord = (addr, c) => c.tokens.some((w, i) => distinctive(w) && (addr.words.has(w) || (!LATIN.test(w) && c.forms[i].some((f) => f.length >= 2 && addr.sounds.has(f)))));

/** How one counted address fits one contact, or null. */
function fitOf(addr, c) {
  let best = null;
  for (const nm of addr.names) {
    const k = nm.key === c.key ? (c.tokens.length >= 2 ? 'exact' : 'one_word')
      : contained(nm, c) ? 'contained'
        : soundsAlike(nm, c) ? 'sounds_alike' : null;
    if (k && (!best || RANK[k] < RANK[best.match])) best = { match: k, seenName: nm.raw };
  }
  if (best) return best;
  const seenName = addr.names.length ? addr.names[0].raw : '';
  if (localSpells(addr, c)) return { match: 'spelled', seenName };
  if (c.domains.some((d) => addressInDomain(addr.email, d)) && sharesWord(addr, c)) return { match: 'club_domain', seenName };
  return null;
}

/**
 * What one count of recipients says about the CRM's records: every way an
 * address fits a contact that has no address yet, and for every club whose
 * domain can be found, how many addresses at its website's domain were written to.
 * → [{ kind, targetId, value, match, shared, mark, seenName, n, last }]
 */
function candidates({ tally, contacts = [], clubs = [], own = '' }) {
  const ownAddr = normalizeEmail(own);
  const domainsOf = clubDomainsOf(clubs);
  const targets = fillable(contacts).map((c) => ({ ...c, domains: domainsOf(c) }));
  const addrs = [];
  for (const [email, e] of tally) {
    if (email === ownAddr || isSystemAddress(email)) continue;
    const local = email.slice(0, email.lastIndexOf('@'));
    const names = [...e.names].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([raw]) => shapeOf(raw)).filter((n) => n.tokens.length);
    const parts = local.split(/[^a-z]+/).filter(Boolean);
    const words = new Set([...names.flatMap((n) => n.tokens), ...parts]);
    const sounds = new Set([...words].filter((w) => w.length >= 3).flatMap(wordVariants));
    addrs.push({ email, names, words, sounds, flat: parts.join(''), localShape: shapeOf(parts.join(' ')), n: e.n, last: e.last });
  }
  const out = [];
  for (const addr of addrs) {
    for (const c of targets) {
      const fit = fitOf(addr, c);
      if (fit) out.push({ kind: 'contact', targetId: c.id, value: addr.email, match: fit.match, shared: isSharedMailbox(addr.email), mark: c.mark, seenName: fit.seenName, n: addr.n, last: addr.last });
    }
  }
  for (const [clubId, domain] of clubTargets({ clubs, own })) {
    const hits = addrs.filter((a) => addressInDomain(a.email, domain));
    out.push({ kind: 'club', targetId: clubId, value: domain, match: 'website', shared: false, mark: clubMark(clubId, domain), seenName: '', n: hits.length, last: Math.max(0, ...hits.map((a) => a.last)) });
  }
  return out;
}

/**
 * What to do with everything found so far. `items` are the kept findings in
 * every state; only the undecided ones (pending, open) change.
 *   covered(mark)   whether the whole year was read for that target
 * → { fills: [{ id, kind, targetId, value, reason }], open: [{ id, reason }], hold: [id], drop: [id] }
 */
function decide({ items = [], contacts = [], clubs = [], own = '', covered = () => true }) {
  const out = { fills: [], open: [], hold: [], drop: [] };
  const ownAddr = normalizeEmail(own);
  const liveContacts = contacts.filter(live);
  const byId = new Map(liveContacts.map((c) => [c.id, c]));
  const keyOf = (c) => nameKey(nameTokens(c.contactName));
  const sameName = new Map();        // name → how many live contacts have it
  const users = new Map();           // address → the contacts that have it
  for (const c of liveContacts) {
    const k = keyOf(c);
    if (k) sameName.set(k, (sameName.get(k) || 0) + 1);
    const e = normalizeEmail(c.contactEmail);
    if (e) users.set(e, [...(users.get(e) || []), c.id]);
  }
  const current = (it) => { const c = byId.get(it.targetId); return c && it.mark === contactMark(c) ? c : null; };
  // Every address that carries a name in full, and every contact an address fits in full,
  // whatever was decided about it: a dismissed address still makes the name ambiguous.
  const carriers = new Map();        // name → addresses
  const fits = new Map();            // address → contacts
  for (const it of items) {
    const c = it.kind === 'contact' && it.match === 'exact' ? current(it) : null;
    if (!c) continue;
    const k = keyOf(c);
    carriers.set(k, (carriers.get(k) || new Set()).add(it.value));
    fits.set(it.value, (fits.get(it.value) || new Set()).add(c.id));
  }
  const undecided = items.filter((it) => it.state === 'pending' || it.state === 'open');

  const byTarget = new Map();
  for (const it of undecided.filter((x) => x.kind === 'contact')) {
    const c = current(it);
    if (!c || normalizeEmail(c.contactEmail) || it.value === ownAddr || isSystemAddress(it.value)) { out.drop.push(it.id); continue; }
    if (!covered(it.mark)) continue;
    let reason = REASON[it.match] || 'name_contained';
    let auto = false;
    if (it.match === 'exact') {
      const k = keyOf(c);
      if (sameName.get(k) > 1) reason = 'same_name_two_contacts';
      else if (carriers.get(k).size > 1) reason = 'same_name_two_addresses';
      else if ((users.get(it.value) || []).some((id) => id !== c.id)) reason = 'address_in_use';
      else if (fits.get(it.value).size > 1) reason = 'address_fits_two_contacts';
      else if (it.shared || isSharedMailbox(it.value)) reason = 'shared_mailbox';
      else { reason = 'full_name'; auto = true; }
    }
    byTarget.set(c.id, [...(byTarget.get(c.id) || []), { it, reason, auto }]);
  }
  for (const list of byTarget.values()) {
    const win = list.find((x) => x.auto);
    if (win) {
      out.fills.push({ id: win.it.id, kind: 'contact', targetId: win.it.targetId, value: win.it.value, reason: win.reason });
      for (const x of list) if (x !== win) out.drop.push(x.it.id);
      continue;
    }
    list.sort((a, b) => (RANK[a.it.match] - RANK[b.it.match]) || ((b.it.n || 0) - (a.it.n || 0)) || (a.it.value < b.it.value ? -1 : 1));
    list.forEach((x, i) => {
      if (i < PER_TARGET) { if (x.it.state !== 'open' || x.it.reason !== x.reason) out.open.push({ id: x.it.id, reason: x.reason }); } else if (x.it.state === 'open') out.hold.push(x.it.id);
    });
  }

  const clubDomains = clubTargets({ clubs, own });
  for (const it of undecided.filter((x) => x.kind === 'club')) {
    if (clubDomains.get(it.targetId) !== it.value) { out.drop.push(it.id); continue; }
    if (!covered(it.mark)) continue;
    if ((it.n || 0) >= 1) out.fills.push({ id: it.id, kind: 'club', targetId: it.targetId, value: it.value, reason: 'website_mail' });
    else if (it.state !== 'open' || it.reason !== 'website_only') out.open.push({ id: it.id, reason: 'website_only' });
  }
  return out;
}

// ── writing ─────────────────────────────────────────────────────────────────

const FIELD = {
  contact: { collection: 'contacts', field: 'contactEmail', source: 'mailbox', clean: normalizeEmail },
  club: { collection: 'clubs', field: 'emailDomain', source: 'website', clean: (v) => { const d = normalizeMailDomain(v); return d && !isFreeMailDomain(d) ? d : ''; } },
};
const SYSTEM = { email: 'mail-addresses', name: 'Mail address search' };

// The audit line names the record by id and the field: never the name or the address.
const audit = (db, { collection, docId, summary, by, via }) => db.collection('audit').add({
  action: 'update', collection, docId, fields: [FIELD[collection === 'clubs' ? 'club' : 'contact'].field], summary,
  by: by.email, byName: by.name, via, at: admin.firestore.FieldValue.serverTimestamp(), undone: false,
}).catch(() => console.error('[mail-addresses] audit write failed'));

/**
 * Save one found value on its record, with where it came from, and mark the
 * finding. Nothing is written when the record is gone, already has a value,
 * or the finding was decided meanwhile. → true when it was written.
 */
async function writeValue(db, id, { state, reason = null, by = SYSTEM, via = 'mail-addresses', from = ['pending', 'open'], now = Date.now() }) {
  const sRef = db.collection(COL).doc(id);
  const done = await db.runTransaction(async (tx) => {
    const s = await tx.get(sRef);
    const it = s.exists ? s.data() : null;
    const f = it && FIELD[it.kind];
    if (!f || !from.includes(it.state)) return null;
    const value = f.clean(it.value);
    const rRef = db.collection(f.collection).doc(String(it.targetId));
    const r = await tx.get(rRef);
    if (!value || !r.exists || !live(r.data()) || f.clean(r.data()[f.field])) return null;
    const stamp = admin.firestore.FieldValue.serverTimestamp();
    tx.update(rRef, { [f.field]: value, [`${f.field}Source`]: f.source, [`${f.field}FilledAt`]: now, updatedAt: stamp, lastEditedAt: stamp, lastEditedBy: by.email, lastEditedByName: by.name });
    tx.set(sRef, { state, ...(reason ? { reason } : {}), at: now, by: by.email }, { merge: true });
    return { collection: f.collection, docId: String(it.targetId) };
  });
  if (!done) return false;
  await audit(db, { ...done, summary: state === 'auto' ? 'E-mail address filled automatically from the sent mail search' : 'E-mail address suggestion approved', by, via });
  return true;
}

/** Add one run's findings to what is kept. A finding that was decided keeps its state. */
async function mergeFindings(db, found, { gen, full, now }) {
  const have = new Map((await db.collection(COL).get()).docs.map((d) => [d.id, d.data()]));
  for (const c of found) {
    const id = idOf(c.kind, c.targetId, c.value);
    const old = have.get(id);
    // A new reading of the whole year counts again from nothing; a look at new mail adds to the count.
    const again = !old || old.mark !== c.mark || (full && old.gen !== gen);
    const match = again || RANK[c.match] < RANK[old.match] ? c.match : old.match;
    const data = {
      kind: c.kind, targetId: String(c.targetId), value: c.value, match, shared: !!c.shared, mark: c.mark, gen: again ? gen : old.gen,
      seenName: (again || match !== old.match ? c.seenName : old.seenName) || c.seenName || '',
      n: (again ? 0 : old.n || 0) + c.n, lastSeenAt: Math.max(again ? 0 : old.lastSeenAt || 0, c.last || 0),
    };
    if (!old) await db.collection(COL).doc(id).set({ ...data, state: 'pending', reason: null, at: now });
    else if (c.n || again) await db.collection(COL).doc(id).set(data, { merge: true });
  }
}

async function loadRecords(db) {
  const [contacts, clubs] = await Promise.all(['contacts', 'clubs'].map((c) => db.collection(c).get().then(rows)));
  return { contacts, clubs };
}

/** Decide about everything kept and write what follows. → counts */
async function settle(db, { records, own, covered, now }) {
  const items = rows(await db.collection(COL).get());
  const plan = decide({ items, ...records, own, covered });
  const saved = { contacts: 0, clubs: 0 };
  for (const f of plan.fills) {
    if (await writeValue(db, f.id, { state: 'auto', reason: f.reason, now })) saved[f.kind === 'club' ? 'clubs' : 'contacts'] += 1;
  }
  for (const o of plan.open) await db.collection(COL).doc(o.id).set({ state: 'open', reason: o.reason, at: now }, { merge: true });
  for (const id of plan.hold) await db.collection(COL).doc(id).set({ state: 'pending' }, { merge: true });
  for (const id of plan.drop) await db.collection(COL).doc(id).delete();
  return { saved, suggested: plan.open.length, dropped: plan.drop.length };
}

// ── the search ──────────────────────────────────────────────────────────────

const stateRef = (db) => db.collection(store.STATE[0]).doc(store.STATE[1]);
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const META = 'format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Date&fields=id%2CinternalDate%2Cpayload%2Fheaders';

/**
 * One run of the search, called by the mail sync job before the sync itself.
 * A new pass over the sent mail starts at most once a day: the whole last
 * year the first time and whenever a new contact or club has nothing found
 * for it yet, otherwise only what was sent since the pass before. A pass that
 * did not finish within one run's share of Gmail calls goes on from where it
 * stopped (mail_state/sync.fill) in the next run. Values are saved and
 * suggestions opened only when a pass has finished.
 * The number of sent messages the last whole-year pass read is kept
 * (fill.yearTotal) through the daily passes that follow, so "the year held
 * nothing for these contacts" can be told from "the year was hardly read". A
 * year read before that number was kept is read once more, to have it.
 * Returns counts only.
 */
async function findAddresses(db, { fetchImpl = fetch, now = Date.now(), job = { note() {} }, env = process.env, maxCalls = MAX_CALLS, maxMs = MAX_MS, clock = Date.now } = {}) {
  const pub = await auth.publicStatus(db);
  if (!pub.connected) return { skipped: 'not connected' };
  if (pub.state === 'needs_api' || (pub.api && pub.api.state === 'off')) return { skipped: 'gmail api off' };
  const ref = stateRef(db);
  const prev = ((await ref.get()).data() || {}).fill || {};
  const running = !!prev.startedAt && !prev.doneAt;
  if (!running && prev.startedAt && now - prev.startedAt < DAY) return { skipped: 'once a day' };
  if (prev.failedAt && now - prev.failedAt < HOUR) return { skipped: 'waiting after a failure' };
  const token = await auth.accessToken(db, { env, fetchImpl, now });
  if (!token) return { skipped: 'no key' };
  let calls = 0;
  const get = (path) => { calls += 1; return auth.gmailGet(token, path, fetchImpl); };
  const apiOff = (e) => e instanceof auth.GmailError && e.apiOff;

  let own = normalizeEmail(pub.address);
  if (!own) {
    try { own = normalizeEmail((await get('profile')).emailAddress); } catch (e) { if (apiOff(e)) return { blocked: 'needs_api' }; throw e; }
  }
  const records = await loadRecords(db);
  const marks = targetMarks({ ...records, own });
  let fill = prev;
  if (!running) {
    const seen = new Set(prev.seen || []);
    const full = !prev.yearDoneAt || !isCount(prev.yearTotal) || marks.some((m) => !seen.has(m));
    fill = {
      gen: (prev.gen || 0) + (full ? 1 : 0), full, startedAt: now, from: full ? now - YEAR_DAYS * DAY : prev.startedAt, upTo: null, edge: [],
      doneAt: null, yearDoneAt: prev.yearDoneAt || null, seen: prev.seen || [], marks, failedAt: null,
      readTotal: 0, yearTotal: isCount(prev.yearTotal) ? prev.yearTotal : null,
    };
    if (!marks.length) {
      // Every contact has an address and no club is waiting for a domain: nothing to ask Gmail.
      await ref.set({ fill: { ...fill, doneAt: now, marks: [] } }, { merge: true });
      const counts = await saveCounts(db, records);
      return { skipped: 'nothing to look for', ...counts };
    }
  }

  // Sent mail of the pass's window, newest first, from where the last run stopped.
  const q = `after:${Math.floor(fill.from / 1000) - 1}${fill.upTo ? ` before:${Math.floor(fill.upTo / 1000) + 1}` : ''}`;
  const skip = new Set(fill.edge || []);
  const tally = new Map();
  const readAt = [];                 // [id, at] of what this run read
  const t0 = clock();
  const room = (n) => calls + n <= maxCalls && clock() - t0 <= maxMs;
  let done = false;
  let failed = null;
  let pageToken = '';
  try {
    paging: while (room(1)) {
      const qs = new URLSearchParams({ labelIds: 'SENT', q, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
      const page = await get(`messages?${qs}`);
      const ids = (page.messages || []).map((m) => m.id).filter((id) => id && !skip.has(id));
      for (let i = 0; i < ids.length;) {
        if (!room(1)) break paging;
        const chunk = ids.slice(i, i + Math.min(PARALLEL, maxCalls - calls));
        i += chunk.length;
        const got = await Promise.all(chunk.map((id) => get(`messages/${encodeURIComponent(id)}?${META}`).catch((e) => { if (e.status === 404) return null; throw e; })));
        for (const msg of got) {
          if (!msg) continue;
          const rec = readRecipients(msg);
          if (rec.at) readAt.push([rec.id, rec.at]);
          if (!rec.at || rec.at >= fill.from) addToTally(tally, rec);
        }
      }
      pageToken = page.nextPageToken || '';
      if (!pageToken) { done = true; break; }
    }
  } catch (e) {
    if (apiOff(e) && !readAt.length) return { blocked: 'needs_api' };
    failed = e;
  }

  const found = candidates({ tally, ...records, own });
  await mergeFindings(db, found, { gen: fill.gen, full: fill.full, now });
  if (readAt.length) {
    const upTo = Math.min(...readAt.map(([, at]) => at), fill.upTo || Infinity);
    const second = Math.floor(upTo / 1000);
    // The messages of the cursor's own second, so the next run does not read them twice.
    const edge = [...(second === Math.floor((fill.upTo || 0) / 1000) ? fill.edge || [] : []), ...readAt.filter(([, at]) => Math.floor(at / 1000) === second).map(([id]) => id)];
    fill = { ...fill, upTo, edge: [...new Set(edge)].slice(-200) };
  }
  // readTotal: how many sent messages this pass has read so far (a number for the status page, nothing else).
  const readTotal = (fill.readTotal || 0) + readAt.length;
  let settled = { saved: { contacts: 0, clubs: 0 }, suggested: 0, dropped: 0 };
  if (done) {
    const seen = fill.full ? [...new Set([...(fill.seen || []), ...(fill.marks || [])])].slice(-SEEN_MAX) : fill.seen || [];
    // yearTotal: what the pass over the whole year read; the daily passes after it leave it as it is.
    fill = { ...fill, doneAt: now, yearDoneAt: fill.full ? now : fill.yearDoneAt, yearTotal: fill.full ? readTotal : isCount(fill.yearTotal) ? fill.yearTotal : null, seen, edge: [] };
    const ok = new Set(seen);
    settled = await settle(db, { records, own, covered: (m) => ok.has(m), now });
  }
  fill = { ...fill, failedAt: failed ? now : null, lastRunAt: now, lastCalls: calls, readTotal };
  await ref.set({ fill }, { merge: true });
  const counts = await saveCounts(db);
  const out = { read: readAt.length, calls, found: found.filter((c) => c.kind === 'contact' || c.n).length, done, ...settled, ...counts, ...(failed ? { failed: failed.status || 'error' } : {}) };
  job.note(`address search: ${out.read} sent messages read (recipients only), ${settled.saved.contacts} contact addresses and ${settled.saved.clubs} club domains saved, ${counts.open} suggestions open${done ? '' : '; the rest of the year is read in the next runs'}${failed ? '; stopped early by a Gmail error' : ''}`);
  return out;
}

// ── for the screen ──────────────────────────────────────────────────────────

/** What was found, with the names for display: values saved by themselves that are still in place, and open suggestions. */
async function listFound(db, records = null) {
  const { contacts, clubs } = records || await loadRecords(db);
  const byId = { contact: new Map(contacts.filter(live).map((c) => [c.id, c])), club: new Map(clubs.filter(live).map((c) => [c.id, c])) };
  const items = rows(await db.collection(COL).get());
  const view = (it, r) => ({
    id: it.id, kind: it.kind, targetId: it.targetId, name: String((it.kind === 'club' ? r.name : r.contactName) || ''), club: it.kind === 'club' ? '' : String(r.clubName || ''),
    value: it.value, reason: it.reason || '', seenName: it.seenName || '', times: it.n || 0, lastSeenAt: it.lastSeenAt || null, at: it.at || null,
  });
  const filled = [];
  const suggestions = [];
  const clubDomains = clubTargets({ clubs, own: (await auth.publicStatus(db)).address || '' });
  // A suggestion is shown while it still fits its record: the same name, the same website.
  const fits = (it, r) => (it.kind === 'club' ? clubDomains.get(it.targetId) === it.value : it.mark === contactMark(r));
  for (const it of items) {
    const f = FIELD[it.kind];
    const r = f && byId[it.kind].get(it.targetId);
    if (!r) continue;
    const has = f.clean(r[f.field]);
    if (it.state === 'auto' && has === it.value) filled.push(view(it, r));
    if (it.state === 'open' && !has && fits(it, r)) suggestions.push(view(it, r));
  }
  const byName = (a, b) => a.name.localeCompare(b.name) || (a.value < b.value ? -1 : 1);
  const fill = ((await stateRef(db).get()).data() || {}).fill || {};
  return {
    filled: filled.sort(byName), suggestions: suggestions.sort(byName),
    search: { state: !fill.startedAt ? 'never' : fill.doneAt ? 'done' : 'running', readBackTo: fill.doneAt ? null : fill.upTo || null, lastRunAt: fill.lastRunAt || fill.doneAt || null, yearRead: !!fill.yearDoneAt,
      targets: (fill.marks || []).length, read: fill.readTotal || 0, yearTotal: isCount(fill.yearTotal) ? fill.yearTotal : null },
  };
}

/**
 * The numbers of the public document: values saved by themselves and still in place, open suggestions, and how
 * far the search got (its state, how many contacts and clubs it looks for, how many sent messages its current
 * pass has read, and how many the last pass over the whole year read), so "nothing found" can be told apart
 * from "nothing to look for" and "nothing read" without opening the screen.
 */
async function saveCounts(db, records = null) {
  const list = await listFound(db, records);
  const counts = { filled: list.filled.length, open: list.suggestions.length };
  const { state, targets, read, yearRead, yearTotal } = list.search;
  await auth.savePublic(db, { found: { ...counts, state, targets, read, yearRead, yearTotal } });
  return counts;
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const who = (by) => ({ email: String((by && by.email) || ''), name: String((by && by.name) || (by && by.email) || '') });

async function readFinding(db, id, states) {
  const snap = await db.collection(COL).doc(String(id || '')).get();
  const it = snap.exists ? snap.data() : null;
  if (!it || !states.includes(it.state)) throw fail('this suggestion is no longer waiting', 404);
  return it;
}

/** The other findings still waiting for the same record: it has a value now. */
async function dropOthers(db, it) {
  const snap = await db.collection(COL).where('targetId', '==', it.targetId).get();
  for (const d of snap.docs) {
    const x = d.data();
    if (x.kind === it.kind && (x.state === 'open' || x.state === 'pending')) await d.ref.delete();
  }
}

/** Approve one suggestion: the value is saved on its record. */
async function accept(db, id, { by, now = Date.now() } = {}) {
  const it = await readFinding(db, id, ['open']);
  if (!(await writeValue(db, String(id), { state: 'accepted', by: who(by), via: 'web', from: ['open'], now }))) throw fail('the record already has a value, or is no longer there', 409);
  await dropOthers(db, it);
  return { accepted: 1, ...(await saveCounts(db)) };
}

/**
 * Approve every suggestion that stands alone: one suggestion for its record,
 * a value suggested for no other record and used by none. The rest stay for a
 * decision one by one.
 */
async function acceptAll(db, { by, now = Date.now() } = {}) {
  const { suggestions } = await listFound(db);
  const perTarget = new Map();
  const perValue = new Map();
  for (const s of suggestions) {
    perTarget.set(`${s.kind}|${s.targetId}`, (perTarget.get(`${s.kind}|${s.targetId}`) || 0) + 1);
    perValue.set(`${s.kind}|${s.value}`, (perValue.get(`${s.kind}|${s.value}`) || 0) + 1);
  }
  const alone = (s) => perTarget.get(`${s.kind}|${s.targetId}`) === 1 && perValue.get(`${s.kind}|${s.value}`) === 1 && s.reason !== 'address_in_use';
  let accepted = 0;
  for (const s of suggestions.filter(alone)) {
    if (!(await writeValue(db, s.id, { state: 'accepted', by: who(by), via: 'web', from: ['open'], now }))) continue;
    accepted += 1;
    await dropOthers(db, s);
  }
  return { accepted, skipped: suggestions.length - accepted, ...(await saveCounts(db)) };
}

/** "Not this one": never offered again for that record. */
async function dismiss(db, id, { by, now = Date.now() } = {}) {
  await readFinding(db, id, ['open']);
  await db.collection(COL).doc(String(id)).set({ state: 'dismissed', at: now, by: who(by).email }, { merge: true });
  return { dismissed: 1, ...(await saveCounts(db)) };
}

/** Take back a value the search saved by itself: the field is emptied and the value is never filled or offered again for that record. */
async function undo(db, id, { by, now = Date.now() } = {}) {
  const it = await readFinding(db, id, ['auto']);
  const f = FIELD[it.kind];
  const user = who(by);
  const sRef = db.collection(COL).doc(String(id));
  const rRef = db.collection(f.collection).doc(String(it.targetId));
  const cleared = await db.runTransaction(async (tx) => {
    const r = await tx.get(rRef);
    const inPlace = r.exists && f.clean(r.data()[f.field]) === it.value;
    if (inPlace) {
      const stamp = admin.firestore.FieldValue.serverTimestamp();
      const gone = admin.firestore.FieldValue.delete();
      tx.update(rRef, { [f.field]: '', [`${f.field}Source`]: gone, [`${f.field}FilledAt`]: gone, updatedAt: stamp, lastEditedAt: stamp, lastEditedBy: user.email, lastEditedByName: user.name });
    }
    tx.set(sRef, { state: 'removed', at: now, by: user.email }, { merge: true });
    return inPlace;
  });
  if (cleared) await audit(db, { collection: f.collection, docId: String(it.targetId), summary: 'Automatically filled e-mail address removed', by: user, via: 'web' });
  return { removed: 1, cleared, ...(await saveCounts(db)) };
}

/** On disconnect: what was found and not decided goes; the owner's decisions stay. */
async function forgetUndecided(db) {
  const snap = await db.collection(COL).get();
  let deleted = 0;
  for (const d of snap.docs) {
    const s = d.data().state;
    if (s === 'pending' || s === 'open') { await d.ref.delete(); deleted += 1; }
  }
  await saveCounts(db);
  return { deleted };
}

module.exports = {
  COL, MAX_CALLS, YEAR_DAYS, PER_TARGET,
  nameTokens, nameKey, isSystemAddress, isSharedMailbox, siteDomain, clubTargets, readRecipients, tallyRecipients, candidates, decide, targetMarks, idOf,
  findAddresses, listFound, saveCounts, accept, acceptAll, dismiss, undo, forgetUndecided,
};
