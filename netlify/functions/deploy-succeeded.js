// Runs the matches sync right after a production deploy, so a fix to the
// sync is proven on real data within minutes instead of at the next 03:10
// cron — with nobody having to press anything.
//
// Netlify calls a function named deploy-succeeded on every successful
// deploy (it signs the event; outside callers can't reach it). Deploy
// previews are skipped, and so is any deploy within MIN_GAP_H of a run that
// finished complete, so a busy day of deploys can't spend the credits
// several times. A run that left players behind doesn't count: the next
// deploy picks up where it stopped.
//
// Two more things happen on a production deploy, before the sync:
//   1. pending data migrations start in the background (backup first), so a
//      model change ships with its data in one step and nobody presses anything;
//   2. Meta's webhook callback for Golda is pointed at production, and her
//      re-engagement template (lib/wa-templates.js) exists on the WhatsApp accounts.
//
// Same hand-off as sync-matches-cron: a single-use internal nonce, then an
// HTTP call to the background worker. When Netlify's WEBHOOK_SECRET is set,
// the event's JWS signature is verified as well.

const crypto = require('crypto');
const { admin, getDb } = require('./lib/firestore.js');
const { internalHeaders } = require('./lib/auth.js');
const { ensureWebhookCallback } = require('./lib/wa-subscription.js');
const { ensureTemplate } = require('./lib/wa-templates.js');
const { ensureAuthorizedDomain } = require('./lib/auth-domains.js');
const { _startBackground: startMigrations } = require('./migrate.js');

const MIN_GAP_H = 20;
// Noam Barzilai is the player this pipeline was verified on; putting him
// first only changes the order, and costs nothing once he is synced. His
// record is in English, so both spellings.
const FIRST = 'Barzilai|ברזילי';

// Netlify signs event payloads with WEBHOOK_SECRET (HS256 JWS in
// X-Webhook-Signature). Optional: when the variable is set, bad signatures
// are refused; when it is not, Netlify itself keeps the function unreachable.
function signatureOk(event) {
  const secret = (process.env.WEBHOOK_SECRET || '').trim();
  if (!secret) return true;
  const h = event.headers || {};
  const sig = h['x-webhook-signature'] || h['X-Webhook-Signature'] || '';
  const [head, payload, mac] = sig.split('.');
  if (!head || !payload || !mac) return false;
  const expect = crypto.createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const bodyHash = crypto.createHash('sha256').update(event.body || '').digest('hex');
    return claims.iss === 'netlify' && (!claims.sha256 || claims.sha256 === bodyHash);
  } catch { return false; }
}

exports.handler = async (event) => {
  if (!signatureOk(event)) return { statusCode: 401, body: 'bad signature' };
  let payload = {};
  try { payload = JSON.parse(event.body || '{}').payload || {}; } catch { payload = {}; }
  if (payload.context && payload.context !== 'production') {
    // A preview or branch deploy only needs one thing: its own host made an
    // authorized domain for Firebase Auth, so Google sign-in works there and
    // a phase can be checked on real data before it goes live.
    const host = payload.deploy_ssl_url || payload.deploy_url || payload.ssl_url || '';
    let note = 'no host';
    try {
      const r = await ensureAuthorizedDomain(host);
      note = r.added ? `added ${host}` : r.unchanged ? 'already authorized' : r.error ? `error: ${r.error}` : JSON.stringify(r);
    } catch (e) { note = `failed: ${e.message}`; }
    console.log(`[deploy-succeeded] ${payload.context}: auth domain ${note}`);
    return { statusCode: 200, body: `skipped: ${payload.context}; auth domain ${note}` };
  }

  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  const notes = [];
  try {
    const m = await startMigrations('deploy-succeeded');
    notes.push(`migrations: ${m.ok ? 'started' : `not started (${m.status})`}`);
  } catch (e) {
    console.error('[deploy-succeeded] migrations failed:', e);
    notes.push(`migrations failed: ${e.message}`);
  }
  try {
    const w = await ensureWebhookCallback(base);
    notes.push(`webhook: ${w.updated ? 'updated' : w.unchanged ? 'unchanged' : w.skipped ? `skipped (${w.skipped})` : `error (${w.error})`}`);
  } catch (e) {
    console.error('[deploy-succeeded] webhook update failed:', e);
    notes.push(`webhook failed: ${e.message}`);
  }
  const db = getDb();
  try {
    const t = await ensureTemplate(db);
    notes.push(`template: ${t.skipped ? `skipped (${t.skipped})` : Object.entries(t.accounts).map(([w, a]) => `${w.slice(-4)} ${a.status}`).join(', ')}`);
  } catch (e) {
    console.error('[deploy-succeeded] template check failed:', e);
    notes.push(`template failed: ${e.message}`);
  }
  console.log(`[deploy-succeeded] ${notes.join('; ')}`);

  // Count production deploys per month for the admin Quotas tab (each costs ~15 Netlify credits).
  try {
    const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
    await db.collection('app_meta').doc('deploys').set({ [month]: admin.firestore.FieldValue.increment(1), lastDeployAt: admin.firestore.FieldValue.serverTimestamp(), lastCommit: String(payload.commit_ref || '').slice(0, 10) }, { merge: true });
  } catch (e) { notes.push(`deploy count failed: ${e.message}`); }
  const status = (await db.collection('app_meta').doc('syncStatus').get()).data() || {};
  const finished = status.finishedAt?.toDate?.()?.getTime?.() || 0;
  const complete = status.lastResult && !status.lastResult.partial;
  if (complete && Date.now() - finished < MIN_GAP_H * 3600000) {
    return { statusCode: 200, body: `${notes.join('; ')}; sync skipped: finished recently` };
  }

  const res = await fetch(`${base}/.netlify/functions/sync-matches-background?first=${encodeURIComponent(FIRST)}`, {
    method: 'POST',
    headers: await internalHeaders('deploy-succeeded'),
  });
  console.log(`[deploy-succeeded] sync triggered: ${res.status}`);
  return { statusCode: 200, body: `${notes.join('; ')}; sync triggered: ${res.status}` };
};
