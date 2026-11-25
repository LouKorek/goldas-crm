// The server's read-only key to the agency's Gmail mailbox.
//
// Lou allows it once in Google, like the YouTube channel: the same Google
// OAuth client (lib/youtube-auth.js, saved in System › YouTube) and the same
// return address, because that is the only one registered for the site. The
// state value tells the two apart: a Gmail sign-in's state starts "gmail-",
// and youtube-connect hands such a return to finish() here.
//
// The one permission asked for is gmail.readonly: read mail and its labels.
// The CRM never sends, deletes, labels or marks mail, and could not if it tried.
//
//   startUrl(db, email, {origin})  a one-time state + the Google consent address
//   finish(db, {code, state})      trades the code for tokens, seals the refresh
//                                  token into app_secrets/gmail; the public
//                                  summary (no secrets) goes to app_meta/gmail
//   accessToken(db)                a fresh access token, or null when not connected
//   forget(db)                     drops the stored key (disconnect)
//   enableGmailApi(svc)            switches the Gmail API on with the service account
//
// Tokens and the client secret never reach a browser and are never logged.
const crypto = require('crypto');
const { seal, unseal } = require('./seal.js');
const ytAuth = require('./youtube-auth.js');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const STATE_PREFIX = 'gmail-';
const STATE_TTL_MS = 15 * 60 * 1000;
const STATES = 'gmail_oauth_states';
const SECRETS = ['app_secrets', 'gmail'];        // server-only
const PUBLIC = ['app_meta', 'gmail'];            // status for the admin screen, no secrets

/** A Gmail sign-in's state, as youtube-connect sees it come back. */
const isGmailState = (state) => /^gmail-[a-f0-9]{48}$/.test(String(state || ''));

async function readSecrets(db) {
  const snap = await db.collection(SECRETS[0]).doc(SECRETS[1]).get();
  return snap.exists ? snap.data() || {} : {};
}

const savePublic = (db, data) => db.collection(PUBLIC[0]).doc(PUBLIC[1]).set(data, { merge: true });
async function publicStatus(db) {
  const snap = await db.collection(PUBLIC[0]).doc(PUBLIC[1]).get();
  return snap.exists ? snap.data() || {} : {};
}

/** Google consent address for one sign-in, with a single-use state. */
async function startUrl(db, email, { env = process.env, now = Date.now(), origin = null } = {}) {
  const c = await ytAuth.client(db, env);
  if (!c) throw new Error('the Google client is not set up yet (System › YouTube)');
  const state = STATE_PREFIX + crypto.randomBytes(24).toString('hex');
  const redirect = ytAuth.redirectUri(origin, env);
  await db.collection(STATES).doc(state).set({ email: String(email || ''), at: now, redirect });
  const qs = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirect, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
  });
  return `${AUTH}?${qs}`;
}

/** Spend a state: its record once, null ever after (or when stale / unknown). */
async function takeState(db, state, now = Date.now()) {
  if (!isGmailState(state)) return null;
  const ref = db.collection(STATES).doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.delete();
  const row = snap.data() || {};
  return now - (Number(row.at) || 0) < STATE_TTL_MS ? row : null;
}

async function postForm(url, form, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const err = new Error(`Google ${res.status}: ${body.error || ''} ${body.error_description || ''}`.trim().slice(0, 300));
    err.code = body.error || null;
    throw err;
  }
  return body;
}

/** A Gmail API error with what matters for deciding what to do next. */
class GmailError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason || ''; }
  /** The Gmail API is switched off on the Google project. */
  get apiOff() { return this.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(`${this.reason} ${this.message}`); }
}

/** GET one Gmail API path ("profile", "messages?q=…") with an access token. */
async function gmailGet(token, path, fetchImpl = fetch) {
  const res = await fetchImpl(`${GMAIL}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || (e.details && e.details[0] && e.details[0].reason) || e.status || '';
    throw new GmailError(res.status, `Gmail ${res.status}: ${String(e.message || '').slice(0, 240)}`, reason);
  }
  return body;
}

/** The code from Google's redirect → refresh token + the mailbox it reaches. */
async function finish(db, { code, state }, { env = process.env, fetchImpl = fetch, now = Date.now(), enable = null } = {}) {
  const who = await takeState(db, state, now);
  if (!who) throw new Error('the sign-in link expired; press the button again');
  if (!code) throw new Error('Google returned no code');
  const c = await ytAuth.client(db, env);
  if (!c) throw new Error('the Google client is not set up yet (System › YouTube)');
  const tok = await postForm(TOKEN, {
    code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: who.redirect || ytAuth.redirectUri(null, env), grant_type: 'authorization_code',
  }, fetchImpl);
  if (!tok.refresh_token) throw new Error('Google returned no lasting permission; press the button again');
  const granted = String(tok.scope || '').split(/\s+/).filter(Boolean);
  if (!granted.includes(SCOPE)) throw new Error('the permission to read mail was not ticked; press the button again and allow it');
  await db.collection(SECRETS[0]).doc(SECRETS[1]).set({ refreshToken: seal(tok.refresh_token), savedAt: now }, { merge: true });
  _cache = { token: tok.access_token, until: now + (Number(tok.expires_in) || 3600) * 1000 - 120000 };
  // The address of the mailbox. When the Gmail API is still off on the project,
  // the key is kept anyway and the sync reads the address once it is on.
  let address = null;
  let api = null;
  try {
    address = String((await gmailGet(tok.access_token, 'profile', fetchImpl)).emailAddress || '').toLowerCase() || null;
    api = { state: 'on', at: now };
  } catch (e) {
    if (!(e instanceof GmailError) || !e.apiOff) throw e;
    const en = enable ? await enable() : { ok: false, status: 0, message: 'not tried' };
    api = en.ok ? { state: 'switched_on', at: now } : { state: 'off', at: now, status: en.status, message: en.message };
  }
  const info = { connected: true, connectedAt: now, connectedBy: who.email || null, address, scope: SCOPE, api, lastError: null };
  await savePublic(db, info);
  return info;
}

let _cache = null;
/** A valid access token (refreshed when needed), or null when the mailbox is not connected. */
async function accessToken(db, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  if (_cache && now < _cache.until) return _cache.token;
  const s = await readSecrets(db);
  if (!s.refreshToken) return null;
  const c = await ytAuth.client(db, env);
  if (!c) return null;
  try {
    const tok = await postForm(TOKEN, {
      refresh_token: unseal(s.refreshToken), client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token',
    }, fetchImpl);
    _cache = { token: tok.access_token, until: now + (Number(tok.expires_in) || 3600) * 1000 - 120000 };
    return tok.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      await savePublic(db, { connected: false, lastError: { at: now, message: 'Google withdrew the permission; connect Gmail again' } }).catch(() => {});
    }
    throw e;
  }
}

/**
 * Drop the stored key. The permission itself is not revoked at Google: the
 * mailbox may be the same Google account as the YouTube channel, and revoking
 * the client's grant there would take YouTube's permission with it.
 */
async function forget(db) {
  _cache = null;
  await db.collection(SECRETS[0]).doc(SECRETS[1]).delete();
}

/** Switch the Gmail API on with the service account itself (works when its roles allow it). */
async function enableGmailApi(svc) {
  if (!svc || !svc.client_email || !svc.private_key) return { ok: false, status: 0, message: 'no service account' };
  const { JWT } = require('google-auth-library');
  const jwt = new JWT({ email: svc.client_email, key: svc.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  try {
    await jwt.request({ url: `https://serviceusage.googleapis.com/v1/projects/${svc.project_id || 'gold-as-crm'}/services/gmail.googleapis.com:enable`, method: 'POST', data: {} });
    return { ok: true };
  } catch (e) {
    const status = e.response ? e.response.status : 0;
    const message = e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message;
    return { ok: false, status, message: String(message || '').slice(0, 300) };
  }
}

/** The service account from the environment (never printed). */
const serviceAccount = (env = process.env) => { try { return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}'); } catch { return {}; } };

module.exports = {
  SCOPE, STATES, SECRETS, PUBLIC, isGmailState, startUrl, takeState, finish, accessToken, forget,
  gmailGet, GmailError, enableGmailApi, serviceAccount, savePublic, publicStatus,
  _resetCacheForTests: () => { _cache = null; },
};
