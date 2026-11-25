// Live player pages: what a link shows and, above all, what it never shows;
// that a link stops when it expires or is revoked, with one answer for every
// link that does not work; how openings are counted; and Golda's tools.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
const { fakeDb, stubFirestore, recorder, OWNER, MANAGER } = require('./fake-firestore.js');
const admin = stubFirestore();

const pages = require('../player-pages.js');
const { playerPageTools } = require('../golda-player-page.js');
const { playerCvPdf } = require('../golda-pdf.js');
const { systemPrompt, toolsFor } = require('../wa-agent.js');
const pagePublic = require('../../player-page.js');
const pageLinks = require('../../player-links.js');

const DAY = 86400000;
const NOW = Date.parse('2026-11-25T12:30:00Z');   // 14:30 in Israel
const PHOTO = `data:image/jpeg;base64,${Buffer.from('a small picture').toString('base64')}`;

// A record with everything the agency keeps on a player. Every value that
// must stay inside starts with SECRET, so one search finds a leak.
const PLAYER = {
  fullName: 'Noam Levi', gender: 'Men', dob: '2004-03-15', nationalities: ['Israel', 'Germany'],
  primaryPosition: 'CB', secondaryPositions: ['RB'], foot: 'Left', height: '188',
  currentClub: 'Hapoel Test', leagueMode: 'auto', leagueCountry: 'Israel', leagueTier: 'Tier 1',
  natTeamStatus: 'Current Youth', natTeamCountry: 'Israel',
  videoLink: 'https://www.youtube.com/watch?v=abcdefghijk', profileLink: 'https://www.transfermarkt.com/noam-levi/profil/spieler/123456',
  photoFiles: [{ fileId: 'photo1', name: 'noam.jpg', type: 'image/jpeg' }],
  // ── never to leave ──
  notes: 'SECRET-notes: knee problem, the father decides',
  contractStatus: 'Under Contract', contractStart: '2025-07-01', contractEnd: '2027-06-30', loanFrom: 'SECRET-loan-club', loanParentEnd: '2028-06-30',
  contractTerms: { salary: 987654, currency: 'SECRET-currency', salaryPeriod: 'month', signingFee: 55555, releaseClause: 7777777, bonuses: 'SECRET-bonuses', notes: 'SECRET-terms-notes', keyDates: [{ date: '2027-01-01', label: 'SECRET-keydate' }], source: 'SECRET-contract.pdf' },
  salary: 'SECRET-salary', transferFee: 'SECRET-fee',
  passportNumber: 'SECRET-passport-31415926', passportExpiry: '2031-02-03',
  contractFiles: [{ fileId: 'contract1', name: 'SECRET-contract-file.pdf' }], passportFiles: [{ fileId: 'passport1', name: 'SECRET-passport-file.pdf' }], reprFiles: [{ fileId: 'repr1', name: 'SECRET-repr-file.pdf' }],
  reprStart: '2024-01-01', reprEnd: '2026-12-31',
  agentName: 'SECRET-agent', agentPhone: '0501112233', phone: '0509998877', goldaPhone: '972509998877', goldaAccess: true, email: 'SECRET@example.com', parentPhone: '0507776655',
  ifaTeamUrl: 'https://www.football.org.il/SECRET-ifa', stage: 'represented', category: 'men',
  createdBy: 'SECRET-creator@x.com', lastEditedBy: 'SECRET-editor@x.com', lastEditedByName: 'SECRET-editor', linkedClubs: [{ clubName: 'SECRET-linked-club' }],
};
const PRIVATE_VALUES = ['SECRET', '987654', '55555', '7777777', '31415926', '0501112233', '0509998877', '972509998877', '0507776655',
  '2004-03-15', '2027-06-30', '2025-07-01', '2026-12-31', '2024-01-01', '2031-02-03', '2028-06-30', 'contract1', 'passport1', 'repr1', 'represented', 'goldaAccess'];
const ALLOWED_KEYS = ['name', 'age', 'birthYear', 'position', 'otherPositions', 'foot', 'heightCm', 'nationalities', 'club', 'league', 'freeAgent', 'nationalTeam', 'video', 'profile', 'photo'];

function world(extra = {}) {
  return fakeDb({
    players: { p1: structuredClone(PLAYER), gone: { ...structuredClone(PLAYER), deletedAt: '2026-11-01' } },
    files: { photo1: { name: 'noam.jpg', type: 'image/jpeg', size: 20, parts: 2 }, contract1: { name: 'c.pdf', type: 'application/pdf', size: 20, parts: 1 } },
    'files/photo1/chunks': { 0: { data: PHOTO.slice(0, 30) }, 1: { data: PHOTO.slice(30) } },
    'files/contract1/chunks': { 0: { data: 'data:application/pdf;base64,SECRET' } },
    app_users: { [OWNER.email]: OWNER, [MANAGER.email]: MANAGER },
    ...extra,
  });
}
const link = (db, o = {}) => pages.createLink(db, { player: { id: 'p1', ...PLAYER }, club: 'Hertha BSC', by: { email: OWNER.email, name: 'לו', channel: 'whatsapp' }, now: NOW, ...o });
const post = (body, headers = {}) => ({ httpMethod: 'POST', headers: { host: 'goldas-crm.netlify.app', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148 SECRET-UA', 'x-forwarded-for': '203.0.113.77', 'x-nf-client-connection-ip': '203.0.113.77', ...headers }, body: JSON.stringify(body) });
const deps = (db, o = {}) => ({ db, now: NOW + 1000, isPreview: async () => false, kickNotice: async () => { (o.kicks || []).push(1); }, ...o });
const view = (db, token, o = {}, headers) => pagePublic._handle(post({ t: token, action: 'view' }, headers), deps(db, o));

test('a token is 192 random bits, safe in an address, and is not kept as it is', async () => {
  const db = world();
  const seen = new Set();
  for (let i = 0; i < 50; i++) { const t = pages.newToken(); assert.match(t, /^[A-Za-z0-9_-]{32}$/); assert.equal(Buffer.from(t, 'base64url').length, 24); seen.add(t); }
  assert.equal(seen.size, 50);
  const made = await link(db);
  assert.equal(made.url, `https://goldas-crm.netlify.app/p/${made.token}`);
  const [doc] = db.all('player_pages');
  assert.equal(doc.id, pages.idOf(made.token));
  assert.match(doc.id, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(doc).includes(made.token), 'the database holds no working link');
  assert.match(doc.tokenSealed, /^enc:v1:/);
});

test('how long a link lives: 14 days when none was named, 90 at most', async () => {
  assert.deepEqual(pages.daysFor(undefined), { days: 14, clamped: false, defaulted: true });
  assert.deepEqual(pages.daysFor(0), { days: 14, clamped: false, defaulted: true });
  assert.deepEqual(pages.daysFor('abc'), { days: 14, clamped: false, defaulted: true });
  assert.deepEqual(pages.daysFor(30), { days: 30, clamped: false, defaulted: false });
  assert.deepEqual(pages.daysFor(400), { days: 90, clamped: true, defaulted: false });
  const db = world();
  const a = await link(db), b = await link(db, { days: 1000 });
  assert.equal(a.expiresAt, NOW + 14 * DAY);
  assert.equal(b.expiresAt, NOW + 90 * DAY);
});

test('a valid link shows the profile, with the headers that keep it out of search engines and caches', async () => {
  const db = world();
  const made = await link(db, { lang: 'he' });
  const res = await view(db, made.token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  const body = JSON.parse(res.body);
  assert.equal(body.lang, 'he');
  assert.deepEqual(body.player, {
    name: 'Noam Levi', age: 22, birthYear: 2004, position: 'CB', otherPositions: ['RB'], foot: 'Left', heightCm: 188,
    nationalities: ['Israel', 'Germany'], club: 'Hapoel Test', league: 'Israel 1',
    nationalTeam: { country: 'Israel', former: false, youth: true },
    video: { url: 'https://www.youtube.com/watch?v=abcdefghijk', youtubeId: 'abcdefghijk' },
    profile: { url: 'https://www.transfermarkt.com/noam-levi/profil/spieler/123456', transfermarkt: true },
    photo: true,
  });
  assert.equal(body.stats, null);
  assert.equal(body.contact.site, 'gold-as.com');
  assert.equal(body.preview, undefined);
});

test('nothing private leaves: a record full of private fields, and none of them in the answer', async () => {
  const db = world();
  const made = await link(db);
  const res = await view(db, made.token);
  const text = res.body;
  for (const v of PRIVATE_VALUES) assert.ok(!text.includes(v), `"${v}" must not be in the answer`);
  const body = JSON.parse(text);
  for (const k of Object.keys(body.player)) assert.ok(ALLOWED_KEYS.includes(k), `"${k}" is not on the allow-list`);
  assert.deepEqual(Object.keys(body).sort(), ['contact', 'expiresAt', 'lang', 'player', 'stats']);
  // the allow-list itself: unknown fields of the record never pass, whatever they are called
  const pub = pages.publicPlayer({ ...PLAYER, anythingNew: 'SECRET-new-field', id: 'p1' }, new Date(NOW));
  assert.ok(!JSON.stringify(pub).includes('SECRET'));
  assert.equal(pub.id, undefined);
});

test('the CV download is made from the same fields: no notes, no full date of birth', async () => {
  const db = world();
  const made = await link(db);
  let drawn = null;
  const load = () => ({ fonts: {}, jsPDF: class {}, buildPlayerCv: async (_j, _f, player, category) => { drawn = { player, category }; return { doc: { output: () => new Uint8Array([37, 80, 68, 70]).buffer } }; } });
  const cvPdf = (p, o) => playerCvPdf(p, { ...o, load, logo: null });
  const res = await pagePublic._handle({ httpMethod: 'GET', headers: {}, queryStringParameters: { t: made.token, cv: '1' } }, deps(db, { cvPdf }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.headers['Content-Disposition'], /^attachment; filename="Noam Levi - Gold A&S\.pdf"/);
  assert.equal(Buffer.from(res.body, 'base64').toString(), '%PDF');
  const text = JSON.stringify(drawn);
  for (const v of PRIVATE_VALUES) assert.ok(!text.includes(v), `"${v}" must not reach the CV`);
  assert.equal(drawn.player.notes, undefined);
  assert.equal(drawn.player.dob, undefined);
  assert.equal(drawn.player.playerName, 'Noam Levi');
  assert.equal(drawn.player.currentClub, 'Hapoel Test');
  // a download is not an opening
  assert.equal(db.all('player_pages')[0].opens, 0);
  // and a link that does not work downloads nothing
  const bad = await pagePublic._handle({ httpMethod: 'GET', headers: {}, queryStringParameters: { t: pages.newToken(), cv: '1' } }, deps(db, { cvPdf }));
  assert.equal(bad.statusCode, 404);
});

test('expired, revoked, unknown, malformed and a deleted player: one and the same answer', async () => {
  const db = world();
  const good = await link(db);
  const expired = await link(db, { days: 3 });
  const revoked = await link(db);
  const orphan = await pages.createLink(db, { player: { id: 'gone-soon', fullName: 'X' }, now: NOW });
  await pages.revokeLink(db, revoked.id, { by: { email: OWNER.email }, now: NOW + 500 });
  const later = NOW + 4 * DAY;
  const answers = [];
  for (const t of [expired.token, revoked.token, orphan.token, pages.newToken(), 'short', '', null, 12345, { $ne: 1 }, `${good.token}x`, '../../etc/passwd', '<script>alert(1)</script>']) {
    for (const action of ['view', 'photo']) answers.push(await pagePublic._handle(post({ t, action }), deps(db, { now: later })));
  }
  answers.push(await pagePublic._handle(post({ t: good.token, action: 'delete' }), deps(db, { now: later })));
  answers.push(await pagePublic._handle({ ...post({}), body: '{not json <script>' }, deps(db, { now: later })));
  answers.push(await pagePublic._handle({ ...post({}), body: JSON.stringify({ t: good.token, action: 'view', pad: 'x'.repeat(3000) }) }, deps(db, { now: later })));
  answers.push(await pagePublic._handle({ httpMethod: 'GET', headers: {}, queryStringParameters: { t: good.token } }, deps(db, { now: later })));
  for (const a of answers) {
    assert.equal(a.statusCode, 404);
    assert.equal(a.body, '{"error":"not_available"}');
    assert.equal(a.headers['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal(a.headers['Cache-Control'], 'no-store');
  }
  // the good one still works on that day, and expires on the server at its hour
  assert.equal((await view(db, good.token, { now: later })).statusCode, 200);
  assert.equal((await view(db, good.token, { now: NOW + 14 * DAY - 1 })).statusCode, 200);
  assert.equal((await view(db, good.token, { now: NOW + 14 * DAY })).statusCode, 404);
  // only the working link was ever counted
  for (const l of db.all('player_pages')) assert.equal(l.opens, l.id === good.id ? 2 : 0);
  // another method is refused without a word about the link
  const put = await pagePublic._handle({ httpMethod: 'PUT', headers: {}, body: '' }, deps(db));
  assert.equal(put.statusCode, 405);
});

test('a revoked link stops at once', async () => {
  const db = world();
  const made = await link(db);
  assert.equal((await view(db, made.token)).statusCode, 200);
  await pages.revokeLink(db, made.id, { by: { email: OWNER.email }, now: NOW + 2000 });
  assert.equal((await view(db, made.token, { now: NOW + 2001 })).statusCode, 404);
  assert.equal(await pages.revokeLink(db, 'not-an-id'), null);
});

test('an opening keeps the time and phone/desktop only: no address, no user agent', async () => {
  const db = world();
  const made = await link(db);
  await view(db, made.token);
  await view(db, made.token, { now: NOW + 10 * 60000 }, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 SECRET-UA' });
  const [doc] = db.all('player_pages');
  assert.equal(doc.opens, 2);
  assert.deepEqual(doc.openLog, [{ at: NOW + 1000, device: 'phone' }, { at: NOW + 10 * 60000, device: 'desktop' }]);
  const text = JSON.stringify(doc);
  for (const v of ['203.0.113.77', 'Mozilla', 'SECRET-UA', 'iPhone']) assert.ok(!text.includes(v));
  assert.equal(doc.firstOpenAt, NOW + 1000);
  assert.equal(doc.lastOpenDevice, 'desktop');
});

test('the last 100 openings are kept, and the total keeps counting', async () => {
  const db = world();
  const made = await link(db);
  for (let i = 1; i <= 130; i++) await pages.recordOpening(db, made.id, { device: i % 2 ? 'phone' : 'desktop', now: NOW + i * 120000 });
  const [doc] = db.all('player_pages');
  assert.equal(doc.opens, 130);
  assert.equal(doc.openLog.length, 100);
  assert.equal(doc.openLog[0].at, NOW + 31 * 120000);
  assert.equal(doc.openLog[99].at, NOW + 130 * 120000);
  assert.equal(doc.firstOpenAt, NOW + 120000);
  const v = pages.viewOf(doc, { now: NOW + DAY });
  assert.equal(v.openings.length, 100);
  assert.equal(v.openings[0].at, new Date(NOW + 130 * 120000).toISOString());
});

test('a reload within a minute is the same opening', async () => {
  const db = world();
  const made = await link(db);
  await view(db, made.token, { now: NOW + 1000 });
  await view(db, made.token, { now: NOW + 20000 });
  await view(db, made.token, { now: NOW + 59000 });
  assert.equal(db.all('player_pages')[0].opens, 1);
  await view(db, made.token, { now: NOW + 62000 });
  assert.equal(db.all('player_pages')[0].opens, 2);
});

test('a robot that only fetches the address is not an opening', async () => {
  const db = world();
  const made = await link(db);
  // WhatsApp's link preview: a GET of the page, never the script's POST
  const res = await pagePublic._handle({ httpMethod: 'GET', headers: { 'user-agent': 'WhatsApp/2.23' }, queryStringParameters: { t: made.token } }, deps(db));
  assert.equal(res.statusCode, 404);
  assert.equal(db.all('player_pages')[0].opens, 0);
});

test("the owner's own look is a preview: shown, marked, never counted", async () => {
  const db = world();
  const made = await link(db);
  const kicks = [];
  const res = await view(db, made.token, { isPreview: async () => true, kicks });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).preview, true);
  const [doc] = db.all('player_pages');
  assert.deepEqual([doc.opens, doc.firstOpenAt, doc.openLog.length, doc.noticeState], [0, null, 0, null]);
  assert.equal(kicks.length, 0);
  // the real check: a sign-in that does not verify is no preview, so it counts like anyone
  const real = await pagePublic._handle(post({ t: made.token, action: 'view' }, { authorization: 'Bearer not-a-real-token' }), { db, now: NOW + 5000, kickNotice: async () => {} });
  assert.equal(JSON.parse(real.body).preview, undefined);
  assert.equal(db.all('player_pages')[0].opens, 1);
});

test('the photo comes only from the first profile photo, and only when it is a picture', async () => {
  const db = world();
  const made = await link(db);
  const ok = await pagePublic._handle(post({ t: made.token, action: 'photo' }), deps(db));
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).photo, PHOTO);
  assert.equal(db.all('player_pages')[0].opens, 0, 'a photo is not an opening');
  // a "photo" that points at a document is not served
  assert.equal(await pages.loadPhoto(db, { photoFiles: [{ fileId: 'contract1' }] }), null);
  assert.equal(await pages.loadPhoto(db, { photoFiles: [{ url: 'data:text/html;base64,PHNjcmlwdD4=' }] }), null);
  assert.equal(await pages.loadPhoto(db, { photoFiles: [{ url: 'javascript:alert(1)' }] }), null);
  assert.equal(await pages.loadPhoto(db, { contractFiles: [{ fileId: 'photo1' }] }), null);
  assert.equal(await pages.loadPhoto(db, { photoFiles: [{ fileId: 'missing' }] }), null);
  // no photo on the record: the page shows its own block, and the answer says so
  assert.equal(pages.publicPlayer({ fullName: 'A B' }).photo, false);
  const db2 = world({ players: { p1: { ...PLAYER, photoFiles: [] } } });
  const made2 = await link(db2);
  assert.equal((await pagePublic._handle(post({ t: made2.token, action: 'photo' }), deps(db2))).statusCode, 404);
});

test('links on the page are plain web addresses or nothing', () => {
  assert.equal(pages.safeUrl('javascript:alert(1)'), '');
  assert.equal(pages.safeUrl('data:text/html,hi'), '');
  assert.equal(pages.safeUrl('https://user:pass@evil.example/x'), '');
  assert.equal(pages.safeUrl('not a url'), '');
  assert.equal(pages.safeUrl(''), '');
  assert.equal(pages.safeUrl('www.transfermarkt.com/x'), 'https://www.transfermarkt.com/x');
  assert.equal(pages.youtubeId('https://youtu.be/abcdefghijk?t=3'), 'abcdefghijk');
  assert.equal(pages.youtubeId('https://evil.example/watch?v=abcdefghijk'), '');
  const p = pages.publicPlayer({ fullName: 'A B', videoLink: 'https://vimeo.com/1234', profileLink: 'javascript:alert(1)', height: '999', foot: 'Sideways', dob: 'yesterday' });
  assert.deepEqual(p, { name: 'A B', freeAgent: true, video: { url: 'https://vimeo.com/1234', youtubeId: null }, photo: false });
});

test("this season's totals appear when the matches carry them, and not otherwise", async () => {
  const matches = {
    m1: { date: '2026-09-01', linkedPlayers: ['p1'], playerStats: { p1: { minutes: 90, goals: 1, assists: 0, rating: 7, note: 'SECRET-note', watchedBy: 'SECRET-scout' }, p2: { goals: 5 } } },
    m2: { date: '2026-10-01', linkedPlayers: ['p1'], playerStats: { p1: { minutes: 45, goals: 2 }, p2: { goals: 9 } } },
    old: { date: '2026-03-01', linkedPlayers: ['p1'], playerStats: { p1: { minutes: 90, goals: 7 } } },
    none: { date: '2026-10-08', linkedPlayers: ['p1'] },
    deleted: { date: '2026-10-09', linkedPlayers: ['p1'], deletedAt: 'x', playerStats: { p1: { goals: 4 } } },
  };
  const db = world({ matches });
  const made = await link(db);
  const body = JSON.parse((await view(db, made.token)).body);
  assert.deepEqual(body.stats, { season: '2026/27', totals: { games: 2, minutes: 135, goals: 3 } });
  assert.ok(!JSON.stringify(body).includes('SECRET'));
  // kept on the link for six hours, so an opening does not read the matches again
  db.data.get('matches').set('m3', { date: '2026-11-01', linkedPlayers: ['p1'], playerStats: { p1: { goals: 10 } } });
  assert.equal(JSON.parse((await view(db, made.token, { now: NOW + 3600000 })).body).stats.totals.goals, 3);
  assert.equal(JSON.parse((await view(db, made.token, { now: NOW + 7 * 3600000 })).body).stats.totals.goals, 13);
  // no stats on any match: nothing is shown
  assert.equal(pages.seasonTotals(Object.values({ a: matches.none }), 'p1', { season: '2026/27' }), null);
  assert.equal(pages.seasonTotals([], 'p1'), null);
});

test('the first opening, and only the first, is told to the owner, once, in one line', async () => {
  const db = world();
  const made = await link(db);
  const general = await link(db, { club: '' });
  const kicks = [];
  await view(db, made.token, { kicks });
  await view(db, made.token, { kicks, now: NOW + 5 * 60000 });
  assert.equal(kicks.length, 1);
  await view(db, general.token, { kicks, now: NOW + 6 * 60000 }, { 'user-agent': 'Mozilla/5.0 (Macintosh)' });
  assert.equal(kicks.length, 2);

  const { out, send } = recorder();
  const first = await pages.sendNotices(db, { now: NOW + 7 * 60000, send });
  assert.equal(first.sent, 2);
  assert.deepEqual(out.map((m) => m.to), [OWNER.email, OWNER.email]);
  assert.deepEqual(out.map((m) => m.kind), ['player_page', 'player_page']);
  assert.equal(out[0].body, '👀 *Hertha BSC* פתחו את הדף החי של Noam Levi (25/11 14:30, מטלפון).');
  assert.equal(out[1].body, '👀 הלינק הכללי לדף החי של Noam Levi נפתח לראשונה (25/11 14:36, ממחשב).');
  for (const m of out) assert.ok(!m.body.includes('\n') && !m.body.includes(made.token) && !m.body.includes('/p/'));
  // again: nothing more, ever
  await view(db, made.token, { kicks, now: NOW + DAY });
  const again = await pages.sendNotices(db, { now: NOW + DAY, send });
  assert.equal(again.sent, 0);
  assert.equal(out.length, 2);
  assert.deepEqual(db.all('player_pages').map((l) => l.noticeState), ['sent', 'sent']);
});

test('a notice that fails or has nobody to go to is not sent twice', async () => {
  const db = world({ app_users: { [MANAGER.email]: MANAGER } });   // the owner has no WhatsApp number on the Team screen
  const made = await link(db);
  await view(db, made.token);
  const { out, send } = recorder();
  assert.equal((await pages.sendNotices(db, { send })).sent, 0);
  assert.equal(out.length, 0, 'never to the team instead');
  assert.equal(db.all('player_pages')[0].noticeState, 'skipped');

  const db2 = world();
  const made2 = await link(db2);
  await view(db2, made2.token);
  const failing = async () => { throw new Error('whatsapp is down'); };
  assert.equal((await pages.sendNotices(db2, { send: failing })).sent, 0);
  assert.equal(db2.all('player_pages')[0].noticeState, 'failed');
  assert.equal((await pages.sendNotices(db2, { send: recorder().send })).pending, 0);
});

// ── Golda's tools ────────────────────────────────────────────────────

const tools = (db, role = 'admin', who = OWNER) => playerPageTools({ db, admin, identity: { email: who.email, name: who.name, phone: who.whatsapp, role }, role, channel: 'whatsapp', now: () => NOW });

test('Golda makes a link only for an admin; 14 days by default, 90 at most; and it is audited', async () => {
  const db = world();
  const made = await tools(db).live_page_create({ playerId: 'p1', club: 'Hertha BSC' });
  assert.equal(made.made, true);
  assert.match(made.link, /^https:\/\/goldas-crm\.netlify\.app\/p\/[A-Za-z0-9_-]{32}$/);
  assert.deepEqual([made.for, made.lang, made.days, made.worksUntil], ['Hertha BSC', 'en', 14, '09/12/2026']);
  assert.match(made.defaulted, /14 days/);
  assert.match(made.instruction, /never send it to anyone else/);
  const long = await tools(db).live_page_create({ playerId: 'p1', days: 365, lang: 'he' });
  assert.deepEqual([long.for, long.lang, long.days], ['general link (no club named)', 'he', 90]);
  assert.match(long.note, /90 days at most/);
  const month = await tools(db).live_page_create({ playerId: 'p1', club: 'Ajax', days: 30 });
  assert.deepEqual([month.days, month.note, month.defaulted], [30, undefined, undefined]);

  await assert.rejects(tools(db, 'manager', MANAGER).live_page_create({ playerId: 'p1', club: 'X' }), /only an admin/);
  await assert.rejects(tools(db, 'viewer', MANAGER).live_page_create({ playerId: 'p1' }), /only an admin/);
  await assert.rejects(tools(db).live_page_create({ playerId: 'gone' }), /player not found/);
  await assert.rejects(tools(db).live_page_create({ playerId: 'nobody' }), /player not found/);
  assert.equal(db.all('player_pages').length, 3);

  const audit = db.all('audit');
  assert.equal(audit.length, 3);
  assert.deepEqual([audit[0].action, audit[0].collection, audit[0].via, audit[0].actor, audit[0].onBehalfOf, audit[0].docId], ['create', 'player_pages', 'golda', 'golda', OWNER.email, made.linkId]);
  assert.equal(audit[0].before, undefined, 'undo_last leaves it alone: a link is undone by revoking it');
  assert.ok(!JSON.stringify(audit).includes(made.link.split('/p/')[1]), 'the audit log holds no working link');
  // the link Golda gave really opens the page
  assert.equal((await view(db, made.link.split('/p/')[1])).statusCode, 200);
});

test('Golda lists the links and who opened them, and stops one for whoever may edit', async () => {
  const db = world();
  const a = await tools(db).live_page_create({ playerId: 'p1', club: 'Hertha BSC' });
  await tools(db).live_page_create({ playerId: 'p1', club: 'Ajax', days: 2 });
  await view(db, a.link.split('/p/')[1]);
  const list = await tools(db).live_page_list({ playerId: 'p1' });
  assert.equal(list.count, 2);
  const hertha = list.links.find((l) => l.for === 'Hertha BSC');
  assert.deepEqual([hertha.state, hertha.opened, hertha.lastOpenings], ['active', 1, ['25/11 14:30 (phone)']]);
  assert.equal(hertha.link, a.link);
  // a viewer sees that links exist and who opened them, never the address
  const seen = await tools(db, 'viewer', MANAGER).live_page_list({ playerId: 'p1' });
  assert.equal(seen.count, 2);
  assert.ok(seen.links.every((l) => l.link === undefined));
  // every link that still works, across players
  assert.equal((await tools(db).live_page_list({})).count, 2);

  await assert.rejects(tools(db, 'viewer', MANAGER).live_page_revoke({ linkId: a.linkId }), /may not stop a link/);
  await assert.rejects(tools(db, 'manager', MANAGER).live_page_revoke({ linkId: 'nope' }), /link not found/);
  const stopped = await tools(db, 'manager', MANAGER).live_page_revoke({ linkId: a.linkId });
  assert.deepEqual([stopped.stopped, stopped.for, stopped.opened], [true, 'Hertha BSC', 1]);
  assert.equal((await view(db, a.link.split('/p/')[1], { now: NOW + 5000 })).statusCode, 404);
  assert.equal((await tools(db).live_page_revoke({ linkId: a.linkId })).already, true);
  assert.equal((await tools(db).live_page_list({})).count, 1);
  const after = (await tools(db).live_page_list({ playerId: 'p1' })).links.find((l) => l.for === 'Hertha BSC');
  assert.deepEqual([after.state, after.link], ['revoked', undefined]);
  assert.equal(db.all('audit').filter((x) => /revoked/.test(x.summary)).length, 1);
});

test('who gets which tool, and what the prompt says about the PDF', () => {
  const names = (role) => toolsFor(role).map((t) => t.name).filter((n) => n.startsWith('live_page'));
  assert.deepEqual(names('admin'), ['live_page_create', 'live_page_list', 'live_page_revoke']);
  assert.deepEqual(names('manager'), ['live_page_list', 'live_page_revoke']);
  assert.deepEqual(names('viewer'), ['live_page_list']);
  assert.ok(toolsFor('viewer').some((t) => t.name === 'player_pdf'), 'the PDF stays open to everyone');
  const p = systemPrompt('גולדה', { name: 'לו', role: 'admin', email: OWNER.email });
  assert.match(p, /"דף שחקן" \/ "CV" \/ "פרופיל PDF" \/ "תשלחי לי את הדף של…" → find the player, then player_pdf/);
  assert.match(p, /never replaces it/);
  assert.match(p, /"דף חי", "לינק לשחקן"/);
  assert.match(p, /Never offer a live page instead of the PDF/);
  assert.match(p, /never send the link to anyone but the writer/);
});

// ── The CRM's own endpoint ───────────────────────────────────────────

const asUser = (role, who = MANAGER) => ({ auth: { user: { email: who.email, name: who.name, role } } });
const get = (playerId) => ({ httpMethod: 'GET', headers: { host: 'goldas-crm.netlify.app' }, queryStringParameters: { playerId } });

test('the CRM reads the links through its own signed-in endpoint; only an editor copies or revokes', async () => {
  const db = world();
  const a = await link(db);
  await link(db, { club: 'Ajax', days: 2 });
  await view(db, a.token);
  const d = { db, now: NOW + 3 * DAY };

  const forEditor = JSON.parse((await pageLinks._handle(get('p1'), asUser('manager'), d)).body);
  assert.equal(forEditor.canEdit, true);
  assert.deepEqual(forEditor.links.map((l) => [l.club, l.state, l.opens, !!l.url]).sort(), [['Ajax', 'expired', 0, false], ['Hertha BSC', 'active', 1, true]]);
  assert.equal(forEditor.links.find((l) => l.club === 'Hertha BSC').url, a.url);
  assert.ok(!JSON.stringify(forEditor).includes('tokenSealed') && !JSON.stringify(forEditor).includes('enc:v1'));

  const forViewer = JSON.parse((await pageLinks._handle(get('p1'), asUser('viewer'), d)).body);
  assert.equal(forViewer.canEdit, false);
  assert.ok(forViewer.links.every((l) => l.url === null));

  assert.equal((await pageLinks._handle(get('../players'), asUser('manager'), d)).statusCode, 400);
  assert.equal((await pageLinks._handle(get(''), asUser('manager'), d)).statusCode, 400);

  const revoke = (role, id) => pageLinks._handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'revoke', id }) }, asUser(role), d);
  assert.equal((await revoke('viewer', a.id)).statusCode, 403);
  assert.equal((await revoke('manager', 'x')).statusCode, 404);
  const done = await revoke('manager', a.id);
  assert.equal(done.statusCode, 200);
  assert.equal(JSON.parse(done.body).link.state, 'revoked');
  assert.equal((await view(db, a.token, { now: NOW + 3 * DAY + 1 })).statusCode, 404);
  const audit = db.all('audit');
  assert.deepEqual([audit.length, audit[0].via, audit[0].by, audit[0].collection], [1, 'web', MANAGER.email, 'player_pages']);
  assert.equal((await pageLinks._handle({ httpMethod: 'POST', headers: {}, body: '{"action":"create"}' }, asUser('admin', OWNER), d)).statusCode, 400);
});

test('a player cannot collect links without end', async () => {
  const db = world();
  for (let i = 0; i < pages.MAX_ACTIVE_PER_PLAYER; i++) await link(db, { club: `Club ${i}` });
  await assert.rejects(link(db, { club: 'One more' }), /already has 40 live links/);
});
