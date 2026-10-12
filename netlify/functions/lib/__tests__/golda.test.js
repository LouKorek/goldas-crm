// Golda 2.0: who she acts for, what each role may do, the morning briefing,
// the queue's retry rules and the audit migration.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';

const { matchSender, sessionKey, whatsappRecipients } = require('../golda-identity.js');
const { toolsFor, TOOLS } = require('../wa-agent.js');
const { buildBriefing, urgentAlerts } = require('../golda-briefing.js');
const { pickRetries, topicCommand, nextUsage } = require('../golda-worker.js');
const { computeAlerts, mergeSettings } = require('@goldas/domain');
const { memoryStore } = require('../migrations/store.js');
const golda = require('../migrations/004-golda-audit.js');
const numbers = require('../migrations/005-golda-numbers.js');

const users = [
  { id: 'lou.korek@gmail.com', email: 'lou.korek@gmail.com', name: 'לו', role: 'admin', whatsapp: '972500000001', channels: ['whatsapp', 'email'], briefingHour: 7 },
  { id: 'yuval@x.com', email: 'yuval@x.com', name: 'יובל', role: 'manager', whatsapp: '0520000002', channels: ['email'] },
  { id: 'eye@x.com', email: 'eye@x.com', name: 'עין', role: 'viewer', whatsapp: '972530000003', channels: ['whatsapp'] },
  { id: 'gone@x.com', email: 'gone@x.com', name: 'דני', role: 'manager', whatsapp: '972540000004', active: false },
];

test('a sender is recognised by the number on their record, with their own role', () => {
  const y = matchSender('+972 52-000-0002', users, '');
  assert.equal(y.email, 'yuval@x.com');
  assert.equal(y.role, 'manager');
  assert.equal(y.source, 'app_users');
  assert.equal(matchSender('972530000003', users, '').role, 'viewer');
  assert.equal(matchSender('972540000004', users, ''), null, 'a disabled user is not a sender');
  assert.equal(matchSender('972599999999', users, ''), null, 'unknown numbers are dropped');
});

test('the legacy allow list still works: owner, a known name, an unknown name', () => {
  const env = '972500000009,972510000010:יובל,972520000011:אורח';
  const lou = matchSender('972500000009', users, env);
  assert.equal(lou.email, 'lou.korek@gmail.com'); assert.equal(lou.role, 'admin'); assert.equal(lou.source, 'env');
  const y = matchSender('972510000010', users, env);
  assert.equal(y.email, 'yuval@x.com'); assert.equal(y.role, 'manager');
  const g = matchSender('972520000011', users, env);
  assert.equal(g.email, ''); assert.equal(g.name, 'אורח'); assert.equal(g.role, 'manager');
  assert.equal(sessionKey(g), '972520000011');
  assert.equal(sessionKey({ email: 'a.b@x.com', phone: '' }), 'u_a_b_x_com');
});

test('WhatsApp recipients are active users with a number who chose the channel', () => {
  const r = whatsappRecipients(users).map((u) => u.email);
  assert.deepEqual(r, ['lou.korek@gmail.com', 'eye@x.com']);
});

test('a viewer gets read tools only; a manager edits; only roles with run_sync get the sync', () => {
  const names = (role) => toolsFor(role).map((t) => t.name);
  assert.deepEqual(names('viewer').sort(), ['alerts_today', 'get', 'list', 'read_file', 'search', 'suggest_matches']);
  assert.ok(names('manager').includes('update') && names('manager').includes('delete') && names('manager').includes('sync_fixtures'));
  assert.equal(names('admin').length, TOOLS.length);
});

test('the briefing lists today, what needs action and what Golda did, in Hebrew', () => {
  const now = new Date('2026-10-12T05:00:00Z');
  const r = computeAlerts({
    players: [{ id: 'a', fullName: 'אבי כהן', contractEnd: '2026-10-20', contractStatus: 'Under Contract', currentClub: 'מכבי' }],
    deals: [{ id: 'd', playerName: 'דן', clubName: 'הפועל', stage: 'Negotiation', enteredStageAt: '2026-09-01T10:00:00Z' }],
    settings: mergeSettings({}), now,
  });
  const text = buildBriefing({ name: 'לו', alerts: r.alerts, games: [{ date: '2026-10-12', time: '20:00', title: 'מכבי – הפועל', sub: 'בלומפילד' }], goldaActions: 2, now });
  assert.match(text, /בוקר טוב, לו/);
  assert.match(text, /20:00 · מכבי – הפועל/);
  assert.match(text, /אבי כהן/);
  assert.match(text, /חוזים שמסתיימים/);
  assert.match(text, /עסקאות שמחכות/);
  assert.match(text, /2 שינויים/);
  const quiet = buildBriefing({ name: 'יובל', alerts: [], games: [], goldaActions: 0, now });
  assert.match(quiet, /אין משחקים או אימונים/);
  assert.match(quiet, /יום שקט/);
});

test('urgent alerts: a contract within a week and a failed job, not a 30-day warning', () => {
  const now = new Date('2026-10-12T05:00:00Z');
  const r = computeAlerts({
    players: [
      { id: 'a', fullName: 'A', contractEnd: '2026-10-15', contractStatus: 'Under Contract' },
      { id: 'b', fullName: 'B', contractEnd: '2026-11-05', contractStatus: 'Under Contract' },
    ],
    jobs: [{ id: 'j', name: 'tm-watch', status: 'error', error: 'boom', startedAt: new Date('2026-10-12T02:00:00Z') }],
    settings: mergeSettings({}), now,
  });
  const u = urgentAlerts(r.alerts);
  assert.deepEqual(u.map((a) => `${a.type}:${a.subject.id}`).sort(), ['contract:a', 'job_failed:j']);
});

test('the queue retries what fell through and leaves the rest alone', () => {
  const now = Date.now();
  const rows = [
    { id: 'fresh', state: 'queued', receivedAt: now - 10000 },
    { id: 'stuckQueued', state: 'queued', receivedAt: now - 300000, attempts: 0 },
    { id: 'tooMany', state: 'queued', receivedAt: now - 300000, attempts: 3 },
    { id: 'running', state: 'processing', startedAt: now - 60000, attempts: 1 },
    { id: 'died', state: 'processing', startedAt: now - 20 * 60000, attempts: 1 },
    { id: 'unsent', state: 'reply_pending', attempts: 1 },
    { id: 'transient', state: 'error', error: 'WhatsApp API 503: overloaded', attempts: 1 },
    { id: 'permanent', state: 'error', error: 'player not found', attempts: 1 },
    { id: 'done', state: 'done' },
  ];
  assert.deepEqual(pickRetries(rows, now).map((r) => r.id), ['stuckQueued', 'died', 'unsent', 'transient']);
});

test('topic commands and daily usage', () => {
  assert.deepEqual(topicCommand('גולדה, חזרה למערכת'), { kind: 'main' });
  assert.equal(topicCommand('גולדה, נושא חדש: טיול לרומא. לתכנן 3 ימים').name, 'טיול לרומא');
  assert.equal(topicCommand('מה שלומך?'), null);
  assert.deepEqual(nextUsage({}, '2026-10-12'), { date: '2026-10-12', count: 1, inputTokens: 0, outputTokens: 0 });
  assert.equal(nextUsage({ usage: { date: '2026-10-12', count: 4, inputTokens: 9, outputTokens: 1 } }, '2026-10-12').count, 5);
  assert.equal(nextUsage({ usage: { date: '2026-10-11', count: 4 } }, '2026-10-12').count, 1);
});

test('004 copies wa_audit lines into audit once, marked via golda', async () => {
  const store = memoryStore({
    wa_audit: { x1: { action: 'update', collection: 'players', docId: 'p1', before: { dob: null }, after: { dob: '2008-01-01' }, sender: 'יובל', phone: '972', at: 't' }, x2: { action: 'create', collection: 'tasks', docId: 't1', before: null, after: { title: 'a' } } },
    audit: { wa_x2: { legacy: true } },
  });
  const { report, writes } = await golda.plan(store);
  assert.equal(writes.length, 1);
  assert.equal(report.counts.skipped, 1);
  const [col, id, data] = writes[0];
  assert.equal(col, 'audit'); assert.equal(id, 'wa_x1');
  assert.equal(data.via, 'golda'); assert.equal(data.actor, 'golda'); assert.equal(data.sender, 'יובל'); assert.equal(data.onBehalfOf, '');
  assert.deepEqual(data.fields, ['dob']);
});

test('005 moves the legacy numbers onto the users, owner gets WhatsApp as a channel', async () => {
  const store = memoryStore({ app_users: {
    'lou.korek@gmail.com': { email: 'lou.korek@gmail.com', name: 'לו', role: 'admin' },
    'yuval@x.com': { email: 'yuval@x.com', name: 'יובל', role: 'manager', whatsapp: '972520000002' },
    'dana@x.com': { email: 'dana@x.com', name: 'דנה', role: 'viewer', channels: ['email'] },
  } });
  const { report, writes } = await numbers.plan(store, '972500000001,972510000010:יובל,972530000003:דנה,972540000004:אורח');
  assert.equal(report.counts.unmatched, 1);
  const lou = writes.find((w) => w[1] === 'lou.korek@gmail.com')[2];
  assert.equal(lou.whatsapp, '972500000001'); assert.deepEqual(lou.channels, ['email', 'whatsapp']); assert.equal(lou.briefingHour, 7);
  assert.ok(!writes.some((w) => w[1] === 'yuval@x.com'), 'a saved number is kept');
  const dana = writes.find((w) => w[1] === 'dana@x.com')[2];
  assert.equal(dana.whatsapp, '972530000003'); assert.equal(dana.channels, undefined);
});
