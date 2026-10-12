// Google sign-in only works on hosts Firebase Auth lists as authorized
// domains. Production is listed; a Netlify deploy preview
// (deploy-preview-16--goldas-crm.netlify.app) is not, so nobody could log in
// to a preview to check a phase before it went live. Each preview deploy now
// adds its own host through the Identity Toolkit admin API, using the same
// service account the functions already hold, and removes stale preview hosts
// so the list does not grow forever.
const admin = require('firebase-admin');
const { getDb } = require('./firestore.js');

const API = 'https://identitytoolkit.googleapis.com/admin/v2/projects';
const PREVIEW_RE = /^[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/i;
const KEEP_PREVIEWS = 6;

async function credentials() {
  getDb();   // initialises the admin app from the functions' service account
  const app = admin.app();
  const { access_token: token } = await app.options.credential.getAccessToken();
  const projectId = app.options.projectId
    || JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}').project_id;
  return { token, projectId };
}

/**
 * Make `host` an authorized domain for Firebase Auth. Idempotent. Stale
 * preview hosts beyond the newest KEEP_PREVIEWS are dropped. Returns
 * { added, unchanged, removed, error }.
 */
async function ensureAuthorizedDomain(host, { fetchImpl = fetch } = {}) {
  host = String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!host) return { skipped: 'no host' };
  let token, projectId;
  try { ({ token, projectId } = await credentials()); } catch (e) { return { error: `credentials: ${e.message}` }; }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const got = await fetchImpl(`${API}/${projectId}/config`, { headers });
  if (!got.ok) return { error: `get ${got.status}: ${(await got.text()).slice(0, 200)}` };
  const cfg = await got.json();
  const current = cfg.authorizedDomains || [];
  const next = planDomains(current, host);
  if (next.join('|') === current.join('|')) return { unchanged: true, domains: current.length };
  const res = await fetchImpl(`${API}/${projectId}/config?updateMask=authorizedDomains`, {
    method: 'PATCH', headers, body: JSON.stringify({ authorizedDomains: next }),
  });
  if (!res.ok) return { error: `patch ${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { added: !current.includes(host), removed: current.filter((d) => !next.includes(d)), domains: next.length };
}

// Pure: the new list. Non-preview domains are untouched; previews keep the
// newest KEEP_PREVIEWS (by position, newest last) including the one added.
function planDomains(current, host) {
  const isPreview = (d) => PREVIEW_RE.test(d) && !/^main--/i.test(d);
  const fixed = current.filter((d) => !isPreview(d));
  const previews = current.filter((d) => isPreview(d) && d !== host);
  const kept = previews.slice(Math.max(0, previews.length - (KEEP_PREVIEWS - 1)));
  return [...fixed, ...kept, host];
}

module.exports = { ensureAuthorizedDomain, planDomains };
