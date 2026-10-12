// Every HTTP-reachable function goes through withAuth(). Two kinds of caller:
//
//   user      a signed-in CRM user: `Authorization: Bearer <Firebase ID token>`.
//             The token is verified with firebase-admin, the role comes from
//             app_users/{email} (the owner is always admin) and the required
//             action is checked with can() from the shared domain package.
//
//   internal  another function of this site (a cron, the WhatsApp webhook,
//             the deploy hook): `x-internal-nonce: <nonce>`. The caller first
//             writes a single-use nonce to Firestore with issueInternalNonce();
//             only code holding the service-account key can do that, so no
//             extra secret has to be configured anywhere.
//
// Usage:
//   exports.handler = withAuth({ action: 'run_sync', internal: true }, async (event, ctx) => {...});
//   ctx.user = { email, role, name } for user calls, ctx.internal = true for nonces.

const crypto = require('crypto');
const { admin, getDb, OWNER_EMAIL } = require('./firestore.js');
const { can, normalizeRole } = require('@goldas/domain');

const NONCE_TTL_MS = 10 * 60 * 1000;
const NONCES = 'internal_nonces';

const header = (event, name) => {
  const h = event.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? String(h[k] || '').trim() : '';
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

/** Issue a nonce another function of this site may spend once, within 10 minutes. */
async function issueInternalNonce(purpose) {
  const nonce = crypto.randomBytes(24).toString('hex');
  await getDb().collection(NONCES).doc(nonce).set({
    purpose: String(purpose || ''),
    issuedAt: admin.firestore.Timestamp.now(),
  });
  return nonce;
}

/** Spend a nonce: true once, false ever after (or when expired / unknown). */
async function consumeInternalNonce(nonce) {
  if (!/^[a-f0-9]{48}$/.test(nonce || '')) return false;
  const db = getDb();
  const ref = db.collection(NONCES).doc(nonce);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const issued = snap.data().issuedAt?.toMillis?.() || 0;
      tx.delete(ref);
      return Date.now() - issued < NONCE_TTL_MS;
    });
  } catch (e) {
    console.error('[auth] nonce check failed:', e.message);
    return false;
  }
}

/** Headers an internal caller sends along with its fetch(). */
async function internalHeaders(purpose) {
  return { 'x-internal-nonce': await issueInternalNonce(purpose) };
}

/** Resolve a Firebase ID token to { email, name, role } or null. */
async function resolveUser(event) {
  const auth = header(event, 'authorization');
  const token = auth.replace(/^Bearer /i, '').trim();
  if (!token) return null;
  getDb();
  const decoded = await admin.auth().verifyIdToken(token);
  const email = String(decoded.email || '').toLowerCase();
  if (!email) throw new Error('token without email');
  if (email === OWNER_EMAIL) return { email, name: decoded.name || 'Owner', role: 'admin' };
  const snap = await getDb().collection('app_users').doc(email).get();
  if (!snap.exists || snap.data().active === false) return { email, name: decoded.name || email, role: null };
  return { email, name: snap.data().name || decoded.name || email, role: normalizeRole(snap.data().role) };
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * opts.action    domain action the user must be allowed (default 'read')
 * opts.internal  accept x-internal-nonce from other functions (default false)
 * opts.secrets   optional list of { header, env } shared-secret pairs that are
 *                also accepted (e.g. the browser sync's x-sync-secret)
 */
function withAuth(opts, handler) {
  const { action = 'read', internal = false, secrets = [] } = opts || {};
  return async (event, context) => {
    const ctx = { user: null, internal: false, via: null };
    try {
      if (internal) {
        const nonce = header(event, 'x-internal-nonce');
        if (nonce) {
          if (!(await consumeInternalNonce(nonce))) return json(401, { error: 'Invalid or expired nonce' });
          ctx.internal = true; ctx.via = 'nonce';
          return handler(event, { ...context, auth: ctx });
        }
      }
      for (const s of secrets) {
        const got = header(event, s.header);
        if (!got) continue;
        const want = (process.env[s.env] || '').trim();
        if (!want) return json(503, { error: `${s.env} is not set on Netlify` });
        if (!safeEqual(got, want)) return json(403, { error: 'Wrong secret' });
        ctx.internal = true; ctx.via = s.env;
        return handler(event, { ...context, auth: ctx });
      }
      let user;
      try { user = await resolveUser(event); } catch (e) { return json(401, { error: 'Invalid token' }); }
      if (!user) return json(401, { error: 'Sign in required' });
      if (!user.role || !can(user.role, action)) return json(403, { error: 'Forbidden' });
      ctx.user = user; ctx.via = 'user';
      return handler(event, { ...context, auth: ctx });
    } catch (e) {
      console.error('[auth] handler failed:', e);
      return json(500, { error: 'Internal error' });
    }
  };
}

module.exports = { withAuth, issueInternalNonce, consumeInternalNonce, internalHeaders, resolveUser, header, json, safeEqual };
