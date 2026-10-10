// One-time WhatsApp wiring, called by hand after setup:
//   /.netlify/functions/whatsapp-setup?key=<WA_VERIFY_TOKEN>
//     &waba=<WhatsApp account id>   subscribe the app to that account (without
//                                   this Meta never sends messages to the webhook)
//     &phones=<WhatsApp account id> list the account's numbers and their status
//     &register=<phone_number_id>   register a newly verified number for the
//                                   Cloud API; its two-step PIN is created here
//                                   and kept only in Firestore (app_meta/whatsapp)
// Never returns the token or the PIN.
const crypto = require('crypto');
const admin = require('firebase-admin');
const GRAPH = 'https://graph.facebook.com/v21.0';

function getDb() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)) });
  return admin.firestore();
}

async function graph(path, method = 'GET', body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.WA_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const isId = (v) => /^\d+$/.test(v || '');

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (!process.env.WA_VERIFY_TOKEN || q.key !== process.env.WA_VERIFY_TOKEN) return { statusCode: 403, body: 'forbidden' };
  const out = {
    env: {
      WA_TOKEN: !!process.env.WA_TOKEN, WA_PHONE_ID: !!process.env.WA_PHONE_ID, WA_APP_SECRET: !!process.env.WA_APP_SECRET,
      WA_ALLOWED_NUMBERS: !!process.env.WA_ALLOWED_NUMBERS, ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    },
  };
  if (!process.env.WA_TOKEN) return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out, null, 2) };

  if (process.env.WA_PHONE_ID) out.phone = await graph(`${process.env.WA_PHONE_ID}?fields=display_phone_number,verified_name`);
  if (isId(q.phones)) {
    out.phones = await graph(`${q.phones}/phone_numbers?fields=id,display_phone_number,verified_name,name_status,code_verification_status,status,platform_type,quality_rating`);
  }
  if (isId(q.register)) {
    const ref = getDb().collection('app_meta').doc('whatsapp');
    const saved = (await ref.get()).data() || {};
    const pin = saved.pins?.[q.register] || String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await ref.set({ pins: { [q.register]: pin } }, { merge: true });
    out.register = await graph(`${q.register}/register`, 'POST', { messaging_product: 'whatsapp', pin });
  }
  if (isId(q.waba)) {
    out.subscribe = await graph(`${q.waba}/subscribed_apps`, 'POST');
    out.subscribedApps = await graph(`${q.waba}/subscribed_apps`);
  }
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
