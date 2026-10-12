const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
const { seal, unseal, isSealed } = require('../seal.js');

test('seal/unseal round-trips and hides the plaintext', () => {
  const s = seal('IGQVJ-secret-token');
  assert.ok(isSealed(s));
  assert.ok(!s.includes('IGQVJ'));
  assert.equal(unseal(s), 'IGQVJ-secret-token');
  assert.notEqual(seal('x'), seal('x'), 'random iv per call');
});

test('unseal passes plaintext through and rejects tampering', () => {
  assert.equal(unseal('plain-old-token'), 'plain-old-token');
  const s = seal('abc');
  const parts = s.split(':');
  parts[4] = parts[4].slice(0, -2) + 'AA';
  assert.throws(() => unseal(parts.join(':')));
});
