// Shared secret for the browser sync (ifa-targets, ifa-import-background).
// The scheduled task on Lou's computer sends it in x-sync-secret; the value
// lives only in that task and in the CRM_SYNC_SECRET environment variable.
const crypto = require('crypto');

function checkSyncSecret(event) {
  const want = (process.env.CRM_SYNC_SECRET || '').trim();
  if (!want) return { ok: false, statusCode: 503, error: 'CRM_SYNC_SECRET is not set on Netlify' };
  const h = event.headers || {};
  const got = String(h['x-sync-secret'] || h['X-Sync-Secret'] || '').trim();
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, statusCode: 403, error: 'Wrong sync secret' };
  }
  return { ok: true };
}

module.exports = { checkSyncSecret };
