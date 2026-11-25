// The agency's mail on its records, end to end against an in-memory Firestore
// and a stand-in for Google: the one-time permission through the YouTube
// return address, what Gmail is asked for (only the known addresses), what is
// kept (no body), the links to contacts, clubs and deals, hand corrections
// that survive the next sync, disconnecting, and Golda's read-only look.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
const { fakeDb, stubFirestore } = require('./fake-firestore.js');

let currentDb = null;
stubFirestore(() => currentDb);

const gmailAuth = require('../gmail-auth.js');
const store = require('../mail-store.js');
const { mailTools } = require('../golda-mail.js');
const { isSealed } = require('../seal.js');

const ENV = { YT_CLIENT_ID: '123-abc.apps.googleusercontent.com', YT_CLIENT_SECRET: 'client-secret-value', URL: 'https://goldas-crm.netlify.app' };
const NOW = Date.parse('2026-11-20T10:00:00Z');
const OWN = 'lou@goldas.example';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A Gmail message as the API gives it with format=full. */
function gmsg(id, { from, to, cc = '', subject, body = '', threadId = `t-${id}`, at = NOW - 864e5, files = [] }) {
  return {
    id, threadId, internalDate: String(at), snippet: body.slice(0, 50).replace(/'/g, '&#39;'),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: from }, { name: 'To', value: to }, ...(cc ? [{ name: 'Cc', value: cc }] : []), { name: 'Subject', value: subject }],
      parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64(body) } }, ...files.map((f) => ({ mimeType: 'application/pdf', filename: f, body: { attachmentId: 'att1', size: 9 } }))],
    },
  };
}

/** A stand-in for Google: answers the token, profile, search, history and message calls, and records them. */
function fakeGoogle(mailbox, { historyAdded = 0, apiOff = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return res(200, { access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: gmailAuth.SCOPE });
    }
    if (apiOff) return res(403, { error: { message: 'Gmail API has not been used in project 1 before or it is disabled', errors: [{ reason: 'accessNotConfigured' }] } });
    const path = url.replace('https://gmail.googleapis.com/gmail/v1/users/me/', '');
    if (path === 'profile') return res(200, { emailAddress: OWN, historyId: '900' });
    if (path.startsWith('history?')) return res(200, { history: historyAdded ? [{ messagesAdded: Array.from({ length: historyAdded }, (_, i) => ({ message: { id: `h${i}` } })) }] : [], historyId: '901' });
    if (path.startsWith('messages?')) {
      const q = new URLSearchParams(path.slice('messages?'.length)).get('q');
      // Gmail's own search: a message is returned when one of its addresses contains a term of the query.
      const terms = [...q.matchAll(/(?:from|to|cc):(\S+?)(?=[\s}])/g)].map((m) => m[1]);
      const hits = mailbox.filter((m) => {
        const heads = m.payload.headers.filter((h) => ['From', 'To', 'Cc'].includes(h.name)).map((h) => h.value.toLowerCase()).join(' ');
        return terms.some((t) => heads.includes(t));
      });
      return res(200, { messages: hits.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const one = /^messages\/([^?]+)\?format=full$/.exec(path);
    if (one) {
      const m = mailbox.find((x) => x.id === decodeURIComponent(one[1]));
      return m ? res(200, m) : res(404, { error: { message: 'not found' } });
    }
    return res(404, { error: { message: `unexpected ${path}` } });
  };
  return { fetchImpl, calls, fullReads: () => calls.filter((c) => /format=full/.test(c.url)).map((c) => decodeURIComponent(/messages\/([^?]+)/.exec(c.url)[1])) };
}

function seedDb(extra = {}) {
  return fakeDb({
    clubs: {
      mhfc: { name: 'Maccabi Haifa', key: 'maccabi haifa', emailDomain: 'mhfc.co.il' },
      hbs: { name: 'Hapoel Beer Sheva', key: 'hapoel beer sheva', emailDomain: 'gmail.com' },     // a free domain is never a club's
    },
    contacts: {
      k1: { clubName: 'Maccabi Haifa', clubId: 'mhfc', contactName: 'Dana Levi', contactEmail: 'Dana.Levi@mhfc.co.il' },
      k2: { clubName: 'Hapoel Beer Sheva', contactName: 'Yossi Cohen', contactEmail: 'yossi.scout@gmail.com' },
    },
    players: { p1: { fullName: 'Assaf Ackerman', stage: 'represented' }, p2: { fullName: 'Noam Barzilay', stage: 'represented' } },
    deals: {
      d1: { playerId: 'p1', playerName: 'Assaf Ackerman', clubName: 'Maccabi Haifa', clubId: 'mhfc', stage: 'Negotiation' },
      d2: { playerId: 'p2', playerName: 'Noam Barzilay', clubName: 'Maccabi Haifa', clubId: 'mhfc', stage: 'Initial Talks' },
    },
    app_meta: { gmail: { connected: true, address: OWN } },
    app_secrets: { gmail: { refreshToken: 'x' } },
    ...extra,
  });
}

const MAILBOX = () => [
  gmsg('m1', { from: 'Dana Levi <dana.levi@mhfc.co.il>', to: OWN, subject: 'הצעה לאסף אקרמן', body: 'שלום לו, מצרפת את ההצעה לאסף לעונה הבאה. הסכום המוצע הוא 250 אלף ומשכורת של 30 אלף בחודש.', files: ['offer.pdf'] }),
  gmsg('m2', { from: OWN, to: '"Office" <office@mhfc.co.il>', subject: 'Re: training ground', body: 'See you on Sunday.' }),
  gmsg('m3', { from: 'Yossi <yossi.scout@gmail.com>', to: OWN, subject: 'Noam Barzilay video', body: 'Saw the video of Noam Barzilay, nice.' }),
  gmsg('m4', { from: 'Bank <info@bank.example>', to: OWN, subject: 'Your statement', body: 'Private.' }),
  gmsg('m5', { from: 'Friend <friend@gmail.com>', to: OWN, subject: 'dinner', body: 'Private too.' }),
  gmsg('m6', { from: 'Spoof <x@notmhfc.co.il>', to: OWN, subject: 'hi', body: 'Looks like the club, is not.' }),
];

async function connectedRun(db, google, opts = {}) {
  gmailAuth._resetCacheForTests();
  db.collection('app_secrets').doc('gmail').set({ refreshToken: require('../seal.js').seal('refresh-1') });
  return store.syncMailbox(db, { fetchImpl: google.fetchImpl, now: NOW, env: ENV, ...opts });
}

// ── the connection ──────────────────────────────────────────────────────────
test('connecting asks only for gmail.readonly and comes back through the YouTube return address', async () => {
  const db = fakeDb();
  const url = new URL(await gmailAuth.startUrl(db, 'lou@x.com', { env: ENV, now: NOW, origin: 'https://goldas-crm.netlify.app' }));
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://goldas-crm.netlify.app/.netlify/functions/youtube-connect');
  assert.equal(url.searchParams.get('client_id'), ENV.YT_CLIENT_ID);
  const state = url.searchParams.get('state');
  assert.ok(gmailAuth.isGmailState(state));
  assert.equal(gmailAuth.isGmailState('a'.repeat(48)), false, 'a YouTube state is not a Gmail one');

  const google = fakeGoogle([]);
  const info = await gmailAuth.finish(db, { code: 'c1', state }, { env: ENV, fetchImpl: google.fetchImpl, now: NOW });
  assert.equal(info.address, OWN);
  assert.equal(info.connected, true);
  const secret = db.read('app_secrets', 'gmail');
  assert.ok(isSealed(secret.refreshToken), 'the refresh token is sealed');
  assert.ok(!JSON.stringify(db.read('app_meta', 'gmail')).includes('refresh-1'), 'no token in the public status');
  await assert.rejects(gmailAuth.finish(db, { code: 'c1', state }, { env: ENV, fetchImpl: google.fetchImpl, now: NOW }), /expired/);
});

test('with the Gmail API off, the key is kept and the server tries to switch the API on', async () => {
  const db = fakeDb();
  const url = new URL(await gmailAuth.startUrl(db, 'lou@x.com', { env: ENV, now: NOW }));
  let enabled = 0;
  const info = await gmailAuth.finish(db, { code: 'c', state: url.searchParams.get('state') }, {
    env: ENV, fetchImpl: fakeGoogle([], { apiOff: true }).fetchImpl, now: NOW, enable: async () => { enabled += 1; return { ok: false, status: 403, message: 'no role' }; },
  });
  assert.equal(enabled, 1);
  assert.equal(info.api.state, 'off');
  assert.equal(info.address, null);
  assert.ok(db.read('app_secrets', 'gmail').refreshToken);
});

test('the YouTube return address hands a Gmail state to the Gmail sign-in', async () => {
  const db = fakeDb();
  currentDb = db;
  const url = new URL(await gmailAuth.startUrl(db, 'lou@x.com', { env: ENV, now: Date.now() }));
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  const realFetch = global.fetch;
  const google = fakeGoogle([]);
  global.fetch = async (u, o) => (String(u).includes('gmail-sync-background') ? res(202, {}) : google.fetchImpl(u, o));
  try {
    delete require.cache[require.resolve('../../youtube-connect.js')];
    const { handler } = require('../../youtube-connect.js');
    const out = await handler({ httpMethod: 'GET', headers: { host: 'goldas-crm.netlify.app' }, queryStringParameters: { code: 'c', state: url.searchParams.get('state') } });
    assert.equal(out.statusCode, 302);
    assert.match(out.headers.Location, /\/admin\/mail\?gm=ok$/);
    assert.equal(db.read('app_meta', 'gmail').address, OWN);
    assert.equal(db.read('app_meta', 'youtube'), undefined, 'YouTube is not touched');
  } finally {
    global.fetch = realFetch;
    process.env = saved;
    currentDb = null;
  }
});

// ── the address book and the matching ───────────────────────────────────────
test('the address book: contact addresses and club domains, never a free domain as a club', () => {
  const book = store.buildBook({
    own: OWN,
    clubs: [{ id: 'mhfc', name: 'Maccabi Haifa', emailDomain: 'https://www.mhfc.co.il' }, { id: 'x', name: 'X', emailDomain: 'walla.co.il' }, { id: 'own', name: 'Us', emailDomain: 'goldas.example' }],
    contacts: [{ id: 'k1', clubName: 'Maccabi Haifa', contactEmail: 'dana@mhfc.co.il' }, { id: 'k2', clubName: '', contactEmail: 'someone@walla.co.il' }, { id: 'k3', contactEmail: 'bad address' }],
  });
  assert.deepEqual(book.terms, ['dana@mhfc.co.il', 'mhfc.co.il', 'someone@walla.co.il']);
  assert.deepEqual(store.matchParticipants(['other@walla.co.il'], book), { contactIds: [], clubIds: [] }, 'a free domain matches only the one address');
  assert.deepEqual(store.matchParticipants(['someone@walla.co.il'], book), { contactIds: ['k2'], clubIds: [] });
  assert.deepEqual(store.matchParticipants(['press@mail.mhfc.co.il'], book), { contactIds: [], clubIds: ['mhfc'] });
  assert.deepEqual(store.matchParticipants(['dana@mhfc.co.il'], book), { contactIds: ['k1'], clubIds: ['mhfc'] });
});

test('a player is found by name in Latin or Hebrew spelling, not by a near miss', () => {
  const targets = new Map([['p1', 'Assaf Ackerman'], ['p2', 'Noam Barzilay'], ['p3', 'Ido Bar']]);
  assert.deepEqual(store.mentions('Offer for ASSAF ACKERMAN attached', targets), ['p1']);
  assert.deepEqual(store.mentions('מצרפת את ההצעה לאסף אקרמן', targets), ['p1']);
  assert.deepEqual(store.mentions('ברזילי נועם הגיע לאימון', targets), ['p2']);
  assert.deepEqual(store.mentions('the bar is open, I do', targets), []);
  assert.deepEqual(store.mentions('Asaf from the office', targets), []);
});

test('Gmail addresses are read from headers the way mail clients write them', () => {
  assert.deepEqual(store.parseAddressList('"Levi, Dana" <Dana@mhfc.co.il>, bare@x.com, broken'), [{ name: 'Levi, Dana', email: 'dana@mhfc.co.il' }, { name: '', email: 'bare@x.com' }]);
});

// ── the sync ────────────────────────────────────────────────────────────────
test('with no address and no domain in the CRM, no mail is asked for or read', async () => {
  const db = seedDb({ clubs: {}, contacts: {} });
  const google = fakeGoogle(MAILBOX());
  const out = await connectedRun(db, google);
  assert.equal(out.terms, 0);
  assert.equal(google.calls.filter((c) => /\/messages|\/history/.test(c.url)).length, 0);
  assert.equal(db.all('mail_messages').length, 0);
  assert.equal(db.read('app_meta', 'gmail').state, 'no_addresses');
});

test('the first sync asks only for the known addresses and keeps only what matches, without the body', async () => {
  const db = seedDb();
  const google = fakeGoogle(MAILBOX());
  const out = await connectedRun(db, google);
  const queries = google.calls.filter((c) => /\/messages\?/.test(c.url)).map((c) => new URLSearchParams(c.url.split('?')[1]).get('q'));
  assert.equal(queries.length, 1);
  assert.match(queries[0], /from:dana\.levi@mhfc\.co\.il/);
  assert.match(queries[0], /from:mhfc\.co\.il/);
  assert.match(queries[0], /from:yossi\.scout@gmail\.com/);
  assert.doesNotMatch(queries[0], /from:gmail\.com/, 'the free domain is never a search term');
  assert.match(queries[0], new RegExp(`after:${Math.floor((NOW - 90 * 864e5) / 1000)}`));
  // The bank and the friend never reach a full read; the look-alike domain is read (Gmail's search is loose) but not kept.
  assert.deepEqual(google.fullReads().sort(), ['m1', 'm2', 'm3', 'm6']);
  assert.deepEqual(db.all('mail_messages').map((m) => m.id).sort(), ['m1', 'm2', 'm3']);
  assert.equal(out.stored, 3);

  const m1 = db.read('mail_messages', 'm1');
  assert.deepEqual(m1.contactIds, ['k1']);
  assert.deepEqual(m1.clubIds, ['mhfc']);
  assert.deepEqual(m1.dealIds, ['d1'], 'named the player of the deal');
  assert.equal(m1.direction, 'in');
  assert.deepEqual(m1.attachments, ['offer.pdf']);
  assert.equal(m1.hasAttachments, true);
  assert.ok(!JSON.stringify(m1).includes('250 אלף'), 'the body is not kept, only Gmail\'s snippet');
  assert.ok(!('body' in m1) && !('text' in m1));
  const m2 = db.read('mail_messages', 'm2');
  assert.equal(m2.direction, 'out');
  assert.deepEqual(m2.dealIds, [], 'no player named: club only');
  assert.deepEqual(m2.clubIds, ['mhfc']);
  const m3 = db.read('mail_messages', 'm3');
  assert.deepEqual(m3.contactIds, ['k2']);
  assert.deepEqual(m3.clubIds, ['hbs'], 'the club through its contact (friend@gmail.com, m5, matched nothing)');
  assert.deepEqual(m3.dealIds, [], 'a deal needs mail with that deal\'s club');
  const pub = db.read('app_meta', 'gmail');
  assert.equal(pub.linkedCount, 3);
  assert.equal(pub.lastSyncAt, NOW);
});

test('later runs ask Gmail history first and search again only when something arrived', async () => {
  const db = seedDb();
  await connectedRun(db, fakeGoogle(MAILBOX()));
  const quiet = fakeGoogle(MAILBOX(), { historyAdded: 0 });
  await connectedRun(db, quiet, { now: NOW + 9e5 });
  assert.equal(quiet.calls.filter((c) => /\/messages/.test(c.url)).length, 0, 'nothing new: no search, no read');
  const box = [...MAILBOX(), gmsg('m7', { from: 'dana.levi@mhfc.co.il', to: OWN, subject: 'Noam Barzilay', body: 'about Noam', at: NOW + 6e5 })];
  const busy = fakeGoogle(box, { historyAdded: 1 });
  await connectedRun(db, busy, { now: NOW + 18e5 });
  assert.deepEqual(busy.fullReads(), ['m6', 'm7'], 'only what is not stored yet is read (the look-alike is read again, still not kept)');
  assert.deepEqual(db.read('mail_messages', 'm7').dealIds, ['d2']);
});

test('a hand correction survives the next sync; "not agency mail" never comes back', async () => {
  const db = seedDb();
  await connectedRun(db, fakeGoogle(MAILBOX()));
  await store.setDeals(db, 'm1', ['d2'], { by: 'lou' });
  await store.hide(db, 'm2', { by: 'lou' });
  assert.deepEqual(db.read('mail_messages', 'm1').dealIds, ['d2']);
  const hidden = db.read('mail_messages', 'm2');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.subject, undefined, 'its content is dropped');

  // The address book changes (a new contact), so every stored message is matched again.
  await db.collection('contacts').doc('k9').set({ clubName: 'Maccabi Haifa', clubId: 'mhfc', contactName: 'Office', contactEmail: 'office@mhfc.co.il' });
  const google = fakeGoogle(MAILBOX(), { historyAdded: 1 });
  await connectedRun(db, google, { now: NOW + 9e5 });
  assert.deepEqual(db.read('mail_messages', 'm1').dealIds, ['d2'], 'the moved message stays on the deal it was moved to');
  assert.equal(db.read('mail_messages', 'm2').hidden, true);
  assert.ok(!google.fullReads().includes('m2'), 'the hidden message is not read again');

  await store.resetLinks(db, 'm1');
  assert.deepEqual(db.read('mail_messages', 'm1').dealIds, ['d1'], 'reset brings back the automatic link');
});

test('removing an address drops the mail that matched only through it', async () => {
  const db = seedDb();
  await connectedRun(db, fakeGoogle(MAILBOX()));
  await db.collection('contacts').doc('k2').set({ clubName: 'Hapoel Beer Sheva', contactName: 'Yossi Cohen', contactEmail: '' });
  await connectedRun(db, fakeGoogle(MAILBOX()), { now: NOW + 9e5 });
  assert.equal(db.read('mail_messages', 'm3'), undefined);
  assert.ok(db.read('mail_messages', 'm1'));
});

test('the Gmail API off: the run stops, says so, and tries to switch it on once a day', async () => {
  const db = seedDb();
  let tries = 0;
  const enable = async () => { tries += 1; return { ok: false, status: 403, message: 'no role' }; };
  const out = await connectedRun(db, fakeGoogle(MAILBOX(), { apiOff: true }), { enable });
  assert.deepEqual(out, { blocked: 'needs_api' });
  await connectedRun(db, fakeGoogle(MAILBOX(), { apiOff: true }), { enable, now: NOW + 36e5 });
  assert.equal(tries, 1);
  assert.equal(db.read('app_meta', 'gmail').state, 'needs_api');
});

test('threads: grouped, newest first; deal mail is left out for those who do not see money', async () => {
  const db = seedDb();
  await connectedRun(db, fakeGoogle([
    ...MAILBOX(),
    gmsg('m8', { from: 'dana.levi@mhfc.co.il', to: OWN, subject: 'Re: הצעה לאסף אקרמן', body: 'עוד משהו', threadId: 't-m1', at: NOW - 3600e3 }),
  ]));
  const admin = store.threadsOf(await store.messagesFor(db, 'club', 'mhfc', { money: true }), OWN);
  assert.deepEqual(admin.map((t) => [t.threadId, t.count]), [['t-m1', 2], ['t-m2', 1]]);
  assert.equal(admin[0].messages[0].id, 'm8');
  assert.deepEqual(admin[0].people, ['Dana Levi'], 'each person once, by name');
  const manager = store.threadsOf(await store.messagesFor(db, 'club', 'mhfc', { money: false }), OWN);
  assert.deepEqual(manager.map((t) => t.threadId), ['t-m2']);
});

test('disconnect deletes the key, every stored message and the sync state', async () => {
  const db = seedDb();
  await connectedRun(db, fakeGoogle(MAILBOX()));
  await store.hide(db, 'm2');
  const out = await store.disconnect(db, { by: 'lou', now: NOW });
  assert.equal(out.deleted, 3);
  assert.equal(db.all('mail_messages').length, 0);
  assert.equal(db.read('app_secrets', 'gmail'), undefined);
  assert.equal(db.read('mail_state', 'sync'), undefined);
  assert.deepEqual(db.read('app_meta', 'gmail'), { connected: false, disconnectedAt: NOW, disconnectedBy: 'lou', linkedCount: 0 });
});

// ── Golda ───────────────────────────────────────────────────────────────────
test('Golda answers the last mail with a club, read-only, for admins and managers only', async () => {
  const db = seedDb();
  await connectedRun(db, fakeGoogle(MAILBOX()));
  const ask = (role, about = 'Maccabi Haifa') => mailTools({ db, identity: { role, email: 'x@x.com' }, role }).mail_recent({ about, n: 5 });
  const admin = await ask('admin');
  assert.equal(admin.about.kind, 'club');
  assert.deepEqual(admin.messages.map((m) => m.subject).sort(), ['Re: training ground', 'הצעה לאסף אקרמן']);
  assert.deepEqual(admin.messages[0].attachments.length + admin.messages[1].attachments.length, 1);
  assert.equal((await ask('admin', 'maccabi haifa fc')).about.name, 'Maccabi Haifa', 'any spelling of the club');
  assert.match(admin.messages[0].gmail, /^https:\/\/mail\.google\.com\/mail\/\?authuser=lou%40goldas\.example#all\/t-m/);
  const manager = await ask('manager');
  assert.deepEqual(manager.messages.map((m) => m.subject), ['Re: training ground'], 'deal mail is admin-only');
  await assert.rejects(ask('viewer'), /admins and managers/);
  await assert.rejects(mailTools({ db, identity: { role: 'player' }, role: 'player' }).mail_recent({ about: 'Maccabi Haifa' }), /admins and managers/);
  const byContact = await mailTools({ db, identity: { role: 'admin' }, role: 'admin' }).mail_recent({ about: 'yossi.scout@gmail.com' });
  assert.equal(byContact.about.kind, 'contact');
  assert.equal(byContact.messages[0].subject, 'Noam Barzilay video');
});
