// One-time WhatsApp wiring check, called by hand after setup:
//   /.netlify/functions/whatsapp-setup?key=<WA_VERIFY_TOKEN>&waba=<WhatsApp account id>
// Subscribes the app to the WhatsApp account (without this Meta never sends
// messages to the webhook) and reports what the token can see. Never returns
// the token itself.
const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(path, method = 'GET') {
  const res = await fetch(`${GRAPH}/${path}`, { method, headers: { authorization: `Bearer ${process.env.WA_TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (!process.env.WA_VERIFY_TOKEN || q.key !== process.env.WA_VERIFY_TOKEN) return { statusCode: 403, body: 'forbidden' };
  const out = {
    env: {
      WA_TOKEN: !!process.env.WA_TOKEN, WA_PHONE_ID: !!process.env.WA_PHONE_ID, WA_APP_SECRET: !!process.env.WA_APP_SECRET,
      WA_ALLOWED_NUMBERS: !!process.env.WA_ALLOWED_NUMBERS, ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    },
  };
  if (process.env.WA_TOKEN && process.env.WA_PHONE_ID) {
    out.phone = await graph(`${process.env.WA_PHONE_ID}?fields=display_phone_number,verified_name`);
  }
  if (process.env.WA_TOKEN && /^\d+$/.test(q.waba || '')) {
    out.subscribe = await graph(`${q.waba}/subscribed_apps`, 'POST');
    out.subscribedApps = await graph(`${q.waba}/subscribed_apps`);
  }
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
