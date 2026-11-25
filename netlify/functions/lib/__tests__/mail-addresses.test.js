// Finding contacts' addresses and clubs' mail domains (lib/mail-addresses.js):
// the name matching as pure functions, then the search end to end against an
// in-memory Firestore and a stand-in for Gmail: what Gmail is asked for
// (recipients of sent mail only), what is saved by itself, what waits as a
// suggestion, the once-a-day pass and its cursor, the owner's decisions that
// are never undone by a later run, and that no name or address reaches the
// public state document, the status page, the job notes or the audit log.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
const { fakeDb, stubFirestore } = require('./fake-firestore.js');
const { can } = require('@goldas/domain');

let currentDb = null;
stubFirestore(() => currentDb);
// The mail function's own sign-in check, with the user of the test.
let currentUser = { email: 'lou@goldas.example', name: 'Lou', role: 'admin' };
const authPath = require.resolve('../auth.js');
const asJson = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    json: asJson, internalHeaders: async () => ({}),
    withAuth: (opts, handler) => async (event, context) => (can(currentUser.role, opts.action) ? handler(event, { ...context, auth: { user: currentUser, via: 'user' } }) : asJson(403, { error: 'Forbidden' })),
  },
};

const gmailAuth = require('../gmail-auth.js');
const store = require('../mail-store.js');
const A = require('../mail-addresses.js');
const { readStatus } = require('../system-status.js');
const { seal } = require('../seal.js');

const ENV = { YT_CLIENT_ID: '123-abc.apps.googleusercontent.com', YT_CLIENT_SECRET: 'client-secret-value', URL: 'https://goldas-crm.netlify.app' };
const NOW = Date.parse('2026-11-25T10:00:00Z');
const DAY = 864e5;
const OWN = 'lou@goldas.example';
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ── the pure matching ───────────────────────────────────────────────────────

/** Sent messages as the search reads them: [to, daysAgo] → { at, people }. */
const mail = (...list) => list.map(([to, daysAgo = 1], i) => ({ id: `s${i}`, at: NOW - daysAgo * DAY, people: store.parseAddressList(to) }));

/** One reading of the whole sent mail against the records: what is saved, what is suggested. */
function plan(messages, { contacts = [], clubs = [], own = OWN, decided = {} } = {}) {
  const found = A.candidates({ tally: A.tallyRecipients(messages), contacts, clubs, own });
  const items = found.map((c) => { const id = A.idOf(c.kind, c.targetId, c.value); return { ...c, id, state: decided[`${c.targetId}|${c.value}`] || 'pending', reason: null }; });
  const byId = new Map(items.map((i) => [i.id, i]));
  const d = A.decide({ items, contacts, clubs, own });
  return {
    fills: d.fills.map((f) => `${f.targetId}=${f.value}`).sort(),
    suggestions: d.open.map((o) => `${byId.get(o.id).targetId}=${byId.get(o.id).value} (${o.reason})`).sort(),
  };
}
const contact = (id, contactName, extra = {}) => ({ id, contactName, ...extra });

test('a full name match saves the address: English, any case, punctuation and word order', () => {
  const contacts = [contact('k1', 'Dana Levi'), contact('k2', "Sean O'Brien"), contact('k3', 'Ben-David Yossi')];
  const out = plan(mail(
    ['"LEVI, Dana" <Dana.L@mhfc.co.il>'],
    ['Sean OBrien <sean@club.ie>, yossi ben david <yossi@hbs.co.il>'],
  ), { contacts });
  assert.deepEqual(out, { fills: ['k1=dana.l@mhfc.co.il', 'k2=sean@club.ie', 'k3=yossi@hbs.co.il'], suggestions: [] });
});

test('a full name match in Hebrew: points (niqqud), a maqaf and extra spaces do not matter', () => {
  const contacts = [contact('k1', 'דנה לוי'), contact('k2', 'יוסי בן דוד')];
  const out = plan(mail(['לֵוִי  דָּנָה <dana@mhfc.co.il>'], ['יוסי בן־דוד <yossi@hbs.co.il>']), { contacts });
  assert.deepEqual(out.fills, ['k1=dana@mhfc.co.il', 'k2=yossi@hbs.co.il']);
  assert.deepEqual(A.nameTokens('לֵוִי,  דָּנָה'), ['לוי', 'דנה']);
  assert.equal(A.nameKey(A.nameTokens('Levi, DANA')), A.nameKey(A.nameTokens(' dana   levi ')));
});

test('a one-word name is never saved by itself', () => {
  const out = plan(mail(['Dana <dana@mhfc.co.il>', 1], ['Dana <dana@mhfc.co.il>', 2]), { contacts: [contact('k1', 'Dana')] });
  assert.deepEqual(out, { fills: [], suggestions: ['k1=dana@mhfc.co.il (one_word_name)'] });
});

test('the same name on two addresses: both wait as suggestions, nothing is saved', () => {
  const out = plan(mail(['Dana Levi <dana@mhfc.co.il>'], ['Dana Levi <dana.levi@gmail.com>']), { contacts: [contact('k1', 'Dana Levi')] });
  assert.deepEqual(out, { fills: [], suggestions: ['k1=dana.levi@gmail.com (same_name_two_addresses)', 'k1=dana@mhfc.co.il (same_name_two_addresses)'] });
});

test('two contacts with the same name: a suggestion on each, nothing is saved', () => {
  const contacts = [contact('k1', 'David Cohen'), contact('k2', 'cohen david'), contact('k3', 'David Cohen', { contactEmail: 'dc@other.org' })];
  const out = plan(mail(['David Cohen <david@mhfc.co.il>']), { contacts });
  assert.deepEqual(out, { fills: [], suggestions: ['k1=david@mhfc.co.il (same_name_two_contacts)', 'k2=david@mhfc.co.il (same_name_two_contacts)'] });
});

test('the mailbox\'s own address is never anyone\'s', () => {
  const out = plan(mail([`Lou Korek <${OWN}>, Dana Levi <dana@mhfc.co.il>`]), { contacts: [contact('k0', 'Lou Korek'), contact('k1', 'Dana Levi')] });
  assert.deepEqual(out, { fills: ['k1=dana@mhfc.co.il'], suggestions: [] });
});

test('a contact that already has an address is left alone', () => {
  const contacts = [contact('k1', 'Dana Levi', { contactEmail: 'dana@old.example' })];
  assert.deepEqual(plan(mail(['Dana Levi <dana@mhfc.co.il>']), { contacts }), { fills: [], suggestions: [] });
});

test('deleted contacts are skipped, and a name is not ambiguous because of a deleted one', () => {
  const contacts = [contact('k1', 'Dana Levi'), contact('k2', 'Dana Levi', { deletedAt: 'x' }), contact('k3', 'Noa Bar', { deletedAt: 'x' })];
  assert.deepEqual(plan(mail(['Dana Levi <dana@mhfc.co.il>, Noa Bar <noa@x.org>']), { contacts }), { fills: ['k1=dana@mhfc.co.il'], suggestions: [] });
});

test('no-reply and system addresses are never used; a shared office address only as a suggestion', () => {
  const contacts = [contact('k1', 'Dana Levi'), contact('k2', 'Noa Bar')];
  const out = plan(mail(['Dana Levi <no-reply@mhfc.co.il>, Dana Levi <notifications@x.org>, Noa Bar <office@hbs.co.il>']), { contacts });
  assert.deepEqual(out, { fills: [], suggestions: ['k2=office@hbs.co.il (shared_mailbox)'] });
  for (const a of ['noreply@x.org', 'do-not-reply@x.org', 'mailer-daemon@x.org', 'reply+abc123@x.org', 'x@resource.calendar.google.com', 'team@googlegroups.com']) assert.equal(A.isSystemAddress(a), true, a);
  assert.equal(A.isSystemAddress('dana.levi@mhfc.co.il'), false);
});

test('an address another contact already has, or that fits two contacts in full, is only suggested', () => {
  const contacts = [contact('k1', 'Dana Levi'), contact('k2', 'Office Haifa', { contactEmail: 'dana@mhfc.co.il' }), contact('k3', 'Noa Bar'), contact('k4', 'Gil Paz')];
  const out = plan(mail(['Dana Levi <dana@mhfc.co.il>'], ['Noa Bar <both@x.org>'], ['Gil Paz <both@x.org>']), { contacts });
  assert.deepEqual(out, { fills: [], suggestions: ['k1=dana@mhfc.co.il (address_in_use)', 'k3=both@x.org (address_fits_two_contacts)', 'k4=both@x.org (address_fits_two_contacts)'] });
});

test('weaker fits wait as suggestions with a reason: a longer name, another spelling, the address itself, a shared word at the club\'s domain', () => {
  const clubs = [{ id: 'mhfc', name: 'Maccabi Haifa', key: 'maccabi haifa', website: 'https://www.mhfc.co.il/he' }];
  const contacts = [
    contact('k1', 'Dana Levi'), contact('k2', 'נועם ברזילי'), contact('k3', 'Gil Paz'), contact('k4', 'אסף אקרמן'),
    contact('k5', 'Ron Shalom', { clubId: 'mhfc', clubName: 'Maccabi Haifa' }), contact('k6', 'אבי גולן', { clubName: 'Maccabi Haifa' }),
  ];
  const out = plan(mail(
    ['Dana Levi (Maccabi Haifa) <dana@mhfc.co.il>'],
    ['Noam Barzilay <noam@hbs.co.il>'],
    ['gil.paz@gmail.com, assaf.ackerman@gmail.com'],
    ['shalom@mhfc.co.il, golan@mhfc.co.il, shalom@elsewhere.org, golan@elsewhere.org'],
  ), { contacts, clubs });
  assert.deepEqual(out.fills, ['mhfc=mhfc.co.il'], 'only the club\'s domain: mail was sent there');
  assert.deepEqual(out.suggestions, [
    'k1=dana@mhfc.co.il (name_contained)', 'k2=noam@hbs.co.il (name_sounds_alike)', 'k3=gil.paz@gmail.com (address_spells_name)',
    'k4=assaf.ackerman@gmail.com (address_spells_name)', 'k5=shalom@mhfc.co.il (shared_word_club_domain)', 'k6=golan@mhfc.co.il (shared_word_club_domain)',
  ]);
});

test('at most three suggestions for one contact, the strongest first', () => {
  const to = ['a', 'b', 'c', 'd', 'e'].map((x) => `Dana <dana.${x}@x${x}.org>`).join(', ');
  const out = plan(mail([to]), { contacts: [contact('k1', 'Dana')] });
  assert.equal(out.suggestions.length, A.PER_TARGET);
});

test('a club\'s domain comes from its own website: saved when mail was sent there, otherwise suggested', () => {
  const clubs = [
    { id: 'c1', name: 'Maccabi Haifa', website: 'https://www.MHFC.co.il/he/contact' },
    { id: 'c2', name: 'Hapoel Beer Sheva', website: 'hbs.co.il' },
    { id: 'c3', name: 'Has one', website: 'https://club3.example', emailDomain: 'mail.club3.example' },
    { id: 'c4', name: 'Gone', website: 'https://club4.example', deletedAt: 'x' },
    { id: 'c5', name: 'English site', website: 'https://en.club5.example/team' },
  ];
  assert.deepEqual([...A.clubTargets({ clubs, own: OWN })], [['c1', 'mhfc.co.il'], ['c2', 'hbs.co.il'], ['c5', 'club5.example']]);
  const out = plan(mail(['someone@mhfc.co.il, x@club3.example, y@club4.example']), { clubs });
  assert.deepEqual(out, { fills: ['c1=mhfc.co.il'], suggestions: ['c2=hbs.co.il (website_only)', 'c5=club5.example (website_only)'] });
});

test('a website that is not the club\'s own, a free mail domain, the agency\'s own domain and a host two clubs share are skipped', () => {
  const notOwn = ['https://www.facebook.com/maccabi', 'https://instagram.com/club', 'https://x.com/club', 'https://twitter.com/club', 'https://m.youtube.com/@club',
    'https://www.tiktok.com/@club', 'https://linktr.ee/club', 'https://he.wikipedia.org/wiki/Club', 'https://www.transfermarkt.co.il/club/startseite/verein/1',
    'https://www.transfermarkt.com/x', 'https://www.football.org.il/team-details/?team_id=1', 'https://www.sofascore.com/team/football/x/1', 'https://sites.google.com/view/club'];
  for (const website of notOwn) assert.equal(A.siteDomain(website), '', website);
  const clubs = [
    ...notOwn.map((website, i) => ({ id: `n${i}`, name: `N${i}`, website })),
    { id: 'free', name: 'Free', website: 'https://club.walla.co.il' },
    { id: 'free2', name: 'Free2', website: 'gmail.com' },
    { id: 'us', name: 'Us', website: 'https://www.goldas.example' },
    { id: 'a', name: 'Senior', website: 'https://shared.example' }, { id: 'b', name: 'Youth', website: 'http://www.shared.example/youth' },
    { id: 'taken', name: 'Taken', website: 'https://used.example' }, { id: 'other', name: 'Other', website: '', emailDomain: 'used.example' },
    { id: 'bad', name: 'Bad', website: 'not a site' },
  ];
  assert.deepEqual([...A.clubTargets({ clubs, own: OWN })], []);
  assert.deepEqual(plan(mail(['x@shared.example, y@goldas.example, z@used.example']), { clubs }), { fills: [], suggestions: [] });
});

test('what was dismissed, and an automatic value that was removed, is never offered or saved again', () => {
  const contacts = [contact('k1', 'Dana Levi'), contact('k2', 'Dana')];
  const clubs = [{ id: 'c1', name: 'Maccabi Haifa', website: 'https://mhfc.co.il' }, { id: 'c2', name: 'HBS', website: 'https://hbs.co.il' }];
  const messages = mail(['Dana Levi <dana@mhfc.co.il>, Dana <d@x.org>']);
  assert.deepEqual(plan(messages, { contacts, clubs }), { fills: ['c1=mhfc.co.il', 'k1=dana@mhfc.co.il'], suggestions: ['c2=hbs.co.il (website_only)', 'k2=d@x.org (one_word_name)'] });
  const decided = { 'k1|dana@mhfc.co.il': 'removed', 'k2|d@x.org': 'dismissed', 'c1|mhfc.co.il': 'removed', 'c2|hbs.co.il': 'dismissed' };
  assert.deepEqual(plan(messages, { contacts, clubs, decided }), { fills: [], suggestions: [] });
  // A removed address still carries the name: another address with that name is not saved by itself either.
  const more = [...messages, ...mail(['Dana Levi <dana.levi@other.org>'])];
  assert.deepEqual(plan(more, { contacts: [contacts[0]], decided }), { fills: [], suggestions: ['k1=dana.levi@other.org (same_name_two_addresses)'] });
});

test('only the To, Cc, Bcc and Date headers of a message are read', () => {
  const rec = A.readRecipients({ id: 'm1', internalDate: String(NOW), snippet: 'SECRET SNIPPET', payload: { headers: [
    { name: 'From', value: 'Hidden Sender <hidden@x.org>' }, { name: 'Subject', value: 'SECRET SUBJECT' },
    { name: 'To', value: '=?UTF-8?B?15PXoNeUINec15XXmQ==?= <dana@mhfc.co.il>' }, { name: 'CC', value: 'a@x.org' }, { name: 'Bcc', value: 'b@x.org' },
  ] } });
  assert.deepEqual(rec, { id: 'm1', at: NOW, people: [{ name: '=?UTF-8?B?15PXoNeUINec15XXmQ==?=', email: 'dana@mhfc.co.il' }, { name: '', email: 'a@x.org' }, { name: '', email: 'b@x.org' }] });
  const tally = A.tallyRecipients([rec, rec]);
  assert.deepEqual([...tally.keys()], ['dana@mhfc.co.il', 'a@x.org', 'b@x.org']);
  assert.deepEqual([...tally.get('dana@mhfc.co.il').names], [['דנה לוי', 2]], 'an encoded name is read as text');
  assert.ok(!JSON.stringify([...tally]).includes('SECRET') && !JSON.stringify([...tally]).includes('hidden'));
});

// ── the search, end to end ──────────────────────────────────────────────────

const sent = (id, to, daysAgo, extra = {}) => ({ id, at: NOW - daysAgo * DAY, to, cc: extra.cc || '', bcc: extra.bcc || '', subject: 'SECRET SUBJECT', body: 'SECRET BODY', from: `Lou <${OWN}>` });

/** A stand-in for Gmail: the SENT list by date with paging, one message's recipient headers, and the ordinary sync's calls. */
function fakeGmail(box, { pageSize = 100, apiOff = false, failAfter = Infinity } = {}) {
  const calls = [];
  let reads = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return res(200, { access_token: 'access-1', expires_in: 3600 });
    if (apiOff) return res(403, { error: { message: 'Gmail API has not been used in project 1 before or it is disabled', errors: [{ reason: 'accessNotConfigured' }] } });
    const path = url.replace('https://gmail.googleapis.com/gmail/v1/users/me/', '');
    if (path === 'profile') return res(200, { emailAddress: OWN, historyId: '900' });
    if (path.startsWith('history?')) return res(200, { history: [] });
    if (path.startsWith('messages?')) {
      const p = new URLSearchParams(path.slice('messages?'.length));
      const q = p.get('q') || '';
      if (p.get('labelIds') !== 'SENT') {
        // The ordinary sync's search, by address.
        const terms = [...q.matchAll(/(?:from|to|cc):(\S+?)(?=[\s}])/g)].map((m) => m[1]);
        return res(200, { messages: box.filter((m) => terms.some((t) => `${m.to} ${m.cc}`.toLowerCase().includes(t))).map((m) => ({ id: m.id, threadId: m.id })) });
      }
      const after = Number((/after:(\d+)/.exec(q) || [])[1] || 0);
      const before = Number((/before:(\d+)/.exec(q) || [])[1] || Infinity);
      const list = box.filter((m) => m.at / 1000 > after && m.at / 1000 < before).sort((a, b) => b.at - a.at);
      const start = Number(p.get('pageToken') || 0);
      return res(200, { messages: list.slice(start, start + pageSize).map((m) => ({ id: m.id, threadId: m.id })), ...(start + pageSize < list.length ? { nextPageToken: String(start + pageSize) } : {}) });
    }
    const one = /^messages\/([^?]+)\?(.*)$/.exec(path);
    if (one) {
      const m = box.find((x) => x.id === decodeURIComponent(one[1]));
      if (!m) return res(404, { error: { message: 'not found' } });
      const p = new URLSearchParams(one[2]);
      if (p.get('format') === 'metadata') {
        reads += 1;
        if (reads > failAfter) return res(429, { error: { message: 'Rate limit exceeded' } });
        const want = p.getAll('metadataHeaders').map((h) => h.toLowerCase());
        const all = { to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, from: m.from };
        const headers = Object.entries(all).filter(([k, v]) => v && want.includes(k)).map(([name, value]) => ({ name, value }));
        const full = { id: m.id, threadId: m.id, internalDate: String(m.at), snippet: m.body, payload: { headers } };
        const fields = (p.get('fields') || '').split(',');
        return res(200, { id: full.id, ...(fields.includes('internalDate') ? { internalDate: full.internalDate } : {}), ...(fields.includes('snippet') ? { snippet: full.snippet } : {}), ...(fields.includes('payload/headers') ? { payload: { headers } } : {}) });
      }
      return res(200, { id: m.id, threadId: m.id, internalDate: String(m.at), snippet: m.body.slice(0, 20), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }], body: { data: Buffer.from(m.body).toString('base64') } } });
    }
    return res(404, { error: { message: 'unexpected' } });
  };
  const gmail = () => calls.filter((u) => u.includes('gmail.googleapis.com'));
  return { fetchImpl, calls, gmail, metaReads: () => gmail().filter((u) => /\/messages\/[^?]+\?/.test(u)).map((u) => decodeURIComponent(/messages\/([^?]+)/.exec(u)[1])), lists: () => gmail().filter((u) => u.includes('labelIds=SENT')) };
}

function seedDb(extra = {}) {
  return fakeDb({
    clubs: {
      mhfc: { name: 'Maccabi Haifa', key: 'maccabi haifa', website: 'https://www.mhfc.co.il' },
      hbs: { name: 'Hapoel Beer Sheva', key: 'hapoel beer sheva', website: 'https://www.hbs.co.il/' },
      fb: { name: 'Bnei Yehuda', key: 'bnei yehuda', website: 'https://www.facebook.com/bneiyehuda' },
    },
    contacts: {
      k1: { clubName: 'Maccabi Haifa', clubId: 'mhfc', contactName: 'Dana Levi' },
      k2: { clubName: 'Hapoel Beer Sheva', contactName: 'יוסי כהן' },
      k3: { clubName: '', contactName: 'Noa' },
      k4: { clubName: '', contactName: 'Gil Paz', contactEmail: 'gil@paz.example' },
    },
    app_meta: { gmail: { connected: true, address: OWN, state: 'no_addresses', api: { state: 'on' } } },
    app_secrets: { gmail: { refreshToken: seal('refresh-1') } },
    ...extra,
  });
}
const BOX = () => [
  sent('s1', 'Dana Levi <dana.levi@mhfc.co.il>', 3),
  sent('s2', '"כהן יוסי" <yossi@gmail.com>, Bank <no-reply@bank.example>', 20, { cc: 'Dana Levi <dana.levi@mhfc.co.il>' }),
  sent('s3', 'Noa <noa@friend.example>', 40, { bcc: 'Gil Paz <gil.other@paz.example>' }),
  sent('s4', 'Stranger Person <stranger@nowhere.example>', 100),
  sent('s5', 'Dana Levi <old@too-old.example>', 400),
];
const PRIVATE = ['dana.levi@mhfc.co.il', 'yossi@gmail.com', 'noa@friend.example', 'stranger@nowhere.example', 'mhfc.co.il', 'hbs.co.il', 'Dana Levi', 'יוסי כהן', 'כהן יוסי', 'Noa', 'Stranger', 'SECRET'];

function search(db, gmail, opts = {}) {
  gmailAuth._resetCacheForTests();
  const notes = [];
  return A.findAddresses(db, { fetchImpl: gmail.fetchImpl, now: NOW, env: ENV, job: { note: (s) => notes.push(s) }, ...opts }).then((out) => ({ out, notes }));
}
const finding = (db, kind, targetId, value) => db.read(A.COL, A.idOf(kind, targetId, value));

test('one run: sent mail of the last year is read for its recipients only, full matches are saved and marked, the rest waits', async () => {
  const db = seedDb();
  const gmail = fakeGmail(BOX());
  const { out, notes } = await search(db, gmail);

  // What Gmail was asked: the SENT list since a year ago, and each message's To, Cc, Bcc and Date. Nothing else.
  assert.equal(gmail.lists().length, 1);
  const q = new URL(gmail.lists()[0]).searchParams.get('q');
  assert.equal(q, `after:${Math.floor((NOW - 365 * DAY) / 1000) - 1}`);
  assert.deepEqual(gmail.metaReads().sort(), ['s1', 's2', 's3', 's4'], 'mail older than a year is not asked for');
  for (const u of gmail.gmail().filter((x) => /\/messages\/[^?]+\?/.test(x))) {
    const p = new URL(u).searchParams;
    assert.equal(p.get('format'), 'metadata');
    assert.deepEqual(p.getAll('metadataHeaders'), ['To', 'Cc', 'Bcc', 'Date']);
    assert.equal(p.get('fields'), 'id,internalDate,payload/headers', 'the field mask leaves Gmail\'s snippet out');
  }
  assert.ok(!gmail.gmail().some((u) => /format=full|format=raw|subject|snippet/i.test(u)));

  // Saved by itself, with where it came from.
  const k1 = db.read('contacts', 'k1');
  assert.equal(k1.contactEmail, 'dana.levi@mhfc.co.il');
  assert.equal(k1.contactEmailSource, 'mailbox');
  assert.equal(k1.contactEmailFilledAt, NOW);
  assert.equal(k1.lastEditedBy, 'mail-addresses');
  assert.equal(db.read('contacts', 'k2').contactEmail, 'yossi@gmail.com', 'a Hebrew name in the other order');
  const mhfc = db.read('clubs', 'mhfc');
  assert.deepEqual([mhfc.emailDomain, mhfc.emailDomainSource, mhfc.emailDomainFilledAt], ['mhfc.co.il', 'website', NOW]);
  // Not saved: a one-word name, a club nobody was written to, a club whose "website" is Facebook, a contact that has an address.
  assert.equal(db.read('contacts', 'k3').contactEmail, undefined);
  assert.equal(db.read('clubs', 'hbs').emailDomain, undefined);
  assert.equal(db.read('clubs', 'fb').emailDomain, undefined);
  assert.equal(db.read('contacts', 'k4').contactEmail, 'gil@paz.example');
  assert.equal(finding(db, 'contact', 'k1', 'dana.levi@mhfc.co.il').state, 'auto');
  assert.deepEqual([finding(db, 'contact', 'k3', 'noa@friend.example').state, finding(db, 'contact', 'k3', 'noa@friend.example').reason], ['open', 'one_word_name']);
  assert.deepEqual([finding(db, 'club', 'hbs', 'hbs.co.il').state, finding(db, 'club', 'hbs', 'hbs.co.il').reason], ['open', 'website_only']);
  // Only results tied to a record of the CRM are kept: the stranger and the bank are nowhere.
  const kept = JSON.stringify(db.all(A.COL));
  assert.ok(!kept.includes('stranger') && !kept.includes('bank.example') && !kept.includes('too-old'));
  assert.equal(db.all(A.COL).length, 5);

  // Counts only, everywhere outside the admin's own list.
  assert.deepEqual(out, { read: 4, calls: 5, found: 4, done: true, saved: { contacts: 2, clubs: 1 }, suggested: 2, dropped: 0, filled: 3, open: 2 });
  assert.deepEqual(db.read('app_meta', 'gmail').found, { filled: 3, open: 2, state: 'done', targets: 5, read: 4, yearRead: true });
  const audit = db.all('audit');
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((a) => [a.collection, a.docId, a.fields.join(), a.via]).sort(), [['clubs', 'mhfc', 'emailDomain', 'mail-addresses'], ['contacts', 'k1', 'contactEmail', 'mail-addresses'], ['contacts', 'k2', 'contactEmail', 'mail-addresses']]);
  const pub = { ...db.read('app_meta', 'gmail'), address: null };
  const outside = JSON.stringify([out, notes, pub, audit, await readStatus(db, NOW), db.read('mail_state', 'sync')]);
  assert.ok(!outside.includes('@'), 'no address outside the admin list');
  for (const p of PRIVATE) assert.ok(!outside.includes(p), `leaked: ${p}`);
  const status = await readStatus(db, NOW);
  assert.deepEqual([status.mail.addressesFilled, status.mail.suggestionsOpen], [3, 2]);
});

test('the admin list names the records; the mail sync that follows reads for the saved addresses', async () => {
  const db = seedDb();
  const box = BOX();
  await search(db, fakeGmail(box));
  const list = await A.listFound(db);
  assert.deepEqual(list.filled.map((f) => [f.kind, f.name, f.club, f.value, f.reason]), [
    ['contact', 'Dana Levi', 'Maccabi Haifa', 'dana.levi@mhfc.co.il', 'full_name'],
    ['club', 'Maccabi Haifa', '', 'mhfc.co.il', 'website_mail'],
    ['contact', 'יוסי כהן', 'Hapoel Beer Sheva', 'yossi@gmail.com', 'full_name'],
  ]);
  assert.deepEqual(list.suggestions.map((s) => [s.kind, s.name, s.value, s.reason, s.seenName, s.times]), [
    ['club', 'Hapoel Beer Sheva', 'hbs.co.il', 'website_only', '', 0], ['contact', 'Noa', 'noa@friend.example', 'one_word_name', 'Noa', 1],
  ]);
  assert.deepEqual(list.search, { state: 'done', readBackTo: null, lastRunAt: NOW, yearRead: true, targets: 5, read: 4 });

  // The same job goes on to the ordinary sync: the book is no longer empty, so mail is read and kept.
  gmailAuth._resetCacheForTests();
  const out = await store.syncMailbox(db, { fetchImpl: fakeGmail(box).fetchImpl, now: NOW, env: ENV });
  assert.equal(out.terms, 4, 'two found addresses, the found domain and the address typed by hand');
  assert.equal(db.read('app_meta', 'gmail').state, 'ok');
  assert.ok(db.read('mail_messages', 's1'));
  assert.deepEqual(db.read('app_meta', 'gmail').found, { filled: 3, open: 2, state: 'done', targets: 5, read: 4, yearRead: true }, 'the sync keeps the numbers');
  assert.ok(db.read('mail_state', 'sync').fill.doneAt, 'and the search\'s own state');
});

test('at most one pass a day; a pass that does not fit one run goes on from its cursor and decides only at the end', async () => {
  const db = seedDb();
  const box = [
    sent('n1', 'Dana Levi <dana.levi@mhfc.co.il>', 1), sent('n2', 'x@a.example', 2), sent('n3', 'y@a.example', 3),
    sent('n4', 'z@a.example', 4), sent('n5', 'w@a.example', 5), sent('n6', 'Dana Levi <dana@home.example>', 6),
  ];
  // Run 1: four Gmail calls are allowed (one list, three messages).
  const g1 = fakeGmail(box, { pageSize: 2 });
  const r1 = await search(db, g1, { maxCalls: 5 });
  assert.equal(r1.out.calls <= 5, true);
  assert.equal(r1.out.done, false);
  assert.deepEqual(g1.metaReads(), ['n1', 'n2', 'n3']);
  assert.equal(db.read('contacts', 'k1').contactEmail, undefined, 'nothing is saved before the whole year is read');
  assert.equal(finding(db, 'contact', 'k1', 'dana.levi@mhfc.co.il').state, 'pending');
  assert.deepEqual((await A.listFound(db)).suggestions, []);
  const fill1 = db.read('mail_state', 'sync').fill;
  assert.deepEqual([fill1.upTo, fill1.doneAt, fill1.edge], [NOW - 3 * DAY, null, ['n3']]);
  assert.deepEqual((await A.listFound(db)).search, { state: 'running', readBackTo: NOW - 3 * DAY, lastRunAt: NOW, yearRead: false, targets: 5, read: 3 });

  // Run 2, fifteen minutes later: goes on below the cursor, reads nothing twice, finishes.
  const g2 = fakeGmail(box, { pageSize: 2 });
  const r2 = await search(db, g2, { now: NOW + 9e5 });
  assert.match(new URL(g2.lists()[0]).searchParams.get('q'), new RegExp(`before:${Math.floor((NOW - 3 * DAY) / 1000) + 1}$`));
  assert.deepEqual(g2.metaReads(), ['n4', 'n5', 'n6']);
  assert.equal(r2.out.done, true);
  // The name is on two addresses over the whole year: both wait, none is saved.
  assert.equal(db.read('contacts', 'k1').contactEmail, undefined);
  assert.deepEqual((await A.listFound(db)).suggestions.filter((s) => s.targetId === 'k1').map((s) => [s.value, s.reason]), [['dana.levi@mhfc.co.il', 'same_name_two_addresses'], ['dana@home.example', 'same_name_two_addresses']]);

  // The same day: not one call to Google.
  const g3 = fakeGmail(box);
  const r3 = await search(db, g3, { now: NOW + 9e5 + 23 * 36e5 });
  assert.deepEqual(r3.out, { skipped: 'once a day' });
  assert.equal(g3.calls.length, 0);

  // A day later: only what was sent since the last pass began.
  const later = [...box, sent('n7', 'Noa <noa@new.example>', -0.5)];
  const g4 = fakeGmail(later);
  const r4 = await search(db, g4, { now: NOW + 9e5 + DAY });
  assert.equal(new URL(g4.lists()[0]).searchParams.get('q'), `after:${Math.floor(NOW / 1000) - 1}`);
  assert.deepEqual(g4.metaReads(), ['n7']);
  assert.equal(r4.out.done, true);
  assert.equal(finding(db, 'contact', 'k3', 'noa@new.example').state, 'open');
  assert.equal(finding(db, 'contact', 'k1', 'dana.levi@mhfc.co.il').n, 1, 'old mail is not counted twice');
});

test('a Gmail error in the middle keeps what was read, waits an hour, then goes on', async () => {
  const db = seedDb();
  const box = BOX();
  const g1 = fakeGmail(box, { failAfter: 2 });
  const r1 = await search(db, g1, { maxCalls: 3 });       // one list, then two messages at once
  assert.equal(r1.out.done, false);
  const g1b = fakeGmail(box, { failAfter: 0 });
  const r1b = await search(db, g1b, { now: NOW + 9e5 });
  assert.equal(r1b.out.failed, 429);
  assert.ok(!JSON.stringify(r1b).includes('@'));
  const g2 = fakeGmail(box);
  assert.deepEqual((await search(db, g2, { now: NOW + 18e5 })).out, { skipped: 'waiting after a failure' });
  assert.equal(g2.calls.length, 0);
  const r3 = await search(db, fakeGmail(box), { now: NOW + 9e5 + 36e5 + 1 });
  assert.equal(r3.out.done, true);
  assert.equal(db.read('contacts', 'k1').contactEmail, 'dana.levi@mhfc.co.il');
  assert.equal(finding(db, 'contact', 'k1', 'dana.levi@mhfc.co.il').n, 2, 'each message counted once');
});

test('not connected, or the Gmail API off: nothing is asked and nothing is written', async () => {
  const off = seedDb({ app_meta: { gmail: { connected: false } } });
  const g1 = fakeGmail(BOX());
  assert.deepEqual((await search(off, g1)).out, { skipped: 'not connected' });
  assert.equal(g1.calls.length, 0);

  const known = seedDb({ app_meta: { gmail: { connected: true, address: OWN, state: 'needs_api', api: { state: 'off' } } } });
  const g2 = fakeGmail(BOX(), { apiOff: true });
  assert.deepEqual((await search(known, g2)).out, { skipped: 'gmail api off' });
  assert.equal(g2.gmail().length, 0);

  // The API went off since the last run: the first call says so, and the day's pass is not used up.
  const fresh = seedDb();
  const g3 = fakeGmail(BOX(), { apiOff: true });
  assert.deepEqual((await search(fresh, g3)).out, { blocked: 'needs_api' });
  assert.equal(fresh.read('mail_state', 'sync'), undefined);
  assert.equal(fresh.all(A.COL).length, 0);
  assert.equal(fresh.read('contacts', 'k1').contactEmail, undefined);
});

test('with nothing to look for, Gmail is not asked at all', async () => {
  const db = seedDb({ clubs: {}, contacts: { k4: { contactName: 'Gil Paz', contactEmail: 'gil@paz.example' } } });
  const g = fakeGmail(BOX());
  assert.equal((await search(db, g)).out.skipped, 'nothing to look for');
  assert.equal(g.gmail().length, 0);
});

test('a dismissed suggestion and a removed automatic value never come back, whatever later runs read', async () => {
  const db = seedDb();
  const box = BOX();
  await search(db, fakeGmail(box));
  const by = { email: 'lou@goldas.example', name: 'Lou' };
  const noa = A.idOf('contact', 'k3', 'noa@friend.example');
  const dana = A.idOf('contact', 'k1', 'dana.levi@mhfc.co.il');
  const club = A.idOf('club', 'mhfc', 'mhfc.co.il');

  assert.deepEqual(await A.dismiss(db, noa, { by, now: NOW + 1 }), { dismissed: 1, filled: 3, open: 1 });
  assert.deepEqual(await A.undo(db, dana, { by, now: NOW + 2 }), { removed: 1, cleared: true, filled: 2, open: 1 });
  assert.deepEqual(await A.undo(db, club, { by, now: NOW + 3 }), { removed: 1, cleared: true, filled: 1, open: 1 });
  const k1 = db.read('contacts', 'k1');
  assert.deepEqual([k1.contactEmail, k1.contactEmailSource, k1.contactEmailFilledAt, k1.lastEditedBy], ['', undefined, undefined, 'lou@goldas.example']);
  assert.equal(db.read('clubs', 'mhfc').emailDomain, '');
  assert.deepEqual([db.read(A.COL, dana).state, db.read(A.COL, noa).state, db.read(A.COL, club).state], ['removed', 'dismissed', 'removed']);
  await assert.rejects(A.undo(db, dana, { by }), /no longer waiting/);
  await assert.rejects(A.dismiss(db, noa, { by }), /no longer waiting/);

  // The next day's pass, and a full pass over the year again: neither saves nor offers them.
  await search(db, fakeGmail([...box, sent('s9', 'Dana Levi <dana.levi@mhfc.co.il>, Noa <noa@friend.example>', -0.2)]), { now: NOW + DAY });
  const st = db.read('mail_state', 'sync');
  await db.collection('mail_state').doc('sync').set({ fill: { ...st.fill, yearDoneAt: null } }, { merge: true });
  const again = await search(db, fakeGmail(box), { now: NOW + 2 * DAY });
  assert.equal(again.out.done, true);
  assert.equal(db.read('contacts', 'k1').contactEmail, '');
  assert.equal(db.read('clubs', 'mhfc').emailDomain, '');
  assert.deepEqual([db.read(A.COL, dana).state, db.read(A.COL, noa).state, db.read(A.COL, club).state], ['removed', 'dismissed', 'removed']);
  const list = await A.listFound(db);
  assert.deepEqual(list.suggestions.map((s) => s.value), ['hbs.co.il']);
  assert.deepEqual(list.filled.map((f) => f.value), ['yossi@gmail.com']);
  assert.equal(db.all('audit').filter((a) => /removed/.test(a.summary)).length, 2);
});

test('approving: one by one, and "all" only where a suggestion stands alone', async () => {
  const db = seedDb({ contacts: {
    k1: { contactName: 'Dana Levi' }, k3: { contactName: 'Noa' }, k5: { contactName: 'Ron Shalom' }, k6: { contactName: 'Tal' }, k7: { contactName: 'tal' },
  } });
  const box = [
    sent('a1', 'Dana Levi <dana@mhfc.co.il>, Dana Levi <dana@home.example>', 2),
    sent('a2', 'Noa <noa@friend.example>, ron.shalom@gmail.com, Tal <tal@x.example>', 3),
  ];
  await search(db, fakeGmail(box));
  const by = { email: 'lou@goldas.example', name: 'Lou' };
  let list = await A.listFound(db);
  assert.equal(list.suggestions.length, 7);
  assert.deepEqual(list.filled.map((f) => f.value), ['mhfc.co.il']);

  const out = await A.acceptAll(db, { by, now: NOW + 5 });
  // Noa, Ron and the Beer Sheva domain stand alone. Dana has two addresses, and one address is offered to both Tals: those wait.
  assert.deepEqual(out, { accepted: 3, skipped: 4, filled: 1, open: 4 });
  assert.equal(db.read('contacts', 'k3').contactEmail, 'noa@friend.example');
  assert.equal(db.read('contacts', 'k5').contactEmail, 'ron.shalom@gmail.com');
  assert.equal(db.read('clubs', 'hbs').emailDomain, 'hbs.co.il');
  assert.equal(db.read('contacts', 'k1').contactEmail, undefined);
  assert.equal(db.read('contacts', 'k6').contactEmail, undefined);

  const home = A.idOf('contact', 'k1', 'dana@home.example');
  assert.deepEqual(await A.accept(db, home, { by, now: NOW + 6 }), { accepted: 1, filled: 1, open: 2 });
  const k1 = db.read('contacts', 'k1');
  assert.deepEqual([k1.contactEmail, k1.contactEmailSource, k1.lastEditedBy], ['dana@home.example', 'mailbox', 'lou@goldas.example']);
  assert.equal(db.read(A.COL, home).state, 'accepted');
  assert.equal(finding(db, 'contact', 'k1', 'dana@mhfc.co.il'), undefined, 'the other suggestion for the same contact is gone');
  await assert.rejects(A.accept(db, home, { by }), /no longer waiting/);
  list = await A.listFound(db);
  assert.deepEqual(list.suggestions.map((s) => [s.targetId, s.value]).sort(), [['k6', 'tal@x.example'], ['k7', 'tal@x.example']]);
  assert.deepEqual(db.all('audit').filter((a) => a.via === 'web').map((a) => a.by), Array(4).fill('lou@goldas.example'));
  assert.ok(!JSON.stringify(db.all('audit')).includes('@home') && !JSON.stringify(db.all('audit')).includes('Dana'));

  // A suggestion whose record got a value by hand meanwhile cannot be approved.
  await db.collection('contacts').doc('k6').set({ contactName: 'Tal', contactEmail: 'typed@by-hand.example' });
  await assert.rejects(A.accept(db, A.idOf('contact', 'k6', 'tal@x.example'), { by }), /already has a value/);
});

test('a contact added later gets the whole year read for it, once, and nothing is counted twice', async () => {
  const db = seedDb();
  const box = BOX();
  await search(db, fakeGmail(box));
  await db.collection('contacts').doc('k9').set({ contactName: 'Stranger Person' });
  const next = fakeGmail(box);
  const r = await search(db, next, { now: NOW + DAY });
  assert.deepEqual(next.metaReads().sort(), ['s1', 's2', 's3', 's4'], 'the year again, for the new name');
  assert.equal(r.out.done, true);
  assert.equal(db.read('contacts', 'k9').contactEmail, 'stranger@nowhere.example');
  assert.equal(finding(db, 'contact', 'k1', 'dana.levi@mhfc.co.il').n, 2, 'still the two messages of the year');
  // Nothing new the day after: only mail sent since.
  const quiet = fakeGmail(box);
  await search(db, quiet, { now: NOW + 2 * DAY });
  assert.deepEqual(quiet.metaReads(), []);
});

test('a renamed contact, or one that got an address by hand, drops what was found for the old state', async () => {
  const db = seedDb();
  await search(db, fakeGmail(BOX()));
  assert.equal(finding(db, 'contact', 'k3', 'noa@friend.example').state, 'open');
  await db.collection('contacts').doc('k3').set({ contactName: 'Noa', contactEmail: 'noa@typed.example' });
  await db.collection('clubs').doc('hbs').set({ name: 'Hapoel Beer Sheva', website: 'https://www.hapoelb7.example' });
  assert.deepEqual((await A.listFound(db)).suggestions, [], 'not offered once the record has a value or another website');
  await search(db, fakeGmail(BOX()), { now: NOW + DAY });
  assert.equal(finding(db, 'contact', 'k3', 'noa@friend.example'), undefined);
  assert.equal(finding(db, 'club', 'hbs', 'hbs.co.il'), undefined);
  assert.equal(finding(db, 'club', 'hbs', 'hapoelb7.example').state, 'open');
});

// ── the mail function ───────────────────────────────────────────────────────

test('the mail function: the list and every address action are for an admin only; disconnecting drops what was not decided', async () => {
  const db = seedDb();
  currentDb = db;
  await search(db, fakeGmail(BOX()));
  const kicked = [];
  const realFetch = global.fetch;
  global.fetch = async (u) => { kicked.push(String(u)); return res(202, {}); };
  try {
    const { handler } = require('../../mail.js');
    const get = () => handler({ httpMethod: 'GET', headers: { host: 'goldas-crm.netlify.app' }, queryStringParameters: { addresses: '1' } });
    const post = (body) => handler({ httpMethod: 'POST', headers: { host: 'goldas-crm.netlify.app' }, body: JSON.stringify(body) });
    const noa = A.idOf('contact', 'k3', 'noa@friend.example');
    const dana = A.idOf('contact', 'k1', 'dana.levi@mhfc.co.il');

    for (const role of ['manager', 'viewer']) {
      currentUser = { email: 'm@goldas.example', name: 'M', role };
      assert.equal((await get()).statusCode, 403, `${role} list`);
      for (const body of [{ action: 'address_accept', id: noa }, { action: 'address_accept_all' }, { action: 'address_dismiss', id: noa }, { action: 'address_undo', id: dana }]) {
        assert.equal((await post(body)).statusCode, 403, `${role} ${body.action}`);
      }
    }
    assert.equal(db.read('contacts', 'k1').contactEmail, 'dana.levi@mhfc.co.il');
    assert.equal(db.read(A.COL, noa).state, 'open');

    currentUser = { email: 'lou@goldas.example', name: 'Lou', role: 'admin' };
    const list = JSON.parse((await get()).body);
    assert.deepEqual([list.filled.length, list.suggestions.length, list.search.state], [3, 2, 'done']);
    assert.equal((await post({ action: 'address_accept', id: 'nope' })).statusCode, 404);
    assert.deepEqual(JSON.parse((await post({ action: 'address_accept', id: noa })).body), { accepted: 1, filled: 3, open: 1 });
    assert.deepEqual(JSON.parse((await post({ action: 'address_undo', id: dana })).body), { removed: 1, cleared: true, filled: 2, open: 1 });
    assert.equal(kicked.filter((u) => u.includes('gmail-sync-background')).length, 2, 'a changed address starts a sync');
    assert.deepEqual(JSON.parse((await post({ action: 'address_accept_all' })).body), { accepted: 1, skipped: 0, filled: 2, open: 0 });

    // Something still undecided, then disconnect.
    await db.collection(A.COL).doc('x1').set({ kind: 'contact', targetId: 'k9', value: 'p@x.example', state: 'pending' });
    await db.collection(A.COL).doc('x2').set({ kind: 'contact', targetId: 'k9', value: 'o@x.example', state: 'open' });
    assert.equal((await post({ action: 'disconnect' })).statusCode, 200);
    assert.deepEqual(db.all(A.COL).map((d) => d.state).sort(), ['accepted', 'accepted', 'auto', 'auto', 'removed']);
    assert.equal(db.read('mail_state', 'sync'), undefined, 'the search starts over after a new connection');
    assert.deepEqual(db.read('app_meta', 'gmail').found, { filled: 2, open: 0, state: 'never', targets: 0, read: 0, yearRead: false });
  } finally {
    global.fetch = realFetch;
    currentDb = null;
  }
});
