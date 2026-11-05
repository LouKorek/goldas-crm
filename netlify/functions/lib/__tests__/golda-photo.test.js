// Golda's WhatsApp profile photo: fetched small through our image CDN, sent
// to Meta in three calls, put once on each number she talks from.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';

const photo = require('../golda-photo.js');
const metaAuth = require('../meta-auth.js');
const onboard = require('../meta-onboard.js');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const img = (type = 'image/jpeg', size = 1000) => ({
  ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => new Uint8Array(size).buffer,
});

function graphFake({ cdn = img(), profileError = null } = {}) {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ method: opts.method || 'GET', url, opts });
    if (url.includes('/.netlify/images?')) return cdn;
    if (url.startsWith('https://d8j0ntlcm91z4.cloudfront.net/')) return img('image/png', 2000);
    if (url.includes('/uploads?')) return json({ id: 'upload:SESSION' });
    if (url.endsWith('/upload:SESSION')) return json({ h: 'HANDLE' });
    if (url.endsWith('/whatsapp_business_profile')) return profileError ? json({ error: profileError }, 400) : json({ success: true });
    return json({}, 404);
  };
  return { fetchImpl, seen };
}

test('setPhoto: 640px JPG from our image CDN, upload session, handle on the profile', async () => {
  const { fetchImpl, seen } = graphFake();
  const r = await photo.setPhoto('TOK', '123', { appId: 'APP', fetchImpl, env: { URL: 'https://site' }, now: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 1000);
  assert.match(seen[0].url, /^https:\/\/site\/\.netlify\/images\?url=https%3A%2F%2Fd8j0ntlcm91z4.*&w=640&h=640&fit=cover&fm=jpg/);
  const session = new URL(seen[1].url);
  assert.equal(session.pathname, '/v21.0/APP/uploads');
  assert.equal(session.searchParams.get('file_length'), '1000');
  assert.equal(session.searchParams.get('file_type'), 'image/jpeg');
  assert.equal(seen[2].opts.headers.file_offset, '0');
  assert.equal(seen[2].opts.headers.authorization, 'OAuth TOK');
  assert.equal(seen[2].opts.body.length, 1000);
  assert.deepEqual(JSON.parse(seen[3].opts.body), { messaging_product: 'whatsapp', profile_picture_handle: 'HANDLE' });
  assert.ok(seen[3].url.endsWith('/123/whatsapp_business_profile'));
});

test('setPhoto: CDN down → original file; Meta refusal → reported, never thrown', async () => {
  const { fetchImpl, seen } = graphFake({ cdn: { ok: false, status: 502, headers: { get: () => 'text/html' } }, profileError: { code: 100, message: 'not registered' } });
  const r = await photo.setPhoto('TOK', '123', { appId: 'APP', fetchImpl, env: { URL: 'https://site' }, now: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 100);
  assert.ok(seen.some((s) => s.url === photo.PHOTO_URL), 'fell back to the original');
  assert.equal(new URL(seen.find((s) => s.url.includes('/uploads?')).url).searchParams.get('file_type'), 'image/png');
});

test('setPhoto: an image over 5 MB is not sent', async () => {
  const big = img('image/jpeg', 6 * 1024 * 1024);
  const fetchImpl = async () => big;
  const r = await photo.setPhoto('TOK', '123', { appId: 'APP', fetchImpl, env: { URL: 'https://site' } });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /not reachable/);
});

function fakeDb(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    _data: data,
    collection: (name) => ({ doc: (id) => ({
      async get() { const d = data[name]?.[id]; return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
      async set(v, o) { data[name] = data[name] || {}; data[name][id] = o?.merge ? { ...(data[name][id] || {}), ...v } : { ...v }; },
    }) }),
  };
}

function metaFake({ registered = false } = {}) {
  return async (url) => {
    if (url.includes(`${metaAuth.REAL_WABA}?fields`)) return json({ account_review_status: 'PENDING' });
    if (url.includes(`${metaAuth.REAL_PHONE}?fields`)) return json({ code_verification_status: 'VERIFIED', ...(registered ? { platform_type: 'CLOUD_API', status: 'CONNECTED' } : { status: 'PENDING' }) });
    if (url.endsWith('/register')) return registered ? json({ success: true }) : json({ error: { code: 100, message: 'WhatsApp Business account not verified' } }, 400);
    if (url.endsWith('/subscribed_apps')) return json({ success: true });
    return json({}, 404);
  };
}

test('onboard: photo on today\'s number while Meta reviews, once; on her own number when live', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb({ app_secrets: { meta: { token: require('../seal.js').seal('TOKEN') } } });
  const calls = [];
  const setPhoto = async (token, phoneId) => { calls.push(phoneId); return { ok: true, url: photo.PHOTO_URL, at: 1 }; };
  const base = { log: () => {}, setPhoto, currentPhoneId: 'TEST_PHONE' };

  const r1 = await onboard.run(db, { ...base, fetchImpl: metaFake(), now: 1 });
  assert.equal(r1.stage, 'waiting_for_meta');
  assert.deepEqual(calls, ['TEST_PHONE'], 'not on the unregistered number');
  await onboard.run(db, { ...base, fetchImpl: metaFake(), now: 2 });
  assert.deepEqual(calls, ['TEST_PHONE'], 'not again');

  const r3 = await onboard.run(db, { ...base, fetchImpl: metaFake({ registered: true }), now: 3 });
  assert.equal(r3.stage, 'live');
  assert.deepEqual(calls, ['TEST_PHONE', metaAuth.REAL_PHONE]);
  assert.equal(db._data.app_meta.metaConnect.onboard.photo[metaAuth.REAL_PHONE].ok, true);
});

test('onboard: a failed photo is retried on the next pass', async () => {
  metaAuth._resetCacheForTests();
  const db = fakeDb({ app_secrets: { meta: { token: require('../seal.js').seal('TOKEN') } } });
  let n = 0;
  const setPhoto = async () => (++n === 1 ? { ok: false, url: photo.PHOTO_URL, error: { code: 200 } } : { ok: true, url: photo.PHOTO_URL });
  const base = { log: () => {}, setPhoto, currentPhoneId: 'TEST_PHONE', fetchImpl: metaFake() };
  await onboard.run(db, { ...base, now: 1 });
  await onboard.run(db, { ...base, now: 2 });
  await onboard.run(db, { ...base, now: 3 });
  assert.equal(n, 2);
});
