// Harness stand-in for data/agreements: the signing page, the player page's
// "Representation agreement" card and System › Agreements, with no backend.
//
// The signing page, as the signer sees it:  /dev/app.html?path=/sign/<token>
//   demo         Hebrew, an adult player
//   demo-minor   Hebrew, a minor: the parent signs and the player too, on one page
//   demo-en      English, an adult
//   signed       just after signing: the confirmation and the signed copy
//   gone         a link that no longer works
//
// The card:  /dev/app.html?path=/players/p1   (one signed and one waiting agreement)
// The tab:   /dev/app.html?path=/system/agreements           (both templates)
//            /dev/app.html?path=/system/agreements&templates=none   (none yet)
//
// The agreement text here is a neutral SAMPLE, written for the harness only.
// It is not the agency's agreement and never reaches production.
const H = 3600e3, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const noTemplates = new URLSearchParams(location.search).get('templates') === 'none';

const SAMPLE_HE = `# הסכם ייצוג (נוסח לדוגמה בלבד)

הסכם זה נערך ונחתם ביום {{today}} בין {{agency_name}} ("הסוכנות") לבין {{player_name}}, יליד {{player_dob}}, מספר זהות {{player_id_number}} ("השחקן").
{{#minor}}
מאחר שהשחקן טרם מלאו לו 18, ההסכם נחתם גם על ידי {{guardian_name}}, מספר זהות {{guardian_id_number}}, בשם השחקן ולמענו.
{{/minor}}

# תקופת ההסכם

ההסכם בתוקף מיום {{start_date}} ועד יום {{end_date}} ({{period_months}} חודשים).

# התחייבויות הצדדים

זהו טקסט לדוגמה שנועד לבדיקת התצוגה בלבד. הנוסח האמיתי של הסוכנות נשמר במערכת › הסכמי ייצוג.

הסוכנות תפעל לקידום הקריירה של השחקן בהתאם לכללים החלים.

השחקן יעדכן את הסוכנות בכל פנייה שתגיע אליו.`;
const SAMPLE_EN = `# Representation agreement (sample text only)

This agreement is made on {{today}} between {{agency_name}} ("the Agency") and {{player_name}}, born {{player_dob}}, ID {{player_id_number}} ("the Player").

# Term

The agreement runs from {{start_date}} to {{end_date}} ({{period_months}} months).

# Duties

This is sample text for checking the display only. The agency's real wording is kept in System › Agreements.`;

const fill = (text, v) => text.replace(/\{\{#minor\}\}([\s\S]*?)\{\{\/minor\}\}/g, v.minor ? '$1' : '').replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
const ID_HE = '(מספר הזהות של השחקן, כפי שנמסר ברשומת החתימה)';
const ID_G = '(מספר הזהות של ההורה או האפוטרופוס, כפי שנמסר ברשומת החתימה)';
const base = { today: '25/11/2026', agency_name: 'Gold A&S', start_date: '01/12/2026', end_date: '30/11/2028', period_months: 24 };
const AGREEMENTS = {
  demo: { lang: 'he', text: fill(SAMPLE_HE, { ...base, player_name: 'נועם ברזילי', player_dob: '15/03/2004', player_id_number: ID_HE }), names: { player: 'נועם ברזילי' }, needs: ['player'] },
  'demo-minor': { lang: 'he', text: fill(SAMPLE_HE, { ...base, minor: true, player_name: 'יואב כהן', player_dob: '01/06/2011', player_id_number: ID_HE, guardian_name: 'רינה כהן', guardian_id_number: ID_G }), names: { player: 'יואב כהן', guardian: 'רינה כהן' }, needs: ['guardian', 'player'] },
  'demo-en': { lang: 'en', text: fill(SAMPLE_EN, { ...base, player_name: 'Daniel de la Cruz', player_dob: '02/02/2001', player_id_number: "(the Player's ID number, as given in the signing record)" }), names: { player: 'Daniel de la Cruz' }, needs: ['player'] },
};
const HASH = 'c3b1f0e9a4d27b6f8e1a90d5c7f3b2e6a1d4c8f09b7e3a5d2c6f1e8b4a9d07c5';

// The "signed" fixture: the page finds its copy key in this tab, as it would right after signing.
try { sessionStorage.setItem('gas-sign-copy:signed', JSON.stringify({ copy: 'copy-demo', until: iso(now + 28 * 60e3), ready: true, lang: 'he' })); } catch { /* no storage */ }

export async function loadAgreement(token) {
  await wait(250);
  const a = AGREEMENTS[token];
  if (!a) throw Object.assign(new Error('not_available'), { status: 404 });
  return { agreement: { ...a, textHash: HASH, agencyName: 'Gold A&S', expiresAt: iso(now + 12 * D) } };
}
export async function signAgreement() {
  await wait(700);
  return { signed: true, copy: 'copy-demo', copyUntil: iso(now + 30 * 60e3), filed: false };
}
export const copyStatus = async () => { await wait(800); return { ready: true, until: iso(now + 29 * 60e3) }; };
export const copyUrl = () => '#copy';

// ── the CRM ────────────────────────────────────────────────────────────────
const agreement = (id, o) => ({
  id, playerId: 'p1', playerName: 'שחקן מיוצג 1', lang: 'he', state: 'waiting', start: '2026-12-01', end: '2028-11-30', months: 24,
  minor: false, guardianName: '', playerSigns: true, templateVersion: 2, createdAt: iso(now - 3 * D), createdByName: 'לו קורק', agencySigned: true,
  linkExpiresAt: iso(now + 11 * D), linkDays: 14, linksIssued: 1, opens: 0, lastOpenAt: null, lastOpenDevice: null,
  signedAt: null, signedDevice: null, signers: [], filedAt: null, fileName: null, filingTries: 0,
  url: `${location.origin}/dev/app.html?path=/sign/demo`, ...o,
});
const LIST = {
  p1: [
    agreement('w1', { opens: 2, lastOpenAt: iso(now - 5 * H), lastOpenDevice: 'phone' }),
    agreement('s1', { state: 'signed', start: '2024-07-01', end: '2026-06-30', createdAt: iso(now - 520 * D), signedAt: iso(now - 515 * D), signedDevice: 'phone', signers: [{ role: 'player', name: 'שחקן מיוצג 1' }], filedAt: iso(now - 515 * D), fileName: 'agreement.pdf', url: null, templateVersion: 1 }),
  ],
};
const TEMPLATES = noTemplates ? { he: null, en: null } : {
  he: { lang: 'he', text: SAMPLE_HE, version: 2, defaultMonths: 24, maxMonths: 24, agencyName: 'Gold A&S', updatedAt: iso(now - 6 * D), updatedByName: 'לו קורק', versions: [{ version: 2, savedAt: iso(now - 6 * D), savedByName: 'לו קורק' }, { version: 1, savedAt: iso(now - 40 * D), savedByName: 'לו קורק' }] },
  en: { lang: 'en', text: SAMPLE_EN, version: 1, defaultMonths: 24, maxMonths: 24, agencyName: 'Gold A&S', updatedAt: iso(now - 40 * D), updatedByName: 'לו קורק', versions: [{ version: 1, savedAt: iso(now - 40 * D), savedByName: 'לו קורק' }] },
};
const brief = (t) => (t ? { version: t.version, defaultMonths: t.defaultMonths, maxMonths: t.maxMonths } : null);

export const listAgreements = async (playerId) => { await wait(150); return { agreements: LIST[playerId] || [], canCreate: true, templates: { he: brief(TEMPLATES.he), en: brief(TEMPLATES.en) } }; };
export const createAgreement = async (input) => {
  await wait(500);
  if (!TEMPLATES[input.lang]) throw new Error('There is no representation agreement template yet. Make one in System › Agreements.');
  return { agreement: agreement(`n${Date.now()}`, { start: input.start, linkExpiresAt: iso(now + (input.days || 14) * D), createdAt: iso(now), opens: 0 }), summary: {}, days: input.days || 14 };
};
export const revokeAgreementLink = async (id) => { await wait(200); return { agreement: { id, state: 'revoked', url: null } }; };
export const reissueAgreementLink = async (id) => { await wait(200); return { agreement: { id, state: 'waiting', linkExpiresAt: iso(now + 14 * D), linksIssued: 2, opens: 0 } }; };
export const retryAgreementFiling = async (id) => { await wait(200); return { filed: true, agreement: { id, state: 'signed' } }; };
export const loadAgreementSettings = async () => { await wait(200); return { ...TEMPLATES, signature: noTemplates ? { has: false } : { has: false, name: '', savedAt: null, png: null } }; };
export const saveAgreementTemplate = async (input) => { await wait(300); const v = (TEMPLATES[input.lang]?.version || 0) + 1; return { saved: true, version: v, template: { ...input, version: v, updatedAt: iso(Date.now()), updatedByName: 'לו קורק', versions: [] } }; };
export const saveAgencySignature = async () => { await wait(200); return { saved: true }; };
export const clearAgencySignature = async () => { await wait(200); return { cleared: true }; };
