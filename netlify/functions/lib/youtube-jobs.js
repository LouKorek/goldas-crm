// One video on its way to Lou's YouTube channel: youtube_jobs/{id}.
//
//   draft          Golda proposed title / description / privacy; nothing sent
//   awaiting_file  confirmed, the video is too big for WhatsApp: the writer
//                  opens the job's page (/yt/<token>) and picks the file, which
//                  goes from the phone straight to YouTube
//   uploading      confirmed, the server is sending the video it got on
//                  WhatsApp (or from a download link)
//   uploaded       YouTube has it: the record's videoLink already points at it
//   done           the cover is set too (or was not wanted / not possible)
//   failed | cancelled
//
// After the upload the record's videoLink (a player or a prospect) is replaced
// with the new address, the previous one is kept on the job and in the audit
// log, the video is filed in the channel's playlist for that kind of player
// (when Lou gave the permission for playlists), and the writer gets the new
// link and the old one on WhatsApp.
const crypto = require('crypto');
const yt = require('./youtube.js');
const ytAuth = require('./youtube-auth.js');
const ytStyle = require('./youtube-style.js');

const JOBS = 'youtube_jobs';
const PAGE_TTL_MS = 48 * 3600000;
const SERVER_MAX = 400 * 1024 * 1024;        // what a background run sends comfortably
const FINISH_TRIES = 5;                      // each waits up to ~11 minutes for YouTube to process
const OPEN = ['draft', 'awaiting_file', 'uploading'];

const { siteUrl } = require('./site.js');
const pageUrl = (job, env = process.env) => `${siteUrl(env)}/yt/${job.token}`;
const newToken = () => crypto.randomBytes(24).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJob(db, id) {
  const snap = await db.collection(JOBS).doc(String(id)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function jobByToken(db, token, now = Date.now()) {
  if (!/^[a-f0-9]{48}$/.test(token || '')) return null;
  const snap = await db.collection(JOBS).where('token', '==', token).limit(1).get();
  if (snap.empty) return null;
  const job = { id: snap.docs[0].id, ...snap.docs[0].data() };
  if (now - (job.confirmedAt || job.createdAt || 0) > PAGE_TTL_MS) return null;
  return job;
}
const patchJob = (db, id, data) => db.collection(JOBS).doc(String(id)).set({ ...data, updatedAt: Date.now() }, { merge: true });

/** A draft: what would be uploaded, for the writer to approve. */
async function createDraft(db, { record, target, meta, values, source, cover, playlist = null, by }, { now = Date.now() } = {}) {
  // One open draft per writer: a new one replaces the previous.
  const prev = await db.collection(JOBS).where('by.email', '==', by.email || '').get();
  for (const d of prev.docs) if (d.data().status === 'draft') await d.ref.set({ status: 'cancelled', updatedAt: now, note: 'replaced by a newer draft' }, { merge: true });
  const ref = db.collection(JOBS).doc();
  const job = {
    token: newToken(), status: 'draft', createdAt: now, updatedAt: now,
    target,                                   // { collection (as Golda names it), physical, id, name }
    oldLink: record.videoLink || '',
    meta, values, source, cover, playlist, by,
  };
  await ref.set(job);
  return { id: ref.id, ...job };
}

/** The newest open job of this writer (to confirm or cancel without an id). */
async function latestOpen(db, email, statuses = ['draft']) {
  const snap = await db.collection(JOBS).where('by.email', '==', email || '').get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((j) => statuses.includes(j.status));
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows[0] || null;
}

/** Confirmed: either the server uploads (it has the video), or the writer gets the page. */
async function confirm(db, job, { now = Date.now(), env = process.env } = {}) {
  if (job.status !== 'draft') throw new Error(`this upload is already ${job.status}`);
  const server = job.source?.kind === 'whatsapp' || job.source?.kind === 'url';
  const status = server ? 'uploading' : 'awaiting_file';
  await patchJob(db, job.id, { status, confirmedAt: now });
  return { ...job, status, confirmedAt: now, mode: server ? 'server' : 'page', page: server ? null : pageUrl(job, env) };
}

/** The page asks for an upload session: the phone sends the bytes to YouTube itself. */
async function openPageSession(db, job, { size, mimeType }, { env = process.env, fetchImpl = fetch, origin = null } = {}) {
  if (job.status !== 'awaiting_file') throw new Error(job.status === 'uploaded' || job.status === 'done' ? 'this video was already uploaded' : 'this upload link is not active');
  const token = await ytAuth.accessToken(db, { env, fetchImpl });
  if (!token) throw new Error('YouTube is not connected');
  const uploadUrl = await yt.startUpload(token, job.meta, { size, mimeType: mimeType || 'video/*', origin: origin || siteUrl(env), fetchImpl });
  await patchJob(db, job.id, { pageSessionAt: Date.now(), fileSize: Number(size) || 0, fileType: mimeType || '' });
  return uploadUrl;
}

/** Replace the record's video link with the new one; keeps and returns the old one. */
async function swapVideoLink(db, admin, job, videoId) {
  const FieldValue = admin.firestore.FieldValue;
  const ref = db.collection(job.target.physical).doc(job.target.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().deletedAt) return { swapped: false, reason: 'the record no longer exists' };
  const before = snap.data().videoLink || '';
  const after = yt.watchUrl(videoId);
  const who = { email: job.by?.email || '', name: `${job.by?.name || ''} (Golda)`.trim() };
  await ref.update({ videoLink: after, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: who.email, lastEditedByName: who.name });
  await db.collection('audit').add({
    action: 'update', collection: job.target.collection, docId: job.target.id, name: job.target.name || '',
    before: { videoLink: before || null }, after: { videoLink: after }, fields: ['videoLink'],
    by: who.email, byName: who.name, via: 'golda', channel: job.by?.channel || 'whatsapp', actor: 'golda', onBehalfOf: job.by?.email || '',
    sender: job.by?.name || '', phone: job.by?.phone || '', at: FieldValue.serverTimestamp(), undone: false, note: 'YouTube upload',
  });
  return { swapped: true, before, after };
}

/** File the video in its playlist. Never fails the upload: says what happened. */
async function fileInPlaylist(db, job, videoId, { token, fetchImpl = fetch }) {
  if (!job.playlist?.id) return { added: false };
  const pub = await ytAuth.publicStatus(db);
  if (!pub.playlistsAllowed) return { added: false, title: job.playlist.title, reason: 'no permission' };
  try {
    await yt.addToPlaylist(token, job.playlist.id, videoId, { fetchImpl });
    return { added: true, title: job.playlist.title };
  } catch (e) {
    console.warn('[youtube] playlist:', e.message);
    return { added: false, title: job.playlist.title, reason: String(e.message).slice(0, 160) };
  }
}

function uploadedText(job, link, swap, list = null) {
  const lines = [`✅ הסרטון של ${job.target.name} עלה ליוטיוב:`, link];
  if (list?.added) lines.push(`נמצא בפלייליסט "${list.title}".`);
  else if (list?.title) lines.push(`לפלייליסט "${list.title}" לא הוספתי אותו${list.reason === 'no permission' ? ' (אין לי הרשאה לפלייליסטים)' : ''}; אפשר להוסיף ביוטיוב.`);
  if (swap.swapped) {
    lines.push('', 'החלפתי את קישור הווידאו שלו במערכת לקישור החדש.');
    if (swap.before && swap.before !== link) lines.push(`הקישור הקודם: ${swap.before}`);
  } else lines.push('', `לא עדכנתי את קישור הווידאו במערכת (${swap.reason}).`);
  if (job.cover?.mode !== 'none') lines.push('', 'את הקאבר אשים ברגע שיוטיוב יסיים לעבד את הסרטון.');
  return lines.join('\n');
}

/** YouTube has the video: point the record at it and tell the writer. */
async function afterUpload(db, job, videoId, { admin, notify, token = null, fetchImpl = fetch, now = Date.now() }) {
  const swap = await swapVideoLink(db, admin, job, videoId);
  const link = yt.watchUrl(videoId);
  await patchJob(db, job.id, { status: 'uploaded', videoId, videoUrl: link, uploadedAt: now, swapped: swap.swapped, oldLink: swap.before ?? job.oldLink ?? '' });
  const list = token ? await fileInPlaylist(db, job, videoId, { token, fetchImpl }) : { added: false, title: job.playlist?.title, reason: job.playlist?.id ? 'no token' : undefined };
  if (job.playlist?.id) await patchJob(db, job.id, { playlistAdded: !!list.added, ...(list.reason ? { playlistError: list.reason } : {}) });
  if (notify) await notify(job, uploadedText(job, link, swap, list)).catch((e) => console.warn('[youtube] notify failed:', e.message));
  return { link, swap, list };
}

/** The server sends the video it holds (a WhatsApp file or a download link). */
async function runServerUpload(db, job, { admin, wa, notify, env = process.env, fetchImpl = fetch }) {
  try {
    const token = await ytAuth.accessToken(db, { env, fetchImpl });
    if (!token) throw new Error('YouTube is not connected');
    let body, size = 0, mimeType = 'video/*';
    if (job.source.kind === 'whatsapp') {
      const m = await wa.downloadMedia(job.source.mediaId, job.source.phoneId || null);
      body = m.buffer; size = m.buffer.length; mimeType = /^video\//.test(m.mimeType) ? m.mimeType : (job.source.mimeType || 'video/mp4');
    } else {
      const res = await fetchImpl(job.source.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`the link answered ${res.status}`);
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (/^text\/html/.test(type)) throw new Error('the link opens a web page, not the video file itself');
      size = Number(res.headers.get('content-length')) || 0;
      if (size > SERVER_MAX) throw new Error('the file behind the link is too big for me to pass on; use the upload page');
      if (/^video\//.test(type)) mimeType = type;
      body = res.body;
    }
    const uploadUrl = await yt.startUpload(token, job.meta, { size, mimeType, fetchImpl });
    const video = await yt.sendChunks(uploadUrl, body, { fetchImpl });
    await afterUpload(db, job, video.id, { admin, notify, token, fetchImpl });
    return { videoId: video.id };
  } catch (e) {
    await patchJob(db, job.id, { status: 'failed', error: String(e.message).slice(0, 300) });
    if (notify) await notify(job, `לא הצלחתי להעלות את הסרטון של ${job.target.name} ליוטיוב: ${reasonHe(e)}`).catch(() => {});
    throw e;
  }
}

function reasonHe(e) {
  const m = String(e.message || e);
  if (e.reason === 'quotaExceeded' || /quota/i.test(m)) return 'נגמרה מכסת ההעלאות היומית של יוטיוב. ננסה שוב מחר.';
  if (e.reason === 'uploadLimitExceeded') return 'הערוץ הגיע למגבלת ההעלאות של יוטיוב להיום.';
  if (/not connected|invalid_grant/i.test(m)) return 'החיבור ליוטיוב לא פעיל. צריך לחבר מחדש במסך מערכת › יוטיוב.';
  if (/web page/.test(m)) return 'הקישור פותח דף ולא את קובץ הסרטון עצמו.';
  if (/too big/.test(m)) return 'הקובץ גדול מדי להעברה דרכי. אפשר להעלות אותו בדף ההעלאה.';
  return m.slice(0, 160);
}

/**
 * After YouTube processed the video: set the cover. Returns
 * { done } or { again: true } when YouTube is still working on it.
 */
async function finish(db, job, { wa, notify, env = process.env, fetchImpl = fetch, waitMs = 11 * 60000, pollMs = 20000, frameTries = 6, render = null }) {
  if (job.status !== 'uploaded') return { done: true, skipped: `status ${job.status}` };
  const mode = job.cover?.mode || 'none';
  if (mode === 'none') { await patchJob(db, job.id, { status: 'done', coverSet: false }); return { done: true }; }
  const token = await ytAuth.accessToken(db, { env, fetchImpl });
  if (!token) { await patchJob(db, job.id, { status: 'done', coverSet: false, coverError: 'YouTube is not connected' }); return { done: true }; }
  try {
    let cover = null;
    if (mode === 'image' && job.cover.mediaId) {
      const m = await wa.downloadMedia(job.cover.mediaId, job.cover.phoneId || null);
      cover = { bytes: m.buffer, type: m.mimeType };
    }
    if (mode === 'style' || (mode === 'image' && cover && job.cover.withText)) {
      let frame = cover;
      if (!frame) {
        // The frame YouTube picked exists only once the video is processed.
        const until = Date.now() + waitMs;
        let unread = 0;
        for (;;) {
          const v = await yt.getVideo(token, job.videoId, { fetchImpl });
          const st = v?.status?.uploadStatus;
          if (st === 'failed' || st === 'rejected' || st === 'deleted') throw new Error(`YouTube ${st} the video`);
          if (st === 'processed') {
            frame = await yt.autoCover(job.videoId, { fetchImpl, video: v });
            // Processed, and still no frame to read: the cover goes up without a photo rather than never.
            if (!frame && ++unread >= frameTries) frame = { bytes: null };
            if (frame) break;
          }
          if (Date.now() + pollMs > until) return { again: true };
          await sleep(pollMs);
        }
      }
      const draw = render || require('./youtube-thumb.js').renderCover;
      const style = (await ytStyle.getStyle(db))?.style;
      cover = await draw({ background: frame.bytes, spec: job.cover.spec || style?.thumbnail, values: job.values || {}, fetchImpl, env });
    }
    if (!cover) throw new Error('no cover image');
    if (cover.bytes.length > yt.THUMB_MAX || !/^image\/(jpeg|png)$/.test(cover.type)) {
      // An image YouTube would refuse (too heavy, or not JPG/PNG): the same picture as a 1280x720 JPG.
      const thumb = require('./youtube-thumb.js');
      cover = await (render || thumb.renderCover)({ background: cover.bytes, spec: thumb.plainSpec(), values: {}, withLogo: false, fetchImpl, env });
    }
    await yt.setThumbnail(token, job.videoId, cover.bytes, cover.type, { fetchImpl });
    await patchJob(db, job.id, { status: 'done', coverSet: true, coverAt: Date.now() });
    if (notify) await notify(job, `🖼️ הקאבר של הסרטון של ${job.target.name} עלה.`).catch(() => {});
    return { done: true, coverSet: true };
  } catch (e) {
    const forbidden = e.status === 403;
    await patchJob(db, job.id, { status: 'done', coverSet: false, coverError: String(e.message).slice(0, 300) });
    if (notify) {
      await notify(job, forbidden
        ? `הסרטון של ${job.target.name} באוויר, אבל יוטיוב לא נתן לי לשים קאבר: בערוץ צריך לאמת מספר טלפון פעם אחת (youtube.com/verify) כדי להעלות קאברים.`
        : `הסרטון של ${job.target.name} באוויר, אבל את הקאבר לא הצלחתי לשים (${String(e.message).slice(0, 120)}).`).catch(() => {});
    }
    return { done: true, coverSet: false };
  }
}

module.exports = {
  createDraft, getJob, jobByToken, latestOpen, confirm, openPageSession, afterUpload, runServerUpload, finish, swapVideoLink, patchJob, fileInPlaylist,
  pageUrl, reasonHe, uploadedText, JOBS, PAGE_TTL_MS, SERVER_MAX, FINISH_TRIES, OPEN,
};
