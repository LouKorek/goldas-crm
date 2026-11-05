// The server's own key to Golda's WhatsApp account at Meta.
//
// WA_TOKEN (the "golda" system user) may send messages but not manage the
// account: reading the review status, registering a number, creating
// templates all answer (#200). Until now those steps ran from Lou's browser.
// Here Lou signs in once with Facebook ("Facebook Login for Business", a
// configuration on our own Meta app) and the server receives its own token:
//
//   startUrl(db, email)      a one-time state + the Facebook dialog address
//   finish(db, {code,state}) trades the code for a token (app secret, server
//                            side only), checks it with debug_token, seals it
//                            (lib/seal.js) and stores it in app_secrets/meta;
//                            the public summary goes to app_meta/metaConnect
//   getToken(db)             the unsealed token for other server code, or null
//
// The token is never returned to a browser and never logged.
const crypto = require('crypto');
const { seal, unseal } = require('./seal.js');

const GRAPH = 'https://graph.facebook.com/v21.0';
const DIALOG = 'https://www.facebook.com/v21.0/dialog/oauth';
const APP_ID = '1583709803467223';                 // Meta app "Gold A&S CRM" (public)
const REAL_WABA = '1564386882158483';              // "Golda - Gold AS"
const REAL_PHONE = '1410468102146516';             // +972 55-295-9496
// Facebook Login for Business configuration on that app (public id; the env
// var only overrides it). Asks for whatsapp_business_management + messaging.
const LOGIN_CONFIG_ID = '';
const STATE_TTL_MS = 15 * 60 * 1000;
const SECRETS = ['app_secrets', 'meta'];           // server-only (not readable by the web app)
const PUBLIC = ['app_meta', 'metaConnect'];         // status for the admin screen, no secrets

const siteUrl = (env = process.env) => env.URL || 'https://goldas-crm.netlify.app';
const redirectUri = (env = process.env) => `${siteUrl(env)}/.netlify/functions/meta-connect`;
const configId = (env = process.env) => String(env.META_LOGIN_CONFIG_ID || LOGIN_CONFIG_ID).trim();

/** Facebook dialog address for one sign-in, with a single-use state. */
async function startUrl(db, email, { env = process.env, now = Date.now() } = {}) {
  const cfg = configId(env);
  if (!cfg) throw new Error('the Facebook sign-in is not configured yet');
  const state = crypto.randomBytes(24).toString('hex');
  await db.collection('meta_oauth_states').doc(state).set({ email: String(email || ''), at: now });
  const qs = new URLSearchParams({
    client_id: APP_ID, redirect_uri: redirectUri(env), response_type: 'code',
    config_id: cfg, override_default_response_type: 'true', state,
  });
  return `${DIALOG}?${qs}`;
}

/** Spend a state: its record once, null ever after (or when stale / unknown). */
async function takeState(db, state, now = Date.now()) {
  if (!/^[a-f0-9]{48}$/.test(state || '')) return null;
  const ref = db.collection('meta_oauth_states').doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.delete();
  const row = snap.data() || {};
  return now - (Number(row.at) || 0) < STATE_TTL_MS ? row : null;
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new Error(`Meta ${res.status}: ${e.code || ''} ${e.message || ''}`.trim().slice(0, 300));
  }
  return body;
}

/** The code from Facebook's redirect → token + what Meta says it may do. */
async function finish(db, { code, state }, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const who = await takeState(db, state, now);
  if (!who) throw new Error('the sign-in link expired; press the button again');
  if (!code) throw new Error('Facebook returned no code');
  const secret = env.WA_APP_SECRET;
  if (!secret) throw new Error('WA_APP_SECRET is not set');
  const tok = await getJson(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    client_id: APP_ID, client_secret: secret, redirect_uri: redirectUri(env), code,
  })}`, fetchImpl);
  if (!tok.access_token) throw new Error('Meta returned no token');
  const dbg = await getJson(`${GRAPH}/debug_token?${new URLSearchParams({
    input_token: tok.access_token, access_token: `${APP_ID}|${secret}`,
  })}`, fetchImpl);
  const d = dbg.data || {};
  const scopes = d.scopes || [];
  const targets = {};
  for (const g of d.granular_scopes || []) targets[g.scope] = g.target_ids || [];
  const expiresAt = d.expires_at ? d.expires_at * 1000 : 0;   // 0 = never
  await db.collection(SECRETS[0]).doc(SECRETS[1]).set({ token: seal(tok.access_token), savedAt: now }, { merge: true });
  const info = {
    connected: true, connectedAt: now, connectedBy: who.email || null,
    tokenType: d.type || null, expiresAt, scopes, targets,
    canManage: scopes.includes('whatsapp_business_management'),
    canMessage: scopes.includes('whatsapp_business_messaging'),
    lastError: null,
  };
  await db.collection(PUBLIC[0]).doc(PUBLIC[1]).set(info, { merge: true });
  _cache = { token: tok.access_token, at: now };
  return info;
}

let _cache = null;
/** The server's management token (unsealed), or null when Lou has not signed in. */
async function getToken(db, { now = Date.now(), maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (_cache && now - _cache.at < maxAgeMs) return _cache.token;
  const snap = await db.collection(SECRETS[0]).doc(SECRETS[1]).get();
  const sealed = snap.exists ? snap.data().token : null;
  const token = sealed ? unseal(sealed) : null;
  _cache = { token, at: now };
  return token;
}

/** A stored secret value of our own (e.g. the number's two-step PIN), unsealed. */
async function getSecret(db, field) {
  const snap = await db.collection(SECRETS[0]).doc(SECRETS[1]).get();
  const v = snap.exists ? snap.data()[field] : null;
  return v ? unseal(v) : null;
}
async function setSecret(db, field, value) {
  await db.collection(SECRETS[0]).doc(SECRETS[1]).set({ [field]: seal(String(value)) }, { merge: true });
}

const savePublic = (db, data) => db.collection(PUBLIC[0]).doc(PUBLIC[1]).set(data, { merge: true });

module.exports = {
  startUrl, finish, takeState, getToken, getSecret, setSecret, savePublic,
  APP_ID, REAL_WABA, REAL_PHONE, redirectUri, configId,
  _resetCacheForTests: () => { _cache = null; },
};
