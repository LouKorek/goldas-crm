const { test } = require('node:test');
const assert = require('node:assert');
const { tmSpendCap, daysUntil } = require('../tm-budget.js');

test('spreads what is left evenly over the days to the reset', () => {
  // 980 usable over 24 days → 40 a day
  assert.strictEqual(tmSpendCap({ remaining: 1000, nextReset: '2026-11-30', today: '2026-11-06' }), 40);
});

test('a second run the same day only gets what the day has left', () => {
  assert.strictEqual(tmSpendCap({ remaining: 970, spentToday: 30, nextReset: '2026-11-30', today: '2026-11-06' }), 10);
  assert.strictEqual(tmSpendCap({ remaining: 960, spentToday: 40, nextReset: '2026-11-30', today: '2026-11-06' }), 0);
});

test('an empty or overdrawn account spends nothing', () => {
  assert.strictEqual(tmSpendCap({ remaining: 0, nextReset: '2026-11-30', today: '2026-11-06' }), 0);
  assert.strictEqual(tmSpendCap({ remaining: 15, nextReset: '2026-11-30', today: '2026-11-06' }), 0);
});

test('never above the per-run ceiling, even on the last day', () => {
  assert.strictEqual(tmSpendCap({ remaining: 900, nextReset: '2026-11-30', today: '2026-11-29' }), 150);
});

test('unknown numbers stay cautious', () => {
  assert.strictEqual(tmSpendCap({ remaining: null, today: '2026-11-06' }), 30);
  assert.strictEqual(tmSpendCap({ remaining: 620, today: '2026-11-06' }), 20);
  assert.strictEqual(daysUntil('2026-11-30', '2026-11-30'), 1);
});
