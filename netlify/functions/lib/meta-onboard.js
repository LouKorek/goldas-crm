// Moves Golda onto her own number (+972 55-295-9496) by itself, once Meta
// allows it — no browser, no one at a computer.
//
// Runs every hour from meta-onboard-cron (and right after Lou signs in with
// Facebook). With the server's management token (lib/meta-auth.js) it:
//   1. reads the account's review status and the number's status;
//   2. when the number is verified but not registered for the Cloud API,
//      registers it with a two-step PIN the server generates and keeps sealed
//      (Meta refuses while the account review is open: recorded, retried next hour);
//   3. once registered: subscribes our app to the account (webhook), creates
//      Golda's templates there, and switches Golda's default sending number
//      to it (app_meta/whatsapp.primaryPhoneId, read by lib/wa-api.js);
//   4. tells Lou on WhatsApp, once.
// Everything it saw goes to app_meta/metaConnect.onboard for the admin screen.
const crypto = require('crypto');
const auth = require('./meta-auth.js');

const GRAPH = 'https://graph.facebook.com/v21.0';

async function call(token, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GRAPH}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  const err = json.error ? { code: json.error.code || res.status, subcode: json.error.error_subcode || null, message: String(json.error.error_user_msg || json.error.message || '').slice(0, 240) } : null;
  return { ok: res.ok && !err, status: res.status, body: json, error: err };
}

const registered = (p) => p && (p.platform_type === 'CLOUD_API' || p.status === 'CONNECTED');

/**
 * One pass. deps: { fetchImpl, now, notify(text) → Promise, ensureTemplates(token) → Promise<summary>, log }
 * Returns the summary it stored.
 */
async function run(db, { fetchImpl = fetch, now = Date.now(), notify = null, ensureTemplates = null, log = console.log } = {}) {
  const pubRef = db.collection('app_meta').doc('metaConnect');
  const prev = ((await pubRef.get()).data() || {}).onboard || {};
  const token = await auth.getToken(db);
  const out = { checkedAt: now, phoneId: auth.REAL_PHONE, waba: auth.REAL_WABA, done: !!prev.done, doneAt: prev.doneAt || null, notifiedAt: prev.notifiedAt || null };
  if (!token) {
    out.stage = 'not_connected';
    await pubRef.set({ onboard: out }, { merge: true });
    return out;
  }

  const waba = await call(token, `${auth.REAL_WABA}?fields=name,account_review_status,business_verification_status`, { fetchImpl });
  out.account = waba.ok ? { review: waba.body.account_review_status || null, businessVerification: waba.body.business_verification_status || null } : { error: waba.error };
  const phone = await call(token, `${auth.REAL_PHONE}?fields=display_phone_number,verified_name,code_verification_status,name_status,status,platform_type,quality_rating`, { fetchImpl });
  out.phone = phone.ok ? {
    number: phone.body.display_phone_number || null, name: phone.body.verified_name || null,
    verification: phone.body.code_verification_status || null, nameStatus: phone.body.name_status || null,
    status: phone.body.status || null, platform: phone.body.platform_type || null, quality: phone.body.quality_rating || null,
  } : { error: phone.error };

  if (!phone.ok) {
    out.stage = 'error';
    out.lastError = phone.error;
    await pubRef.set({ onboard: out }, { merge: true });
    log(`[meta-onboard] cannot read the number: ${phone.error?.code} ${phone.error?.message}`);
    return out;
  }

  // 2. register
  if (!registered(phone.body)) {
    if (phone.body.code_verification_status !== 'VERIFIED') {
      out.stage = 'needs_code';   // the SMS code step was never finished
    } else {
      let pin = await auth.getSecret(db, 'pin');
      if (!pin) { pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); await auth.setSecret(db, 'pin', pin); }
      const reg = await call(token, `${auth.REAL_PHONE}/register`, { method: 'POST', body: { messaging_product: 'whatsapp', pin }, fetchImpl });
      out.register = reg.ok ? { ok: true, at: now } : { ok: false, at: now, error: reg.error };
      if (!reg.ok) {
        out.stage = 'waiting_for_meta';
        out.lastError = reg.error;
        await pubRef.set({ onboard: out }, { merge: true });
        log(`[meta-onboard] register refused: ${reg.error?.code} ${reg.error?.message}`);
        return out;
      }
      log('[meta-onboard] number registered for the Cloud API');
    }
    if (out.stage === 'needs_code') {
      await pubRef.set({ onboard: out }, { merge: true });
      return out;
    }
  }

  // 3. wire it up (idempotent; repeated every pass until done)
  const sub = await call(token, `${auth.REAL_WABA}/subscribed_apps`, { method: 'POST', fetchImpl });
  out.subscribed = sub.ok ? true : { error: sub.error };
  if (ensureTemplates) {
    try { out.templates = await ensureTemplates(token); } catch (e) { out.templates = { error: String(e.message).slice(0, 200) }; }
  }
  const waRef = db.collection('app_meta').doc('whatsapp');
  const wa = (await waRef.get()).data() || {};
  if (wa.primaryPhoneId !== auth.REAL_PHONE) {
    await waRef.set({ primaryPhoneId: auth.REAL_PHONE, primarySince: now, managedPhoneIds: [auth.REAL_PHONE] }, { merge: true });
    log(`[meta-onboard] Golda now sends from ${auth.REAL_PHONE}`);
  }
  out.stage = 'live';
  if (!out.done) { out.done = true; out.doneAt = now; }

  // 4. tell Lou, once
  if (!out.notifiedAt && notify) {
    try {
      await notify('גולדה עברה למספר שלה: 055-295-9496 ✅\nמעכשיו אני כותבת לך משם. כדאי לשמור אותו באנשי הקשר בשם "גולדה" ולשלוח לי שם הודעה אחת, ככה ההודעות שלי יגיעו בלי הגבלה.');
      out.notifiedAt = now;
    } catch (e) { out.notifyError = String(e.message).slice(0, 200); }
  }
  await pubRef.set({ onboard: out }, { merge: true });
  return out;
}

/** Hourly until Golda is live on her number; after that once a day is enough. */
async function shouldRun(db, now = Date.now()) {
  const o = ((await db.collection('app_meta').doc('metaConnect').get()).data() || {}).onboard || {};
  return !(o.done && o.notifiedAt && now - (o.checkedAt || 0) < 23 * 3600000);
}

/** run() with the real WhatsApp helpers: templates via lib/wa-templates.js,
 *  the note to Lou from the number she already talks to (WA_PHONE_ID). */
async function runWithDeps({ db = require('./firestore.js').getDb(), force = false } = {}) {
  if (!force && !(await shouldRun(db))) return { stage: 'live', skipped: 'checked today' };
  const { ensureTemplate } = require('./wa-templates.js');
  const { deliver } = require('./wa-outbox.js');
  const { digits } = require('./wa-api.js');
  const lou = digits((process.env.WA_ALLOWED_NUMBERS || '').split(',')[0].split(':')[0]);
  return run(db, {
    ensureTemplates: async (token) => {
      const t = await ensureTemplate(db, { metaToken: token });
      return Object.fromEntries(Object.entries(t.templates || {}).map(([n, x]) => [n, x.accounts?.[auth.REAL_WABA]?.status || 'unknown']));
    },
    notify: lou ? (text) => deliver(db, { to: lou, body: text, via: process.env.WA_PHONE_ID || null, kind: 'system' }) : null,
  });
}

module.exports = { run, runWithDeps, shouldRun, registered, _internal: { call } };
