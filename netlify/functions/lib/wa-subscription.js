// Keeps Meta's webhook pointed at this site. The WhatsApp app's webhook
// callback is an app-level setting; after a production deploy this makes
// sure it is the production URL, so moving Golda from a preview to
// production needs nobody in the Meta dashboard.
//
// Uses the app access token (APP_ID|WA_APP_SECRET), which is what Meta's
// /{app-id}/subscriptions endpoint requires. Reads first, writes only when
// the callback differs. Never logs the verify token.
const GRAPH = 'https://graph.facebook.com/v21.0';
const APP_ID_DEFAULT = '1583709803467223';

async function ensureWebhookCallback(base, { fetchImpl = fetch, log = console.log } = {}) {
  const appId = (process.env.WA_APP_ID || APP_ID_DEFAULT).trim();
  const secret = (process.env.WA_APP_SECRET || '').trim();
  const verify = (process.env.WA_VERIFY_TOKEN || '').trim();
  if (!secret || !verify) return { skipped: 'WA_APP_SECRET or WA_VERIFY_TOKEN not set' };
  const token = `${appId}|${secret}`;
  const callback = `${base.replace(/\/$/, '')}/.netlify/functions/whatsapp-webhook`;

  const cur = await fetchImpl(`${GRAPH}/${appId}/subscriptions?access_token=${encodeURIComponent(token)}`);
  const curJson = await cur.json().catch(() => ({}));
  const wa = (curJson.data || []).find((s) => s.object === 'whatsapp_business_account');
  const fields = new Set((wa?.fields || []).map((f) => (typeof f === 'string' ? f : f.name)));
  if (wa && wa.callback_url === callback && wa.active !== false && fields.has('messages')) {
    return { unchanged: true, callback };
  }
  const body = new URLSearchParams({
    object: 'whatsapp_business_account', callback_url: callback, verify_token: verify,
    fields: 'messages', include_values: 'true', access_token: token,
  });
  const res = await fetchImpl(`${GRAPH}/${appId}/subscriptions`, { method: 'POST', body });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.success === false) {
    const msg = out.error?.message || `HTTP ${res.status}`;
    log(`[wa-subscription] update failed: ${msg}`);
    return { error: msg, callback, was: wa?.callback_url || null };
  }
  log(`[wa-subscription] callback set to ${callback}`);
  return { updated: true, callback, was: wa?.callback_url || null };
}

module.exports = { ensureWebhookCallback, APP_ID_DEFAULT };
