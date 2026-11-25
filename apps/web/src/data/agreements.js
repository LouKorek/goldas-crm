// Representation agreements signed inside the system.
//
// Two users of this file:
//   The signing page (/sign/<token>, pages/SignPage.jsx): the player, or his
//     parent or guardian, reads the agreement and signs. No sign-in: the token
//     in the link is its key (netlify/functions/agreement-sign.js).
//   The CRM (components/player/PlayerAgreements.jsx, the System tab
//     components/admin/AgreementTemplates.jsx): a player's agreements, making
//     one, the link, the templates and the agency's signature. That goes
//     through a signed-in function; the browser never reads the agreement
//     collections itself.
import { auth } from 'lib/firebase';
import { callFunction } from 'lib/api';

// ── the signing page ────────────────────────────────────────────────────────

/** A CRM user looking at the link sends his sign-in along: the server shows it as a preview, uncounted and unsignable. */
async function ownSignIn() {
  try {
    await Promise.race([auth.authStateReady(), new Promise((r) => setTimeout(r, 1500))]);
    return auth.currentUser ? { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` } : {};
  } catch { return {}; }
}

async function signCall(body, headers = {}) {
  const res = await fetch('/.netlify/functions/agreement-sign', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'unavailable'); e.status = res.status; e.problems = data.problems || []; e.locked = !!data.locked; throw e; }
  return data;
}

/** The agreement as the signer sees it: { agreement: { lang, text, textHash, agencyName, names, needs, expiresAt }, preview? }. Counts an opening. */
export const loadAgreement = async (token) => signCall({ t: token, action: 'view' }, await ownSignIn());
/**
 * Signs: { consent, textHash, signers: [{ role, name, idNumber, relation?, signature }] } → { signed, copy, copyUntil, filed }.
 * A refused submission throws with e.status 400 and e.problems (codes), a dead link with 404.
 */
export const signAgreement = async (token, body) => signCall({ t: token, action: 'sign', ...body }, await ownSignIn());
/** Whether the signed copy is ready yet → { ready, until }. */
export const copyStatus = (copy) => signCall({ c: copy, action: 'copy' });
/** The address the signed copy downloads from, for a short while after signing. */
export const copyUrl = (copy) => `/.netlify/functions/agreement-sign?c=${encodeURIComponent(copy)}`;

// ── the CRM ─────────────────────────────────────────────────────────────────

/** A signed-in call whose refusal carries the server's own sentence (e.message), e.g. "there is no template in English yet…". */
async function crm(opts) {
  const res = await callFunction('player-agreements', opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || data.error || `Request failed (${res.status})`); e.code = data.error; throw e; }
  return data;
}
const callFunctionJson = (_name, opts) => crm(opts);

/** A player's agreements, newest first: { agreements: [...], canCreate, templates: { he, en } }. */
export const listAgreements = (playerId) => callFunctionJson('player-agreements', { query: { playerId } });
/** Makes one → { agreement (with url), summary, days, clamped }. Refusals come back as an error with the server's sentence. */
export const createAgreement = (input) => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'create', ...input } });
export const revokeAgreementLink = (id) => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'revoke', id } });
export const reissueAgreementLink = (id, days) => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'reissue', id, days } });
export const retryAgreementFiling = (id) => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'retry', id } });

/** Both templates and the admin's own signature: { he, en, signature: { has, name, savedAt, png } }. */
export const loadAgreementSettings = () => callFunctionJson('player-agreements', { query: { templates: '1' } });
export const saveAgreementTemplate = (input) => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'template_save', ...input } });
export const saveAgencySignature = (png) => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'signature_save', png } });
export const clearAgencySignature = () => callFunctionJson('player-agreements', { method: 'POST', body: { action: 'signature_clear' } });
