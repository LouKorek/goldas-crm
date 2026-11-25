// Lou's one Google "Allow" that lets the server upload to his YouTube channel
// (lib/youtube-auth.js), and the status of that connection.
//
//   POST { action: 'start', playlists? } (admin)
//                                      → { url }: the Google consent screen;
//                                      playlists=true also asks for the wider
//                                      permission that files videos in playlists
//   POST { action: 'client', clientId, clientSecret } (admin)
//                                      saves the Google OAuth client (sealed)
//   POST { action: 'learn' } (admin)   → re-reads the channel's style
//   POST { action: 'managers', allow } (admin)
//                                      whether managers too may ask Golda to upload
//   GET  ?code=…&state=…               Google's redirect back: stores the key,
//                                      starts learning the channel's style,
//                                      sends the browser to /admin/youtube?yt=ok|error
//   GET  ?status=1 (admin, or the      → the public status (no secrets)
//        x-sync-secret header)
//
// The Google client has one return address registered for the site, this
// one, so the Gmail connection (lib/gmail-auth.js) comes back here too: its
// state starts "gmail-", and such a return is finished by the Gmail code and
// sends the browser to /admin/mail?gm=ok|error instead.
const { withAuth, json, internalHeaders } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const ytAuth = require('./lib/youtube-auth.js');
const { originOf } = require('./lib/site.js');
const gmailAuth = require('./lib/gmail-auth.js');

// Everything stays on the address the request came to: the site, or a preview of it.
const back = (event, result, msg) => ({
  statusCode: 302,
  headers: { Location: `${originOf(event)}/admin/youtube?yt=${result}${msg ? `&reason=${encodeURIComponent(String(msg).slice(0, 160))}` : ''}`, 'Cache-Control': 'no-store' },
  body: '',
});

async function kickLearn(event) {
  try {
    await fetch(`${originOf(event)}/.netlify/functions/youtube-upload-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('youtube-learn')) },
      body: JSON.stringify({ phase: 'learn' }),
    });
  } catch (e) { console.warn('[youtube-connect] could not start learning the style:', e.message); }
}

const status = withAuth({ action: 'manage_settings', secrets: [{ header: 'x-sync-secret', env: 'CRM_SYNC_SECRET' }] }, async (event) => {
  const db = getDb();
  const d = await ytAuth.publicStatus(db);
  return json(200, { redirectUri: ytAuth.redirectUri(originOf(event)), clientReady: !!(await ytAuth.client(db)), ...d });
});

const post = withAuth({ action: 'manage_settings' }, async (event, ctx) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* none */ }
  const db = getDb();
  try {
    if (body.action === 'client') return json(200, await ytAuth.setClient(db, body));
    if (body.action === 'learn') { await kickLearn(event); return json(200, { started: true }); }
    if (body.action === 'managers') { await ytAuth.savePublic(db, { managersMayUpload: !!body.allow }); return json(200, { managersMayUpload: !!body.allow }); }
    return json(200, { url: await ytAuth.startUrl(db, ctx.auth.user.email, { origin: originOf(event), playlists: !!body.playlists }) });
  } catch (e) { return json(/not set up/.test(e.message) ? 503 : 400, { error: e.message }); }
});

// ── the Gmail return ────────────────────────────────────────────────────────
const backToMail = (event, result, msg) => ({
  statusCode: 302,
  headers: { Location: `${originOf(event)}/admin/mail?gm=${result}${msg ? `&reason=${encodeURIComponent(String(msg).slice(0, 160))}` : ''}`, 'Cache-Control': 'no-store' },
  body: '',
});

async function gmailReturn(event, q) {
  const db = getDb();
  if (q.error) {
    await gmailAuth.takeState(db, q.state).catch(() => null);
    return backToMail(event, 'error', q.error === 'access_denied' ? 'the permission was not given' : q.error);
  }
  try {
    await gmailAuth.finish(db, { code: q.code, state: q.state }, { enable: () => gmailAuth.enableGmailApi(gmailAuth.serviceAccount()) });
    console.log('[youtube-connect] the Gmail mailbox is connected');
    try {
      await fetch(`${originOf(event)}/.netlify/functions/gmail-sync-background`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('gmail-first-sync')) }, body: JSON.stringify({ reason: 'connected' }),
      });
    } catch (e) { console.warn('[youtube-connect] could not start the first mail sync:', e.message); }
    return backToMail(event, 'ok');
  } catch (e) {
    console.error('[youtube-connect] Gmail sign-in failed:', e.message);
    await gmailAuth.savePublic(db, { lastError: { at: Date.now(), message: String(e.message).slice(0, 240) } }).catch(() => {});
    return backToMail(event, 'error', e.message);
  }
}

exports.handler = async (event, context) => {
  const q = event.queryStringParameters || {};
  if (event.httpMethod === 'POST') return post(event, context);
  if (q.status) return status(event, context);
  if (gmailAuth.isGmailState(q.state)) return gmailReturn(event, q);
  if (q.error) return back(event, 'error', q.error === 'access_denied' ? 'the permission was not given' : q.error);
  if (q.code || q.state) {
    try {
      const info = await ytAuth.finish(getDb(), { code: q.code, state: q.state });
      console.log('[youtube-connect] connected to channel', info.channel?.id);
      await kickLearn(event);
      return back(event, 'ok');
    } catch (e) {
      console.error('[youtube-connect] sign-in failed:', e.message);
      await ytAuth.savePublic(getDb(), { lastError: { at: Date.now(), message: String(e.message).slice(0, 240) } }).catch(() => {});
      return back(event, 'error', e.message);
    }
  }
  return json(400, { error: 'nothing to do' });
};
