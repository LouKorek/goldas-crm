// Who may drive the browser sync (ifa-targets, ifa-import-background).
// Two doors:
//   1. x-sync-secret = CRM_SYNC_SECRET (the original scheduled task on Lou's
//      computer carries the value in its prompt);
//   2. a signed-in CRM user whose role may run_sync (admin or manager), as a
//      Firebase ID token in Authorization: Bearer. The scheduled task's Chrome
//      is signed in to the CRM, so the task needs no secret at all this way.
const crypto = require('crypto');
const { resolveUser } = require('./auth.js');
const { can } = require('@goldas/domain');

async function checkSyncSecret(event) {
  const h = event.headers || {};
  const got = String(h['x-sync-secret'] || h['X-Sync-Secret'] || '').trim();
  if (got) {
    const want = (process.env.CRM_SYNC_SECRET || '').trim();
    if (!want) return { ok: false, statusCode: 503, error: 'CRM_SYNC_SECRET is not set on Netlify' };
    const a = Buffer.from(got), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, statusCode: 403, error: 'Wrong sync secret' };
    return { ok: true, via: 'secret' };
  }
  let user = null;
  try { user = await resolveUser(event); } catch { return { ok: false, statusCode: 401, error: 'Invalid token' }; }
  if (!user) return { ok: false, statusCode: 401, error: 'Sign in or x-sync-secret required' };
  if (!can(user.role, 'run_sync')) return { ok: false, statusCode: 403, error: 'Forbidden' };
  return { ok: true, via: 'user', user };
}

module.exports = { checkSyncSecret };
