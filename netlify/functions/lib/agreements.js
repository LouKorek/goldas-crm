// Representation agreements signed inside the system.
//
// An admin makes an agreement for a player from the agency's own template
// (one per language, versioned), in the CRM or through Golda. The player, or
// for a minor his parent or guardian together with him, opens a private link on the phone (/sign/<token>,
// apps/web/src/pages/SignPage.jsx), reads the text, types the name and the
// ID number, draws the signature with a finger and signs. The server then
// builds the signed PDF, files it in the player's representation documents
// exactly as an uploaded one is filed, sets the representation's start and
// end on the player through an audited, undoable change (so the existing
// "representation ends" alert takes it from there) and tells the owner.
// A minor's agreement is signed by the parent or guardian and by the player,
// both on the same page; an adult signs alone. Agreements stored earlier with
// playerSigns: false (the guardian alone) still open, sign and print as stored.
//
// Collections (functions only; the browser never reads them):
//
//   agreement_templates/{he|en}
//     lang, text, version, defaultMonths, maxMonths, agencyName,
//     updatedAt, updatedBy { email, name }, draft { text, defaultMonths, maxMonths, agencyName, by, turn, at } (Golda's proposal)
//   agreement_templates/{he|en}/versions/{n}
//     the same fields as saved, one document per save, never changed
//   agreement_signatures/{admin email}
//     png (data:image/png), name, savedAt          the agency's drawn signature
//   agreement_drafts/{admin email}
//     input, summary, turn, at                      Golda's armed "create", waiting for the yes
//   agreements/{id}
//     playerId, playerName, lang, templateVersion, agencyName,
//     text                 the filled text, frozen; what is shown, hashed and printed
//     textHash             SHA-256 of text
//     start, end, months, minor, guardianName, playerSigns
//     createdAt, createdBy { email, name, channel }, agencySignature { png, name, at } | null
//     link { id, tokenSealed, createdAt, expiresAt, days, revokedAt, failed, lockedAt }   the live signing link
//     linksIssued, opens, lastOpenAt, lastOpenDevice, openLog [{ at, device }] (last 50)
//     signedAt, signedDevice ('phone'|'desktop'), signedLinkId, shownHash,
//     signers [{ role 'guardian'|'player', name, idNumber, relation, png }]   ← the ID numbers live here only
//     copy { id, until }   the signer's own download of the signed PDF
//     filingState pending|working|failed|done, filingTries, filingError, filingStartedAt, filedAt, fileId, fileName
//     noticeState, lateNoticeState   pending|sending|sent|failed|skipped
//   agreement_links/{sha256(token)}
//     kind 'sign'|'copy', agreementId, createdAt       a pointer only: the agreement decides whether it works
//
// The token is 192 random bits (lib/public-link.js); only its hash is a
// document id and the agreement keeps a sealed copy so an admin can copy the
// link again. Every link that does not work gets the same answer.
//
// What leaves the public endpoint is built in publicAgreement() and nothing
// else: the agreement's text and the names printed in it. The ID numbers the
// signers type are stored on the agreement and printed in the PDF; they are
// never logged, never put in an audit line, Golda's memory or an error report.
// Times are epoch milliseconds.
const { israelDate, playerName: nameOf, checkTemplate, fillTemplate, agreementValues, agreementPeriod, isMinorOn, dayText,
  AGREEMENT_DEFAULT_MONTHS, AGREEMENT_MAX_MONTHS } = require('@goldas/domain');
const { newToken, validToken, idOf, validId, sha256, whenHe } = require('./public-link.js');
const { seal, unseal } = require('./seal.js');
const { siteUrl } = require('./site.js');

const COL = 'agreements';
const LINKS = 'agreement_links';
const TEMPLATES = 'agreement_templates';
const SIGNATURES = 'agreement_signatures';
const DRAFTS = 'agreement_drafts';

const DAY = 86400000;
const MIN = 60000;
const DEFAULT_LINK_DAYS = 14;
const MAX_LINK_DAYS = 30;
const COPY_MINUTES = 30;             // the signer may download the signed copy this long after signing
const MAX_FAILED = 10;               // failed submissions on one link before it stops working
const KEEP_OPENINGS = 50;
const REPEAT_MS = MIN;               // a reload within a minute is the same opening
const PNG_MAX_BYTES = 200 * 1024;    // one drawn signature
const PNG_MIN_BYTES = 100;
const BODY_MAX = 700000;             // a signing request with two signatures fits well within this
const RETRY_AFTER_MS = 2 * MIN;      // the signing request itself tries first; the retry waits this long
const STALE_WORK_MS = 5 * MIN;
const MAX_TRIES = 12;                // ten-minute checks: about two hours of retries
const FILE_CHUNK = 600 * 1024;       // as lib/db.js uploadFile and Golda's attach_file
const RELATIONS = ['father', 'mother', 'guardian'];
const LANGS = ['he', 'en'];

class AgreementError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** Text as it may be shown: one line, trimmed, capped. */
const clean = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const signUrl = (token, base = siteUrl()) => `${base}/sign/${token}`;
const langOf = (l) => (l === 'en' ? 'en' : 'he');

/** How many days a link lives: 14 when nothing was asked, never more than 30. */
function linkDays(asked) {
  const n = Math.floor(Number(asked));
  if (!Number.isFinite(n) || n < 1) return { days: DEFAULT_LINK_DAYS, clamped: false, defaulted: true };
  return n > MAX_LINK_DAYS ? { days: MAX_LINK_DAYS, clamped: true, defaulted: false } : { days: n, clamped: false, defaulted: false };
}

/** The signing link's state: active, expired, revoked, locked (too many failed tries) or used (signed). */
function linkState(a, now = Date.now()) {
  if (!a || !a.link) return 'missing';
  if (a.signedAt) return 'used';
  if (a.link.revokedAt) return 'revoked';
  if (a.link.lockedAt) return 'locked';
  return Number(a.link.expiresAt) > now ? 'active' : 'expired';
}

/**
 * The agreement's state, as the CRM and Golda name it:
 *   waiting         made, the link works, not signed yet
 *   expired         not signed and the link expired (a new link can be issued)
 *   revoked         not signed and the link was stopped (a new link can be issued)
 *   locked          not signed and the link stopped after too many failed tries (a new link can be issued)
 *   signed_filing   signed; the PDF is being made and filed
 *   filing_failed   signed; making or filing the PDF failed, a retry will finish it (the signature is kept)
 *   signed          signed, and the PDF is in the player's file
 */
function stateOf(a, now = Date.now()) {
  if (!a) return 'missing';
  if (a.signedAt) return a.filingState === 'done' ? 'signed' : a.filingState === 'failed' ? 'filing_failed' : 'signed_filing';
  const l = linkState(a, now);
  return l === 'active' ? 'waiting' : l;
}

// ── Templates ─────────────────────────────────────────────────────────

/** The template a language uses now, or null when there is none. */
async function getTemplate(db, lang) {
  const snap = await db.collection(TEMPLATES).doc(langOf(lang)).get();
  const t = snap.exists ? snap.data() : null;
  return t && String(t.text || '').trim() ? { lang: langOf(lang), ...t } : null;
}

/** Period settings of a template, made sane: two years by default and at most. */
function periodSettings({ defaultMonths, maxMonths } = {}) {
  const max = Math.min(AGREEMENT_MAX_MONTHS, Math.max(1, Math.floor(Number(maxMonths) || AGREEMENT_MAX_MONTHS)));
  const def = Math.min(max, Math.max(1, Math.floor(Number(defaultMonths) || AGREEMENT_DEFAULT_MONTHS)));
  return { defaultMonths: def, maxMonths: max };
}

/** The sentence a refused template gets: which placeholders are wrong. */
function templateProblem(check) {
  if (check.empty) return 'the template is empty';
  if (check.tooLong) return 'the template is too long';
  const parts = [];
  if (check.unknown.length) parts.push(`unknown placeholders: ${check.unknown.map((k) => `{{${k}}}`).join(', ')}`);
  if (check.sections.length) parts.push(`sections not closed properly: ${check.sections.map((k) => `{{#${k}}}`).join(', ')}`);
  return parts.join('; ');
}

/**
 * Saves a new version of a language's template; the previous versions stay
 * (agreement_templates/{lang}/versions/{n}) and every agreement keeps the
 * exact text it was made with. Returns { version, ...settings }.
 */
async function saveTemplate(db, { lang, text, defaultMonths, maxMonths, agencyName, by = {}, now = Date.now() }) {
  if (!LANGS.includes(lang)) throw new AgreementError('lang', 'lang is he or en');
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const check = checkTemplate(body);
  if (!check.ok) throw new AgreementError('template', templateProblem(check));
  const settings = periodSettings({ defaultMonths, maxMonths });
  const ref = db.collection(TEMPLATES).doc(lang);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const was = snap.exists ? snap.data() : {};
    const version = (Number(was.version) || 0) + 1;
    const doc = { lang, text: body, version, ...settings, agencyName: clean(agencyName, 60) || clean(was.agencyName, 60) || 'Gold A&S',
      updatedAt: now, updatedBy: { email: String(by.email || ''), name: String(by.name || '') } };
    tx.set(ref.collection('versions').doc(String(version)), { ...doc, savedAt: now, savedBy: doc.updatedBy });
    tx.set(ref, { ...doc, draft: null });
    return { version, ...settings, agencyName: doc.agencyName, used: check.used };
  });
}

/** A template as the System tab shows it: the text, the settings and its versions. */
async function templateView(db, lang) {
  const ref = db.collection(TEMPLATES).doc(lang);
  const snap = await ref.get();
  if (!snap.exists || !String(snap.data().text || '').trim()) return null;
  const t = snap.data();
  const versions = (await ref.collection('versions').get()).docs.map((d) => d.data())
    .sort((a, b) => (b.version || 0) - (a.version || 0)).slice(0, 20)
    .map((v) => ({ version: v.version, savedAt: v.savedAt ? new Date(v.savedAt).toISOString() : null, savedByName: v.savedBy?.name || '' }));
  return { lang, text: t.text, version: t.version || 1, ...periodSettings(t), agencyName: t.agencyName || 'Gold A&S',
    updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null, updatedByName: t.updatedBy?.name || '', versions };
}

// ── The agency's signature ────────────────────────────────────────────

/** A drawn signature as a PNG data: URL, or null when it is not one (the size is checked too). */
function pngOf(v) {
  const s = String(v ?? '');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m || s.length > Math.ceil(PNG_MAX_BYTES / 3) * 4 + 40) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < PNG_MIN_BYTES || buf.length > PNG_MAX_BYTES) return null;
  // The PNG signature, then the IHDR chunk with the picture's size.
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w < 50 || w > 3000 || h < 30 || h > 1500) return null;
  return s;
}

async function saveSignature(db, { email, name, png, now = Date.now() }) {
  const ok = pngOf(png);
  if (!ok) throw new AgreementError('signature', 'the signature must be a drawn PNG of a sensible size');
  if (!email) throw new AgreementError('who', 'no signed-in admin');
  await db.collection(SIGNATURES).doc(String(email).toLowerCase()).set({ png: ok, name: clean(name, 80), savedAt: now });
  return { saved: true, savedAt: new Date(now).toISOString() };
}

async function getSignature(db, email) {
  if (!email) return null;
  const snap = await db.collection(SIGNATURES).doc(String(email).toLowerCase()).get();
  return snap.exists && snap.data().png ? snap.data() : null;
}

async function clearSignature(db, email) {
  if (email) await db.collection(SIGNATURES).doc(String(email).toLowerCase()).delete();
  return { cleared: true };
}

// ── Making an agreement ───────────────────────────────────────────────

const PERIOD_MESSAGES = {
  start: 'the start date is missing or not a date (YYYY-MM-DD)',
  end: 'the end date is not a date (YYYY-MM-DD)',
  order: 'the end date must be after the start date',
  months: 'the length in months must be a whole number of at least 1',
  tooLong: (max) => `a representation agreement may run ${max} months at most`,
};

// A language with no template yet. app: the sentence a person reads in the
// CRM. golda: what Golda's tool result tells her to do instead (never a screen
// to go to, never a set sentence for the writer to type).
const goldaNoTemplate = (name) => `There is no ${name} representation agreement template yet. Do not send the writer to a screen and do not ask him to type anything. `
  + 'Say in one short line that there is no template yet and that you are preparing it now from the agency\'s existing agreements. '
  + 'Then call agreement_template action=examples, read one or two of the files it lists with read_file (field reprFiles, the file name as listed; one of a minor and one of an adult when both exist) '
  + 'and call agreement_template action=propose with the agency\'s own wording. When examples lists nothing, or none of the files can be read, ask the writer to send the agreement file (a PDF, a photo or a document) here in the chat and build it from that. '
  + 'Once the template is saved after his yes, go on with the agreement that was asked for: agreement_create action=check again.';
const NO_TEMPLATE = {
  he: {
    app: 'There is no Hebrew representation agreement template yet. Golda prepares it from the agency\'s existing agreements when she is asked for an agreement, or it can be written in System › Agreements.',
    golda: goldaNoTemplate('Hebrew'),
  },
  en: {
    app: 'There is no English representation agreement template yet. Golda prepares it from the agency\'s existing agreements when she is asked for an agreement, or it can be written in System › Agreements.',
    golda: goldaNoTemplate('English'),
  },
};

/**
 * The agency's own representation agreements already on the players (the
 * paper ones uploaded to reprFiles; never one this system made and filed),
 * newest first, one per player: what Golda reads to build a template from.
 * No file content, no document id.
 */
function agreementExamples(players, { today = israelDate(new Date()), limit = 8 } = {}) {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
  const rows = [];
  for (const p of players || []) {
    if (!p || p.deletedAt || (p.stage && p.stage !== 'represented')) continue;
    const files = (Array.isArray(p.reprFiles) ? p.reprFiles : []).filter((f) => f && f.name && !f.agreementId && (f.fileId || f.url));
    if (!files.length) continue;
    const f = [...files].sort((a, b) => String(day(b.uploadedAt) || '').localeCompare(String(day(a.uploadedAt) || '')))[0];
    const date = day(f.uploadedAt);
    const minor = isMinorOn(p.dob, today);
    const minorThen = date ? isMinorOn(p.dob, date) : null;
    rows.push({ playerId: p.id, player: nameOf(p), ...(minor === null ? {} : { minor }), ...(minorThen === null ? {} : { minorWhenUploaded: minorThen }),
      file: f.name, date, ...(f.type ? { type: f.type } : {}), ...(files.length > 1 ? { otherFiles: files.length - 1 } : {}) });
  }
  return rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, limit);
}

/**
 * Everything an agreement would be, checked, without writing anything:
 * { player, lang, template, period, minor, guardianName, playerSigns, text, missing }.
 * A minor's agreement always needs both signatures: playerSigns is true on
 * every new agreement, whatever is sent. Throws an AgreementError with a
 * sentence an admin or Golda can say.
 */
async function prepareAgreement(db, { playerId, lang, start, end, months, guardianName, minor, now = Date.now() }) {
  const l = langOf(lang);
  const snap = await db.collection('players').doc(String(playerId || '-')).get();
  if (!snap.exists || snap.data().deletedAt) throw new AgreementError('player', 'player not found');
  const player = { id: snap.id, ...snap.data() };
  const template = await getTemplate(db, l);
  if (!template) throw new AgreementError('no_template', NO_TEMPLATE[l].app);
  const settings = periodSettings(template);
  const period = agreementPeriod({ start, end, months, ...settings });
  if (!period.ok) {
    const msg = PERIOD_MESSAGES[period.error];
    throw new AgreementError(`period_${period.error}`, typeof msg === 'function' ? msg(period.maxMonths) : msg);
  }
  const today = israelDate(new Date(now));
  const known = isMinorOn(player.dob, today);
  if (known === null && typeof minor !== 'boolean') {
    throw new AgreementError('dob', `${nameOf(player)}'s date of birth is not in the CRM: say whether he is under 18 (minor true or false), or add his date of birth first`);
  }
  const isMinor = known === null ? minor === true : known;
  const guardian = isMinor ? clean(guardianName, 80) : '';
  if (isMinor && guardian.length < 2) throw new AgreementError('guardian', `${nameOf(player)} is under 18: the full name of the parent or guardian who signs is needed`);
  const values = agreementValues({ playerName: nameOf(player), dob: player.dob, guardianName: guardian, start: period.start, end: period.end, months: period.months, agencyName: template.agencyName, today });
  const filled = fillTemplate(template.text, values, { minor: isMinor, lang: l });
  if (filled.missing.length) {
    throw new AgreementError('missing', `the template needs ${filled.missing.map((k) => `{{${k}}}`).join(', ')} and the CRM has no value for it${filled.missing.length > 1 ? 'm' : ''}: fill it in on the player first`);
  }
  // A template whose text sits only in the other age's section fills to nothing: never an empty page to sign.
  if (!filled.text.trim()) {
    throw new AgreementError('no_section', `the ${l === 'en' ? 'English' : 'Hebrew'} template has no text for ${isMinor ? 'a player under 18' : 'an adult player'}: make this agreement in the other language, or add that part to the template in System › Agreements`);
  }
  return { player, lang: l, template, period, minor: isMinor, minorFromDob: known !== null, guardianName: guardian, playerSigns: true, text: filled.text };
}

/** What an admin or Golda reads before saying yes: no ID numbers, nothing private. */
function summaryOf(p) {
  return {
    player: nameOf(p.player), playerId: p.player.id, lang: p.lang,
    start: dayText(p.period.start), end: dayText(p.period.end), months: p.period.months,
    minor: p.minor, ...(p.minor ? { guardian: p.guardianName } : {}),
    templateVersion: p.template.version || 1, maxMonths: periodSettings(p.template).maxMonths,
  };
}

/**
 * Makes an agreement and its signing link. `by` is the admin: { email, name, channel }.
 * Returns { id, token, url, view, summary, days, clamped, defaulted }.
 */
async function createAgreement(db, input = {}) {
  const { by = {}, days, now = Date.now(), base } = input;
  const p = await prepareAgreement(db, { ...input, now });
  const span = linkDays(days);
  const token = newToken();
  const linkId = idOf(token);
  const sig = await getSignature(db, by.email);
  const ref = db.collection(COL).doc();
  const doc = {
    playerId: p.player.id, playerName: clean(nameOf(p.player), 80), lang: p.lang, templateVersion: p.template.version || 1,
    agencyName: p.template.agencyName || 'Gold A&S',
    text: p.text, textHash: sha256(p.text),
    start: p.period.start, end: p.period.end, months: p.period.months, minor: p.minor, guardianName: p.guardianName, playerSigns: p.playerSigns,
    createdAt: now, createdBy: { email: String(by.email || ''), name: String(by.name || ''), channel: String(by.channel || '') },
    agencySignature: sig ? { png: sig.png, name: sig.name || String(by.name || ''), at: now } : null,
    link: { id: linkId, tokenSealed: seal(token), createdAt: now, expiresAt: now + span.days * DAY, days: span.days, revokedAt: null, failed: 0, lockedAt: null },
    linksIssued: 1, opens: 0, lastOpenAt: null, lastOpenDevice: null, openLog: [],
    signedAt: null, signedDevice: null, signedLinkId: null, shownHash: null, signers: [], copy: null,
    filingState: null, filingTries: 0, filingError: null, filedAt: null, fileId: null, fileName: null,
    noticeState: null, lateNoticeState: null,
  };
  await ref.set(doc);
  await db.collection(LINKS).doc(linkId).set({ kind: 'sign', agreementId: ref.id, createdAt: now });
  return { id: ref.id, token, url: signUrl(token, base), view: viewOf({ id: ref.id, ...doc }, { now, withUrl: false }), summary: summaryOf(p), ...span };
}

/** Stops an unsigned agreement's link at once. Returns the agreement as it was, or null. */
async function revokeLink(db, id, { now = Date.now() } = {}) {
  const ref = db.collection(COL).doc(String(id || '-'));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const a = { id: snap.id, ...snap.data() };
    if (a.signedAt) throw new AgreementError('signed', 'this agreement is already signed; its link no longer works anyway');
    if (!a.link.revokedAt) tx.update(ref, { link: { ...a.link, revokedAt: now } });
    return a;
  });
}

/** A new link for an unsigned agreement: the old one stops at once. Returns { token, url, days, expiresAt }. */
async function reissueLink(db, id, { days, now = Date.now(), base } = {}) {
  const ref = db.collection(COL).doc(String(id || '-'));
  const span = linkDays(days);
  const token = newToken();
  const linkId = idOf(token);
  const a = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const was = { id: snap.id, ...snap.data() };
    if (was.signedAt) throw new AgreementError('signed', 'this agreement is already signed: no new link is needed');
    tx.update(ref, {
      link: { id: linkId, tokenSealed: seal(token), createdAt: now, expiresAt: now + span.days * DAY, days: span.days, revokedAt: null, failed: 0, lockedAt: null },
      linksIssued: (Number(was.linksIssued) || 1) + 1,
    });
    return was;
  });
  if (!a) return null;
  await db.collection(LINKS).doc(linkId).set({ kind: 'sign', agreementId: a.id, createdAt: now });
  return { agreement: a, token, url: signUrl(token, base), ...span, expiresAt: now + span.days * DAY };
}

// ── Views ─────────────────────────────────────────────────────────────

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/**
 * An agreement as the CRM and Golda may see it: states, dates and names, never
 * the ID numbers or the signatures. The link's address only with withUrl (an
 * admin) and only while it works.
 */
function viewOf(a, { now = Date.now(), withUrl = false, base } = {}) {
  const state = stateOf(a, now);
  let url = null;
  if (withUrl && state === 'waiting' && a.link?.tokenSealed) {
    try { url = signUrl(unseal(a.link.tokenSealed), base); } catch { url = null; }
  }
  return {
    id: a.id, playerId: a.playerId, playerName: a.playerName || '', lang: langOf(a.lang), state,
    start: a.start || null, end: a.end || null, months: a.months || null,
    minor: !!a.minor, guardianName: a.minor ? a.guardianName || '' : '', playerSigns: a.playerSigns !== false,
    templateVersion: a.templateVersion || 1, createdAt: iso(a.createdAt), createdByName: a.createdBy?.name || '',
    agencySigned: !!(a.agencySignature && a.agencySignature.png),
    linkExpiresAt: iso(a.link?.expiresAt), linkDays: a.link?.days || null, linksIssued: Number(a.linksIssued) || 1,
    opens: Number(a.opens) || 0, lastOpenAt: iso(a.lastOpenAt), lastOpenDevice: a.lastOpenDevice || null,
    signedAt: iso(a.signedAt), signedDevice: a.signedDevice || null,
    signers: (Array.isArray(a.signers) ? a.signers : []).map((s) => ({ role: s.role === 'guardian' ? 'guardian' : 'player', name: s.name || '', ...(s.relation ? { relation: s.relation } : {}) })),
    filedAt: iso(a.filedAt), fileName: a.fileName || null, filingTries: Number(a.filingTries) || 0,
    url,
  };
}

/** A player's agreements, newest first. */
async function listAgreements(db, playerId, opts = {}) {
  if (!playerId) return [];
  const docs = (await db.collection(COL).where('playerId', '==', String(playerId)).get()).docs;
  return docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((a) => viewOf(a, opts));
}

/**
 * The allow-list of the public endpoint: the agreement's text and the names
 * printed in it, and what the page needs to ask for. Nothing else of the
 * agreement or the player leaves the server.
 */
function publicAgreement(a) {
  const needs = a.minor ? ['guardian', ...(a.playerSigns !== false ? ['player'] : [])] : ['player'];
  return {
    lang: langOf(a.lang), text: String(a.text || ''), textHash: sha256(String(a.text || '')),
    agencyName: clean(a.agencyName, 60) || 'Gold A&S',
    names: { player: clean(a.playerName, 80), ...(a.minor ? { guardian: clean(a.guardianName, 80) } : {}) },
    needs, expiresAt: iso(a.link?.expiresAt),
  };
}

// ── The public side ───────────────────────────────────────────────────

/**
 * The agreement a token opens, or null. Unknown, malformed, re-issued,
 * revoked, locked, expired and signed all come back as null. Two reads.
 * kind 'sign' (the signing link) or 'copy' (the signer's download).
 */
async function agreementByToken(db, token, { kind = 'sign', now = Date.now() } = {}) {
  if (!validToken(token)) return null;
  const id = idOf(token);
  const ptr = await db.collection(LINKS).doc(id).get();
  if (!ptr.exists || ptr.data().kind !== kind) return null;
  const snap = await db.collection(COL).doc(String(ptr.data().agreementId || '-')).get();
  if (!snap.exists) return null;
  const a = { id: snap.id, ...snap.data() };
  if (kind === 'sign') return a.link?.id === id && linkState(a, now) === 'active' ? { ...a, linkId: id } : null;
  return a.copy && a.copy.id === id && Number(a.copy.until) > now ? a : null;
}

/** Counts one opening of the signing link (time and phone/desktop only). Returns { counted } or null. */
async function recordOpening(db, a, { device = 'desktop', now = Date.now() } = {}) {
  const ref = db.collection(COL).doc(a.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const cur = { id: snap.id, ...snap.data() };
    if (linkState(cur, now) !== 'active' || cur.link.id !== a.linkId) return null;
    if (cur.lastOpenAt && now - cur.lastOpenAt < REPEAT_MS) return { counted: false };
    const openLog = [...(Array.isArray(cur.openLog) ? cur.openLog : []), { at: now, device }].slice(-KEEP_OPENINGS);
    tx.update(ref, { opens: (Number(cur.opens) || 0) + 1, lastOpenAt: now, lastOpenDevice: device, openLog });
    return { counted: true };
  });
}

/**
 * Checks what a signer sent. Returns { signers } or { problems: [codes] }.
 * Codes only (never what was sent): consent, text, signers, name, id, relation, signature.
 */
function checkSubmission(a, input = {}) {
  const problems = new Set();
  if (input.consent !== true) problems.add('consent');
  if (String(input.textHash || '') !== sha256(String(a.text || ''))) problems.add('text');
  const needs = publicAgreement(a).needs;
  const given = Array.isArray(input.signers) ? input.signers.slice(0, 4) : [];
  if (given.length !== needs.length || !needs.every((r) => given.filter((s) => s && s.role === r).length === 1)) problems.add('signers');
  const signers = needs.map((role) => {
    const s = given.find((x) => x && x.role === role) || {};
    const name = clean(s.name, 80);
    const idNumber = String(s.idNumber ?? '').replace(/[\s-]/g, '').toUpperCase();
    if (name.length < 2) problems.add('name');
    if (!/^[A-Z0-9]{5,20}$/.test(idNumber)) problems.add('id');
    const relation = role === 'guardian' ? String(s.relation || '') : '';
    if (role === 'guardian' && !RELATIONS.includes(relation)) problems.add('relation');
    const png = pngOf(s.signature);
    if (!png) problems.add('signature');
    return { role, name, idNumber, ...(relation ? { relation } : {}), png };
  });
  return problems.size ? { problems: [...problems] } : { signers };
}

/**
 * Signs, once. In one transaction: the link is checked again, the submission
 * is checked, and the signature, the time, the device and the hash of the
 * text that was shown are stored; the link is used up and a download key for
 * the signer is made. A bad submission counts against the link; after
 * MAX_FAILED the link stops working.
 * Returns { signed: true, id, copyToken, copyUntil } | { problems } | null (the link does not work).
 */
async function signAgreement(db, token, input, { device = 'desktop', now = Date.now() } = {}) {
  if (!validToken(token)) return null;
  const linkId = idOf(token);
  const ptr = await db.collection(LINKS).doc(linkId).get();
  if (!ptr.exists || ptr.data().kind !== 'sign') return null;
  const ref = db.collection(COL).doc(String(ptr.data().agreementId || '-'));
  const copyToken = newToken();
  const copyId = idOf(copyToken);
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const a = { id: snap.id, ...snap.data() };
    if (a.link?.id !== linkId || linkState(a, now) !== 'active') return null;
    const checked = checkSubmission(a, input);
    if (checked.problems) {
      const failed = (Number(a.link.failed) || 0) + 1;
      tx.update(ref, { link: { ...a.link, failed, ...(failed >= MAX_FAILED ? { lockedAt: now } : {}) } });
      return { problems: checked.problems, locked: failed >= MAX_FAILED };
    }
    tx.update(ref, {
      signedAt: now, signedDevice: device === 'phone' ? 'phone' : 'desktop', signedLinkId: linkId, shownHash: sha256(String(a.text || '')),
      signers: checked.signers, copy: { id: copyId, until: now + COPY_MINUTES * MIN },
      filingState: 'pending', filingTries: 0, filingError: null, noticeState: 'pending',
    });
    return { signed: true, id: a.id };
  });
  if (!out || !out.signed) return out;
  await db.collection(LINKS).doc(copyId).set({ kind: 'copy', agreementId: out.id, createdAt: now });
  return { ...out, copyToken, copyUntil: now + COPY_MINUTES * MIN };
}

// ── The signed PDF into the player's file ─────────────────────────────

function defaultLoad() {
  /* eslint-disable global-require */
  const m = require('../../../apps/web/src/lib/agreementPdf.js');
  const fonts = require('../../../apps/web/src/lib/pdfFonts.js');
  const jspdf = require('jspdf');
  return { buildAgreementPdf: m.buildAgreementPdf, fonts, jsPDF: jspdf.jsPDF || jspdf.default || jspdf };
}

/** The signed agreement as a PDF: { buffer, filename, mimeType }. */
async function agreementPdf(a, { load = defaultLoad, logo } = {}) {
  const { buildAgreementPdf, fonts, jsPDF } = load();
  const { logoDataUrl } = require('./golda-pdf.js');
  const { doc, filename } = await buildAgreementPdf(jsPDF, fonts, {
    id: a.id, lang: a.lang, text: a.text, playerName: a.playerName, templateVersion: a.templateVersion, agencyName: a.agencyName,
    createdAt: a.createdAt, createdBy: a.createdBy, agencySignature: a.agencySignature,
    signers: a.signers, signedAt: a.signedAt, signedDevice: a.signedDevice, shownHash: a.shownHash, linkId: a.signedLinkId,
  }, { logo: logo === undefined ? await logoDataUrl() : logo });
  return { buffer: Buffer.from(doc.output('arraybuffer')), filename, mimeType: 'application/pdf' };
}

/** Writes a file the way uploadFile (lib/db.js) and attach_file do: chunks first, then the metadata. */
async function storeFile(db, fileId, { buffer, filename, mimeType }, { by, now }) {
  const dataUrl = `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
  const chunks = [];
  for (let i = 0; i < dataUrl.length; i += FILE_CHUNK) chunks.push(dataUrl.slice(i, i + FILE_CHUNK));
  await Promise.all(chunks.map((data, i) => db.collection('files').doc(fileId).collection('chunks').doc(String(i)).set({ data })));
  const at = new Date(now).toISOString();
  await db.collection('files').doc(fileId).set({ name: filename, originalName: filename, type: mimeType, size: buffer.length, parts: chunks.length, uploadedAt: at, uploadedBy: by });
  return { fileId, name: filename, originalName: filename, uploadedAt: at, uploadedBy: by, size: buffer.length, type: mimeType };
}

/** A stored file back as a Buffer, or null. Bounded reads. */
async function loadFile(db, fileId, { maxParts = 40 } = {}) {
  if (!fileId) return null;
  const meta = await db.collection('files').doc(fileId).get();
  if (!meta.exists) return null;
  const parts = Number(meta.data().parts) || 0;
  if (parts < 1 || parts > maxParts) return null;
  const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => db.collection('files').doc(fileId).collection('chunks').doc(String(i)).get()));
  if (chunks.some((c) => !c.exists)) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(chunks.map((c) => c.data().data).join(''));
  return m ? { buffer: Buffer.from(m[2], 'base64'), filename: meta.data().name || 'agreement.pdf', mimeType: m[1] } : null;
}

/**
 * Builds the signed PDF and files it on the player, then marks the agreement
 * filed. Claimed in a transaction first, so two runs never file at once. The
 * file id is fixed per agreement, so a retry writes over a half-written file
 * instead of adding a second one, and the player's list never holds it twice.
 * The player is changed through one audited, undoable update (the same audit
 * line Golda's own changes write): reprFiles gets the PDF, reprStart and
 * reprEnd the agreement's dates.
 *   makePdf  tests inject it: (agreement) → { buffer, filename, mimeType }
 * Returns { filed: true } | { filed: false, error } | { skipped }.
 */
async function fileAgreement(db, id, { now = Date.now(), makePdf = agreementPdf, FieldValue } = {}) {
  const ref = db.collection(COL).doc(String(id));
  const a = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const cur = { id: snap.id, ...snap.data() };
    if (!cur.signedAt || cur.filingState === 'done') return null;
    if (cur.filingState === 'working' && now - (Number(cur.filingStartedAt) || 0) < STALE_WORK_MS) return null;
    tx.update(ref, { filingState: 'working', filingStartedAt: now, filingTries: (Number(cur.filingTries) || 0) + 1 });
    return cur;
  });
  if (!a) return { skipped: true };
  const by = a.createdBy?.email || '';
  const byName = `${a.createdBy?.name || ''} (Golda)`.trim();
  try {
    const file = await makePdf(a);
    const fileRef = { ...(await storeFile(db, `agr_${a.id}`, file, { by, now })), expiresAt: a.end, agreementId: a.id };
    const pRef = db.collection('players').doc(a.playerId);
    const change = await db.runTransaction(async (tx) => {
      const snap = await tx.get(pRef);
      if (!snap.exists || snap.data().deletedAt) throw new AgreementError('player_gone', 'the player is no longer in the CRM');
      const p = snap.data();
      const files = Array.isArray(p.reprFiles) ? p.reprFiles : [];
      const after = { reprFiles: files.some((f) => f && f.fileId === fileRef.fileId) ? files : [...files, fileRef], reprStart: a.start, reprEnd: a.end };
      const before = { reprFiles: files, reprStart: p.reprStart === undefined ? null : p.reprStart, reprEnd: p.reprEnd === undefined ? null : p.reprEnd };
      const stamp = FieldValue ? FieldValue.serverTimestamp() : new Date(now).toISOString();
      tx.update(pRef, { ...after, updatedAt: stamp, lastEditedAt: stamp, lastEditedBy: by, lastEditedByName: byName });
      return { before, after, name: nameOf(p) };
    });
    // The same audit line Golda's own edits write, so it shows on the Golda screen and "undo" reverses it.
    await db.collection('audit').add({
      action: 'update', collection: 'players', docId: a.playerId, name: change.name,
      summary: `Signed representation agreement filed: ${change.name} · ${a.start} → ${a.end}`,
      before: change.before, after: change.after, fields: ['reprFiles', 'reprStart', 'reprEnd'], note: 'signed representation agreement',
      by, byName, via: 'golda', channel: 'agreement', actor: 'golda', onBehalfOf: by, sender: a.createdBy?.name || '', phone: '',
      at: FieldValue ? FieldValue.serverTimestamp() : new Date(now).toISOString(), undone: false,
    }).catch((e) => console.error('[agreements] audit failed:', e.message));
    const late = a.noticeState === 'sent' && a.noticeSaidFiled === false;
    await ref.update({ filingState: 'done', filingError: null, filedAt: now, fileId: fileRef.fileId, fileName: fileRef.name, ...(late ? { lateNoticeState: 'pending' } : {}) });
    return { filed: true };
  } catch (e) {
    // The signature stays; only the filing waits for the next try. No detail of the agreement goes to the log.
    const code = e instanceof AgreementError ? e.code : 'pdf_or_save';
    console.error('[agreements] filing failed:', code, e.name);
    await ref.update({ filingState: 'failed', filingError: code, filingFailedAt: now }).catch(() => {});
    return { filed: false, error: code };
  }
}

// ── Telling the owner ─────────────────────────────────────────────────

const relationHe = { father: 'האב', mother: 'האם', guardian: 'האפוטרופוס' };

/** The line the owner gets once an agreement is signed. */
function noticeText(a) {
  const when = whenHe(a.signedAt || Date.now());
  const from = a.signedDevice === 'phone' ? 'מטלפון' : 'ממחשב';
  const player = a.playerName || 'השחקן';
  const signers = Array.isArray(a.signers) ? a.signers : [];
  const guardian = signers.find((s) => s.role === 'guardian');
  const head = guardian
    ? `✍️ הסכם הייצוג של *${player}* נחתם: ${guardian.name}${guardian.relation ? ` (${relationHe[guardian.relation] || 'ההורה'})` : ''}${signers.some((s) => s.role === 'player') ? ` ו${player}` : ''} (${when}, ${from}).`
    : `✍️ *${player}* חתם על הסכם הייצוג (${when}, ${from}).`;
  const tail = a.filingState === 'done'
    ? `ה-PDF החתום נשמר בתיק שלו, ותקופת הייצוג עודכנה: ${dayText(a.start)} עד ${dayText(a.end)}. ההתראה על סוף הייצוג תגיע בזמן.`
    : 'החתימה שמורה, אבל ה-PDF החתום עוד לא נשמר בתיק שלו. אני מנסה שוב לבד ואעדכן כשזה מסתדר.';
  return `${head}\n${tail}`;
}

/** The line when the PDF reached the file after the first notice said it had not. */
function lateNoticeText(a) {
  return `📄 ה-PDF החתום של הסכם הייצוג של *${a.playerName || 'השחקן'}* נשמר עכשיו בתיק שלו, ותקופת הייצוג עודכנה: ${dayText(a.start)} עד ${dayText(a.end)}.`;
}

/**
 * Tells the owner, once per agreement, that it was signed (and, once more,
 * when a PDF that failed to file reached the file later). Each notice is
 * claimed in a transaction before it is sent, as lib/player-pages.js does.
 *   send  tests inject it: (owner, body, kind, buttons) → { state }
 */
async function sendNotices(db, { now = Date.now(), send = null, limit = 10 } = {}) {
  const [first, late] = await Promise.all([
    db.collection(COL).where('noticeState', '==', 'pending').get(),
    db.collection(COL).where('lateNoticeState', '==', 'pending').get(),
  ]);
  const jobs = [...first.docs.map((d) => [d.id, 'noticeState']), ...late.docs.map((d) => [d.id, 'lateNoticeState'])].slice(0, limit);
  if (!jobs.length) return { sent: 0, pending: 0 };
  const { whatsappRecipients } = require('./golda-identity.js');
  const { ownerOf, nudge } = require('./golda-nudge.js');
  const users = (await db.collection('app_users').get()).docs.map((d) => ({ id: d.id, email: d.id, ...d.data() }));
  const owner = ownerOf(whatsappRecipients(users));
  let sent = 0;
  for (const [id, field] of jobs) {
    const ref = db.collection(COL).doc(id);
    const a = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()[field] !== 'pending') return null;
      tx.update(ref, { [field]: owner ? 'sending' : 'skipped' });
      return { id, ...snap.data() };
    });
    if (!a || !owner) continue;
    try {
      const body = field === 'noticeState' ? noticeText(a) : lateNoticeText(a);
      await nudge(db, owner, { body, kind: 'agreement', remember: true }, { now, send });
      await ref.update({ [field]: 'sent', ...(field === 'noticeState' ? { noticeSaidFiled: a.filingState === 'done', noticeSentAt: now } : {}) });
      // Filed between the first notice and now: the late line follows on the next run.
      if (field === 'noticeState' && a.filingState !== 'done') {
        const fresh = (await ref.get()).data();
        if (fresh.filingState === 'done' && !fresh.lateNoticeState) await ref.update({ lateNoticeState: 'pending' });
      }
      sent++;
    } catch (e) {
      console.error('[agreements] notice failed:', e.message);
      await ref.update({ [field]: 'failed' }).catch(() => {});
    }
  }
  return { sent, pending: jobs.length, owner: !!owner };
}

/**
 * The background run: finishes filings the signing request could not (still
 * pending after a couple of minutes, failed, or stuck mid-way), then sends
 * the owner's notices. Bounded per run.
 */
async function runPending(db, { now = Date.now(), makePdf, send, FieldValue, limit = 5 } = {}) {
  const [pending, failed, working] = await Promise.all(['pending', 'failed', 'working'].map((s) => db.collection(COL).where('filingState', '==', s).get()));
  const due = [
    ...pending.docs.filter((d) => now - (Number(d.data().signedAt) || 0) >= RETRY_AFTER_MS),
    ...failed.docs.filter((d) => (Number(d.data().filingTries) || 0) < MAX_TRIES),
    ...working.docs.filter((d) => now - (Number(d.data().filingStartedAt) || 0) >= STALE_WORK_MS && (Number(d.data().filingTries) || 0) < MAX_TRIES),
  ].slice(0, limit);
  const filed = [];
  for (const d of due) filed.push(await fileAgreement(db, d.id, { now, makePdf, FieldValue }));
  const notices = await sendNotices(db, { now, send });
  return { tried: due.length, filed: filed.filter((r) => r.filed).length, notices };
}

/** True when the background run has something to do (the ten-minute check asks this). */
async function hasPending(db, now = Date.now()) {
  const [a, b, c] = await Promise.all([
    db.collection(COL).where('filingState', '==', 'failed').get(),
    db.collection(COL).where('noticeState', '==', 'pending').get(),
    db.collection(COL).where('filingState', '==', 'pending').get(),
  ]);
  return a.docs.some((d) => (Number(d.data().filingTries) || 0) < MAX_TRIES) || b.docs.length > 0 || c.docs.some((d) => now - (Number(d.data().signedAt) || 0) >= RETRY_AFTER_MS);
}

module.exports = {
  COL, LINKS, TEMPLATES, SIGNATURES, DRAFTS, DEFAULT_LINK_DAYS, MAX_LINK_DAYS, COPY_MINUTES, MAX_FAILED, PNG_MAX_BYTES, BODY_MAX, MAX_TRIES, RELATIONS, NO_TEMPLATE,
  AgreementError, linkDays, linkState, stateOf, signUrl,
  getTemplate, saveTemplate, templateView, periodSettings, templateProblem, agreementExamples,
  pngOf, saveSignature, getSignature, clearSignature,
  prepareAgreement, summaryOf, createAgreement, revokeLink, reissueLink, viewOf, listAgreements, publicAgreement,
  agreementByToken, recordOpening, checkSubmission, signAgreement,
  agreementPdf, storeFile, loadFile, fileAgreement, noticeText, lateNoticeText, sendNotices, runPending, hasPending,
};
