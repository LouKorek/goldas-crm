// Lou's one Facebook sign-in that gives the server its own key to Golda's
// WhatsApp account (lib/meta-auth.js), and the status of her move to her own
// number (lib/meta-onboard.js).
//
//   POST (signed-in admin)          → { url }: the Facebook dialog to open
//   GET  ?code=…&state=…            Facebook's redirect back: stores the key,
//                                   starts a move pass, sends the browser to
//                                   /admin/whatsapp?meta=ok|error
//   GET  ?status=1 (admin, or the   → the public status (no secrets)
//        x-sync-secret header)
const { withAuth, json, internalHeaders } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const metaAuth = require('./lib/meta-auth.js');

const site = () => process.env.URL || 'https://goldas-crm.netlify.app';
const back = (result, msg) => ({
  statusCode: 302,
  headers: { Location: `${site()}/admin/whatsapp?meta=${result}${msg ? `&reason=${encodeURIComponent(String(msg).slice(0, 160))}` : ''}`, 'Cache-Control': 'no-store' },
  body: '',
});

async function kickOnboard() {
  try {
    await fetch(`${site()}/.netlify/functions/ops-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('meta-connect')) },
      body: JSON.stringify({ task: 'meta-onboard' }),
    });
  } catch (e) { console.warn('[meta-connect] could not start a move pass:', e.message); }
}

const status = withAuth({ action: 'manage_settings', secrets: [{ header: 'x-sync-secret', env: 'CRM_SYNC_SECRET' }] }, async () => {
  const snap = await getDb().collection('app_meta').doc('metaConnect').get();
  const d = snap.data() || {};
  return json(200, { configured: !!metaAuth.configId(), ...d });
});

const start = withAuth({ action: 'manage_settings' }, async (event, ctx) => {
  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* none */ }
    const url = await metaAuth.startUrl(getDb(), ctx.auth.user.email, { config: body.config || null });
    return json(200, { url });
  } catch (e) { return json(503, { error: e.message }); }
});

exports.handler = async (event, context) => {
  const q = event.queryStringParameters || {};
  if (event.httpMethod === 'POST') return start(event, context);
  if (q.status) return status(event, context);
  if (q.error) return back('error', q.error_description || q.error);
  if (q.code || q.state) {
    try {
      await metaAuth.finish(getDb(), { code: q.code, state: q.state });
      console.log('[meta-connect] Meta key stored');
      await kickOnboard();
      return back('ok');
    } catch (e) {
      console.error('[meta-connect] sign-in failed:', e.message);
      await metaAuth.savePublic(getDb(), { lastError: { at: Date.now(), message: String(e.message).slice(0, 240) } }).catch(() => {});
      return back('error', e.message);
    }
  }
  return json(400, { error: 'nothing to do' });
};
