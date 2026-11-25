// Publishing a change to the agency's website (gold-as.com).
//
// The site is a separate Netlify site with no repository: Lou publishes it
// from his own panel, which talks to a small server of its own ("admin-api")
// that holds the site's Netlify key and lets one Google account in. Golda uses
// the same door, so there is one way to publish and no second key:
//
//   who she is    the CRM's own Google service account. She asks Google for a
//                 signed note saying "this is that account, speaking to the
//                 panel" (an ID token whose audience is the panel's Google
//                 client), and the panel's server checks it with Google the
//                 way it checks Lou's sign-in. It lets her in once her
//                 address is on its list (ALLOWED_SERVICE_EMAIL).
//   how           exactly what the panel does: the list of the site's files
//                 with their fingerprints, the same list with the changed
//                 files' new fingerprints, then only those files are sent.
//                 Every other file (the panel itself included) is carried
//                 over untouched.
//   undo          the list from before a publish is kept, so publishing it
//                 again brings the site back; Netlify still has every file.
//
// The page is always taken fresh from the live site and checked against the
// site's own fingerprint, because Lou may have published from the panel a
// minute ago.
const crypto = require('crypto');
const { applyChanges } = require('./website-html.js');

const ADMIN_API = 'https://gold-as-admin-api.netlify.app/.netlify/functions/admin-api';
const SITE = 'https://gold-as.com';
const INDEX = '/index.html';
const PANEL = '/manage-g7k2x.html';

const sha1 = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serviceAccount(env = process.env) {
  let svc;
  try { svc = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY || ''); } catch { svc = null; }
  if (!svc?.client_email || !svc?.private_key) throw new Error('the server has no Google service account');
  return svc;
}
/** The address Golda is known by at the panel's server (not a secret). */
const serviceEmail = (env = process.env) => serviceAccount(env).client_email;

/** Ask Google for the signed note (lasts an hour). */
async function mintWithGoogle(audience, env = process.env) {
  const { JWT } = require('google-auth-library');
  const svc = serviceAccount(env);
  return new JWT({ email: svc.client_email, key: svc.private_key }).fetchIdToken(audience);
}

const WHY = {
  'email not allowed': "Lou's website panel does not know Golda yet: its server has to be given her address once",
  'wrong audience': "Lou's website panel was moved to another Google client, so Golda's pass no longer fits",
  'token expired': 'the pass to the website panel ran out',
};

/**
 * The website, as Golda reaches it.
 *   mint(audience) → the signed note; fetchImpl / wait are replaced in tests.
 */
function siteClient({ fetchImpl = fetch, env = process.env, mint = (aud) => mintWithGoogle(aud, env), wait = sleep, now = () => Date.now() } = {}) {
  const api = (env.WEBSITE_ADMIN_API || ADMIN_API).replace(/\/$/, '');
  const site = (env.WEBSITE_URL || SITE).replace(/\/$/, '');
  let token = null;

  async function pass() {
    if (token && token.until > now()) return token.value;
    const res = await fetchImpl(`${api}?action=config`);
    const cfg = res.ok ? await res.json().catch(() => ({})) : {};
    if (!cfg.google_client_id) throw new Error("the website panel's server did not answer");
    token = { value: await mint(cfg.google_client_id), until: now() + 45 * 60 * 1000 };
    return token.value;
  }

  async function call(action, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${api}?action=${action}`, {
      method, headers: { authorization: `Bearer ${await pass()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { token = null; const e = new Error(WHY[data.why] || `the website panel's server refused (${data.why || 'no reason given'})`); e.code = 'refused'; e.why = data.why || ''; throw e; }
    if (!res.ok) throw new Error(`the website panel's server answered ${res.status}${data.error ? `: ${data.error}` : ''}${data.status ? ` (Netlify ${data.status})` : ''}`);
    return data;
  }

  /** { '/index.html': fingerprint, … } of the live site. */
  async function files() {
    const out = {};
    for (const f of (await call('files')).files || []) out[f.path] = f.sha;
    if (!out[INDEX]) throw new Error('the website has no page');
    return out;
  }

  /** The live page, proven to be the one the site is serving now. */
  async function page(known) {
    const list = known || await files();
    for (let i = 0; i < 4; i++) {
      const res = await fetchImpl(`${site}${INDEX}?nocache=${now()}${i}`, { headers: { 'cache-control': 'no-cache' } });
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (sha1(bytes) === list[INDEX]) return { html: bytes.toString('utf8'), files: list };
      }
      await wait(1500);
    }
    throw new Error('the website is in the middle of another publish; try again in a minute');
  }

  /** Reading needs no pass: the page is public. */
  async function publicPage() {
    const res = await fetchImpl(`${site}${INDEX}?nocache=${now()}`, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`the website did not answer (${res.status})`);
    return Buffer.from(await res.arrayBuffer()).toString('utf8');
  }

  /** Send a list of files as the new site and wait until it is live. */
  async function deploy(manifest, contents = new Map()) {
    if (!manifest[INDEX]) throw new Error('a publish without the page was stopped');
    const dep = await call('deploy', { method: 'POST', body: { files: manifest } });
    const need = dep.required || [];
    const missing = need.filter((sha) => !contents.has(sha));
    if (missing.length) throw new Error('the website no longer has some of the files of that version, so it cannot be brought back from here');
    for (const sha of need) {
      const f = contents.get(sha);
      await call('upload', { method: 'POST', body: { deploy_id: dep.deploy_id, path: f.path, content_b64: f.bytes.toString('base64') } });
    }
    for (let i = 0; i < 45; i++) {
      await wait(2000);
      const s = await call(`status&deploy_id=${encodeURIComponent(dep.deploy_id)}`);
      if (s.state === 'ready') return { deployId: dep.deploy_id, uploaded: need.length };
      if (s.state === 'error') throw new Error('Netlify could not publish this version; the site stays as it was');
    }
    throw new Error('the publish is taking too long; the site may update in a few minutes');
  }

  /**
   * Publish a list of changes (lib/website-html.js) with the photos they need.
   *   photos: Map(path → Buffer) for every new or replaced player photo
   */
  async function publish({ changes, photos = new Map() }) {
    const before = await files();
    const live = await page(before);
    const r = applyChanges(live.html, changes);
    const manifest = { ...before };
    const contents = new Map();
    const put = (path, bytes) => { const sha = sha1(bytes); manifest[path] = sha; contents.set(sha, { path, bytes }); };
    for (const path of r.removedPhotoPaths) if (/^\/player-[a-z0-9-]+\.jpg$/.test(path)) delete manifest[path];
    for (const path of r.newPhotoPaths) {
      const bytes = photos.get(path);
      if (!bytes) throw new Error(`the photo ${path} is missing from the draft`);
      put(path, bytes);
    }
    put(INDEX, Buffer.from(r.html, 'utf8'));
    // Nothing but the page and player photos may differ, and the panel stays.
    for (const p of new Set([...Object.keys(before), ...Object.keys(manifest)])) {
      if (before[p] !== manifest[p] && p !== INDEX && !/^\/player-[a-z0-9-]+\.jpg$/.test(p)) throw new Error(`the publish would have changed ${p}; stopped`);
    }
    if (before[PANEL] && manifest[PANEL] !== before[PANEL]) throw new Error("the publish would have removed Lou's panel; stopped");
    if (manifest[INDEX] === before[INDEX] && !r.newPhotoPaths.length) throw new Error('nothing would change on the site');
    const done = await deploy(manifest, contents);
    return { ...done, before, after: manifest, summary: r.summary, playerCount: r.playerCount };
  }

  /** Bring back an earlier list of files (the undo of a publish). */
  async function restore(manifest, { expect } = {}) {
    const now_ = await files();
    if (expect && JSON.stringify(sorted(now_)) !== JSON.stringify(sorted(expect))) {
      const e = new Error('the site was published again since then (from the panel), so undoing would throw that away'); e.code = 'moved'; throw e;
    }
    const done = await deploy(manifest);
    return { ...done, before: now_, after: manifest };
  }

  /** Can Golda publish? Never throws. */
  async function check() {
    let email = '';
    try { email = serviceEmail(env); } catch (e) { return { ok: false, serviceEmail: '', why: e.message }; }
    try { const list = await files(); return { ok: true, serviceEmail: email, files: Object.keys(list).length }; }
    catch (e) { return { ok: false, serviceEmail: email, why: e.message, waitingForPanel: e.why === 'email not allowed' }; }
  }

  return { files, page, publicPage, publish, restore, check, deploy };
}

const sorted = (o) => Object.keys(o).sort().map((k) => [k, o[k]]);

module.exports = { siteClient, serviceEmail, sha1, ADMIN_API, SITE, INDEX, PANEL };
