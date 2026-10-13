const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryStore } = require('../migrations/store.js');
const migrations = require('../migrations/index.js');
const { ensureWebhookCallback } = require('../wa-subscription.js');

const seed = () => ({
  players: {
    p1: { fullName: 'Noam Barzilai', gender: 'Men', currentClub: 'Maccabi Haifa', contractStatus: 'Under Contract' },
    p2: { fullName: 'Dana Levi', gender: 'Women', currentClub: 'מכבי חיפה', deletedAt: '2026-10-01T00:00:00Z' },
    lQKfyOZsaFHSKkn7JkFO: { fullName: 'Eyal Prashizky', gender: 'Men', currentClub: "Ironi Modi'in", clubId: 'c_ironi_modiin', dob: '2010-04-14', stage: 'represented', contractStatus: 'Under Contract',
      autoFetch: { ifa: { playerId: '256780', teamId: '6522', teamName: "הפ' מ.ס חבל מודיעין", ageGroup: 'נערים ג', forClub: "Ironi Modi'in", resolvedAt: '2026-10-12T20:36:00Z' } } },
  },
  jobs: {
    UHluG6hbVT8aO5mNLGZA: { name: 'migrate', status: 'error', error: 'לא נמחק כלום. נמצאו 51 משחקים בלי שחקן, צפויים 74', startedAt: '2026-10-12T20:55:00Z' },
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
  matches: { m1: { homeTeam: 'Maccabi Haifa', awayTeam: 'Hapoel Tel Aviv', date: '2026-10-20' }, ...cleanupMatches(), ...fixMatches() },
});

// A matches collection that migration 006 accepts: the 51 player-less IFA
// matches of the three squads, the 13 duplicates with their twins, and a few
// live records it must leave alone.
const clean = require('../migrations/006-clean-matches.js');
function cleanupMatches() {
  const out = {};
  let n = 0;
  for (const [team, count] of Object.entries(clean._internal.A_TEAMS)) {
    for (let i = 0; i < count; i++) {
      const d = new Date(Date.UTC(2026, 8, 19 + (n % 240)));
      out[`a${n++}`] = { source: 'ifa', linkedPlayers: [], homeTeam: i % 2 ? team : 'יריבה', awayTeam: i % 2 ? 'יריבה' : team, date: d.toISOString().slice(0, 10), time: '00:00' };
    }
  }
  for (const r of clean._internal.B_ROWS) {
    const player = ['ueZUaMrbMeFdxmQFY5RF', 'RWOyZP8ngQ7sJDUV5Jgl', 'D428dQJjM7Mxlxmhad6v', 'RwDLZfvOEI0dzn3mk64j', '2PA2qBLbENTk2BpJ6jEN', 'cQXzhZZUo2rkyCrMNUmg'].includes(r.id) ? 'dNxtLA2YQj4nfgLOqwKo' : '7Cg7ARx3SXjzDYGlQ4NA';
    out[r.id] = { source: 'ifa', linkedPlayers: [player], homeTeam: 'הפועל חדרה', awayTeam: 'הפ\' יריב', date: r.date, time: r.sameTime ? '17:15' : '00:00', stadiumName: '' };
    out[`twin_${r.id}`] = { source: 'ifa', linkedPlayers: [player], homeTeam: 'הפועל חדרה', awayTeam: 'הפועל יריב', date: r.twinDate, time: '17:15', stadiumName: 'חדרה מתחם אימונים' };
  }
  out.keep1 = { source: 'ifa', linkedPlayers: ['7Cg7ARx3SXjzDYGlQ4NA'], homeTeam: 'הפועל חדרה', awayTeam: 'מכבי נתניה', date: '2026-11-01', time: '19:00' };
  out.keep2 = { source: 'ifa', linkedPlayers: [], homeTeam: 'מ.כ. נהלל יזרעאל', awayTeam: 'x', date: '2026-10-01', deletedAt: '2026-10-01T00:00:00Z' };
  return out;
}

// What migration 007 expects: Eyal on 25 Hevel Modi'in (team 6522) fixtures,
// one of them shared with another player, his 26 Gadna matches of last
// season, and the two Hadera duplicate pairs of 10.10.
const fix = require('../migrations/007-eyal-and-hadera-dupes.js');
const HEVEL = 'https://www.football.org.il/team-details/team-games/?team_id=6522';
const GADNA = 'https://www.football.org.il/team-details/team-games/?team_id=4004';
function fixMatches() {
  const out = {};
  for (let i = 0; i < 25; i++) {
    const d = new Date(Date.UTC(2026, 8, 19 + i * 9));
    out[`h${i}`] = { source: 'ifa', sourceTeamId: HEVEL, sourceMatchId: `99${i}`, linkedPlayers: i === 3 ? ['lQKfyOZsaFHSKkn7JkFO', 'someone'] : ['lQKfyOZsaFHSKkn7JkFO'], homeTeam: "הפ' מ.ס חבל מודיעין", awayTeam: 'יריבה', date: d.toISOString().slice(0, 10) };
  }
  for (let i = 0; i < 26; i++) {
    out[`g${i}`] = { source: 'ifa', sourceTeamId: GADNA, sourceMatchId: `88${i}`, linkedPlayers: ['lQKfyOZsaFHSKkn7JkFO'], homeTeam: 'גדנע ת"א רוני', awayTeam: 'יריבה', date: `2025-${String(9 + (i % 3)).padStart(2, '0')}-1${i % 9}` };
  }
  out.CKyrQU414uoxQrueBhk5 = { source: 'ifa', sourceMatchId: '1121923', date: '2026-10-10', time: '17:30', homeTeam: 'הפועל חדרה', awayTeam: 'הפועל ק"ש', linkedPlayers: ['7Cg7ARx3SXjzDYGlQ4NA'] };
  out.XALTePkYxX5YWO1Eu926 = { source: 'ifa', sourceMatchId: '2026-10-10|הפועל חדרה|הפועל ק"ש', date: '2026-10-10', time: '', homeTeam: 'הפועל חדרה', awayTeam: 'הפועל ק"ש', linkedPlayers: ['7Cg7ARx3SXjzDYGlQ4NA', 'fbN4jQ4OGD5u5V8NDYrm'] };
  out.ghMi4dRvNe8enUKmvdT7 = { source: 'ifa', sourceMatchId: '1123327', date: '2026-10-10', time: '13:30', homeTeam: 'הפועל חדרה מתי', awayTeam: 'הפועל ב"ש', linkedPlayers: ['dNxtLA2YQj4nfgLOqwKo'] };
  out.Zz8U7hU6TEdC5zErwfDl = { source: 'ifa', sourceMatchId: '2026-10-10|הפועל חדרה מתי|הפועל ב"ש', date: '2026-10-10', time: '', homeTeam: 'הפועל חדרה מתי', awayTeam: 'הפועל ב"ש', linkedPlayers: ['dNxtLA2YQj4nfgLOqwKo'] };
  return out;
}

test('001 tags represented players and copies candidates with stage/category', async () => {
  const store = memoryStore(seed());
  const { migrations: rows, ran } = await migrations.run(store);
  assert.equal(ran.length, 7);
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
  assert.equal(rows.length, 7);
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

test('006 deletes exactly the ordered matches, into the recycle bin', async () => {
  const store = memoryStore(seed());
  const { ran } = await migrations.run(store);
  const r = ran.find((x) => x.id === '006-clean-matches');
  assert.equal(r.writes, 51 + 13);
  const m = store.db.matches;
  assert.ok(Object.keys(m).filter((k) => k.startsWith('a')).every((k) => m[k].deletedAt && m[k].deletedVia === '006-clean-matches'));
  for (const row of clean._internal.B_ROWS) {
    assert.ok(m[row.id].deletedAt, `${row.id} deleted`);
    assert.ok(!m[`twin_${row.id}`].deletedAt, `twin of ${row.id} kept`);
  }
  assert.ok(!m.keep1.deletedAt && !m.m1.deletedAt);
  const rec = store.db.migrations['006-clean-matches'];
  assert.equal(rec.report.counts.partA, 51); assert.equal(rec.report.counts.partB, 13);
  assert.equal(rec.report.counts.byTeam['מ.כ. נהלל יזרעאל'], 29);
});

test('006 refuses when the counts differ or a twin is missing', async () => {
  const bad = seed(); delete bad.matches.a0;
  await assert.rejects(migrations.run(memoryStore(bad), { only: ['006-clean-matches'] }), /50 .*51|נמצאו 50/);
  const noTwin = seed(); delete noTwin.matches.twin_Ord3jUM7KOuTdgmQjp1L;
  await assert.rejects(migrations.run(memoryStore(noTwin), { only: ['006-clean-matches'] }), /Ord3jUM7KOuTdgmQjp1L: לא נמצא תאום/);
  for (const st of [memoryStore(bad), memoryStore(noTwin)]) {
    try { await migrations.run(st, { only: ['006-clean-matches'] }); } catch {}
    assert.ok(Object.values(st.db.matches).every((x) => !x.deletedVia), 'nothing deleted on refusal');
  }
  // An id that is already gone is skipped, not an error.
  const gone = seed(); delete gone.matches['3lWpNI7i8aK6FWfqKO1t']; delete gone.matches.twin_3lWpNI7i8aK6FWfqKO1t;
  const st = memoryStore(gone);
  const { ran } = await migrations.run(st, { only: ['006-clean-matches'] });
  assert.equal(ran[0].writes, 51 + 12);
  assert.deepEqual(st.db.migrations['006-clean-matches'].report.skipped, [{ id: '3lWpNI7i8aK6FWfqKO1t', reason: 'כבר לא קיים' }]);
});

test('007 moves Eyal to Ironi Modi\'in, unlinks the Hevel Modi\'in fixtures, merges the Hadera pairs, marks the job', async () => {
  const store = memoryStore(seed());
  const { ran } = await migrations.run(store);
  const r = ran.find((x) => x.id === '007-eyal-and-hadera-dupes');
  assert.equal(r.writes, 1 + 25 + 1 + 2 + 1);
  const p = store.db.players.lQKfyOZsaFHSKkn7JkFO;
  assert.equal(p.autoFetch.ifa.teamId, '6249'); assert.equal(p.autoFetch.ifa.playerId, '256780'); assert.equal(p.autoFetch.ifa.forClub, "Ironi Modi'in");
  const m = store.db.matches;
  for (let i = 0; i < 25; i++) {
    assert.ok(!m[`h${i}`].linkedPlayers.includes('lQKfyOZsaFHSKkn7JkFO'), `h${i} unlinked`);
    if (i === 3) assert.ok(!m.h3.deletedAt && m.h3.linkedPlayers.includes('someone'));
    else assert.equal(m[`h${i}`].deletedVia, '007-eyal-and-hadera-dupes');
  }
  for (let i = 0; i < 26; i++) assert.ok(!m[`g${i}`].deletedAt && m[`g${i}`].linkedPlayers.includes('lQKfyOZsaFHSKkn7JkFO'), `g${i} history kept`);
  assert.deepEqual(m.CKyrQU414uoxQrueBhk5.linkedPlayers.sort(), ['7Cg7ARx3SXjzDYGlQ4NA', 'fbN4jQ4OGD5u5V8NDYrm']);
  assert.ok(m.XALTePkYxX5YWO1Eu926.deletedAt && m.Zz8U7hU6TEdC5zErwfDl.deletedAt);
  assert.ok(!m.ghMi4dRvNe8enUKmvdT7.deletedAt && m.ghMi4dRvNe8enUKmvdT7.linkedPlayers.length === 1);
  assert.equal(store.db.jobs.UHluG6hbVT8aO5mNLGZA.status, 'handled');
  const rep = store.db.migrations['007-eyal-and-hadera-dupes'].report;
  assert.equal(rep.counts.aRecycled, 24); assert.equal(rep.counts.aUnlinked, 1); assert.equal(rep.counts.bRecycled, 2); assert.equal(rep.counts.skipped, 0);
});

test('007 refuses on any mismatch and skips ids that are gone', async () => {
  const only = { only: ['007-eyal-and-hadera-dupes'] };
  const fewer = seed(); delete fewer.matches.h0;
  await assert.rejects(migrations.run(memoryStore(fewer), only), /נמצאו 24 משחקים/);
  const otherTeam = seed(); otherTeam.players.lQKfyOZsaFHSKkn7JkFO.autoFetch.ifa.teamId = '6249';
  await assert.rejects(migrations.run(memoryStore(otherTeam), only), /teamId הוא 6249/);
  const wrongKeep = seed(); wrongKeep.matches.CKyrQU414uoxQrueBhk5.sourceMatchId = '1';
  await assert.rejects(migrations.run(memoryStore(wrongKeep), only), /CKyrQU414uoxQrueBhk5: sourceMatchId/);
  const jobOk = seed(); jobOk.jobs.UHluG6hbVT8aO5mNLGZA.status = 'ok';
  await assert.rejects(migrations.run(memoryStore(jobOk), only), /הסטטוס הוא ok/);
  for (const bad of [fewer, otherTeam, wrongKeep, jobOk]) {
    const st = memoryStore(bad);
    try { await migrations.run(st, only); } catch {}
    assert.ok(Object.values(st.db.matches).every((x) => x.deletedVia !== '007-eyal-and-hadera-dupes'), 'nothing changed on refusal');
    assert.equal(st.db.players.lQKfyOZsaFHSKkn7JkFO.autoFetch.ifa.teamId, bad.players.lQKfyOZsaFHSKkn7JkFO.autoFetch.ifa.teamId);
  }
  const gone = seed(); delete gone.matches.XALTePkYxX5YWO1Eu926; delete gone.jobs.UHluG6hbVT8aO5mNLGZA;
  const st = memoryStore(gone);
  const { ran } = await migrations.run(st, only);
  assert.equal(ran[0].writes, 1 + 25 + 1 + 1);
  assert.deepEqual(st.db.migrations['007-eyal-and-hadera-dupes'].report.skipped.map((x) => x.id).sort(), ['XALTePkYxX5YWO1Eu926', 'jobs/UHluG6hbVT8aO5mNLGZA']);
});
