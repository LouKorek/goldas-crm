// The server's own key to Lou's YouTube channel.
//
// A service account cannot upload to a person's channel, so Lou allows the
// CRM once in Google and the server keeps the refresh token that comes back.
// From then on Golda uploads by herself, with no browser and no PC involved.
//
// Two levels of permission:
//   upload + view    upload videos, set covers, read the channel (the style)
//   + manage         also file the new video in a playlist. Google has no
//                    narrower permission for playlists than "manage your
//                    YouTube account", so it is asked for only when the admin
//                    chose it, and everything else works without it.
//
//   setClient(db, {clientId, clientSecret})  the Google OAuth web client of
//                            the gold-as-crm project (made once in the Cloud
//                            console); the secret is sealed (lib/seal.js)
//   startUrl(db, email, {origin, playlists})
//                            a one-time state + the Google consent address;
//                            the state remembers which address Google sends
//                            the browser back to (the site or a preview)
//   finish(db, {code,state}) trades the code for tokens, reads the channel,
//                            seals the refresh token into app_secrets/youtube;
//                            the public summary goes to app_meta/youtube
//   accessToken(db)          a fresh access token for the YouTube API, or null
//
// Tokens and the client secret never reach a browser and are never logged.
const crypto = require('crypto');
const { seal, unseal } = require('./seal.js');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',     // upload, set the cover
  'https://www.googleapis.com/auth/youtube.readonly',   // read the channel's videos (to learn the style)
];
const MANAGE = 'https://www.googleapis.com/auth/youtube';             // + add a video to a playlist
const MANAGE_ALSO = 'https://www.googleapis.com/auth/youtube.force-ssl';
const canUpload = (granted) => granted.includes(SCOPES[0]) || granted.includes(MANAGE) || granted.includes(MANAGE_ALSO);
const canManage = (granted) => granted.includes(MANAGE) || granted.includes(MANAGE_ALSO);
const STATE_TTL_MS = 15 * 60 * 1000;
const STATES = 'yt_oauth_states';
const SECRETS = ['app_secrets', 'youtube'];         // server-only
const PUBLIC = ['app_meta', 'youtube'];              // status for the admin screen, no secrets

const { siteUrl, isOurOrigin } = require('./site.js');
/** Where Google sends the browser back: on the given origin (the site or a preview), else the site. */
const redirectUri = (origin, env = process.env) => `${isOurOrigin(origin) ? String(origin).replace(/\/$/, '') : siteUrl(env)}/.netlify/functions/youtube-connect`;

async function readSecrets(db) {
  const snap = await db.collection(SECRETS[0]).doc(SECRETS[1]).get();
  return snap.exists ? snap.data() || {} : {};
}

/** The OAuth client: env vars win, else the one saved from the admin screen. */
async function client(db, env = process.env) {
  if (env.YT_CLIENT_ID && env.YT_CLIENT_SECRET) return { clientId: env.YT_CLIENT_ID, clientSecret: env.YT_CLIENT_SECRET };
  const s = await readSecrets(db);
  if (!s.clientId || !s.clientSecret) return null;
  return { clientId: s.clientId, clientSecret: unseal(s.clientSecret) };
}

const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

async function setClient(db, { clientId, clientSecret }, { now = Date.now() } = {}) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!CLIENT_ID_RE.test(id)) throw new Error('that is not a Google OAuth client id');
  if (secret.length < 10 || /\s/.test(secret)) throw new Error('that is not a Google OAuth client secret');
  await db.collection(SECRETS[0]).doc(SECRETS[1]).set({ clientId: id, clientSecret: seal(secret), clientSavedAt: now }, { merge: true });
  await savePublic(db, { clientReady: true, clientId: id, clientSavedAt: now });
  return { clientReady: true };
}

/** Google consent address for one sign-in, with a single-use state. */
async function startUrl(db, email, { env = process.env, now = Date.now(), origin = null, playlists = false } = {}) {
  const c = await client(db, env);
  if (!c) throw new Error('the Google client is not set up yet');
  const state = crypto.randomBytes(24).toString('hex');
  const redirect = redirectUri(origin, env);
  await db.collection(STATES).doc(state).set({ email: String(email || ''), at: now, redirect });
  const qs = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirect, response_type: 'code',
    scope: (playlists ? [...SCOPES, MANAGE] : SCOPES).join(' '), access_type: 'offline', prompt: 'consent',
    state,
  });
  return `${AUTH}?${qs}`;
}

/** Spend a state: its record once, null ever after (or when stale / unknown). */
async function takeState(db, state, now = Date.now()) {
  if (!/^[a-f0-9]{48}$/.test(state || '')) return null;
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

async function channelOf(accessTokenValue, fetchImpl) {
  const res = await fetchImpl(`${API}/channels?part=snippet,contentDetails,status&mine=true`, { headers: { Authorization: `Bearer ${accessTokenValue}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube ${res.status}: ${body.error?.message || ''}`.slice(0, 300));
  const ch = (body.items || [])[0];
  if (!ch) return null;
  return {
    id: ch.id,
    title: ch.snippet?.title || '',
    handle: ch.snippet?.customUrl || '',
    thumbnail: ch.snippet?.thumbnails?.default?.url || '',
    uploads: ch.contentDetails?.relatedPlaylists?.uploads || '',
    longUploads: ch.status?.longUploadsStatus || null,
  };
}

/** The code from Google's redirect → refresh token + the channel it reaches. */
async function finish(db, { code, state }, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const who = await takeState(db, state, now);
  if (!who) throw new Error('the sign-in link expired; press the button again');
  if (!code) throw new Error('Google returned no code');
  const c = await client(db, env);
  if (!c) throw new Error('the Google client is not set up yet');
  const tok = await postForm(TOKEN, {
    code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: who.redirect || redirectUri(null, env), grant_type: 'authorization_code',
  }, fetchImpl);
  if (!tok.refresh_token) throw new Error('Google returned no lasting permission; press the button again');
  const granted = String(tok.scope || '').split(/\s+/).filter(Boolean);
  if (!canUpload(granted)) throw new Error('the upload permission was not ticked; press the button again and allow everything');
  const channel = await channelOf(tok.access_token, fetchImpl);
  if (!channel) throw new Error('this Google account has no YouTube channel');
  await db.collection(SECRETS[0]).doc(SECRETS[1]).set({ refreshToken: seal(tok.refresh_token), savedAt: now }, { merge: true });
  const info = {
    connected: true, connectedAt: now, connectedBy: who.email || null,
    scopes: granted, playlistsAllowed: canManage(granted), channel, lastError: null,
  };
  await savePublic(db, info);
  _cache = { token: tok.access_token, until: now + (Number(tok.expires_in) || 3600) * 1000 - 120000 };
  return info;
}

let _cache = null;
/** A valid access token (refreshed when needed), or null when Lou has not connected. */
async function accessToken(db, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  if (_cache && now < _cache.until) return _cache.token;
  const s = await readSecrets(db);
  if (!s.refreshToken) return null;
  const c = await client(db, env);
  if (!c) return null;
  try {
    const tok = await postForm(TOKEN, {
      refresh_token: unseal(s.refreshToken), client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token',
    }, fetchImpl);
    _cache = { token: tok.access_token, until: now + (Number(tok.expires_in) || 3600) * 1000 - 120000 };
    return tok.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      await savePublic(db, { connected: false, lastError: { at: now, message: 'Google withdrew the permission; connect YouTube again' } }).catch(() => {});
    }
    throw e;
  }
}

const savePublic = (db, data) => db.collection(PUBLIC[0]).doc(PUBLIC[1]).set(data, { merge: true });
async function publicStatus(db) {
  const snap = await db.collection(PUBLIC[0]).doc(PUBLIC[1]).get();
  return snap.exists ? snap.data() || {} : {};
}

module.exports = {
  setClient, startUrl, finish, takeState, accessToken, savePublic, publicStatus, client, channelOf,
  SCOPES, MANAGE, canUpload, canManage, redirectUri, siteUrl, CLIENT_ID_RE,
  _resetCacheForTests: () => { _cache = null; },
};
