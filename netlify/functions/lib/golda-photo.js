// Golda's WhatsApp profile photo. Lou picked it on 2026-11-05 (a realistic
// portrait in the agency lounge, Gold A&S emblem on her jacket).
//
// WhatsApp wants a JPG/PNG of at most 5 MB, ideally 640x640. The original is a
// 2k PNG, so it is fetched through Netlify's image CDN on our own site, which
// returns a 640x640 JPG (netlify.toml allows that one remote host); the
// original is the fallback. Setting it takes three Graph calls:
//   1. open an upload session on our app;
//   2. send the bytes → a file handle;
//   3. put that handle on the number's business profile.
// The photo can only go on a number that is registered for the Cloud API.

const GRAPH = 'https://graph.facebook.com/v21.0';
const PHOTO_URL = 'https://d8j0ntlcm91z4.cloudfront.net/user_3DRaorqH8vqBamy1xjWWdw6rSN5/hf_20261105_104510_e87c770c-4446-4eb2-919e-723790edd1c3.png';
const MAX_BYTES = 5 * 1024 * 1024;

function sources(env = process.env, url = PHOTO_URL) {
  const site = env.URL || '';
  const viaCdn = site ? `${site}/.netlify/images?url=${encodeURIComponent(url)}&w=640&h=640&fit=cover&fm=jpg&q=88` : null;
  return [viaCdn, url].filter(Boolean);
}

async function loadImage({ fetchImpl = fetch, env = process.env, url = PHOTO_URL } = {}) {
  const tried = [];
  for (const src of sources(env, url)) {
    try {
      const res = await fetchImpl(src);
      const type = String(res.headers?.get?.('content-type') || '').split(';')[0].trim();
      if (!res.ok || !/^image\/(jpeg|png)$/.test(type)) { tried.push(`${res.status} ${type || '?'}`); continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES) { tried.push(`size ${bytes.length}`); continue; }
      return { bytes, type };
    } catch (e) { tried.push(String(e.message).slice(0, 80)); }
  }
  throw new Error(`photo not reachable (${tried.join('; ')})`);
}

async function graphJson(res) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(String(e.error_user_msg || e.message || `HTTP ${res.status}`).slice(0, 200));
    err.code = e.code || res.status;
    throw err;
  }
  return json;
}

/**
 * Puts the photo on one number. Returns { ok, at, url } or { ok: false, at, url, error }.
 * Never throws.
 */
async function setPhoto(token, phoneId, { appId, fetchImpl = fetch, env = process.env, now = Date.now(), url = PHOTO_URL } = {}) {
  try {
    const { bytes, type } = await loadImage({ fetchImpl, env, url });
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const q = new URLSearchParams({ file_name: `golda.${ext}`, file_length: String(bytes.length), file_type: type });
    const session = await graphJson(await fetchImpl(`${GRAPH}/${appId}/uploads?${q}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    }));
    if (!session.id) throw new Error('no upload session');
    const up = await graphJson(await fetchImpl(`${GRAPH}/${session.id}`, {
      method: 'POST', headers: { authorization: `OAuth ${token}`, file_offset: '0', 'content-type': type }, body: bytes,
    }));
    if (!up.h) throw new Error('no file handle');
    await graphJson(await fetchImpl(`${GRAPH}/${phoneId}/whatsapp_business_profile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: up.h }),
    }));
    return { ok: true, at: now, url, bytes: bytes.length };
  } catch (e) {
    return { ok: false, at: now, url, error: { code: e.code || null, message: String(e.message).slice(0, 200) } };
  }
}

/** True when this number already shows the current photo. */
const hasPhoto = (photos, phoneId, url = PHOTO_URL) => !!(photos && photos[phoneId]?.ok && photos[phoneId].url === url);

module.exports = { PHOTO_URL, setPhoto, hasPhoto, sources, loadImage };
