const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb } = require('./fake-firestore.js');
const { readStatus, when } = require('../system-status.js');

const NOW = Date.parse('2026-11-25T19:30:00Z');
// A Firestore time as the fake database can hold it (no functions): the real one also has toMillis().
const T = (iso) => ({ _seconds: Date.parse(iso) / 1000, _nanoseconds: 0 });
// Everything private a status document can hold: none of it may come out.
const PRIVATE = ['dana@club-example.com', 'club-example.com', 'Dana Levi', 'p_secret_id', 'backup-2026-11-25.jsonl', 'Permission denied for dana', 'refresh-token-value', 'weird free text'];

const seed = () => ({
  app_meta: {
    jobStatus: {
      'gmail-sync': { runningSince: null, last: { status: 'ok', startedAt: T('2026-11-25T19:15:02Z'), durationMs: 4321, trigger: 'schedule' } },
      'backup-weekly': { runningSince: T('2026-11-25T19:29:00Z'), last: { status: 'error', startedAt: T('2026-11-24T01:10:00Z'), durationMs: 900, trigger: 'weird free text', error: 'Permission denied for dana' },
        lastError: { status: 'error', startedAt: T('2026-11-24T01:10:00Z'), error: 'Permission denied for dana' } },
      'Dana Levi': { last: { status: 'ok' } },                                   // not a job name: left out
    },
    goldaCost: { capUsd: 7.5, updatedBy: 'dana@club-example.com', updatedAt: NOW },
    gmail: { connected: true, address: 'dana@club-example.com', state: 'ok', api: { state: 'on', at: NOW, message: 'Permission denied for dana' },
      book: { emails: 12, domains: 5 }, linkedCount: 40, backlog: 3, lastSyncAt: NOW - 60000, lastError: { at: NOW - 3600000, message: 'Permission denied for dana' },
      found: { filled: 7, open: 2, last: 'dana@club-example.com' } },
  },
  backups: {
    b1: { status: 'ok', startedAt: T('2026-11-18T01:00:00Z'), verified: true, docs: 5000, offsite: { key: 'backup-2026-11-25.jsonl', bytes: 9 }, collections: ['players'] },
    b2: { status: 'error', startedAt: T('2026-11-25T01:00:00Z'), verified: false, docs: 10, error: 'Permission denied for dana', offsite: null },
  },
  push_subscriptions: { p_secret_id: { email: 'dana@club-example.com', endpoint: 'https://push.example/refresh-token-value' } },
  // What Golda cost today (lib/golda-cost.js). The ledger holds numbers only; the extra fields here are what must never come out if something else ever wrote them.
  golda_cost: { '2026-11-25': { totalUsd: 3.456789, backgroundUsd: 1.2, calls: 31, byKind: { chat: { usd: 2.256789, calls: 28 }, scouting: { usd: 1.2, calls: 3 } }, note: 'weird free text', lastPrompt: 'Dana Levi' } },
});

test('the status says states, times and counts', async () => {
  const s = await readStatus(fakeDb(seed()), NOW);
  assert.equal(s.at, '2026-11-25T19:30:00.000Z');
  assert.deepEqual(s.jobs['gmail-sync'], { status: 'ok', at: '2026-11-25T19:15:02.000Z', seconds: 4, trigger: 'schedule', running: false, lastFailedAt: null });
  assert.deepEqual(s.jobs['backup-weekly'], { status: 'error', at: '2026-11-24T01:10:00.000Z', seconds: 1, trigger: 'unknown', running: true, lastFailedAt: '2026-11-24T01:10:00.000Z' });
  assert.deepEqual(Object.keys(s.jobs).sort(), ['backup-weekly', 'gmail-sync']);
  assert.deepEqual(s.mail, { connected: true, state: 'ok', api: 'on', contactAddresses: 12, clubDomains: 5, messagesKept: 40, waiting: 3,
    lastReadAt: new Date(NOW - 60000).toISOString(), lastFailedAt: new Date(NOW - 3600000).toISOString(), addressesFilled: 7, suggestionsOpen: 2 });
  assert.deepEqual(s.backup.latest, { status: 'error', at: '2026-11-25T01:00:00.000Z', readBackOk: false, outsideCopy: false, documents: 10 });
  assert.deepEqual(s.backup.latestGood, { status: 'ok', at: '2026-11-18T01:00:00.000Z', readBackOk: true, outsideCopy: true, documents: 5000 });
  assert.deepEqual(s.notifications, { devices: 1 });
  assert.deepEqual(s.cost, { todayUsd: 3.46, capUsd: 7.5, capped: false });
});

test('nothing a person typed, no address, id, file name or error text comes out', async () => {
  const text = JSON.stringify(await readStatus(fakeDb(seed()), NOW));
  for (const p of PRIVATE) assert.ok(!text.includes(p), `leaked: ${p}`);
  assert.ok(!/@/.test(text), 'no e-mail address');
});

test('a state that is not on the list comes out as "unknown", and an empty system still answers', async () => {
  const db = fakeDb({ app_meta: { gmail: { connected: true, state: 'Dana Levi', api: { state: 'p_secret_id' } } } });
  const s = await readStatus(db, NOW);
  assert.deepEqual([s.mail.state, s.mail.api, s.mail.contactAddresses, s.mail.lastReadAt], ['unknown', 'unknown', null, null]);
  assert.deepEqual([s.mail.addressesFilled, s.mail.suggestionsOpen], [null, null], 'no address search yet');
  assert.deepEqual(s.jobs, {});
  assert.deepEqual(s.backup, { latest: null, latestGood: null });
  assert.deepEqual(s.notifications, { devices: 0 });
  assert.deepEqual(s.cost, { todayUsd: 0, capUsd: 5, capped: false }, 'nothing spent yet, the default ceiling');
});

test('the address search shows as two numbers; anything that is not a number comes out empty', async () => {
  const db = fakeDb({ app_meta: { gmail: { connected: true, state: 'ok', found: { filled: 'dana@club-example.com', open: 'Dana Levi' } } } });
  const s = await readStatus(db, NOW);
  assert.deepEqual([s.mail.addressesFilled, s.mail.suggestionsOpen], [null, null]);
  assert.ok(!/@|Dana/.test(JSON.stringify(s)));
});

test('the cost is two sums and a yes/no: no kinds, no counts, no who set the ceiling', async () => {
  const db = fakeDb(seed());
  const s = await readStatus(db, NOW);
  assert.deepEqual(Object.keys(s.cost).sort(), ['capUsd', 'capped', 'todayUsd']);
  for (const v of [s.cost.todayUsd, s.cost.capUsd]) assert.equal(typeof v, 'number');
  assert.equal(typeof s.cost.capped, 'boolean');
  // The day's own work reached the ceiling: said as a yes, with the same two sums.
  const full = seed();
  full.golda_cost['2026-11-25'].backgroundUsd = 7.5;
  assert.deepEqual((await readStatus(fakeDb(full), NOW)).cost, { todayUsd: 3.46, capUsd: 7.5, capped: true });
  // Chats alone, however much they cost, do not reach it.
  const chats = seed();
  chats.golda_cost['2026-11-25'] = { totalUsd: 40, backgroundUsd: 0 };
  assert.deepEqual((await readStatus(fakeDb(chats), NOW)).cost, { todayUsd: 40, capUsd: 7.5, capped: false });
  // A ceiling of 0 (her own work switched off) reads as capped; a ceiling that is not a number falls back to the default.
  const off = seed();
  off.app_meta.goldaCost = { capUsd: 0 };
  assert.deepEqual((await readStatus(fakeDb(off), NOW)).cost, { todayUsd: 3.46, capUsd: 0, capped: true });
  const junk = seed();
  junk.app_meta.goldaCost = { capUsd: 'Dana Levi' };
  junk.golda_cost['2026-11-25'] = { totalUsd: 'weird free text', backgroundUsd: 'p_secret_id' };
  const j = await readStatus(fakeDb(junk), NOW);
  assert.deepEqual(j.cost, { todayUsd: 0, capUsd: 5, capped: false });
  assert.ok(!/Dana|weird|secret/.test(JSON.stringify(j.cost)));
  // Yesterday's ledger is not today's.
  assert.equal((await readStatus(fakeDb(seed()), NOW + 24 * 3600000)).cost.todayUsd, 0);
});

test('a real Firestore time (toMillis) reads the same', () => {
  assert.equal(when({ toMillis: () => NOW }), '2026-11-25T19:30:00.000Z');
  assert.equal(when('not a time'), null);
  assert.equal(when(null), null);
});

test('one part that cannot be read does not take the rest with it', async () => {
  const db = fakeDb(seed());
  const real = db.collection;
  db.collection = (name) => { if (name === 'backups') throw new Error('boom'); return real(name); };
  const s = await readStatus(db, NOW);
  assert.equal(s.backup, null);
  assert.equal(s.mail.state, 'ok');
  assert.equal(s.jobs['gmail-sync'].status, 'ok');
  assert.deepEqual(s.cost, { todayUsd: 3.46, capUsd: 7.5, capped: false });
});

test('a cost ledger that cannot be read comes out empty and leaves the rest', async () => {
  const db = fakeDb(seed());
  const real = db.collection;
  db.collection = (name) => { if (name === 'golda_cost') throw new Error('boom'); return real(name); };
  const s = await readStatus(db, NOW);
  assert.equal(s.cost, null);
  assert.equal(s.mail.state, 'ok');
  assert.deepEqual(s.notifications, { devices: 1 });
});
