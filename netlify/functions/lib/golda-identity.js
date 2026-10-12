// Who is talking to Golda. Every sender maps to a CRM user: first by the
// WhatsApp number saved on their app_users record (Team screen), then, for
// numbers not saved yet, through the legacy WA_ALLOWED_NUMBERS variable
// (digits with an optional name; an entry without a name is the owner).
// Golda acts in that user's name and with that user's permissions.
//
//   resolveSender(db, phone)   → { email, name, role, phone, channels, locale, briefingHour, source } | null
//   userForApp(user)           → the same shape for a signed-in app user (lib/auth.js resolveUser)
//   sessionKey(identity)       → the wa_sessions document the conversation lives in
const { OWNER_EMAIL } = require('./firestore.js');
const { normalizeRole } = require('@goldas/domain');

// International digits. A number saved the Israeli way (05x-...) is the same
// person Meta reports as 9725x..., so both spellings compare equal.
const digits = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.startsWith('0') && d.length === 10 ? `972${d.slice(1)}` : d; };

function legacyEntries(env = process.env.WA_ALLOWED_NUMBERS) {
  return String(env || '').split(',')
    .map((e) => { const [num, ...name] = e.split(':'); return { num: digits(num), name: name.join(':').trim() }; })
    .filter((e) => e.num);
}

const DEFAULT_PREFS = { channels: ['email'], locale: 'he', briefingHour: 7 };

function fromUser(u, phone) {
  const email = String(u.email || u.id || '').toLowerCase();
  const owner = email === OWNER_EMAIL;
  return {
    email, phone: digits(phone || u.whatsapp),
    name: u.name || (owner ? 'לו' : email),
    role: owner ? 'admin' : normalizeRole(u.role),
    active: u.active !== false,
    channels: Array.isArray(u.channels) ? u.channels : DEFAULT_PREFS.channels,
    locale: u.locale || DEFAULT_PREFS.locale,
    briefingHour: Number.isInteger(u.briefingHour) ? u.briefingHour : DEFAULT_PREFS.briefingHour,
  };
}

/** Pure part of resolveSender: match a phone against loaded users, then the env list. */
function matchSender(phone, users, env = process.env.WA_ALLOWED_NUMBERS) {
  const p = digits(phone);
  if (!p) return null;
  const u = users.find((x) => digits(x.whatsapp) === p);
  if (u) {
    const id = fromUser(u, p);
    return id.active ? { ...id, source: 'app_users' } : null;
  }
  const e = legacyEntries(env).find((x) => x.num === p);
  if (!e) return null;
  if (!e.name) {
    const owner = users.find((x) => String(x.email || x.id || '').toLowerCase() === OWNER_EMAIL) || { email: OWNER_EMAIL, name: 'לו' };
    return { ...fromUser({ ...owner, role: 'admin' }, p), source: 'env' };
  }
  // A named legacy entry: a team member whose number is not on their record
  // yet. Match by name when possible (so their email and role are real);
  // otherwise act as a manager under that name, like Golda always did.
  const byName = users.find((x) => x.active !== false && String(x.name || '').trim() === e.name);
  if (byName) return { ...fromUser(byName, p), source: 'env' };
  return { email: '', phone: p, name: e.name, role: 'manager', active: true, ...DEFAULT_PREFS, source: 'env' };
}

async function loadUsers(db) {
  const snap = await db.collection('app_users').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function resolveSender(db, phone) {
  return matchSender(phone, await loadUsers(db));
}

/** A signed-in app user (from withAuth) as a Golda identity; reads their record for prefs and number. */
async function userForApp(db, user) {
  const snap = await db.collection('app_users').doc(user.email).get();
  const rec = snap.exists ? { id: snap.id, ...snap.data() } : { email: user.email, name: user.name, role: user.role };
  const id = fromUser({ ...rec, role: user.role, name: rec.name || user.name }, rec.whatsapp);
  return { ...id, source: 'app' };
}

/** Every user who can be written to on WhatsApp right now. */
function whatsappRecipients(users) {
  return users.filter((u) => u.active !== false && digits(u.whatsapp) && (Array.isArray(u.channels) ? u.channels : []).includes('whatsapp'))
    .map((u) => fromUser(u));
}

/**
 * One conversation per person, whichever door they come through: a person
 * with a WhatsApp number continues the same chat in the app; one without a
 * number gets a chat keyed by email.
 */
const sessionKey = (identity) => (identity.phone ? identity.phone : `u_${String(identity.email || 'anon').replace(/[^a-z0-9]/gi, '_')}`);

module.exports = { resolveSender, matchSender, userForApp, whatsappRecipients, sessionKey, legacyEntries, digits, fromUser, DEFAULT_PREFS };
