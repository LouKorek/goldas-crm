// The monthly report through Golda: she prepares the month's facts (never the
// agency's ratings, notes or watchers), saves the text as a draft through her
// audited update, and sends the PDF to the writer only after a yes in a later
// message. Represented players only. On the 1st of the month she reminds the
// owner once, and waits a day when another question of hers went out.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
delete process.env.SCRAPER_API_KEY;
const { fakeDb, stubFirestore, recorder, OWNER, MANAGER } = require('./fake-firestore.js');

let DB;
const admin = stubFirestore(() => DB);
const { askMonthlyReports, remindedOn, reminderText, playersToReport, FROM_HOUR, TO_HOUR } = require('../golda-monthly-report.js');
const { whatsappRecipients } = require('../golda-identity.js');
const { ownerOf } = require('../golda-nudge.js');
const { createTools, toolsFor, systemPrompt } = require('../wa-agent.js');
const { run } = require(path.join(__dirname, '..', '..', 'golda-briefing.js'))._internal;
const pdf = require('../golda-pdf.js');

const root = path.join(__dirname, '..', '..', '..', '..');
let loaded;
function load() {
  if (loaded) return loaded;
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    stdin: { contents: "module.exports = { r: require('./apps/web/src/lib/monthlyReport.js'), fonts: require('./apps/web/src/lib/pdfFonts.js'), jspdf: require('jspdf') };", resolveDir: root, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')],
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); // eslint-disable-line no-new-func
  loaded = { buildMonthlyReport: m.exports.r.buildMonthlyReport, reportFilename: m.exports.r.reportFilename, fonts: m.exports.fonts, jsPDF: m.exports.jspdf.jsPDF };
  return loaded;
}
// The tool builds the PDF through golda-pdf; here with the web module bundled on the fly and no logo.
const realReportPdf = pdf.playerReportPdf;
pdf.playerReportPdf = (player, month, opts = {}) => realReportPdf(player, month, { ...opts, load, logo: null });

const owner = ownerOf(whatsappRecipients([OWNER]));
const LOU = { email: 'lou.korek@gmail.com', name: 'לו', role: 'admin', phone: '972500000001' };
const AVI = { fullName: 'Avi Cohen', gender: 'Men', stage: 'represented', currentClub: 'Hapoel Hadera', notes: 'secret internal note', contractTerms: { salary: 5000 } };
const MATCHES = {
  m1: { date: '2026-10-04', homeTeam: 'Hapoel Hadera', awayTeam: 'Maccabi Netanya', competition: 'Liga Leumit', linkedPlayers: ['a'],
    playerStats: { a: { minutes: 90, goals: 1, assists: 0, rating: 8, note: 'שיחק מצוין בהגנה', watchedBy: 'Dani' } } },
  m2: { date: '2026-10-18', homeTeam: 'Beitar', awayTeam: 'Hapoel Hadera', linkedPlayers: ['a'], playerStats: { a: { minutes: 0 } } },
  m3: { date: '2026-11-02', homeTeam: 'Hapoel Hadera', awayTeam: 'Bnei Yehuda', linkedPlayers: ['a'], playerStats: { a: { minutes: 60, goals: 2 } } },
};

// fakeDb's update does not know field paths; this one does, like Firestore.
function withFieldPaths(base) {
  const wrapDoc = (d) => ({
    ...d,
    update: async (v) => {
      const cur = (await d.get()).data() || {};
      for (const [k, x] of Object.entries(v)) {
        if (!k.includes('.')) { cur[k] = x; continue; }
        const [a, b] = k.split('.');
        cur[a] = { ...(cur[a] || {}) };
        if (x === undefined) delete cur[a][b]; else cur[a][b] = x;
      }
      await d.set(cur);
    },
  });
  return { ...base, collection: (p) => { const c = base.collection(p); return { ...c, doc: (id) => wrapDoc(c.doc(id)) }; } };
}
const seed = (extra = {}) => withFieldPaths(fakeDb({
  players: { a: { ...AVI }, pr: { fullName: 'Prospect Pete', stage: 'shortlist', category: 'men' } },
  matches: MATCHES,
  interactions: {
    i1: { kind: 'call', playerId: 'a', text: 'שיחה עם המאמן על דקות משחק', at: '2026-10-08T10:00:00Z' },
    i2: { kind: 'stage', playerId: 'a', dealId: 'd1', text: 'Deal moved to Offer Received at Maccabi Haifa', at: '2026-10-09T10:00:00Z' },
    i3: { kind: 'note', playerId: 'a', text: 'September note', at: '2026-09-30T10:00:00Z' },
  },
  meetings: { mt1: { title: 'פגישה עם ההורים', date: '2026-10-12', linkedPlayers: ['a'] } },
  tasks: { t1: { title: 'לשלוח סרטון לסקאוט', done: true, completedAt: '2026-10-20T09:00:00Z', linkedPlayers: ['a'] }, t2: { title: 'open task', done: false, linkedPlayers: ['a'] } },
  ...extra,
}));
const tools = (db, turn = 1, identity = LOU) => createTools({ db, admin, identity, media: null, session: { turn }, assistantName: 'גולדה', channel: 'whatsapp' });

test('prepare: the month\'s facts without rating, note or watcher, and no deal moves', async () => {
  const r = await tools(seed()).run('monthly_report', { action: 'prepare', playerId: 'a', month: '2026-10' });
  assert.equal(r.month, '2026-10');
  assert.deepEqual(r.monthName, { he: 'אוקטובר 2026', en: 'October 2026' });
  assert.deepEqual(r.matches.map((m) => [m.date, m.title, m.competition, m.minutes, m.goals, m.played]),
    [['2026-10-04', 'Hapoel Hadera – Maccabi Netanya', 'Liga Leumit', 90, 1, true], ['2026-10-18', 'Beitar – Hapoel Hadera', '', 0, 0, false]]);
  assert.deepEqual(r.monthTotals, { apps: 1, minutes: 90, goals: 1, assists: 0 });
  assert.equal(r.season.label, '2026/27');
  const { neverWrite: _rules, instruction: _how, ...facts } = r;
  const json = JSON.stringify(facts);
  for (const word of ['rating', 'watchedBy', 'Dani', 'שיחק מצוין', 'secret internal note', 'salary', 'Maccabi Haifa', 'September note']) assert.ok(!json.includes(word), word);
  assert.deepEqual(r.activity.notes.map((x) => x.text), ['שיחה עם המאמן על דקות משחק']);
  assert.deepEqual(r.activity.meetings, [{ date: '2026-10-12', title: 'פגישה עם ההורים' }]);
  assert.deepEqual(r.activity.tasksDone, [{ date: '2026-10-20', title: 'לשלוח סרטון לסקאוט' }]);
  assert.equal(r.saved, null);
  assert.ok(r.neverWrite.includes('ratings'));
});

test('prepare: the last full month by default; represented players only; no future month', async () => {
  const t = tools(seed());
  const now = require('@goldas/domain').lastFullMonth();
  assert.equal((await t.run('monthly_report', { action: 'prepare', playerId: 'a' })).month, now);
  await assert.rejects(t.run('monthly_report', { action: 'prepare', playerId: 'pr', month: '2026-10' }), /represented players only/);
  await assert.rejects(t.run('monthly_report', { action: 'prepare', playerId: 'zz', month: '2026-10' }), /represented players only/);
  await assert.rejects(t.run('monthly_report', { action: 'prepare', playerId: 'a', month: '2099-01' }), /not started/);
  await assert.rejects(t.run('monthly_report', { action: 'prepare', playerId: 'a', month: 'October' }), /YYYY-MM/);
});

test('save then send: the PDF only after a yes in a later message, to the writer', async () => {
  const db = seed();
  const did = ['• שיחה עם המאמן על הדקות שלו', 'נפגשנו עם ההורים', 'שלחנו סרטון לסקאוט'];
  const next = 'בחודש הבא נמשיך לעקוב אחרי הדקות שלו ונעדכן אתכם.';
  const t1 = tools(db, 1);
  const s = await t1.run('monthly_report', { action: 'save', playerId: 'a', month: '2026-10', did, next });
  assert.equal(s.saved, true);
  assert.deepEqual(s.did, ['שיחה עם המאמן על הדקות שלו', 'נפגשנו עם ההורים', 'שלחנו סרטון לסקאוט']);
  const saved = db.read('players', 'a').monthlyReports['2026-10'];
  assert.deepEqual([saved.status, saved.by, saved.turn, saved.next], ['draft', LOU.email, 1, next]);
  // the audit holds the draft as one field path, so undo_last can take it back
  const audit = db.all('audit');
  assert.deepEqual([audit[0].collection, audit[0].docId, audit[0].fields], ['players', 'a', ['monthlyReports.2026-10']]);
  // the same message: no PDF
  await assert.rejects(t1.run('monthly_report', { action: 'send', playerId: 'a', month: '2026-10' }), /has not answered/);
  assert.equal(t1.state.outFiles.length, 0);
  // prepare now shows the saved draft
  assert.deepEqual((await t1.run('monthly_report', { action: 'prepare', playerId: 'a', month: '2026-10' })).saved.status, 'draft');
  // the next message (the yes)
  const t2 = tools(db, 2);
  const r = await t2.run('monthly_report', { action: 'send', playerId: 'a', month: '2026-10' });
  assert.equal(r.made, true);
  assert.equal(db.read('players', 'a').monthlyReports['2026-10'].status, 'approved');
  assert.equal(t2.state.outFiles.length, 1);
  const f = t2.state.outFiles[0];
  assert.equal(f.mimeType, 'application/pdf');
  assert.equal(f.buffer.slice(0, 5).toString(), '%PDF-');
  assert.equal(f.filename, 'Avi Cohen - אוקטובר 2026 - Gold A&S.pdf');
  // approved: an English copy later needs no second yes
  const t3 = tools(db, 3);
  const en = await t3.run('monthly_report', { action: 'send', playerId: 'a', month: '2026-10', lang: 'en' });
  assert.equal(t3.state.outFiles[0].filename, 'Avi Cohen - October 2026 - Gold A&S.pdf');
  assert.equal(en.approved, true);
});

test('send: a text saved in the app, or by someone else, is shown and saved again first', async () => {
  const app = seed();
  await app.collection('players').doc('a').update({ 'monthlyReports.2026-10': { did: ['a line'], next: 'next', status: 'draft', by: LOU.email, at: 'x' } });
  const r = await tools(app, 5).run('monthly_report', { action: 'send', playerId: 'a', month: '2026-10' });
  assert.equal(r.needsApproval, true);
  assert.equal(app.read('players', 'a').monthlyReports['2026-10'].status, 'draft');
  const other = seed();
  await tools(other, 1, { email: 'dani@x.com', name: 'דני', role: 'manager', phone: '972500000002' }).run('monthly_report', { action: 'save', playerId: 'a', month: '2026-10', did: ['x'], next: 'y' });
  assert.equal((await tools(other, 2).run('monthly_report', { action: 'send', playerId: 'a', month: '2026-10' })).needsApproval, true);
  await assert.rejects(tools(seed(), 2).run('monthly_report', { action: 'send', playerId: 'a', month: '2026-10' }), /no saved text/);
});

test('save: audited and undoable; empty parts refused; the generic update cannot touch it', async () => {
  const db = seed();
  const t = tools(db);
  await assert.rejects(t.run('monthly_report', { action: 'save', playerId: 'a', month: '2026-10', did: [], next: 'x' }), /did is/);
  await assert.rejects(t.run('monthly_report', { action: 'save', playerId: 'a', month: '2026-10', did: ['x'], next: ' ' }), /next is/);
  await assert.rejects(t.run('update', { collection: 'players', id: 'a', data: { 'monthlyReports.2026-10': { did: ['x'], next: 'y', status: 'approved' } } }), /only with monthly_report/);
  await assert.rejects(t.run('update', { collection: 'players', id: 'a', data: { monthlyReports: {} } }), /only with monthly_report/);
  await t.run('monthly_report', { action: 'save', playerId: 'a', month: '2026-10', did: ['x'], next: 'y' });
  assert.equal(db.all('audit').length, 1);
  assert.equal((await t.run('undo_last', {})).undone, 'update');
  assert.equal(db.read('players', 'a').monthlyReports['2026-10'], undefined);
});

test('who may: editors write reports, a viewer cannot; the reminder is the admin\'s; players never get the tool', async () => {
  const names = (role) => toolsFor(role).map((x) => x.name);
  assert.ok(names('manager').includes('monthly_report'));
  assert.ok(!names('viewer').includes('monthly_report'));
  assert.ok(!require('../golda-player.js').TOOLS.some((x) => x.name === 'monthly_report'));
  await assert.rejects(tools(seed(), 1, { email: 'v@x.com', name: 'V', role: 'viewer' }).run('monthly_report', { action: 'save', playerId: 'a', month: '2026-10', did: ['x'], next: 'y' }), /may not edit/);
  const db = seed();
  await assert.rejects(tools(db, 1, { email: 'dani@x.com', name: 'D', role: 'manager' }).run('monthly_report', { action: 'reminder', reminder: 'off' }), /only an admin/);
  const t = tools(db);
  assert.equal((await t.run('monthly_report', { action: 'reminder', reminder: 'status' })).on, true);
  assert.equal((await t.run('monthly_report', { action: 'reminder', reminder: 'off' })).on, false);
  assert.equal(db.read('app_meta', 'goldaMonthlyReports').enabled, false);
  assert.equal((await t.run('monthly_report', { action: 'reminder', reminder: 'on' })).on, true);
  assert.match(systemPrompt('גולדה'), /monthly_report action=prepare/);
  assert.match(systemPrompt('גולדה'), /never send it to the player or the family/);
});

// ── the reminder ─────────────────────────────────────────────────────────────
const at = (hhmm, day) => new Date(`${day}T${String(Number(hhmm.slice(0, 2)) - 2).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);   // Israel is UTC+2 in winter
const PLAYERS = [{ id: 'a', ...AVI }, { id: 'b', fullName: 'Ben Levi' }, { id: 'pr', fullName: 'P', stage: 'shortlist' }, { id: 'gone', fullName: 'G', deletedAt: 'x' }];

test('the reminder: on the 1st between 9 and 12, once for the month, to the owner only', async () => {
  assert.deepEqual([FROM_HOUR, TO_HOUR], [9, 12]);
  const db = fakeDb();
  const { out, send } = recorder();
  for (const hour of [8, 13]) assert.deepEqual(await askMonthlyReports(db, owner, { players: PLAYERS }, at('09:30', '2026-12-01'), { hour, send }), { skipped: 'not the hour' });
  assert.deepEqual(await askMonthlyReports(db, owner, { players: PLAYERS }, at('09:30', '2026-12-04'), { hour: 9, send }), { skipped: 'not the day' });
  assert.deepEqual(await askMonthlyReports(db, owner, { players: PLAYERS }, at('09:30', '2026-12-01'), { hour: 9, send }), { sent: 1, month: '2026-11', players: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].to, 'lou.korek@gmail.com');
  assert.match(out[0].body, /^\*הדוחות החודשיים של נובמבר 2026, לו\* 📄/);
  assert.match(out[0].body, /ל-2 שחקנים מיוצגים/);
  assert.match(out[0].body, /"בלי תזכורת לדוחות"/);
  assert.deepEqual(out[0].buttons, ['להתחיל', 'לדלג החודש']);
  assert.deepEqual(db.read('app_meta', 'goldaMonthlyReports'), { lastMonth: '2026-11', lastSentOn: '2026-12-01', updatedAt: at('09:30', '2026-12-01').getTime() });
  assert.equal(await remindedOn(db, '2026-12-01'), true);
  // in the chat as her turn, so "להתחיל" has something to answer
  assert.equal(db.all('wa_sessions/972500000001/threads')[0].history[0].proactive, 'question');
  // never twice for the same month
  assert.deepEqual(await askMonthlyReports(db, owner, { players: PLAYERS }, at('11:30', '2026-12-02'), { hour: 11, send }), { skipped: 'reminded this month' });
  assert.equal(out.length, 1);
  // the next month again, without the line about switching it off
  const jan = await askMonthlyReports(db, owner, { players: PLAYERS }, at('09:30', '2027-01-01'), { hour: 9, send });
  assert.equal(jan.month, '2026-12');
  assert.ok(!/בלי תזכורת/.test(out[1].body));
});

test('the reminder waits a day when the match or the daily question went out; the 2nd catches up', async () => {
  const { out, send } = recorder();
  const db = fakeDb({ app_meta: { goldaMatchQuestions: { lastAskedOn: '2026-12-01' } } });
  assert.deepEqual(await askMonthlyReports(db, owner, { players: PLAYERS }, at('10:30', '2026-12-01'), { hour: 10, send }), { skipped: 'another question went out today' });
  assert.equal((await askMonthlyReports(db, owner, { players: PLAYERS }, at('09:30', '2026-12-02'), { hour: 9, send })).sent, 1);
  const daily = fakeDb({ app_meta: { goldaDailyQuestion: { lastAskedOn: '2026-12-03' } } });
  assert.deepEqual(await askMonthlyReports(daily, owner, { players: PLAYERS }, at('09:30', '2026-12-03'), { hour: 9, send }), { skipped: 'another question went out today' });
  assert.equal(out.length, 1);
});

test('the reminder: off, or every report of the month already approved: nothing', async () => {
  const { out, send } = recorder();
  const off = fakeDb({ app_meta: { goldaMonthlyReports: { enabled: false } } });
  assert.deepEqual(await askMonthlyReports(off, owner, { players: PLAYERS }, at('09:30', '2026-12-01'), { hour: 9, send }), { skipped: 'off' });
  const done = PLAYERS.map((p) => ({ ...p, monthlyReports: { '2026-11': { status: 'approved', did: ['x'], next: 'y' } } }));
  assert.deepEqual(playersToReport(done, '2026-11'), []);
  const db = fakeDb();
  assert.deepEqual(await askMonthlyReports(db, owner, { players: done }, at('09:30', '2026-12-01'), { hour: 9, send }), { skipped: 'nothing to prepare' });
  assert.equal(db.read('app_meta', 'goldaMonthlyReports'), undefined, 'the month is not used up');
  assert.equal(out.length, 0);
  assert.match(reminderText('לו', '2026-11', 1).text, /לשחקן מיוצג אחד/);
});

// ── the hourly pass ──────────────────────────────────────────────────────────
const approved = { templates: { golda_digest: { accounts: { 1: { status: 'APPROVED' } } }, golda_update: { accounts: { 1: { status: 'APPROVED' } } } } };
const FULL = { gender: 'Men', currentClub: 'Hapoel Hadera', contractStatus: 'Under Contract', contractEnd: '2028-06-30', reprEnd: '2028-06-30', passportExpiry: '2031-01-01', primaryPosition: 'CDM', dob: '2007-05-01', foot: '', nationalities: ['Israel'] };
const write = Object.assign(async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }), { recap: async ({ fallbackText }) => ({ text: fallbackText, ai: false, reason: 'test' }) });
async function hour(when) {
  const out = [];
  const send = async (u, body, kind, buttons = []) => { out.push({ to: u.email, kind, body, buttons }); return { state: 'sent' }; };
  await run({ note: () => {} }, when, { send, write, site: require('./fake-site.js').fakeSite() });
  return out.filter((m) => m.kind === 'question');
}

test('the hourly pass: the reminder on the 1st in the morning, and the daily question waits for the next day', async () => {
  const day = '2026-12-01';
  DB = fakeDb({
    app_users: { lou: OWNER, dani: MANAGER },
    players: { a: { ...FULL, fullName: 'Avi Cohen' } },
    backups: { b1: { status: 'ok', verified: true, startedAt: at('03:30', day).getTime() } },
    app_meta: { whatsapp: approved, goldaSent: { briefings: { 'lou.korek@gmail.com': day, 'dani@x.com': day }, eventsAt: at('08:30', day).getTime() },
      goldaSiteFollow: { seen: { a: require('../golda-site-follow.js').viewOf({ ...FULL, fullName: 'Avi Cohen' }) } } },
  });
  const morning = await hour(at('09:30', day));
  assert.equal(morning.length, 1);
  assert.match(morning[0].body, /הדוחות החודשיים של נובמבר 2026/);
  assert.equal(morning[0].to, 'lou.korek@gmail.com');
  assert.deepEqual(await hour(at('10:30', day)), [], 'once');
  assert.deepEqual(await hour(at('14:30', day)), [], 'no daily question on the day of the reminder');
  const sent = DB.read('app_meta', 'goldaSent');
  await DB.collection('app_meta').doc('goldaSent').set({ ...sent, briefings: { 'lou.korek@gmail.com': '2026-12-02', 'dani@x.com': '2026-12-02' } });
  const next = await hour(at('14:30', '2026-12-02'));
  assert.match(next[0].body, /שאלה יומית/, 'it comes the next day');
});

// ── the page ─────────────────────────────────────────────────────────────────
test('the report comes out as a one-page PDF in Hebrew and English, with and without matches', { timeout: 60000 }, async () => {
  const { buildMonthlyReport, fonts, jsPDF } = load();
  const many = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, title: 'Hapoel Hadera – A very long opponent name that goes on', competition: 'Liga Leumit', minutes: 90, goals: i % 2, assists: 0, played: true }));
  const long = { did: Array(5).fill('א'.repeat(139)), next: 'ב'.repeat(300) };
  for (const lang of ['he', 'en']) {
    for (const matches of [[], many]) {
      const { doc } = await buildMonthlyReport(jsPDF, fonts, { playerName: 'אבי כהן', currentClub: 'הפועל חדרה' },
        { month: '2026-10', matches, monthTotals: { apps: 2, minutes: 180, goals: 1, assists: 0 }, season: { label: '2026/27', apps: 5, minutes: 400, goals: 2, assists: 1 }, ...long }, { lang });
      assert.equal(doc.getNumberOfPages(), 1, `${lang} ${matches.length}`);
    }
  }
  const r = await realReportPdf({ id: 'a', ...AVI, monthlyReports: { '2026-10': { did: ['נפגשנו עם ההורים'], next: 'נמשיך לעקוב.', status: 'approved' } } }, '2026-10',
    { lang: 'he', load, logo: null, matches: Object.entries(MATCHES).map(([id, m]) => ({ id, ...m })) });
  assert.equal(r.buffer.slice(0, 5).toString(), '%PDF-');
  assert.ok(r.buffer.length > 5000);
  // nothing of the agency's own words is in the file
  const raw = r.buffer.toString('latin1');
  assert.ok(!/Dani|secret internal note/.test(raw));
});
