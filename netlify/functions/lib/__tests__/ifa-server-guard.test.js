const { test } = require('node:test');
const assert = require('node:assert');
const { browserFresh } = require('../../ifa-server-sync-background.js');

const now = new Date('2026-11-07T03:00:00Z');
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

test('server stands aside the morning after the browser published', () => {
  // routine ran 07:45 Israel (05:45Z) the day before → 21h ago
  assert.strictEqual(browserFresh({ lastBrowserSuccessAt: ts('2026-11-06T05:45:00Z') }, now), true);
});

test('server publishes when the computer was off for a day', () => {
  assert.strictEqual(browserFresh({ lastBrowserSuccessAt: ts('2026-11-05T05:45:00Z') }, now), false);
});

test('server publishes when the browser never ran', () => {
  assert.strictEqual(browserFresh({}, now), false);
  assert.strictEqual(browserFresh(undefined, now), false);
});
