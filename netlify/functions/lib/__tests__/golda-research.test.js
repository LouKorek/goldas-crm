// The research dossier: what may be stated as fact (only what carries a
// source), who may see money, the ceilings on what one job costs, the limits
// on how many are asked for, the job that got stuck, the file that is kept,
// and the PDF itself. A fake model client and a fake Firestore: no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fakeDb, stubFirestore, OWNER, MANAGER } = require('./fake-firestore.js');

let DB;
stubFirestore(() => DB);
const research = require('../golda-research.js');
const { cleanDossier, runResearch, researchTools, pickStuck, kickStuck, stepsFor, doneText, failedText } = research;
const { systemFor } = research._internal;
const { toolsFor, systemPrompt } = require('../wa-agent.js');

const NOW = Date.parse('2026-11-25T10:00:00Z');   // 12:00 in Israel
const DAY = '2026-11-25';
const MIN = 60000;
const LOU = { email: OWNER.email, name: OWNER.name, role: 'admin', phone: OWNER.whatsapp };
const DANI = { email: MANAGER.email, name: MANAGER.name, role: 'manager', phone: MANAGER.whatsapp };
const src = (p) => `https://www.example.com/${p}`;

// ── fakes ───────────────────────────────────────────────────────────────────
const stepOf = (req) => (req.system.includes('"valueEstimate":{') ? 'market' : req.system.includes('"decisionMakers":[') ? 'people' : 'profile');
const PARTS = {
  profile: {
    headline: { text: 'ZZHEAD קשר התקפי בן 21', source: src('p') },
    profile: [{ text: 'ZZSOURCED נולד ב-2005', source: src('p') }, { text: 'ZZUNSOURCED אחיו משחק בנוער', source: '' }, { text: 'ZZNOTURL גובה 1.78', source: 'transfermarkt' }],
    stats: [{ label: 'שערים', value: '6', source: src('stats') }, { label: 'דירוג', value: '7.1' }],
    unverified: ['ZZGUESS ייתכן שיש לו סוכן נוסף'],
  },
  market: {
    headline: { text: 'ערכו מוערך בטווח', source: src('value') },
    contract: [{ text: 'ZZMONEY שכר של 180 אלף אירו לעונה', source: src('salary') }],
    valueEstimate: { low: 300000, high: 450000, currency: 'EUR', basis: 'שחקנים דומים',
      comparables: [{ name: 'Tomer Ashbel', detail: 'עבר ב-400 אלף אירו', source: src('ashbel') }, { name: 'Ido Karmeli', detail: 'נמכר ב-320 אלף', source: src('karmeli') }, { name: 'Rafael Dimitrescu', detail: 'בלי אישור' }] },
  },
  people: {
    headline: { text: 'המאמן מתנגד למכירה', source: src('coach') },
    decisionMakers: [{ name: 'Marek Dolvansky', role: 'מנהל מקצועי', note: 'מנהל את המשא ומתן', source: src('staff') }, { name: 'Nir Tzalach', role: 'ראש מחלקת הנוער' }],
    risks: [{ text: 'פציעת שריר ירך', source: src('injury') }, { text: 'ZZRUMOUR שמועה על עניין מיוון' }],
  },
};
const SMALL = { input_tokens: 20000, output_tokens: 3000, server_tool_use: { web_search_requests: 4 } };   // about 0.18 dollars
const answer = (json, { usage = SMALL, stop = 'end_turn', results = [] } = {}) => ({
  stop_reason: stop, usage,
  content: [...(results.length ? [{ type: 'web_search_tool_result', content: results.map((url) => ({ type: 'web_search_result', url })) }] : []), { type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }],
});
/** A model client that answers each part with `reply(step, req, n)` and remembers what it was asked. */
function fakeClient(reply = (step) => answer(PARTS[step])) {
  const calls = [];
  return { calls, beta: { messages: { stream: (req) => { calls.push(req); const n = calls.length; return { finalMessage: async () => reply(stepOf(req), req, n) }; } } } };
}
function fakeApi() {
  const texts = [], docs = [];
  return { texts, docs,
    sendText: async (to, body) => { texts.push({ to, body }); return [`wamid.t${texts.length}`]; },
    sendDocument: async (to, file) => { docs.push({ to, filename: file.filename, bytes: file.buffer.length }); return [`wamid.d${docs.length}`]; },
    sendTemplate: async () => 'wamid.tpl' };
}
const fakePdf = () => { const made = []; return Object.assign(async (dossier) => { made.push(dossier); return { buffer: Buffer.from('%PDF-1.3 a dossier'), filename: `תחקיר - ${dossier.subject} - Gold A&S.pdf`, mimeType: 'application/pdf' }; }, { made }); };
const PLAYER = { fullName: 'Elior Zamirov', dob: '2005-03-03', primaryPosition: 'Attacking Midfielder', currentClub: 'Hapoel Givat Dekel', nationalities: ['Israel'], contractEnd: '2027-06-30',
  notes: 'ZZPRIVATENOTE המשפחה מעדיפה אירופה', contractTerms: { salary: 15123, currency: 'EUR', salaryPeriod: 'month', releaseClause: 600000 } };
const jobRow = (asker = LOU, over = {}) => ({ status: 'queued', subject: 'Elior Zamirov', kind: 'player', playerId: 'p1', clubName: '', askedBy: asker.email,
  asker: { name: asker.name, phone: asker.phone, role: asker.role, channel: 'whatsapp' }, day: DAY, attempts: 0, dossier: null, file: null, costUsd: 0, calls: 0, error: null, createdAt: NOW, startedAt: null, doneAt: null, ...over });
function seed({ asker = LOU, job = {}, extra = {} } = {}) {
  return fakeDb({
    players: { p1: PLAYER }, golda_research: { r1: jobRow(asker, job) },
    wa_contacts: { [LOU.phone]: { lastInbound: NOW - 30 * MIN }, [DANI.phone]: { lastInbound: NOW - 30 * MIN } },
    ...extra,
  });
}
async function run(opts = {}) {
  const client = opts.client || fakeClient();
  const api = fakeApi(), pdf = opts.pdf || fakePdf(), notes = [];
  const r = await runResearch(DB, 'r1', { client, now: NOW, clock: opts.clock, job: { note: (s) => notes.push(s) }, api, pdf });
  return { r, client, api, pdf, notes, row: DB.read('golda_research', 'r1') };
}
const facts = (d) => [...d.summary, ...d.profile, ...d.stats, ...d.contract.items, ...d.decisionMakers, ...d.risks, ...(d.value ? d.value.comparables : [])];

// ── what may be stated as fact ──────────────────────────────────────────────
test('a claim stays a fact only with the address of its source; the rest moves to "not verified"', () => {
  const d = cleanDossier({ subject: 'Elior Zamirov', kind: 'player', ...PARTS.profile, ...PARTS.people, headlines: [PARTS.profile.headline, { text: 'כותרת בלי מקור' }] }, { money: true });
  for (const c of facts(d)) assert.ok(c.refs.length >= 1, JSON.stringify(c));
  for (const c of facts(d)) for (const n of c.refs) assert.match(d.sources[n - 1].url, /^https:\/\//);
  const stated = JSON.stringify(facts(d));
  for (const mark of ['ZZUNSOURCED', 'ZZNOTURL', 'ZZGUESS', 'ZZRUMOUR', 'Nir Tzalach', 'דירוג', 'כותרת בלי מקור']) assert.ok(!stated.includes(mark), mark);
  const loose = d.notVerified.map((u) => u.text).join(' | ');
  for (const mark of ['ZZUNSOURCED', 'ZZNOTURL', 'ZZGUESS', 'ZZRUMOUR', 'Nir Tzalach', 'דירוג: 7.1']) assert.ok(loose.includes(mark), mark);
  assert.ok(!loose.includes('כותרת בלי מקור'));      // a headline repeats a claim: without a source it is simply dropped
  assert.deepEqual(d.sources.map((s) => s.n), d.sources.map((_, i) => i + 1));
  assert.equal(new Set(d.sources.map((s) => s.url)).size, d.sources.length);
});

test('a source is an http address and nothing else', () => {
  const d = cleanDossier({ subject: 'X', kind: 'club', profile: [
    { text: 'א', source: 'javascript:alert(1)' }, { text: 'ב', source: 'ftp://files.example.com/a' }, { text: 'ג', source: 'www.example.com/no-scheme' },
    { text: 'ד', source: 'https://www.example.com/page#part' }, { text: 'ה', sources: ['', 'https://football.example.org/x'] },
  ] }, {});
  assert.deepEqual(d.profile.map((c) => c.text), ['ד', 'ה']);
  assert.deepEqual(d.sources.map((s) => s.url), ['https://www.example.com/page', 'https://football.example.org/x']);
  assert.equal(d.notVerified.length, 3);
});

test('when the searches showed their results, a claim that names a page from elsewhere is not taken as sourced', () => {
  const json = { subject: 'X', kind: 'club', profile: [{ text: 'מהתוצאות', source: 'https://www.example.com/a' }, { text: 'ממקום אחר', source: 'https://invented.example.net/b' }] };
  const strict = cleanDossier(json, { seenHosts: new Set(['example.com']) });
  assert.deepEqual(strict.profile.map((c) => c.text), ['מהתוצאות']);
  assert.equal(strict.notVerified[0].text, 'ממקום אחר');
  assert.match(strict.notVerified[0].why, /לא הופיע בתוצאות/);
  // No results were visible in the answers: the address itself is what is checked.
  assert.equal(cleanDossier(json, { seenHosts: new Set() }).profile.length, 2);
});

test('a value estimate is a range resting on sourced comparables, or it is not given', () => {
  const ok = cleanDossier({ subject: 'X', kind: 'player', valueEstimate: PARTS.market.valueEstimate }, {});
  assert.equal(ok.value.text, 'בין 300 ל-450 אלף אירו');
  assert.deepEqual(ok.value.comparables.map((c) => c.name), ['Tomer Ashbel', 'Ido Karmeli']);
  assert.ok(ok.notVerified.some((u) => u.text.includes('Rafael Dimitrescu')));
  const one = cleanDossier({ subject: 'X', kind: 'player', valueEstimate: { low: 400000, high: 400000, currency: 'EUR', comparables: PARTS.market.valueEstimate.comparables } }, {});
  assert.equal(one.value, null);                      // one number is not an estimate
  assert.ok(one.notVerified.some((u) => /לא ניתנה כטווח/.test(u.why)));
  const bare = cleanDossier({ subject: 'X', kind: 'player', valueEstimate: { low: 300000, high: 450000, currency: 'EUR', comparables: [{ name: 'Rafael Dimitrescu' }] } }, {});
  assert.equal(bare.value, null);
  assert.ok(bare.notVerified.some((u) => /בין 300 ל-450/.test(u.text) && /השוואות/.test(u.why)));
  assert.match(doneText(ok), /הערכת שווי: בין 300 ל-450 אלף אירו \(הערכה בלבד\)/);
});

// ── money ───────────────────────────────────────────────────────────────────
test('money is in the dossier for an admin and closed for anyone else', () => {
  const json = { subject: 'X', kind: 'player', contract: PARTS.market.contract, own: { profile: [{ label: 'מועדון', value: 'Hapoel Givat Dekel' }], contract: [{ label: 'שכר', value: 'ZZOWNMONEY 15,123 EUR' }] } };
  const open = cleanDossier(json, { money: true });
  assert.equal(open.contract.restricted, false);
  assert.match(open.contract.items[0].text, /ZZMONEY/);
  assert.match(open.own.contract[0].value, /ZZOWNMONEY/);
  const closed = cleanDossier(json, { money: false });
  assert.deepEqual(closed.contract, { restricted: true, items: [] });
  assert.deepEqual(closed.own.contract, []);
  assert.ok(!JSON.stringify(closed).includes('ZZMONEY') && !JSON.stringify(closed).includes('ZZOWNMONEY'));
  assert.equal(closed.own.profile.length, 1);          // what is not money stays
  assert.equal(cleanDossier(json).contract.restricted, true);   // closed unless said otherwise
});

test('a manager\'s job does not ask the web about money, and the CRM\'s money rows are not read into it', async () => {
  assert.ok(stepsFor('player', true).some((s) => s.sections.includes('contract')));
  assert.ok(!stepsFor('player', false).some((s) => s.sections.includes('contract')));
  assert.ok(!stepsFor('club', false).some((s) => s.sections.includes('contract')));
  const market = stepsFor('player', false).find((s) => s.key === 'market');
  assert.match(systemFor(market, false), /Do not look for and do not report salaries/);
  assert.ok(!systemFor(market, false).includes('"contract"'));

  DB = seed({ asker: DANI });
  const m = await run();
  assert.equal(m.row.status, 'done');
  assert.equal(m.row.dossier.contract.restricted, true);
  assert.ok(!JSON.stringify(m.row.dossier).includes('ZZMONEY'));     // the model answered it anyway: it is dropped
  assert.ok(!JSON.stringify(m.row.dossier).includes('15,123'));

  DB = seed({ asker: LOU });
  const a = await run();
  assert.equal(a.row.dossier.contract.restricted, false);
  assert.match(a.row.dossier.contract.items[0].text, /ZZMONEY/);
  assert.ok(a.row.dossier.own.contract.some((r) => r.value.includes('15,123')));
});

test('what the model is given about the subject holds no money and no private note', async () => {
  DB = seed();
  const { client } = await run();
  const sent = JSON.stringify(client.calls.map((c) => c.messages));
  assert.ok(sent.includes('Elior Zamirov') && sent.includes('Hapoel Givat Dekel'));
  for (const secret of ['ZZPRIVATENOTE', '15123', '600000']) assert.ok(!sent.includes(secret), secret);
});

// ── a whole run ─────────────────────────────────────────────────────────────
test('a run: three searches, each recorded as research, a cleaned dossier, the PDF to the asker only', async () => {
  DB = seed();
  const { r, client, api, pdf, notes, row } = await run();
  assert.equal(r.status, 'done');
  assert.equal(client.calls.length, 3);
  for (const c of client.calls) {
    assert.equal(c.model, 'claude-opus-5-5');
    assert.equal(c.output_config.effort, 'high');
    assert.deepEqual(c.tools.map((t) => t.type), ['web_search_20260209']);
  }
  const ledger = DB.read('golda_cost', DAY);
  assert.equal(ledger.byKind.research.calls, 3);
  assert.ok(Math.abs(ledger.byKind.research.usd - row.costUsd) < 0.011);
  assert.equal(row.status, 'done');
  assert.equal(row.attempts, 1);
  assert.equal(row.error, null);
  assert.equal(row.work, null);
  assert.equal(row.dossier.meta.madeOn, DAY);
  assert.equal(row.dossier.meta.calls, 3);
  assert.ok(row.dossier.own.profile.some((x) => x.label === 'ההערות שלנו'));      // our own data is in, under its own heading
  for (const c of facts(pdf.made[0])) assert.ok(c.refs.length >= 1);              // nothing unsourced reaches the PDF as fact
  assert.ok(!JSON.stringify(facts(pdf.made[0])).includes('ZZUNSOURCED'));
  // The stored file belongs to the job.
  assert.match(row.file.fileId, /^golda_/);
  assert.equal(DB.read('files', row.file.fileId).uploadedBy, LOU.email);
  // To the asker only: the document, then two lines.
  assert.deepEqual(api.docs.map((d) => d.to), [LOU.phone]);
  assert.deepEqual(api.texts.map((t) => t.to), [LOU.phone]);
  const lines = api.texts[0].body.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '*התחקיר על Elior Zamirov מוכן* 📑');
  assert.match(lines[1], /ממצאים עם מקור, \d+ לא מאומתים\. הערכת שווי: בין 300 ל-450 אלף אירו \(הערכה בלבד\)\.$/);
  const outbox = DB.all('wa_outbox');
  assert.deepEqual(outbox.map((o) => [o.to, o.kind, o.ref]), [[LOU.phone, 'research', { type: 'research', id: 'r1' }]]);
  // And in the asker's own chat, with the file, so the app shows it.
  const history = DB.read(`wa_sessions/${LOU.phone}/threads`, 'main').history;
  assert.equal(history.length, 1);
  assert.equal(history[0].proactive, 'research');
  assert.equal(history[0].files[0].fileId, row.file.fileId);
  // The job's notes are numbers and states: nothing of what was asked or found.
  const said = notes.join(' | ');
  assert.match(said, /done: 3 calls/);
  for (const secret of ['Elior', 'Zamirov', 'ZZ', 'example.com']) assert.ok(!said.includes(secret), secret);
});

test('a closed window: the lines wait in the outbox and say how to get the file', async () => {
  DB = seed({ extra: { wa_contacts: { [LOU.phone]: { lastInbound: NOW - 30 * 3600000 } } } });
  const { api, row } = await run();
  assert.equal(row.status, 'done');
  assert.equal(api.docs.length, 0);
  const queued = DB.all('wa_outbox').filter((o) => o.state === 'queued');
  assert.equal(queued.length, 1);
  assert.match(queued[0].body, /שלחי את התחקיר/);
});

test('a search that pauses is sent back, and each answer is one recorded call', async () => {
  DB = seed({ job: { kind: 'person', playerId: '', subject: 'Marek Dolvansky' } });
  const client = fakeClient((step, req) => (step === 'profile' && req.messages.length === 1 ? answer('', { stop: 'pause_turn' }) : answer(PARTS[step])));
  const { r } = await run({ client });
  assert.equal(r.status, 'done');
  assert.equal(client.calls.length, 3);                // profile, profile again, people
  assert.equal(client.calls[1].messages.length, 2);
  assert.equal(DB.read('golda_cost', DAY).byKind.research.calls, 3);
});

// ── the ceilings ────────────────────────────────────────────────────────────
test('the day\'s ceiling is closed: the job ends politely and no model call is made', async () => {
  DB = seed({ extra: { golda_cost: { [DAY]: { totalUsd: 6, backgroundUsd: 5, calls: 40 } } } });
  const { r, client, api, pdf, notes, row } = await run();
  assert.equal(client.calls.length, 0);
  assert.equal(pdf.made.length, 0);
  assert.deepEqual([r.status, r.error, row.status, row.error], ['failed', 'cap', 'failed', 'cap']);
  assert.equal(api.docs.length, 0);
  assert.equal(api.texts.length, 1);
  assert.equal(api.texts[0].to, LOU.phone);
  assert.match(api.texts[0].body, /^לו, לא התחלתי את התחקיר על Elior Zamirov: הגעתי היום לתקרת העלות/);
  assert.match(api.texts[0].body, /אפשר לבקש אותו שוב מחר/);
  assert.match(notes.join(' '), /ceiling is reached \(5 of 5 USD\): no call made/);
  assert.equal(DB.read('golda_cost', DAY).calls, 40);  // nothing was added to the ledger
});

test('the job\'s own ceiling: once it has cost 1.5 dollars no further call is made, and it finishes with what there is', async () => {
  DB = seed({ extra: { app_meta: { goldaCost: { capUsd: 50 } } } });
  const dear = { input_tokens: 390000, output_tokens: 3000 };       // about 1.62 dollars
  const { r, client, row, api } = await run({ client: fakeClient((step) => answer(PARTS[step], { usage: dear })) });
  assert.equal(client.calls.length, 1);
  assert.ok(row.costUsd >= 1.5);
  assert.deepEqual([r.status, r.stoppedBy, row.status], ['done', 'cost', 'done']);
  assert.equal(row.dossier.meta.stoppedBy, 'cost');
  assert.ok(row.dossier.profile.length >= 1);
  assert.equal(row.dossier.value, null);                // the part that was never asked is simply not there
  assert.match(api.texts[0].body, /תקרת העלות של תחקיר אחד, אז הוא חלקי/);
});

test('ten minutes: no further call after them', async () => {
  DB = seed();
  let t = 0;
  const client = fakeClient((step) => { t += 6 * MIN; return answer(PARTS[step]); });
  const { r, row } = await run({ client, clock: () => t });
  assert.equal(client.calls.length, 2);                 // the third would start after twelve minutes
  assert.deepEqual([r.status, r.stoppedBy], ['done', 'time']);
  assert.equal(row.dossier.meta.stoppedBy, 'time');
});

test('the day\'s ceiling reached in the middle stops the next call too', async () => {
  DB = seed({ extra: { app_meta: { goldaCost: { capUsd: 1 } } } });
  const { r, client } = await run({ client: fakeClient((step) => answer(PARTS[step], { usage: { input_tokens: 270000, output_tokens: 1000 } })) });   // about 1.1 dollars
  assert.equal(client.calls.length, 1);
  assert.deepEqual([r.status, r.stoppedBy], ['done', 'cap']);
});

test('nothing usable came back: the job fails with a state word and the asker is told', async () => {
  DB = seed();
  const { r, row, api, pdf } = await run({ client: fakeClient(() => answer('I could not find anything.')) });
  assert.deepEqual([r.status, r.error, row.error], ['failed', 'search_failed', 'search_failed']);
  assert.equal(pdf.made.length, 0);
  assert.match(api.texts[0].body, /לא הצלחתי להשלים את התחקיר על Elior Zamirov/);
  assert.ok(row.costUsd > 0);                           // what it cost is still counted
});

test('an error keeps no private text: the row holds a state word, the notes a kind', async () => {
  DB = seed();
  const client = { beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('ZZLEAK Elior Zamirov salary 15123'); } }) } } };
  const { row, notes } = await run({ client });
  assert.equal(row.error, 'search_failed');
  assert.ok(!JSON.stringify(row).includes('ZZLEAK') && !notes.join(' ').includes('ZZLEAK'));
  DB = seed();
  const broken = await run({ pdf: async () => { throw new Error('ZZLEAK in the pdf'); } });
  assert.deepEqual([broken.row.status, broken.row.error], ['failed', 'pdf']);
  assert.ok(broken.row.dossier.profile.length >= 1);    // what was found is kept
  assert.ok(!JSON.stringify(broken.row).includes('ZZLEAK') && !broken.notes.join(' ').includes('ZZLEAK'));
});

// ── the stuck job ───────────────────────────────────────────────────────────
test('a job is stuck after twenty minutes in the queue or in a run, not before', () => {
  const rows = [
    { id: 'fresh', status: 'queued', createdAt: NOW - 19 * MIN }, { id: 'lost', status: 'queued', createdAt: NOW - 21 * MIN },
    { id: 'working', status: 'running', createdAt: NOW - 40 * MIN, startedAt: NOW - 12 * MIN }, { id: 'dead', status: 'running', createdAt: NOW - 50 * MIN, startedAt: NOW - 25 * MIN },
    { id: 'done', status: 'done', createdAt: NOW - 90 * MIN }, { id: 'failed', status: 'failed', createdAt: NOW - 90 * MIN },
  ];
  assert.deepEqual(pickStuck(rows, NOW).map((r) => r.id), ['dead', 'lost']);
});

test('the queue check wakes the worker again for stuck jobs, three a round, and never throws', async () => {
  DB = fakeDb({ golda_research: {
    a: jobRow(LOU, { createdAt: NOW - 30 * MIN }), b: jobRow(DANI, { status: 'running', createdAt: NOW - 60 * MIN, startedAt: NOW - 30 * MIN }),
    c: jobRow(LOU, { createdAt: NOW - 5 * MIN }), d: jobRow(LOU, { status: 'done', createdAt: NOW - 30 * MIN }),
  } });
  const woke = [];
  assert.equal(await kickStuck(DB, { now: NOW, kick: async (id) => { woke.push(id); } }), 2);
  assert.deepEqual(woke.sort(), ['a', 'b']);
  assert.equal(await kickStuck(DB, { now: NOW, kick: async () => { throw new Error('down'); } }), 0);
  assert.equal(await kickStuck({ collection: () => { throw new Error('no database'); } }, { now: NOW }), 0);
});

test('a run in progress is left alone; a dead one is taken once more; after two attempts the job is given up', async () => {
  DB = seed({ job: { status: 'running', attempts: 1, startedAt: NOW - 5 * MIN } });
  const busy = await run();
  assert.deepEqual([busy.r.status, busy.client.calls.length, busy.row.attempts], ['skipped', 0, 1]);

  // The first run died after its first part: the second goes on from there.
  DB = seed({ job: { status: 'running', attempts: 1, startedAt: NOW - 21 * MIN, costUsd: 0.2, calls: 1, work: { done: { profile: PARTS.profile }, seen: [] } } });
  const again = await run();
  assert.deepEqual(again.client.calls.map(stepOf), ['market', 'people']);
  assert.deepEqual([again.row.status, again.row.attempts, again.row.calls], ['done', 2, 3]);
  assert.ok(again.row.dossier.profile.some((c) => c.text.includes('ZZSOURCED')));
  assert.ok(again.row.costUsd > 0.2);

  DB = seed({ job: { status: 'running', attempts: 2, startedAt: NOW - 21 * MIN } });
  const over = await run();
  assert.equal(over.client.calls.length, 0);
  assert.deepEqual([over.r.status, over.row.status, over.row.error], ['failed', 'failed', 'gave_up']);
  assert.match(over.api.texts[0].body, /לא הצלחתי להשלים/);

  DB = seed({ job: { status: 'done' } });
  assert.equal((await run()).r.status, 'skipped');       // a finished job is never run again
  DB = fakeDb({});
  assert.equal((await runResearch(DB, 'nope', { client: fakeClient(), now: NOW })).status, 'skipped');
});

// ── the tools ───────────────────────────────────────────────────────────────
function tools(identity, { now = NOW, kick } = {}) {
  const woke = [], state = { outFiles: [] };
  const t = researchTools({ db: DB, identity, role: identity.role, channel: 'whatsapp', state, kick: kick || (async (id) => { woke.push(id); }), now: () => now });
  return { ...t, woke, state };
}

test('research_start writes the job, wakes the worker and answers at once', async () => {
  DB = fakeDb({ players: { p1: PLAYER } });
  const t = tools(LOU);
  const out = await t.research_start({ subject: '', kind: 'player', playerId: 'p1' });
  assert.equal(out.started, true);
  assert.match(out.say, /^התחקיר על Elior Zamirov יצא לדרך\. זה לוקח כמה דקות, והוא יגיע לכאן כקובץ PDF/);
  assert.deepEqual(t.woke, [out.id]);
  const row = DB.read('golda_research', out.id);
  assert.deepEqual([row.status, row.subject, row.kind, row.playerId, row.askedBy, row.day, row.attempts], ['queued', 'Elior Zamirov', 'player', 'p1', LOU.email, DAY, 0]);
  assert.deepEqual(row.asker, { name: LOU.name, phone: LOU.phone, role: 'admin', channel: 'whatsapp' });
  assert.equal(out.leftToday, 2);
  await assert.rejects(t.research_start({ subject: 'X', kind: 'team' }), /kind must be/);
  await assert.rejects(t.research_start({ subject: '', kind: 'club' }), /subject is required/);
  await assert.rejects(t.research_start({ subject: 'X', kind: 'player', playerId: 'nobody' }), /no such player/);
});

test('a wake-up call that fails does not lose the job: the queue check will send it again', async () => {
  DB = fakeDb({});
  const t = tools(LOU, { kick: async () => { throw new Error('network'); } });
  const out = await t.research_start({ subject: 'FC Carmel Coast', kind: 'club' });
  assert.deepEqual([out.started, out.woke], [true, false]);
  assert.equal(DB.read('golda_research', out.id).clubName, 'FC Carmel Coast');
});

test('one job per writer at a time, and three a day, said kindly', async () => {
  DB = fakeDb({});
  const lou = tools(LOU);
  const first = await lou.research_start({ subject: 'FC Carmel Coast', kind: 'club' });
  const second = await lou.research_start({ subject: 'Marek Dolvansky', kind: 'person' });
  assert.deepEqual([second.started, second.refused], [false, 'running']);
  assert.equal(second.say, 'כבר יש תחקיר אחד שלך בעבודה (FC Carmel Coast). כשהוא יסתיים אפשר לבקש את הבא.');
  assert.equal(DB.all('golda_research').length, 1);
  // Another writer is not held back by it.
  assert.equal((await tools(DANI).research_start({ subject: 'Marek Dolvansky', kind: 'person' })).started, true);

  const finish = (id, over = { status: 'done' }) => DB.collection('golda_research').doc(id).set(over, { merge: true });
  await finish(first.id);
  const b = await lou.research_start({ subject: 'B', kind: 'club' });
  await finish(b.id, { status: 'failed', error: 'search_failed', costUsd: 0.4 });      // it cost something: it counts
  const c = await lou.research_start({ subject: 'C', kind: 'club' });
  await finish(c.id);
  const fourth = await lou.research_start({ subject: 'D', kind: 'club' });
  assert.deepEqual([fourth.started, fourth.refused, fourth.say], [false, 'daily_limit', 'הגענו לשלושה תחקירים היום. מחר אפשר להזמין עוד.']);
  // Tomorrow is a new day.
  assert.equal((await tools(LOU, { now: NOW + 24 * 3600000 }).research_start({ subject: 'D', kind: 'club' })).started, true);
});

test('a job the day\'s ceiling refused before any call does not use up one of the three', async () => {
  DB = fakeDb({ golda_research: {
    x1: jobRow(LOU, { status: 'failed', error: 'cap' }), x2: jobRow(LOU, { status: 'failed', error: 'cap' }), x3: jobRow(LOU, { status: 'failed', error: 'no_key' }),
  } });
  assert.equal((await tools(LOU).research_start({ subject: 'A', kind: 'club' })).started, true);
});

test('a job abandoned long ago no longer blocks a new one', async () => {
  DB = fakeDb({ golda_research: { old: jobRow(LOU, { status: 'running', day: '2026-11-24', createdAt: NOW - 3 * 3600000, startedAt: NOW - 3 * 3600000 }) } });
  assert.equal((await tools(LOU).research_start({ subject: 'A', kind: 'club' })).started, true);
});

test('the research tools are for admins and managers; a viewer and a player do not get them', async () => {
  const names = (role) => toolsFor(role).map((t) => t.name).filter((n) => n.startsWith('research_'));
  assert.deepEqual(names('admin'), ['research_start', 'research_status']);
  assert.deepEqual(names('manager'), ['research_start', 'research_status']);
  assert.deepEqual(names('viewer'), []);
  assert.deepEqual(names('player'), []);
  DB = fakeDb({});
  await assert.rejects(tools({ email: 'v@x.com', name: 'צופה', role: 'viewer', phone: '' }).research_start({ subject: 'A', kind: 'club' }), /admins and managers/);
  assert.match(systemPrompt('גולדה', { name: 'לו', role: 'admin' }), /research_start/);
});

test('research_status: what is running, the last dossiers, and a finished PDF again', async () => {
  DB = seed();
  const done = await run();
  await DB.collection('golda_research').doc('r2').set(jobRow(DANI, { subject: 'FC Carmel Coast', kind: 'club', createdAt: NOW + MIN }));
  const lou = tools(LOU, { now: NOW + 2 * MIN });
  const all = await lou.research_status({});
  assert.deepEqual(all.running.map((r) => [r.id, r.askedBy]), [['r2', DANI.name]]);      // an admin sees everyone's
  assert.deepEqual(all.last.map((r) => [r.id, r.status, r.hasFile]), [['r1', 'done', true]]);
  assert.match(all.last[0].valueEstimate, /בין 300 ל-450 אלף אירו \(הערכה בלבד\)/);
  assert.equal(all.leftToday, 2);

  const sent = await lou.research_status({ send: true });
  assert.equal(sent.sent, true);
  assert.equal(lou.state.outFiles.length, 1);
  assert.equal(lou.state.outFiles[0].buffer.toString(), '%PDF-1.3 a dossier');
  assert.equal(lou.state.outFiles[0].filename, done.row.file.name);
  assert.equal(sent.dossier.contract.startsWith('restricted'), false);

  // A manager sees only their own, and cannot read or get an admin's dossier.
  const dani = tools(DANI, { now: NOW + 2 * MIN });
  const own = await dani.research_status({});
  assert.deepEqual([own.running.map((r) => r.id), own.last], [['r2'], []]);
  assert.equal(own.running[0].askedBy, undefined);
  await assert.rejects(dani.research_status({ id: 'r1', send: true }), /no such dossier/);
  assert.equal(dani.state.outFiles.length, 0);
  assert.deepEqual((await dani.research_status({ send: true })).sent, false);
});

// ── the file is kept ────────────────────────────────────────────────────────
test('the nightly cleanup keeps a dossier\'s stored file and still removes a file nothing refers to', async () => {
  const old = new Date(NOW - 30 * 86400000).toISOString();
  const base = fakeDb({
    files: { f_dossier: { name: 'תחקיר.pdf', uploadedAt: old, parts: 1 }, f_orphan: { name: 'old.pdf', uploadedAt: old, parts: 1 }, f_new: { name: 'new.pdf', uploadedAt: new Date().toISOString(), parts: 1 } },
    'files/f_dossier/chunks': { 0: { data: 'data:application/pdf;base64,AAAA' } }, 'files/f_orphan/chunks': { 0: { data: 'data:application/pdf;base64,BBBB' } },
    golda_research: { r1: jobRow(LOU, { status: 'done', file: { fileId: 'f_dossier', name: 'תחקיר.pdf', type: 'application/pdf' } }), r2: jobRow(LOU, { status: 'failed', file: null }) },
  });
  // The fake has no batch: deletes are applied at commit.
  DB = { ...base, batch: () => { const refs = []; return { delete: (ref) => refs.push(ref), commit: async () => { for (const ref of refs) await ref.delete(); } }; } };
  const { runOrphanCleanup } = require(path.join(__dirname, '..', '..', 'nightly-engines.js'))._internal;
  const notes = [];
  const removed = await runOrphanCleanup(DB, { players: [], deals: [] }, { note: (s) => notes.push(s) });
  assert.equal(removed, 1);
  assert.ok(base.read('files', 'f_dossier'), 'the dossier file is kept');
  assert.ok(base.read('files/f_dossier/chunks', '0'));
  assert.equal(base.read('files', 'f_orphan'), undefined);
  assert.equal(base.read('files/f_orphan/chunks', '0'), undefined);
  assert.ok(base.read('files', 'f_new'));
});

// ── her words ───────────────────────────────────────────────────────────────
test('what she says about a dossier is Hebrew without a dash as punctuation', () => {
  const d = cleanDossier({ subject: 'Elior Zamirov', kind: 'player', ...PARTS.profile, valueEstimate: PARTS.market.valueEstimate, meta: { stoppedBy: 'time' } }, {});
  const row = jobRow(LOU);
  const said = [doneText(d), doneText(d, { fileSent: false }), failedText(row, 'cap'), failedText(row, 'gave_up'), research.researchSection(), ...research.RESEARCH_TOOL_DEFS.map((t) => t.description)];
  for (const s of said) assert.ok(!/[–—]/.test(s), s);
  // A dash the model wrote as punctuation does not reach the dossier either.
  assert.equal(cleanDossier({ subject: 'X', kind: 'club', profile: [{ text: 'נבחר לשחקן החודש — לראשונה', source: src('a') }] }, {}).profile[0].text, 'נבחר לשחקן החודש, לראשונה');
});

// ── the PDF ─────────────────────────────────────────────────────────────────
let loaded;
function load() {
  if (loaded) return loaded;
  const root = path.join(__dirname, '..', '..', '..', '..');
  const out = require('esbuild').buildSync({
    stdin: { contents: "module.exports = { dossier: require('./apps/web/src/lib/dossierPdf.js'), fonts: require('./apps/web/src/lib/pdfFonts.js'), jspdf: require('jspdf') };", resolveDir: root, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')],
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); // eslint-disable-line no-new-func
  loaded = { buildDossier: m.exports.dossier.buildDossier, dossierSafe: m.exports.dossier.dossierSafe, fonts: m.exports.fonts, jsPDF: m.exports.jspdf.jsPDF };
  return loaded;
}
/** The same loader, with every line the builder draws written down. */
function spying() {
  const real = load(), drawn = [];
  function Spy(opts) {
    const doc = new real.jsPDF(opts);
    const text = doc.text.bind(doc);
    doc.text = (t, ...rest) => { drawn.push(...(Array.isArray(t) ? t : [t]).map(String)); return text(t, ...rest); };
    return doc;
  }
  return { drawn, load: () => ({ ...real, jsPDF: Spy }) };
}
const { dossierPdf } = require('../golda-pdf.js');
const whole = (money) => cleanDossier({ subject: 'Elior Zamirov', kind: 'player', headlines: [PARTS.profile.headline], ...PARTS.profile, ...PARTS.market, ...PARTS.people,
  own: { profile: [{ label: 'מועדון', value: 'ZZOWN Hapoel Givat Dekel' }], contract: [{ label: 'שכר', value: 'ZZOWNMONEY 15,123 EUR' }] }, meta: { madeOn: DAY, costUsd: 0.84, calls: 3 } }, { money });

test('the PDF builds for a short dossier and for a long one', { timeout: 120000 }, async () => {
  const short = cleanDossier({ subject: 'Marek Dolvansky', kind: 'person', profile: [{ text: 'מנהל מקצועי', source: src('staff') }], meta: { madeOn: DAY, costUsd: 0.2 } }, {});
  const a = await dossierPdf(short, { load, logo: null });
  assert.equal(a.mimeType, 'application/pdf');
  assert.equal(a.buffer.slice(0, 5).toString(), '%PDF-');
  assert.equal(a.filename, 'תחקיר - Marek Dolvansky - Gold A&S.pdf');
  assert.ok(a.pages <= 2);

  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const long = cleanDossier({ subject: 'Elior Zamirov', kind: 'player',
    headlines: many(4, (i) => ({ text: `ממצא מרכזי מספר ${i + 1} על השחקן`, source: src(`h${i}`) })),
    profile: many(12, (i) => ({ text: `עובדה מספר ${i + 1} על הקריירה שלו, עם כמה מילים כדי שהשורה תהיה ארוכה ותישבר לשתי שורות בעמוד, Hapoel Givat Dekel ${2010 + i}`, source: src(`p${i}`) })),
    stats: many(14, (i) => ({ label: `נתון ${i + 1}`, value: String(i * 3), source: src(`s${i}`) })),
    contract: many(6, (i) => ({ text: `פרט חוזה ${i + 1}`, source: src(`c${i}`) })),
    valueEstimate: { low: 1200000, high: 1800000, currency: 'EUR', basis: 'שחקנים דומים', comparables: many(6, (i) => ({ name: `Player ${i}`, detail: 'עבר בסכום דומה', source: src(`v${i}`) })) },
    decisionMakers: many(8, (i) => ({ name: `Person ${i}`, role: 'תפקיד', note: 'הערה על האיש ועל מה שהוא מחליט', source: src(`d${i}`) })),
    risks: many(12, (i) => ({ text: `סיכון מספר ${i + 1}`, source: src(`r${i}`) })),
    unverified: many(15, (i) => `טענה לא מאומתת ${i + 1}`),
    own: { profile: many(10, (i) => ({ label: `שדה ${i}`, value: `ערך ${i}` })), contract: [{ label: 'שכר', value: '15,000 EUR לחודש' }] },
    meta: { madeOn: DAY, costUsd: 1.52, calls: 4, stoppedBy: 'cost' } }, { money: true });
  assert.equal(long.value.text, 'בין 1.2 ל-1.8 מיליון אירו');
  const b = await dossierPdf(long, { load, logo: null });
  assert.equal(b.buffer.slice(0, 5).toString(), '%PDF-');
  assert.ok(b.pages >= 3, `${b.pages} pages`);
  assert.ok(b.buffer.length < 1024 * 1024);              // far under what WhatsApp takes as a document
});

test('in the PDF an unsourced claim is drawn only in the "not verified" list, after the sources', { timeout: 120000 }, async () => {
  const spy = spying();
  const d = whole(true);
  await dossierPdf(d, { load: spy.load, logo: null });
  const at = (mark) => spy.drawn.map((s, i) => (s.includes(mark) ? i : -1)).filter((i) => i >= 0);
  const firstSource = spy.drawn.findIndex((s) => s.startsWith('https://'));
  const lastSource = spy.drawn.map((s) => s.startsWith('https://')).lastIndexOf(true);
  assert.ok(firstSource > 0);
  assert.equal(spy.drawn.filter((s) => s.startsWith('https://')).length, d.sources.length);
  for (const mark of ['ZZSOURCED', 'ZZHEAD', 'ZZOWN ', 'ZZMONEY']) { assert.ok(at(mark).length >= 1, mark); assert.ok(at(mark).every((i) => i < firstSource), mark); }
  for (const mark of ['ZZUNSOURCED', 'ZZNOTURL', 'ZZGUESS', 'ZZRUMOUR']) { assert.equal(at(mark).length, 1, mark); assert.ok(at(mark)[0] > lastSource, mark); }
  // Each sourced claim is followed by the number of its source.
  assert.ok(spy.drawn.includes('[1]'));
  // The footer of every page: the date and what the dossier cost.
  assert.ok(spy.drawn.some((s) => s.includes('25/11/2026') && s.includes('0.84')));
});

test('in a manager\'s PDF the contract part is one line saying it is restricted, and no money is drawn', { timeout: 120000 }, async () => {
  const spy = spying();
  await dossierPdf(whole(false), { load: spy.load, logo: null });
  const all = spy.drawn.join('\n');
  assert.ok(!all.includes('ZZMONEY') && !all.includes('ZZOWNMONEY') && !all.includes('15,123'));
  assert.ok(all.includes('ZZSOURCED') && all.includes('ZZOWN '));
  const open = spying();
  await dossierPdf(whole(true), { load: open.load, logo: null });
  assert.ok(open.drawn.join('\n').includes('ZZOWNMONEY'));
  assert.equal(spy.drawn.length < open.drawn.length, true);
});

test('letters and signs the fonts cannot draw are replaced, not lost', () => {
  const { dossierSafe } = load();
  assert.equal(dossierSafe('Luka Šeprović'), 'Luka Seprovic');
  assert.equal(dossierSafe('Jonas Østergaard-Lind, Adrián Vellós'), 'Jonas Østergaard-Lind, Adrián Vellós');
  assert.equal(dossierSafe('Łukasz'), 'Lukasz');
  assert.equal(dossierSafe('שכר של כ-€180,000 לעונה'), 'שכר של כ-180,000 EUR לעונה');
  assert.equal(dossierSafe('“ציטוט” – כך…'), '"ציטוט" - כך...');
  assert.equal(dossierSafe('מוכן 📑'), 'מוכן');
});
