// Phase 5: the operations alerts Golda sends admins, and the "run now" plumbing.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';

const { opsAlerts, buildOps } = require('../golda-briefing.js');

const now = new Date('2026-10-12T09:00:00Z');
const at = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600000).toISOString();

test('a job that failed twice in a row is reported once a day; one failure is not', () => {
  const jobs = [
    { name: 'tm-watch', status: 'error', startedAt: at(2), error: 'quota' },
    { name: 'tm-watch', status: 'error', startedAt: at(26), error: 'quota' },
    { name: 'sync-matches', status: 'error', startedAt: at(1) },
    { name: 'sync-matches', status: 'ok', startedAt: at(25) },
    { name: 'golda', status: 'error', startedAt: at(1) },
    { name: 'golda', status: 'error', startedAt: at(2) },
  ];
  const out = opsAlerts({ jobs, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'job2|tm-watch|2026-10-12');
  assert.match(out[0].text, /tm-watch/);
});

test('ScraperAPI at 80% or more is reported, keyed by the reset date', () => {
  assert.equal(opsAlerts({ scraper: { requestCount: 790, requestLimit: 1000 }, now }).length, 0);
  const out = opsAlerts({ scraper: { requestCount: 812, requestLimit: 1000, nextReset: '2026-10-30' }, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'scraper80|2026-10-30');
  assert.match(out[0].text, /81%/);
});

test('the IFA browser sync silent for 36 hours is reported; a recent run is not', () => {
  assert.equal(opsAlerts({ ifaSync: { lastRunAt: at(10) }, now }).length, 0);
  const out = opsAlerts({ ifaSync: { lastRunAt: at(40), lastSuccessAt: at(60) }, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'ifa36|2026-10-12');
  assert.match(out[0].text, /40 שעות/);
});

test('ops message lists every item and links to the admin screen', () => {
  const text = buildOps('לו', [{ key: 'a', text: '• אחד' }, { key: 'b', text: '• שניים' }]);
  assert.match(text, /^\*לו, עדכון תפעולי\*/);
  assert.match(text, /• אחד\n• שניים/);
  assert.match(text, /\/admin$/);
});

test('every "run now" job maps to a worker or an ops task that exists', () => {
  const { _internal } = require('../../admin-run-job.js');
  const { TASKS } = require('../../ops-background.js');
  for (const t of _internal.OPS) assert.ok(TASKS.includes(t), `${t} has no ops task`);
  for (const w of Object.values(_internal.WORKERS)) assert.match(w, /-background$/);
});
