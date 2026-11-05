// The server's own Meta key (one Facebook sign-in) and Golda's move to her
// own number: what is stored, what is never stored in the clear, and what
// happens while Meta still reviews the account.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';

const metaAuth = require('../meta-auth.js');
const onboard = require('../meta-onboard.js');

function fakeDb(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  const col = (name) => ({
    doc(id) {
      return {
        id,
        async get() { const d = data[name]?.[id]; return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
        async set(v, o) { data[name] = data[name] || {}; data[name][id] = o?.merge ? { ...(data[name][id] || {}), ...v } : { ...v }; },
        async delete() { if (data[name]) delete data[name][id]; },
      };
    },
  });
  return { collection: col, _data: data };
}

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('startUrl: a single-use state and the configured dialog', async () => {
  const db = fakeDb();
  const url = new URL(await metaAuth.startUrl(db, 'lou@x', { env: { META_LOGIN_CONFIG_ID: '42', URL: 'https://site' }, now: 1000 }));
  assert.equal(url.searchParams.get('config_id'), '42');
  assert.equal(url.searchParams.get('client_id'), metaAuth.APP_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://site/.netlify/functions/meta-connect');
  const state = url.searchParams.get('state');
  assert.equal(db._data.meta_oauth_states[state].email, 'lou@x');
  assert.ok(await metaAuth.takeState(db, state, 2000));
  assert.equal(await metaAuth.takeState(db, state, 2000), null, 'spent');
});

test('finish: trades the code, stores the token sealed, publishes only a summary', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb({ meta_oauth_states: { ['a'.repeat(48)]: { email: 'lou@x', at: 0 } } });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/oauth/access_token')) return reply({ access_token: 'TOKEN-SECRET-123' });
    if (url.includes('/debug_token')) {
      return reply({ data: { type: 'SYSTEM_USER', expires_at: 0, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['1564386882158483'] }] } });
    }
    return reply({}, 404);
  };
  const info = await metaAuth.finish(db, { code: 'c', state: 'a'.repeat(48) }, { env: { WA_APP_SECRET: 's', URL: 'https://site' }, fetchImpl, now: 10 });
  assert.equal(info.canManage, true);
  assert.equal(info.reachesWaba, true, "Golda's account is among the key's targets");
  assert.equal(info.expiresAt, 0);
  const stored = JSON.stringify(db._data);
  assert.ok(!stored.includes('TOKEN-SECRET-123'), 'never in the clear');
  assert.ok(!JSON.stringify(db._data.app_meta).includes('enc:v1'), 'public doc has no token at all');
  metaAuth._resetCacheForTests();
  assert.equal(await metaAuth.getToken(db), 'TOKEN-SECRET-123');
  assert.ok(calls[0].includes('redirect_uri=https%3A%2F%2Fsite'));
});

test('finish: an expired or unknown state is refused before calling Meta', async () => {
  const db = fakeDb({ meta_oauth_states: { ['b'.repeat(48)]: { email: 'x', at: 0 } } });
  let called = false;
  await assert.rejects(metaAuth.finish(db, { code: 'c', state: 'b'.repeat(48) }, { env: { WA_APP_SECRET: 's' }, fetchImpl: async () => { called = true; }, now: 60 * 60 * 1000 }));
  assert.equal(called, false);
});

function metaFake({ registerError = null, phone = {} } = {}) {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url.replace('https://graph.facebook.com/v21.0/', '')}`);
    if (url.includes(`${metaAuth.REAL_WABA}?fields`)) return reply({ account_review_status: 'PENDING', business_verification_status: 'pending' });
    if (url.includes(`${metaAuth.REAL_PHONE}?fields`)) return reply({ display_phone_number: '+972 55-295-9496', code_verification_status: 'VERIFIED', status: 'PENDING', platform_type: 'NOT_APPLICABLE', ...phone });
    if (url.endsWith('/register')) return registerError ? reply({ error: registerError }, 400) : reply({ success: true });
    if (url.endsWith('/subscribed_apps')) return reply({ success: true });
    return reply({}, 404);
  };
  return { fetchImpl, seen };
}

test('onboard without the key: says so, calls nothing', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb();
  const { fetchImpl, seen } = metaFake();
  const r = await onboard.run(db, { fetchImpl, now: 1, log: () => {} });
  assert.equal(r.stage, 'not_connected');
  assert.equal(seen.length, 0);
});

test('onboard while Meta still reviews: register refused, nothing switched, PIN kept sealed for next time', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb();
  await metaAuth.setSecret(db, 'token', 'x');           // stored the way finish() stores it
  db._data.app_secrets.meta.token = require('../seal.js').seal('TOKEN');
  const { fetchImpl } = metaFake({ registerError: { code: 100, message: 'WhatsApp Business account not verified' } });
  const r = await onboard.run(db, { fetchImpl, now: 5, log: () => {} });
  assert.equal(r.stage, 'waiting_for_meta');
  assert.equal(r.lastError.code, 100);
  assert.equal(db._data.app_meta.whatsapp, undefined, 'Golda still sends from the old number');
  const pin1 = await metaAuth.getSecret(db, 'pin');
  assert.match(pin1, /^\d{6}$/);
  assert.ok(!JSON.stringify(db._data).includes(`"${pin1}"`), 'PIN never in the clear');
  await onboard.run(db, { fetchImpl, now: 6, log: () => {} });
  assert.equal(await metaAuth.getSecret(db, 'pin'), pin1, 'same PIN on every retry');
});

test('onboard once Meta allows: registers, wires up, switches Golda, tells Lou once', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb({ app_secrets: { meta: { token: require('../seal.js').seal('TOKEN') } } });
  const { fetchImpl, seen } = metaFake();
  const notes = [];
  const deps = { fetchImpl, log: () => {}, notify: async (t) => notes.push(t), ensureTemplates: async () => ({ golda_digest: 'PENDING' }) };
  const r = await onboard.run(db, { ...deps, now: 7 });
  assert.equal(r.stage, 'live');
  assert.ok(seen.some((s) => s.startsWith('POST') && s.endsWith('/register')));
  assert.equal(db._data.app_meta.whatsapp.primaryPhoneId, metaAuth.REAL_PHONE);
  assert.deepEqual(db._data.app_meta.whatsapp.managedPhoneIds, [metaAuth.REAL_PHONE]);
  assert.equal(notes.length, 1);
  // next pass: already registered → no second register, no second note
  const { fetchImpl: f2, seen: s2 } = metaFake({ phone: { status: 'CONNECTED', platform_type: 'CLOUD_API' } });
  await onboard.run(db, { ...deps, fetchImpl: f2, now: 8 });
  assert.ok(!s2.some((s) => s.endsWith('/register')));
  assert.equal(notes.length, 1);
  assert.equal(await onboard.shouldRun(db, 9), false, 'live and told: once a day is enough');
});

test('startUrl: the dialog can ask for a known configuration, never an unknown one', async () => {
  const db = fakeDb();
  const env = { URL: 'https://site' };
  const cfg = async (config) => new URL(await metaAuth.startUrl(db, 'lou@x', { env, config, now: 1 })).searchParams.get('config_id');
  assert.equal(await cfg(null), '828757043627753', 'default: WhatsApp Embedded Signup, which lets Lou pick the account');
  assert.equal(await cfg('2506080863235560'), '2506080863235560');
  assert.equal(await cfg('999'), '828757043627753');
  const es = new URL(await metaAuth.startUrl(db, 'lou@x', { env, now: 1 }));
  assert.deepEqual(JSON.parse(es.searchParams.get('extras')), { setup: {}, featureType: '', sessionInfoVersion: '3' }, 'Embedded Signup extras: pick the account, not coexistence');
  const general = new URL(await metaAuth.startUrl(db, 'lou@x', { env, config: '2506080863235560', now: 1 }));
  assert.equal(general.searchParams.get('extras'), null);
});

test('onboard with a key that cannot see the number: says so, touches nothing', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb({ app_secrets: { meta: { token: require('../seal.js').seal('TOKEN') } } });
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url}`);
    return reply({ error: { code: 100, message: "Unsupported get request. Object with ID '1410468102146516' does not exist" } }, 400);
  };
  const r = await onboard.run(db, { fetchImpl, now: 3, log: () => {} });
  assert.equal(r.stage, 'no_access');
  assert.ok(!seen.some((s) => s.startsWith('POST')));
  assert.equal(db._data.app_meta.whatsapp, undefined);
});

test('onboard while Meta hides the number (account not verified): waits, never asks to sign in again', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb({ app_secrets: { meta: { token: require('../seal.js').seal('TOKEN') } } });
  const seen = [];
  const notVerified = { code: 100, error_subcode: 2388001, message: 'Invalid parameter', error_user_msg: 'WhatsApp Business account not verified' };
  const fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url}`);
    if (url.includes(`${metaAuth.REAL_WABA}?fields`)) return reply({ account_review_status: 'PENDING', business_verification_status: 'pending' });
    return reply({ error: notVerified }, 400);
  };
  const r = await onboard.run(db, { fetchImpl, now: 4, log: () => {} });
  assert.equal(r.stage, 'waiting_for_meta');
  assert.equal(r.phoneError.code, 100);
  assert.ok(seen.some((s) => s.startsWith('POST') && s.endsWith('/register')), 'still tries to register');
  assert.equal(db._data.app_meta.whatsapp, undefined);
});
