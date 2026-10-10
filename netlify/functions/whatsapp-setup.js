// One-time WhatsApp wiring, called by hand after setup:
//   /.netlify/functions/whatsapp-setup?key=<WA_VERIFY_TOKEN>
//     &waba=<WhatsApp account id>   subscribe the app to that account (without
//                                   this Meta never sends messages to the webhook)
//     &phones=<WhatsApp account id> list the account's numbers and their status
//     &register=<phone_number_id>   register a newly verified number for the
//                                   Cloud API; its two-step PIN is created here
//                                   and kept only in Firestore (app_meta/whatsapp)
//   ?auto=1 (no key)               for each WhatsApp account in WA_WABA_IDS: subscribe
//                                   the app and register every verified number that
//                                   isn't registered yet. Idempotent, returns statuses
//                                   only, so it can be called from a public CI log.
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

const WABAS = () => (process.env.WA_WABA_IDS || '1564386882158483').split(',').map((x) => x.trim()).filter(isId);

async function register(phoneId) {
  const ref = getDb().collection('app_meta').doc('whatsapp');
  const saved = (await ref.get()).data() || {};
  const pin = saved.pins?.[phoneId] || String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await ref.set({ pins: { [phoneId]: pin } }, { merge: true });
  return graph(`${phoneId}/register`, 'POST', { messaging_product: 'whatsapp', pin });
}

const brief = (r) => ({ status: r.status, ...(r.body?.error ? { error: { code: r.body.error.code, message: r.body.error.message } } : { ok: true }) });

async function auto() {
  const out = [];
  for (const waba of WABAS()) {
    const row = { waba, subscribe: brief(await graph(`${waba}/subscribed_apps`, 'POST')) };
    const phones = await graph(`${waba}/phone_numbers?fields=id,display_phone_number,verified_name,name_status,code_verification_status,status,platform_type`);
    row.phones = phones.body?.data || brief(phones);
    if (Array.isArray(row.phones)) {
      for (const p of row.phones) {
        if (p.code_verification_status === 'VERIFIED' && p.status !== 'CONNECTED') p.register = brief(await register(p.id));
      }
    }
    out.push(row);
  }
  return out;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.auto && process.env.WA_TOKEN) {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ at: new Date().toISOString(), accounts: await auto() }, null, 2) };
  }
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
  if (isId(q.register)) out.register = await register(q.register);
  if (isId(q.waba)) {
    out.subscribe = await graph(`${q.waba}/subscribed_apps`, 'POST');
    out.subscribedApps = await graph(`${q.waba}/subscribed_apps`);
  }
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
