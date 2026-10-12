const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryStore } = require('../migrations/store.js');
const migrations = require('../migrations/index.js');
const { ensureWebhookCallback } = require('../wa-subscription.js');

const seed = () => ({
  players: {
    p1: { fullName: 'Noam Barzilai', gender: 'Men', currentClub: 'Maccabi Haifa', contractStatus: 'Under Contract' },
    p2: { fullName: 'Dana Levi', gender: 'Women', currentClub: 'מכבי חיפה', deletedAt: '2026-10-01T00:00:00Z' },
  },
  pipeline_men: {
    c1: { playerName: 'Yossi Cohen', status: 'Negotiation', linkedClubs: [{ clubName: 'Maccabi Haifa FC', linkedAt: '2026-09-01T00:00:00Z' }, { clubName: 'Hapoel Tel Aviv', linkedAt: '2026-09-02T00:00:00Z' }], previousClubs: [{ clubName: 'Beitar Jerusalem', markedAt: '2026-08-01T00:00:00Z' }] },
    c2: { playerName: 'Avi Nimni', status: 'Not Relevant' },
  },
  pipeline_women: { w1: { playerName: 'Noa Katz', status: '' } },
  pipeline_youth: { y1: { playerName: 'Ido Shapira', status: 'Not Contacted', linkedClubs: [{ clubName: 'מ.ס. אשדוד' }] } },
  pipeline_jewish: {},
  club_requirements: { r1: { clubName: 'Maccabi Haifa', requiredPosition: 'CB' } },
  contacts: { k1: { clubName: 'Hapoel Tel-Aviv', contactName: 'Dani' } },
  matches: { m1: { homeTeam: 'Maccabi Haifa', awayTeam: 'Hapoel Tel Aviv', date: '2026-10-20' } },
});

test('001 tags represented players and copies candidates with stage/category', async () => {
  const store = memoryStore(seed());
  const { migrations: rows, ran } = await migrations.run(store);
  assert.equal(ran.length, 3);
  assert.ok(rows.every((m) => m.status === 'done'));
  const p = store.db.players;
  assert.equal(p.p1.stage, 'represented'); assert.equal(p.p1.category, 'men'); assert.equal(p.p1.name, 'Noam Barzilai');
  assert.equal(p.p2.category, 'women'); assert.equal(p.p2.deletedAt, '2026-10-01T00:00:00Z');
  assert.equal(p.c1.stage, 'in_process'); assert.equal(p.c1.category, 'men'); assert.equal(p.c1.name, 'Yossi Cohen');
  assert.deepEqual(p.c1.legacy, { collection: 'pipeline_men', id: 'c1' });
  assert.equal(p.c2.stage, 'not_relevant');
  assert.equal(p.w1.stage, 'tracking'); assert.equal(p.w1.category, 'women');
  assert.equal(p.y1.category, 'youth');
  assert.equal(store.db.pipeline_men.c1.migratedTo, 'players/c1');
});

test('002 folds club spellings into one club and links records', async () => {
  const store = memoryStore(seed());
  await migrations.run(store);
  const clubs = Object.values(store.db.clubs);
  const haifa = clubs.find((c) => c.aliases.concat(c.name).some((n) => /haifa/i.test(n)));
  assert.ok(haifa, 'Maccabi Haifa club created');
  const haifaNames = [haifa.name, ...haifa.aliases];
  assert.ok(haifaNames.includes('Maccabi Haifa') && haifaNames.includes('Maccabi Haifa FC'), haifaNames.join(','));
  // p2 is in the recycle bin, so its club spelling is not collected.
  assert.ok(!clubs.some((c) => c.name === 'מכבי חיפה'));
  const tlv = clubs.filter((c) => /tel.?aviv/i.test([c.name, ...c.aliases].join(' ')));
  assert.equal(tlv.length, 1, 'Hapoel Tel Aviv / Tel-Aviv is one club');
  const haifaId = Object.entries(store.db.clubs).find(([, c]) => c === haifa)[0];
  assert.equal(store.db.players.p1.currentClubId, haifaId);
  assert.equal(store.db.club_requirements.r1.clubId, haifaId);
  const rep = store.db.migrations['002-clubs'].report;
  assert.ok(rep.groups.some((g) => g.variants.length >= 2), 'report lists the merged spellings');
});

test('003 creates one deal per linked club and closes previous clubs', async () => {
  const store = memoryStore(seed());
  await migrations.run(store);
  const deals = Object.values(store.db.deals);
  const c1 = deals.filter((d) => d.playerId === 'c1');
  assert.equal(c1.length, 3);
  assert.equal(c1.filter((d) => !d.closedAt).length, 2);
  assert.equal(c1.find((d) => /beitar/i.test(d.clubName)).stage, 'Not Relevant');
  assert.ok(c1.every((d) => d.stage === 'Negotiation' || d.closedAt));
  assert.ok(c1.find((d) => /haifa/i.test(d.clubName)).clubId, 'deal points at the club record');
  assert.equal(deals.filter((d) => d.playerId === 'p1').length, 0, 'represented players get no deals');
});

test('running twice changes nothing', async () => {
  const store = memoryStore(seed());
  await migrations.run(store);
  const snap = JSON.stringify(store.db);
  const r = await migrations.run(store);
  assert.equal(r.ran.length, 0);
  assert.equal(JSON.stringify(store.db), snap);
  // A fresh pipeline record after the run is picked up by a re-run of 001 only when pending; dryRun reports nothing broken.
  const dry = await migrations.dryRun(store);
  assert.ok(dry.every((m) => m.status === 'done'));
});

test('dryRun writes nothing', async () => {
  const store = memoryStore(seed());
  const before = JSON.stringify(store.db);
  const rows = await migrations.dryRun(store);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((m) => m.status === 'pending' && m.report && m.report.summary));
  assert.equal(JSON.stringify(store.db), before);
});

test('ensureWebhookCallback reads first and only writes when the callback differs', async () => {
  process.env.WA_APP_SECRET = 'x'; process.env.WA_VERIFY_TOKEN = 'zq-secret-token-7781';
  const calls = [];
  const mk = (data) => ({ ok: true, status: 200, json: async () => data });
  const fetchSame = async (url, opts) => { calls.push(opts?.method || 'GET'); return mk({ data: [{ object: 'whatsapp_business_account', callback_url: 'https://goldas-crm.netlify.app/.netlify/functions/whatsapp-webhook', fields: [{ name: 'messages' }] }] }); };
  const r1 = await ensureWebhookCallback('https://goldas-crm.netlify.app', { fetchImpl: fetchSame, log: () => {} });
  assert.equal(r1.unchanged, true); assert.deepEqual(calls, ['GET']);
  calls.length = 0;
  const fetchOther = async (url, opts) => { calls.push(opts?.method || 'GET'); return opts?.method === 'POST' ? mk({ success: true }) : mk({ data: [{ object: 'whatsapp_business_account', callback_url: 'https://deploy-preview-12--goldas-crm.netlify.app/.netlify/functions/whatsapp-webhook', fields: ['messages'] }] }); };
  const r2 = await ensureWebhookCallback('https://goldas-crm.netlify.app', { fetchImpl: fetchOther, log: () => {} });
  assert.equal(r2.updated, true); assert.deepEqual(calls, ['GET', 'POST']);
  assert.ok(!JSON.stringify(r2).includes('zq-secret-token-7781'), 'verify token is not in the result');
  delete process.env.WA_APP_SECRET; delete process.env.WA_VERIFY_TOKEN;
});
