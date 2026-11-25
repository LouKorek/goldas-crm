// Representation agreements signed inside the system: making one from the
// template, the one answer every dead link gets, signing exactly once, what
// a submission must hold, the hash of the text that was shown, what never
// leaves the server, filing the signed PDF (and its retry), revoking and
// re-issuing the link, telling the owner, and Golda's tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
const { fakeDb, stubFirestore, recorder, OWNER, MANAGER } = require('./fake-firestore.js');
const admin = stubFirestore();

const ag = require('../agreements.js');
const { agreementTools } = require('../golda-agreement.js');
const { idOf, sha256 } = require('../public-link.js');
const { toolsFor, systemPrompt } = require('../wa-agent.js');
const signPublic = require('../../agreement-sign.js');
const signedIn = require('../../player-agreements.js');

const DAY = 86400000;
const NOW = Date.parse('2026-11-25T12:30:00Z');   // 14:30 in Israel
const SECRET_ID = '312345678';
const SECRET_GUARDIAN_ID = '298765432';

/** A real PNG (w×h, a drawn-looking line), so jsPDF can place it too. */
function png(w = 300, h = 100) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (__, x) => (Math.abs(y - (h / 2 + 20 * Math.sin(x / 17))) < 3 ? 0 : 255)))])));
  const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
const SIG = png();

const TEMPLATE_HE = [
  '# הסכם ייצוג',
  'הסכם זה נערך בין {{agency_name}} לבין {{player_name}}, יליד {{player_dob}}, מספר זהות {{player_id_number}}.',
  '{{#minor}}השחקן קטין, וההסכם נחתם גם על ידי {{guardian_name}}, מספר זהות {{guardian_id_number}}.{{/minor}}',
  '# תקופה',
  'ההסכם בתוקף מ-{{start_date}} עד {{end_date}} ({{period_months}} חודשים). נערך ביום {{today}}.',
].join('\n\n');
const TEMPLATE_EN = '# Representation agreement\n\nBetween {{agency_name}} and {{player_name}} (ID {{player_id_number}}), from {{start_date}} to {{end_date}}.';

// Every value that must stay inside starts with SECRET or is one of the two ID numbers.
const ADULT = { fullName: 'Noam Levi', dob: '2000-03-15', stage: 'represented', notes: 'SECRET-notes', phone: '0509998877', passportNumber: 'SECRET-passport', email: 'SECRET@example.com', reprStart: '2024-01-01', reprEnd: '2025-12-31', reprFiles: [{ fileId: 'old', name: 'SECRET-old.pdf' }] };
const MINOR = { fullName: 'Yoav Cohen', dob: '2011-06-01', stage: 'represented', notes: 'SECRET-minor-notes', parentPhone: '0507776655' };
const NODOB = { fullName: 'Eli Ben', stage: 'represented' };

function seed(extra = {}) {
  return fakeDb({
    players: { p1: ADULT, p2: MINOR, p3: NODOB, gone: { fullName: 'Gone', deletedAt: '2026-01-01' } },
    app_users: { [OWNER.email]: OWNER, [MANAGER.email]: MANAGER },
    ...extra,
  });
}
async function withTemplates(db) {
  await ag.saveTemplate(db, { lang: 'he', text: TEMPLATE_HE, by: OWNER, now: NOW - DAY });
  await ag.saveTemplate(db, { lang: 'en', text: TEMPLATE_EN, by: OWNER, now: NOW - DAY });
  return db;
}
const by = { email: OWNER.email, name: OWNER.name, channel: 'web' };
const fakePdf = async (a) => ({ buffer: Buffer.from(`%PDF-1.4 agreement ${a.id}`), filename: `agreement-${a.id}.pdf`, mimeType: 'application/pdf' });

async function viewOf(db, token, ua = 'Mozilla/5.0 (iPhone)') {
  return signPublic._handle({ httpMethod: 'POST', headers: { 'user-agent': ua }, body: JSON.stringify({ t: token, action: 'view' }) }, { db, now: NOW, isPreview: async () => false, kick: async () => {} });
}
async function submit(db, token, body, { now = NOW, makePdf = fakePdf } = {}) {
  return signPublic._handle({ httpMethod: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' }, body: JSON.stringify({ t: token, action: 'sign', ...body }) },
    { db, now, isPreview: async () => false, kick: async () => {}, makePdf, FieldValue: admin.firestore.FieldValue });
}
const adultSign = (text) => ({ consent: true, textHash: sha256(text), signers: [{ role: 'player', name: 'Noam Levi', idNumber: SECRET_ID, signature: SIG }] });

test('a template is checked, versioned, and the earlier version stays', async () => {
  const db = seed();
  await assert.rejects(ag.saveTemplate(db, { lang: 'he', text: 'שלום {{nickname}}', by: OWNER }), /unknown placeholders: \{\{nickname\}\}/);
  const one = await ag.saveTemplate(db, { lang: 'he', text: TEMPLATE_HE, by: OWNER, now: NOW });
  const two = await ag.saveTemplate(db, { lang: 'he', text: `${TEMPLATE_HE}\n\nסעיף נוסף.`, maxMonths: 60, defaultMonths: 12, by: OWNER, now: NOW + 1 });
  assert.equal(one.version, 1); assert.equal(two.version, 2);
  assert.equal(two.maxMonths, 24, 'never more than two years');
  assert.equal(two.defaultMonths, 12);
  const v = await ag.templateView(db, 'he');
  assert.equal(v.versions.length, 2);
  assert.ok(db.read('agreement_templates/he/versions', '1').text === TEMPLATE_HE);
});

test('without a template: the app gets a plain sentence, Golda the path to prepare it, and no one a sentence to type', async () => {
  const db = seed();
  await assert.rejects(ag.createAgreement(db, { playerId: 'p1', lang: 'he', start: '2026-12-01', by, now: NOW }),
    (e) => e.code === 'no_template' && /Golda prepares it from the agency's existing agreements/.test(e.message) && /System › Agreements/.test(e.message) && !/[֐-׿"]/.test(e.message));
  const golda = agreementTools({ db, identity: OWNER, role: 'admin', session: { turn: 1 }, now: () => NOW });
  const r = await golda.agreement_create({ action: 'check', playerId: 'p1', start: '2026-12-01', lang: 'en' });
  assert.equal(r.refused, true); assert.equal(r.noTemplate, true); assert.equal(r.lang, 'en');
  assert.match(r.reason, /no English representation agreement template/);
  assert.match(r.reason, /Do not send the writer to a screen and do not ask him to type anything/);
  assert.match(r.reason, /agreement_template action=examples/);
  assert.match(r.reason, /send the agreement file \(a PDF, a photo or a document\) here in the chat/);
  assert.match(r.reason, /agreement_create action=check again/);
  assert.ok(!/[֐-׿]/.test(r.reason), 'no Hebrew sentence for the writer to copy');
  const shown = await golda.agreement_template({ action: 'show', lang: 'he' });
  assert.equal(shown.exists, false); assert.match(shown.note, /agreement_template action=examples/);
  for (const l of ['he', 'en']) assert.ok(ag.NO_TEMPLATE[l].app && ag.NO_TEMPLATE[l].golda);
});

test("Golda finds the agency's own agreements to build the template from: admins only, newest first, no content", async () => {
  const db = seed({ players: {
    p1: { ...ADULT, reprFiles: [{ fileId: 'old', name: 'Noam old.pdf', type: 'application/pdf', uploadedAt: '2023-01-10T09:00:00Z' }, { fileId: 'new', name: 'Noam 2025.pdf', type: 'application/pdf', uploadedAt: '2025-02-01T09:00:00Z' }] },
    p2: { ...MINOR, reprFiles: [{ url: 'data:image/jpeg;base64,SECRETBYTES', name: 'Yoav scan.jpg', type: 'image/jpeg', uploadedAt: '2024-09-01T09:00:00Z' }] },
    p3: { ...NODOB, reprFiles: [{ fileId: 'agr_x', name: 'made here.pdf', agreementId: 'x', uploadedAt: '2026-11-01T09:00:00Z' }] },
    p4: { fullName: 'Prospect', stage: 'tracking', reprFiles: [{ fileId: 'z', name: 'prospect.pdf', uploadedAt: '2026-10-01T09:00:00Z' }] },
    gone: { fullName: 'Gone', deletedAt: '2026-01-01', reprFiles: [{ fileId: 'g', name: 'gone.pdf' }] },
  } });
  const owner = agreementTools({ db, identity: OWNER, role: 'admin', session: { turn: 1 }, now: () => NOW });
  const manager = agreementTools({ db, identity: MANAGER, role: 'manager', session: { turn: 1 }, now: () => NOW });
  await assert.rejects(manager.agreement_template({ action: 'examples', lang: 'he' }), /only an admin/);
  const r = await owner.agreement_template({ action: 'examples', lang: 'he' });
  assert.equal(r.count, 2, 'represented players only, never a file this system made, never the recycle bin');
  assert.deepEqual(r.examples.map((e) => [e.playerId, e.player, e.file, e.date, e.minor]), [
    ['p1', 'Noam Levi', 'Noam 2025.pdf', '2025-02-01', false],
    ['p2', 'Yoav Cohen', 'Yoav scan.jpg', '2024-09-01', true],
  ]);
  assert.equal(r.examples[0].otherFiles, 1);
  assert.equal(r.examples[1].minorWhenUploaded, true);
  assert.match(r.instruction, /read_file/);
  assert.ok(!/SECRET|fileId|base64|"new"|"old"/.test(JSON.stringify(r)), 'no file content, no stored ids, nothing private');
  const none = await agreementTools({ db: seed(), identity: OWNER, role: 'admin', session: { turn: 1 }, now: () => NOW }).agreement_template({ action: 'examples', lang: 'he' });
  assert.equal(none.count, 1, 'the seed adult has one uploaded agreement');
  const empty = await agreementTools({ db: fakeDb({ players: { p2: MINOR } }), identity: OWNER, role: 'admin', session: { turn: 1 }, now: () => NOW }).agreement_template({ action: 'examples', lang: 'he' });
  assert.equal(empty.count, 0); assert.match(empty.instruction, /send the agreement file/);
});

test("read_file reads a Word .docx agreement as text (the agency's agreements are often Word files)", () => {
  const { fileBlocks } = require('../wa-agent.js')._internal;
  // A minimal .docx: a zip holding word/document.xml, deflated.
  const xml = Buffer.from('<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>הסכם ייצוג</w:t></w:r></w:p><w:p><w:r><w:t>בין Gold A&amp;S</w:t><w:tab/><w:t>לבין השחקן</w:t></w:r></w:p></w:body></w:document>');
  const body = zlib.deflateRawSync(xml);
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdAt = 30 + name.length + body.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(cdAt, 16);
  const docx = Buffer.concat([local, name, body, central, name, end]).toString('base64');
  const blocks = fileBlocks(`data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docx}`, 'Document:');
  assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, 'Document:\nהסכם ייצוג\nבין Gold A&S\tלבין השחקן');
  // stored without a type: the name tells
  assert.equal(fileBlocks(`data:application/octet-stream;base64,${docx}`, 'Document:', 'agreement.docx')[0].text, blocks[0].text);
  // a PDF and a photo still reach the model as a document and an image, never as text
  assert.equal(fileBlocks('data:application/pdf;base64,JVBERi0=', 'x')[1].type, 'document');
  assert.equal(fileBlocks('data:image/jpeg;base64,/9j/', 'x')[1].type, 'image');
  assert.equal(fileBlocks('data:application/msword;base64,AAAA', 'x'), null, 'an old .doc cannot be read');
  assert.equal(fileBlocks('data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA', 'x'), null, 'a broken .docx is not read');
});

test('making an adult agreement: the period, the frozen text and its hash, a working link', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', lang: 'he', start: '2026-12-01', by, now: NOW, base: 'https://crm.test' });
  assert.match(made.url, /^https:\/\/crm\.test\/sign\/[A-Za-z0-9_-]{32}$/);
  assert.equal(made.days, 14); assert.equal(made.defaulted, true);
  const a = db.read('agreements', made.id);
  assert.equal(a.start, '2026-12-01'); assert.equal(a.end, '2028-11-30'); assert.equal(a.months, 24);
  assert.equal(a.textHash, sha256(a.text));
  assert.ok(a.text.includes('Noam Levi') && a.text.includes('01/12/2026'));
  assert.ok(!a.text.includes('{{'), 'nothing left unfilled');
  assert.ok(!a.text.includes('קטין'), 'the minor section is left out for an adult');
  assert.equal(db.read('agreement_links', idOf(made.token)).agreementId, made.id);
  assert.ok(!JSON.stringify(a).includes(made.token), 'the token itself is never stored');
  assert.equal(made.view.state, 'waiting');
});

test('the period: capped by the template, the end after the start, the link at most 30 days', async () => {
  const db = await withTemplates(seed());
  await assert.rejects(ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', months: 36, by, now: NOW }), (e) => e.code === 'period_tooLong' && /24 months at most/.test(e.message));
  await assert.rejects(ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', end: '2026-11-01', by, now: NOW }), (e) => e.code === 'period_order');
  await assert.rejects(ag.createAgreement(db, { playerId: 'p1', by, now: NOW }), (e) => e.code === 'period_start');
  const r = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', months: 6, days: 90, by, now: NOW });
  assert.equal(r.days, 30); assert.equal(r.clamped, true);
  assert.equal(db.read('agreements', r.id).end, '2027-05-31');
});

test('a minor needs the parent or guardian, and the minor section is in the text', async () => {
  const db = await withTemplates(seed());
  await assert.rejects(ag.createAgreement(db, { playerId: 'p2', start: '2026-12-01', by, now: NOW }), (e) => e.code === 'guardian');
  await assert.rejects(ag.createAgreement(db, { playerId: 'p3', start: '2026-12-01', by, now: NOW }), (e) => e.code === 'dob', 'no date of birth: say whether he is a minor');
  const made = await ag.createAgreement(db, { playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen', by, now: NOW });
  const a = db.read('agreements', made.id);
  assert.equal(a.minor, true); assert.equal(a.playerSigns, true);
  assert.ok(a.text.includes('Rina Cohen') && a.text.includes('קטין'));
  assert.deepEqual(ag.publicAgreement(a).needs, ['guardian', 'player']);
});

test("a minor always signs with the parent: asking for the guardian alone changes nothing, from the app or from Golda", async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen', playerSigns: false, by, now: NOW });
  assert.equal(db.read('agreements', made.id).playerSigns, true);
  assert.deepEqual(ag.publicAgreement(db.read('agreements', made.id)).needs, ['guardian', 'player']);
  const res = await signedIn._handle({ httpMethod: 'POST', body: JSON.stringify({ action: 'create', playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen', playerSigns: false }) }, { auth: { user: { ...OWNER, role: 'admin' } } }, { db, now: NOW });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).agreement.playerSigns, true);
  // Golda's tool no longer takes the choice at all.
  const def = require('../golda-agreement.js').AGREEMENT_TOOL_DEFS.find((d) => d.name === 'agreement_create');
  assert.equal(def.input_schema.properties.playerSigns, undefined);
  assert.ok(!/signs too beside/.test(JSON.stringify(def)));
  const golda = agreementTools({ db, identity: OWNER, role: 'admin', session: { turn: 1 }, now: () => NOW });
  const checked = await golda.agreement_create({ action: 'check', playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen' });
  assert.match(checked.signedBy, /^Rina Cohen \(parent or guardian\) and Yoav Cohen/);
  // An adult: the player alone, as before.
  const adult = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  assert.deepEqual(ag.publicAgreement(db.read('agreements', adult.id)).needs, ['player']);
});

test('an agreement stored earlier with the guardian alone still opens, signs and shows as stored', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen', by, now: NOW });
  await db.collection('agreements').doc(made.id).update({ playerSigns: false });
  const a = { id: made.id, ...db.read('agreements', made.id) };
  assert.deepEqual(ag.publicAgreement(a).needs, ['guardian']);
  assert.equal(ag.viewOf(a, { now: NOW }).playerSigns, false);
  const view = JSON.parse((await viewOf(db, made.token)).body);
  assert.deepEqual(view.agreement.needs, ['guardian']);
  const r = await submit(db, made.token, { consent: true, textHash: sha256(a.text), signers: [{ role: 'guardian', name: 'Rina Cohen', idNumber: SECRET_GUARDIAN_ID, relation: 'mother', signature: SIG }] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(db.read('agreements', made.id).signers.map((s) => s.role), ['guardian']);
});

test('every link that does not work gets the same short answer', async () => {
  const db = await withTemplates(seed());
  const live = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const expired = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', days: 1, by, now: NOW - 2 * DAY });
  const revoked = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  await ag.revokeLink(db, revoked.id, { now: NOW });
  const reissued = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  await ag.reissueLink(db, reissued.id, { now: NOW });
  const signed = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  assert.equal((await submit(db, signed.token, adultSign(db.read('agreements', signed.id).text))).statusCode, 200);

  const answers = [];
  for (const t of ['nope', 'A'.repeat(32), expired.token, revoked.token, reissued.token, signed.token, `${live.token}x`]) {
    const r = await viewOf(db, t);
    answers.push([r.statusCode, r.body]);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.headers['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
  }
  assert.ok(answers.every(([s, b]) => s === 404 && b === answers[0][1]), 'one answer for all of them');
  assert.equal((await viewOf(db, live.token)).statusCode, 200);
});

test('the public view holds only the text and the names printed in it', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen', by, now: NOW });
  const r = await viewOf(db, made.token);
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body.agreement).sort(), ['agencyName', 'expiresAt', 'lang', 'names', 'needs', 'text', 'textHash']);
  assert.deepEqual(body.agreement.names, { player: 'Yoav Cohen', guardian: 'Rina Cohen' });
  assert.ok(!/SECRET|0507776655|tokenSealed|createdBy|lou\.korek/.test(r.body));
  // An opening counts time and phone/desktop only; a reload within a minute is the same opening.
  await viewOf(db, made.token);
  const a = db.read('agreements', made.id);
  assert.equal(a.opens, 1); assert.equal(a.lastOpenDevice, 'phone');
  assert.deepEqual(Object.keys(a.openLog[0]).sort(), ['at', 'device']);
});

test('a signed-in CRM user opening the link is a preview: not counted, and it cannot sign', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const deps = { db, now: NOW, isPreview: async () => true, kick: async () => {} };
  const v = await signPublic._handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ t: made.token, action: 'view' }) }, deps);
  assert.equal(JSON.parse(v.body).preview, true);
  assert.equal(db.read('agreements', made.id).opens, 0);
  const s = await signPublic._handle({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ t: made.token, action: 'sign', ...adultSign(db.read('agreements', made.id).text) }) }, deps);
  assert.equal(s.statusCode, 403);
  assert.equal(db.read('agreements', made.id).signedAt, null);
});

test('signing: once, with the hash of the text shown; a second submit is refused', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const shown = JSON.parse((await viewOf(db, made.token)).body).agreement;
  const r = await submit(db, made.token, { consent: true, textHash: shown.textHash, signers: [{ role: 'player', name: 'Noam Levi', idNumber: '312-345 678', signature: SIG }] });
  assert.equal(r.statusCode, 200);
  const out = JSON.parse(r.body);
  assert.equal(out.signed, true); assert.equal(out.filed, true);
  assert.ok(!r.body.includes(SECRET_ID), 'the answer never repeats the ID number');
  const a = db.read('agreements', made.id);
  assert.equal(a.shownHash, sha256(shown.text));
  assert.equal(a.shownHash, a.textHash);
  assert.equal(a.signers[0].idNumber, SECRET_ID, 'stored, spaces and dashes taken out');
  assert.equal(a.signedDevice, 'phone');
  assert.equal(a.signedLinkId, idOf(made.token));
  assert.equal(ag.stateOf(a, NOW), 'signed');
  // The second submit, even a perfect one, finds a dead link.
  const again = await submit(db, made.token, adultSign(a.text), { now: NOW + 1000 });
  assert.equal(again.statusCode, 404);
  assert.equal(db.read('agreements', made.id).signedAt, NOW);
});

test('a text that changed since it was shown is refused (the hash must match)', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const r = await submit(db, made.token, adultSign('another text'));
  assert.equal(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body).problems, ['text']);
});

test('bad submissions: consent, name, ID, a bad or oversized PNG; each counts, ten lock the link', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const text = db.read('agreements', made.id).text;
  const ok = adultSign(text);
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from(SIG.split(',')[1], 'base64'), Buffer.alloc(ag.PNG_MAX_BYTES)]).toString('base64')}`;
  const notPng = `data:image/png;base64,${Buffer.from('GIF89a this is not a png at all, but long enough to pass the size check of a hundred bytes....').toString('base64')}`;
  const cases = [
    [{ ...ok, consent: false }, 'consent'],
    [{ ...ok, signers: [{ ...ok.signers[0], name: 'N' }] }, 'name'],
    [{ ...ok, signers: [{ ...ok.signers[0], idNumber: '12' }] }, 'id'],
    [{ ...ok, signers: [{ ...ok.signers[0], signature: notPng }] }, 'signature'],
    [{ ...ok, signers: [{ ...ok.signers[0], signature: big }] }, 'signature'],
    [{ ...ok, signers: [{ ...ok.signers[0], signature: png(20, 10) }] }, 'signature'],
    [{ ...ok, signers: [] }, 'signers'],
  ];
  for (const [body, code] of cases) {
    const r = await submit(db, made.token, body);
    assert.equal(r.statusCode, 400, code);
    assert.ok(JSON.parse(r.body).problems.includes(code), code);
    assert.ok(!r.body.includes(SECRET_ID));
  }
  assert.equal(db.read('agreements', made.id).link.failed, cases.length);
  // A body far too big never reaches the checks.
  const huge = await submit(db, made.token, { ...ok, padding: 'x'.repeat(ag.BODY_MAX) });
  assert.equal(huge.statusCode, 404);
  for (let i = cases.length; i < ag.MAX_FAILED; i++) await submit(db, made.token, { ...ok, consent: false });
  assert.equal(ag.stateOf(db.read('agreements', made.id), NOW), 'locked');
  assert.equal((await submit(db, made.token, ok)).statusCode, 404, 'a locked link is dead, even for a good submission');
  // A new link for the same agreement starts again.
  const re = await ag.reissueLink(db, made.id, { now: NOW });
  assert.equal((await submit(db, re.token, ok)).statusCode, 200);
});

test('a minor: the guardian (with the relation) and the player sign on the same page', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p2', start: '2026-12-01', guardianName: 'Rina Cohen', by, now: NOW });
  const text = db.read('agreements', made.id).text;
  const guardian = { role: 'guardian', name: 'Rina Cohen', idNumber: SECRET_GUARDIAN_ID, relation: 'mother', signature: SIG };
  const player = { role: 'player', name: 'Yoav Cohen', idNumber: SECRET_ID, signature: SIG };
  const onlyPlayer = await submit(db, made.token, { consent: true, textHash: sha256(text), signers: [player] });
  assert.ok(JSON.parse(onlyPlayer.body).problems.includes('signers'));
  const noRelation = await submit(db, made.token, { consent: true, textHash: sha256(text), signers: [{ ...guardian, relation: 'uncle' }, player] });
  assert.ok(JSON.parse(noRelation.body).problems.includes('relation'));
  const r = await submit(db, made.token, { consent: true, textHash: sha256(text), signers: [guardian, player] });
  assert.equal(r.statusCode, 200);
  const a = db.read('agreements', made.id);
  assert.deepEqual(a.signers.map((s) => s.role), ['guardian', 'player']);
  assert.equal(a.signers[0].relation, 'mother');
});

test('filed like an uploaded agreement: the PDF in reprFiles, the dates through an undoable audit line', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', months: 12, by, now: NOW });
  await submit(db, made.token, adultSign(db.read('agreements', made.id).text));
  const p = db.read('players', 'p1');
  assert.equal(p.reprStart, '2026-12-01'); assert.equal(p.reprEnd, '2027-11-30');
  const f = p.reprFiles.find((x) => x.agreementId === made.id);
  assert.equal(f.fileId, `agr_${made.id}`); assert.equal(f.type, 'application/pdf'); assert.equal(f.expiresAt, '2027-11-30');
  assert.equal(p.reprFiles.length, 2, 'the earlier file stays');
  const meta = db.read('files', f.fileId);
  assert.equal(meta.parts, 1);
  const line = db.all('audit').find((x) => x.docId === 'p1');
  assert.equal(line.via, 'golda'); assert.equal(line.undone, false);
  assert.deepEqual(line.before.reprEnd, '2025-12-31');
  assert.deepEqual(line.after.reprEnd, '2027-11-30');
  assert.ok(!JSON.stringify(db.all('audit')).includes(SECRET_ID), 'no ID number in any audit line');
  // The signer may download the copy for thirty minutes, and then not.
  const copy = db.all('agreement_links').find((x) => x.kind === 'copy');
  assert.ok(copy);
  const tokenOfCopy = JSON.parse((await (async () => {
    const m = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
    return submit(db, m.token, adultSign(db.read('agreements', m.id).text));
  })()).body).copy;
  const get = (now) => signPublic._handle({ httpMethod: 'GET', headers: {}, queryStringParameters: { c: tokenOfCopy } }, { db, now });
  const pdf = await get(NOW + 60000);
  assert.equal(pdf.statusCode, 200); assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.from(pdf.body, 'base64').toString().startsWith('%PDF'));
  assert.equal((await get(NOW + 31 * 60000)).statusCode, 404);
});

test('when filing fails the signature is kept, and the retry finishes it and tells the owner', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const broken = async () => { throw new Error(`disk full ${SECRET_ID}`); };
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  let r;
  try { r = await submit(db, made.token, adultSign(db.read('agreements', made.id).text), { makePdf: broken }); } finally { console.error = orig; }
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).filed, false);
  assert.ok(!errors.join('\n').includes(SECRET_ID), 'nothing private in the log');
  let a = db.read('agreements', made.id);
  assert.ok(a.signedAt); assert.equal(ag.stateOf(a, NOW), 'filing_failed');
  assert.equal(db.read('players', 'p1').reprEnd, '2025-12-31', 'not changed until the PDF is filed');

  const { out, send } = recorder();
  await ag.runPending(db, { now: NOW + 60000, makePdf: broken, send, FieldValue: admin.firestore.FieldValue });
  assert.equal(out.length, 1, 'the owner hears it was signed, once');
  assert.match(out[0].body, /✍️ \*Noam Levi\* חתם על הסכם הייצוג/);
  assert.match(out[0].body, /עוד לא נשמר/);
  assert.equal(out[0].to, OWNER.email);

  await ag.runPending(db, { now: NOW + 11 * 60000, makePdf: fakePdf, send, FieldValue: admin.firestore.FieldValue });
  a = db.read('agreements', made.id);
  assert.equal(ag.stateOf(a, NOW), 'signed');
  assert.equal(db.read('players', 'p1').reprEnd, '2028-11-30');
  await ag.runPending(db, { now: NOW + 21 * 60000, makePdf: fakePdf, send, FieldValue: admin.firestore.FieldValue });
  assert.equal(out.length, 2, 'then once more, when it reached the file');
  assert.match(out[1].body, /📄/);
  await ag.runPending(db, { now: NOW + 31 * 60000, makePdf: fakePdf, send, FieldValue: admin.firestore.FieldValue });
  assert.equal(out.length, 2, 'and never again');
  assert.ok(!out.map((o) => o.body).join('\n').includes(SECRET_ID));
  assert.equal(await ag.hasPending(db, NOW + 40 * 60000), false);
});

test('revoke stops the link at once; re-issue kills the old link and the new one works', async () => {
  const db = await withTemplates(seed());
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  await ag.revokeLink(db, made.id, { now: NOW });
  assert.equal((await viewOf(db, made.token)).statusCode, 404);
  assert.equal(ag.stateOf(db.read('agreements', made.id), NOW), 'revoked');
  const re = await ag.reissueLink(db, made.id, { days: 45, now: NOW });
  assert.equal(re.days, 30);
  assert.equal((await viewOf(db, made.token)).statusCode, 404);
  assert.equal((await viewOf(db, re.token)).statusCode, 200);
  assert.equal(db.read('agreements', made.id).linksIssued, 2);
  await submit(db, re.token, adultSign(db.read('agreements', made.id).text));
  await assert.rejects(ag.reissueLink(db, made.id, { now: NOW }), (e) => e.code === 'signed');
  await assert.rejects(ag.revokeLink(db, made.id, { now: NOW }), (e) => e.code === 'signed');
});

test('the CRM endpoint: everyone sees the states, only an admin makes one or sees the link; no ID leaves', async () => {
  const db = await withTemplates(seed());
  const asUser = (user, ev) => signedIn._handle({ headers: { host: 'crm.test' }, ...ev }, { auth: { user } }, { db, now: NOW, makePdf: fakePdf });
  const viewer = { email: 'v@x.com', name: 'V', role: 'viewer' };
  const create = await asUser(OWNER, { httpMethod: 'POST', body: JSON.stringify({ action: 'create', playerId: 'p1', start: '2026-12-01' }) });
  assert.equal(create.statusCode, 200);
  const { agreement } = JSON.parse(create.body);
  assert.match(agreement.url, /\/sign\//);
  assert.equal((await asUser(MANAGER, { httpMethod: 'POST', body: JSON.stringify({ action: 'create', playerId: 'p1', start: '2026-12-01' }) })).statusCode, 403);
  assert.equal((await asUser(viewer, { httpMethod: 'POST', body: JSON.stringify({ action: 'revoke', id: agreement.id }) })).statusCode, 403);
  const list = async (u) => JSON.parse((await asUser(u, { httpMethod: 'GET', queryStringParameters: { playerId: 'p1' } })).body);
  assert.equal((await list(viewer)).agreements[0].state, 'waiting');
  assert.equal((await list(viewer)).agreements[0].url, null);
  assert.equal((await list(viewer)).canCreate, false);
  assert.match((await list(OWNER)).agreements[0].url, /\/sign\//);
  const token = (await list(OWNER)).agreements[0].url.split('/sign/')[1];
  await submit(db, token, adultSign(db.read('agreements', agreement.id).text));
  const after = await asUser(OWNER, { httpMethod: 'GET', queryStringParameters: { playerId: 'p1' } });
  assert.equal(JSON.parse(after.body).agreements[0].state, 'signed');
  assert.ok(!after.body.includes(SECRET_ID) && !after.body.includes('base64'), 'neither the ID number nor the drawn signature');
  const noTemplate = await signedIn._handle({ headers: {}, httpMethod: 'POST', body: JSON.stringify({ action: 'create', playerId: 'p1', start: '2026-12-01', lang: 'en' }) }, { auth: { user: OWNER } }, { db: seed(), now: NOW });
  assert.equal(noTemplate.statusCode, 400);
  assert.equal(JSON.parse(noTemplate.body).error, 'no_template');
  assert.match(JSON.parse(noTemplate.body).message, /no English representation agreement template yet\. Golda prepares it/);
});

test('the agency signature is drawn once and goes on the agreements its admin makes', async () => {
  const db = await withTemplates(seed());
  await assert.rejects(ag.saveSignature(db, { email: OWNER.email, name: OWNER.name, png: 'data:image/png;base64,AAAA' }), (e) => e.code === 'signature');
  await ag.saveSignature(db, { email: OWNER.email, name: OWNER.name, png: SIG, now: NOW });
  const made = await ag.createAgreement(db, { playerId: 'p1', start: '2026-12-01', by, now: NOW });
  const a = db.read('agreements', made.id);
  assert.equal(a.agencySignature.png, SIG); assert.equal(a.agencySignature.at, NOW);
  assert.equal(made.view.agencySigned, true);
});

test('the signed PDF is a real PDF, in Hebrew and in English', { timeout: 60000 }, async () => {
  const root = path.resolve(__dirname, '../../../..');
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    stdin: { contents: "module.exports = { m: require('./apps/web/src/lib/agreementPdf.js'), fonts: require('./apps/web/src/lib/pdfFonts.js'), jspdf: require('jspdf') };", resolveDir: root, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error', nodePaths: [path.join(root, 'node_modules')],
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); // eslint-disable-line no-new-func
  const load = () => ({ buildAgreementPdf: m.exports.m.buildAgreementPdf, fonts: m.exports.fonts, jsPDF: m.exports.jspdf.jsPDF });
  const db = await withTemplates(seed());
  await ag.saveSignature(db, { email: OWNER.email, name: OWNER.name, png: SIG, now: NOW });
  for (const [playerId, lang, extra] of [['p1', 'he', {}], ['p2', 'en', { guardianName: 'Rina Cohen' }]]) {
    const made = await ag.createAgreement(db, { playerId, lang, start: '2026-12-01', by, now: NOW, ...extra });
    const a = db.read('agreements', made.id);
    const signers = a.minor
      ? [{ role: 'guardian', name: 'Rina Cohen', idNumber: SECRET_GUARDIAN_ID, relation: 'mother', signature: SIG }, { role: 'player', name: 'Yoav Cohen', idNumber: SECRET_ID, signature: SIG }]
      : [{ role: 'player', name: 'Noam Levi', idNumber: SECRET_ID, signature: SIG }];
    const r = await submit(db, made.token, { consent: true, textHash: a.textHash, signers }, { makePdf: (x) => ag.agreementPdf(x, { load, logo: null }) });
    assert.equal(JSON.parse(r.body).filed, true, lang);
    const file = await ag.loadFile(db, `agr_${made.id}`);
    assert.ok(file.buffer.subarray(0, 5).toString() === '%PDF-', lang);
    assert.ok(file.buffer.length > 5000, lang);
    if (process.env.AGREEMENT_PDF_OUT) require('fs').writeFileSync(path.join(process.env.AGREEMENT_PDF_OUT, `agreement-${lang}.pdf`), file.buffer);
  }
});

test("Golda: who may do what, and the yes must come in a later message", async () => {
  const db = await withTemplates(seed());
  const owner = (turn) => agreementTools({ db, identity: OWNER, role: 'admin', session: { turn }, now: () => NOW });
  const manager = agreementTools({ db, identity: MANAGER, role: 'manager', session: { turn: 1 }, now: () => NOW });
  // The model only gets the tools its role may use.
  const names = (role) => toolsFor(role).map((t) => t.name).filter((n) => n.startsWith('agreement_'));
  assert.deepEqual(names('admin').sort(), ['agreement_create', 'agreement_link', 'agreement_list', 'agreement_template']);
  assert.deepEqual(names('manager'), ['agreement_list']);
  assert.deepEqual(names('viewer'), ['agreement_list']);
  await assert.rejects(manager.agreement_create({ action: 'check', playerId: 'p1', start: '2026-12-01' }), /only an admin/);
  await assert.rejects(manager.agreement_template({ action: 'show', lang: 'he' }), /only an admin/);
  await assert.rejects(manager.agreement_link({ action: 'revoke', agreementId: 'x' }), /only an admin/);

  const checked = await owner(5).agreement_create({ action: 'check', playerId: 'p2', start: '2026-12-01', months: 12 });
  assert.equal(checked.refused, true); assert.match(checked.reason, /parent or guardian/);
  const ok = await owner(5).agreement_create({ action: 'check', playerId: 'p2', start: '2026-12-01', months: 12, guardianName: 'Rina Cohen' });
  assert.equal(ok.ready, true); assert.equal(ok.summary.end, '30/11/2027');
  assert.equal(db.all('agreements').length, 0, 'nothing made on check');
  await assert.rejects(owner(5).agreement_create({ action: 'confirm' }), /later message/);
  const made = await owner(6).agreement_create({ action: 'confirm' });
  assert.equal(made.made, true); assert.match(made.link, /\/sign\//);
  assert.match(made.instruction, /never send it to the player/);
  assert.equal((await owner(7).agreement_create({ action: 'confirm' })).refused, true, 'one yes makes one agreement');

  const listed = await manager.agreement_list({ playerId: 'p2' });
  assert.equal(listed.agreements[0].state, 'waiting'); assert.equal(listed.agreements[0].link, undefined, 'no link for a manager');
  assert.match((await owner(8).agreement_list({ playerId: 'p2' })).agreements[0].link, /\/sign\//);

  const re = await owner(8).agreement_link({ action: 'reissue', agreementId: made.agreementId, days: 7 });
  assert.equal(re.worksDays, 7);
  assert.equal((await owner(8).agreement_link({ action: 'revoke', agreementId: made.agreementId })).stopped, true);

  // The template: a proposal is kept, saved only after a yes in a later message, and never with a real ID number in it.
  const leaked = await owner(9).agreement_template({ action: 'propose', lang: 'en', text: `# Agreement\n\nBetween us and {{player_name}}, ID ${SECRET_ID}.` });
  assert.equal(leaked.refused, true);
  const bad = await owner(9).agreement_template({ action: 'propose', lang: 'en', text: 'Hello {{nickname}}' });
  assert.equal(bad.refused, true);
  const proposed = await owner(9).agreement_template({ action: 'propose', lang: 'en', text: '# Agreement\n\nBetween {{agency_name}} and {{player_name}}, {{start_date}} to {{end_date}}.' });
  assert.equal(proposed.proposed, true);
  await assert.rejects(owner(9).agreement_template({ action: 'save', lang: 'en' }), /later message/);
  const otherAdmin = agreementTools({ db, identity: { ...OWNER, email: 'other@x.com' }, role: 'admin', session: { turn: 20 }, now: () => NOW });
  assert.equal((await otherAdmin.agreement_template({ action: 'save', lang: 'en' })).refused, true, "another admin's yes does not save it");
  const saved = await owner(10).agreement_template({ action: 'save', lang: 'en' });
  assert.equal(saved.saved, true); assert.equal(saved.version, 2);
  assert.equal((await ag.getTemplate(db, 'en')).text.includes('{{start_date}}'), true);

  // Nothing private reaches the model through any of it.
  const everything = JSON.stringify([listed, await owner(11).agreement_list({ playerId: 'p2' })]);
  assert.ok(!/SECRET|base64/.test(everything));
});

test('the prompt tells Golda about agreements and never to call them legally binding', () => {
  const p = systemPrompt('גולדה', { name: 'לו', role: 'admin', email: OWNER.email });
  assert.match(p, /agreement_create action=check/);
  assert.match(p, /Never say an agreement is legally binding/);
  // No template: she prepares it herself from the agency's own agreements; the writer only approves.
  assert.match(p, /never send the writer to a screen and never ask him to type anything/);
  assert.match(p, /agreement_template action=examples, read one or two of them with read_file \(one of a minor and one of an adult/);
  assert.match(p, /never a clause or a word of your own/);
  assert.match(p, /\[\[כפתורים: לשמור, לשנות\]\]; after the yes in a later message action=save, then go on with the agreement/);
  assert.match(p, /send the agreement file \(a PDF, a photo or a document\) here in the chat/);
  assert.match(p, /a minor's agreement is always signed by the parent or guardian and by the player himself/);
  assert.ok(!/"תבני את תבנית ההסכם/.test(p), 'no set sentence for anyone to type');
  const def = require('../golda-agreement.js').AGREEMENT_TOOL_DEFS.find((d) => d.name === 'agreement_template');
  assert.deepEqual(def.input_schema.properties.action.enum, ['show', 'examples', 'propose', 'save']);
  assert.match(def.description, /never invent, add or reword a clause/);
});
