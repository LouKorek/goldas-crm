const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
const { withAuth, header, safeEqual } = require('../auth.js');

const ok = async () => ({ statusCode: 200, body: 'ok' });

test('header lookup is case-insensitive', () => {
  assert.equal(header({ headers: { 'X-Internal-Nonce': ' abc ' } }, 'x-internal-nonce'), 'abc');
  assert.equal(header({}, 'authorization'), '');
});

test('no credentials -> 401, never reaches the handler', async () => {
  let called = false;
  const h = withAuth({ action: 'read' }, async () => { called = true; return ok(); });
  const res = await h({ headers: {} }, {});
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('shared secret path: wrong secret 403, unset secret 503, right secret passes', async () => {
  const h = withAuth({ secrets: [{ header: 'x-sync-secret', env: 'TEST_SYNC_SECRET' }] }, ok);
  delete process.env.TEST_SYNC_SECRET;
  assert.equal((await h({ headers: { 'x-sync-secret': 'a' } }, {})).statusCode, 503);
  process.env.TEST_SYNC_SECRET = 'right';
  assert.equal((await h({ headers: { 'x-sync-secret': 'wrong' } }, {})).statusCode, 403);
  assert.equal((await h({ headers: { 'x-sync-secret': 'right' } }, {})).statusCode, 200);
});

test('malformed nonce is rejected without touching Firestore', async () => {
  const h = withAuth({ internal: true }, ok);
  const res = await h({ headers: { 'x-internal-nonce': 'not-a-nonce' } }, {});
  assert.equal(res.statusCode, 401);
});

test('safeEqual', () => {
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'b'), false);
  assert.equal(safeEqual('', ''), false);
});
