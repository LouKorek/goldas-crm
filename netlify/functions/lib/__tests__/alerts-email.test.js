// The daily email dedupes per alert per threshold, and forgets old keys.
const test = require('node:test');
const assert = require('node:assert');
const { dedupeKey, pruneSent, buildEmailHtml } = require('../../send-alerts.js')._internal;
const { computeAlerts, mergeSettings } = require('@goldas/domain');

const settings = mergeSettings({ matchDays: [0, 1] });
const noon = new Date('2026-10-12T09:00:00Z');

test('a contract warns once per threshold and again when it has passed', () => {
  const r = computeAlerts({ players: [{ id: 'a', fullName: 'Avi', contractEnd: '2026-10-20', contractStatus: 'Under Contract' }], settings, now: noon });
  const k8 = dedupeKey(r.alerts[0], settings, '2026-10-12');
  assert.strictEqual(k8, 'contract|a|2026-10-20|30');
  const r2 = computeAlerts({ players: [{ id: 'a', fullName: 'Avi', contractEnd: '2026-10-20', contractStatus: 'Under Contract' }], settings, now: new Date('2026-10-15T09:00:00Z') });
  assert.strictEqual(dedupeKey(r2.alerts[0], settings, '2026-10-15'), 'contract|a|2026-10-20|7');
  const r3 = computeAlerts({ players: [{ id: 'a', fullName: 'Avi', contractEnd: '2026-10-20', contractStatus: 'Under Contract' }], settings, now: new Date('2026-10-25T09:00:00Z') });
  assert.strictEqual(dedupeKey(r3.alerts[0], settings, '2026-10-25'), 'contract|a|2026-10-20|overdue');
});

test('stale deals re-alert every stale period; jobs and matches once', () => {
  const r = computeAlerts({
    deals: [{ id: 'd', playerName: 'P', clubName: 'C', stage: 'Negotiation', enteredStageAt: '2026-09-20T10:00:00Z' }],
    jobs: [{ id: 'j', name: 'x', status: 'error', startedAt: new Date('2026-10-12T02:00:00Z') }],
    matches: [{ id: 'm', homeTeam: 'A', awayTeam: 'B', date: '2026-10-13' }],
    settings, now: noon,
  });
  const keys = r.alerts.map((a) => dedupeKey(a, settings, '2026-10-12'));
  assert.ok(keys.includes('deal_stale|d|2026-09-20T10:00:00Z|1'));
  assert.ok(keys.includes('job_failed|j'));
  assert.ok(keys.includes('match|m|2026-10-13'));
});

test('pruneSent keeps recent keys, dates legacy ones, drops old ones', () => {
  const out = pruneSent({ fresh: '2026-10-01', legacy: 1, ancient: '2024-01-01' }, '2026-10-12');
  assert.deepStrictEqual(out, { fresh: '2026-10-01', legacy: '2026-10-12' });
});

test('the email is Hebrew and right-to-left', () => {
  const r = computeAlerts({ players: [{ id: 'a', fullName: 'אבי', contractEnd: '2026-10-20', contractStatus: 'Under Contract', currentClub: 'מכבי' }], settings, now: noon });
  const html = buildEmailHtml(r.alerts, 1);
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes('סיום חוזה'));
  assert.ok(html.includes('מכבי'));
  assert.ok(!html.includes('<script'));
});
