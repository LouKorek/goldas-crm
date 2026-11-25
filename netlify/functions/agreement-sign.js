// The signing page's endpoint (/sign/<token>, apps/web/src/pages/SignPage.jsx).
//
// No sign-in: the token in the link is the key (lib/agreements.js). It opens
// one agreement, works until it expires (14 days unless the admin chose, 30
// at most), stops when it is revoked, re-issued or used, and stops after ten
// failed submissions.
//
//   POST { t, action: 'view' }                   → the agreement's text and the names in it; counts an opening
//   POST { t, action: 'sign', consent, textHash, signers: [{ role, name, idNumber, relation, signature }] }
//        → { signed: true, copy, copyUntil, filed } | 400 { error: 'invalid', problems: [codes], locked }
//   POST { c, action: 'copy' }                   → { ready } (the signer's copy is in the file)
//   GET  ?c=<copy token>                         → the signed PDF, for the signer, for thirty minutes
//
// Every link that does not work gets the same short 404. Nothing from the
// request is echoed back or logged: the ID numbers and the drawn signatures
// travel to the agreement document and nowhere else.
const { getDb, admin } = require('./lib/firestore.js');
const { header, internalHeaders } = require('./lib/auth.js');
const { originOf } = require('./lib/site.js');
const agreements = require('./lib/agreements.js');
const { json, notAvailable, isPreview, pdfResponse, deviceOf } = require('./lib/public-link.js');

/** Wakes the function that files the PDF and tells the owner; never waits long and never fails the page. */
async function kickBackground(event) {
  try {
    await fetch(`${originOf(event)}/.netlify/functions/agreement-file-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('agreement-filing')) },
      body: '{}', signal: AbortSignal.timeout(2500),
    });
  } catch (e) { console.warn('[agreement-sign] the ten-minute check will finish it:', e.name); }
}

async function handle(event, deps = {}) {
  const db = deps.db || getDb();
  const now = deps.now || Date.now();
  const preview = deps.isPreview || isPreview;
  const kick = deps.kick || kickBackground;
  const FieldValue = deps.FieldValue || (admin && admin.firestore && admin.firestore.FieldValue);

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const a = await agreements.agreementByToken(db, q.c, { kind: 'copy', now });
    if (!a || a.filingState !== 'done') return notAvailable();
    const file = await agreements.loadFile(db, a.fileId);
    return file ? pdfResponse(file, 'agreement.pdf') : notAvailable();
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (String(event.body || '').length > agreements.BODY_MAX) return notAvailable();
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return notAvailable(); }
  if (!body || typeof body !== 'object') return notAvailable();

  if (body.action === 'copy') {
    const a = await agreements.agreementByToken(db, body.c, { kind: 'copy', now });
    return a ? json(200, { ready: a.filingState === 'done', until: new Date(a.copy.until).toISOString() }) : notAvailable();
  }

  if (body.action === 'view') {
    const a = await agreements.agreementByToken(db, body.t, { kind: 'sign', now });
    if (!a) return notAvailable();
    const isOwn = await preview(event);
    if (!isOwn) await agreements.recordOpening(db, a, { device: deviceOf(header(event, 'user-agent')), now });
    return json(200, { agreement: agreements.publicAgreement(a), ...(isOwn ? { preview: true } : {}) });
  }

  if (body.action === 'sign') {
    if (await preview(event)) return json(403, { error: 'preview' });   // a CRM user looking at the link never signs it
    const out = await agreements.signAgreement(db, body.t, {
      consent: body.consent, textHash: body.textHash, signers: body.signers,
    }, { device: deviceOf(header(event, 'user-agent')), now });
    if (!out) return notAvailable();
    if (out.problems) return json(400, { error: 'invalid', problems: out.problems, locked: !!out.locked });
    // File it now when it goes quickly; the background run (and the ten-minute check) finishes what does not.
    let filed = false;
    try {
      const r = await agreements.fileAgreement(db, out.id, { now, makePdf: deps.makePdf, FieldValue });
      filed = !!r.filed;
    } catch (e) { console.error('[agreement-sign] filing waits for the retry:', e.name); }
    await kick(event);
    return json(200, { signed: true, copy: out.copyToken, copyUntil: new Date(out.copyUntil).toISOString(), filed });
  }

  return notAvailable();
}

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('[agreement-sign]', e.name);
    return json(500, { error: 'unavailable' });
  }
};
exports._handle = handle;
