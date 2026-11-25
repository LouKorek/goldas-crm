// Lou's YouTube channel and Golda's uploads to it.
//
// Two users of this file:
//   System › YouTube (components/admin/YouTubeConnect.jsx): the status of the
//     connection, the one Google "Allow", the style Golda learned.
//   The upload page (/yt/<token>, pages/YouTubeUpload.jsx): a video too big
//     for WhatsApp goes from the phone straight to YouTube. That page has no
//     sign-in; the token in its link is its key. For highlights the page cuts
//     the moments out of the match on the phone (lib/highlights-cut.js) and
//     sends that cut as it is produced (sendStream).
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { callFunctionJson } from 'lib/api';

const listenMeta = (id) => (callback) =>
  onSnapshot(doc(db, 'app_meta', id), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error(`${id} error:`, e); callback({}); });

/** app_meta/youtube: connected, channel, playlistsAllowed, clientReady, managersMayUpload, lastError (no secrets). */
export const listenYouTube = listenMeta('youtube');
/** app_meta/youtubeStyle: style, examples, channelPlaylists, learnedAt, problem. */
export const listenYouTubeStyle = listenMeta('youtubeStyle');

const post = (body) => callFunctionJson('youtube-connect', { method: 'POST', body });
/** The Google consent address; the page navigates there. playlists asks for the wider permission. */
export const startYouTubeConnect = (playlists) => post({ action: 'start', playlists: !!playlists });
/** The Google client the sign-in uses (the server seals the secret). */
export const saveYouTubeClient = (clientId, clientSecret) => post({ action: 'client', clientId, clientSecret });
export const relearnYouTubeStyle = () => post({ action: 'learn' });
export const setManagersMayUpload = (allow) => post({ action: 'managers', allow: !!allow });

// ── the upload page ─────────────────────────────────────────────────────────
async function uploadCall(method, body, token) {
  const res = await fetch(`/.netlify/functions/youtube-upload${method === 'GET' ? `?t=${encodeURIComponent(token)}` : ''}`, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}
/** What this link uploads: { status, player, title, privacy, link }, and for highlights { highlights: { moments: [{ start, end }], total } }. */
export const uploadInfo = (token) => uploadCall('GET', null, token);
/**
 * Opens the upload on YouTube with the agreed details → its address.
 * `file` is what goes up: { size, type }. For highlights `cut` says what the
 * page cut ({ seconds, clips }); the server opens a highlights upload only with it.
 */
export const openUploadSession = (token, file, cut = null) =>
  uploadCall('POST', { t: token, action: 'session', size: file.size, type: file.type || 'video/mp4', ...(cut ? { cut } : {}) }).then((r) => r.uploadUrl);
/** Tells the server the video is on the channel → { link }. */
export const uploadFinished = (token, videoId) => uploadCall('POST', { t: token, action: 'done', videoId });

const CHUNK = 8 * 1024 * 1024;        // a multiple of 256 KB, as YouTube's resumable upload requires
const MAX_FAILS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// YouTube answers a piece with "Range: bytes=0-N": everything up to N arrived.
const nextFrom = (range, fallback) => { const m = /bytes=0-(\d+)/.exec(range || ''); return m ? Number(m[1]) + 1 : fallback; };

function put(url, blob, range, onSent) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Range', range);
    if (onSent) x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => { let r = null; try { r = x.getResponseHeader('Range'); } catch { /* not exposed */ } resolve({ status: x.status, text: x.responseText, range: r }); };
    x.onerror = () => reject(new Error('network'));
    x.onabort = () => reject(new Error('aborted'));
    x.send(blob);
  });
}
const videoOf = (text) => { try { return JSON.parse(text); } catch { return null; } };
const reasonOf = (r) => videoOf(r.text)?.error?.message || `YouTube ${r.status}`;

/**
 * Send `total` bytes to YouTube in pieces. A dropped connection is not the
 * end: the page asks YouTube how much arrived and goes on from there.
 *   source.piece(offset)  the bytes from `offset` on, one piece at most (a Blob or a Uint8Array)
 *   source.floor()        the earliest offset the source can still give
 * onProgress(sentBytes, totalBytes). Resolves with the new video ({ id }).
 */
async function sendPieces(uploadUrl, total, source, onProgress) {
  let offset = 0, fails = 0;
  // After a failure: how much does YouTube hold? (It may even have the whole file.)
  const recover = async () => {
    if (++fails > MAX_FAILS) throw new Error('החיבור נפל יותר מדי פעמים. בדוק את הרשת ונסה שוב.');
    await sleep(Math.min(2000 * fails, 15000));
    try {
      const q = await put(uploadUrl, null, `bytes */${total}`);
      if (q.status === 200 || q.status === 201) return videoOf(q.text);
      if (q.status === 308) offset = nextFrom(q.range, source.floor());
      else if (q.status === 404 || q.status === 410) throw Object.assign(new Error('ההעלאה פגה. פתח את הקישור מחדש ונסה שוב.'), { final: true });
    } catch (e) { if (e.final) throw e; }
    return null;
  };
  for (;;) {
    const from = offset;
    const body = await source.piece(from);
    const end = from + (body.size ?? body.length);
    let r;
    try {
      r = await put(uploadUrl, body, `bytes ${from}-${end - 1}/${total}`, (n) => onProgress(Math.min(from + n, total), total));
    } catch { const v = await recover(); if (v?.id) return v; continue; }
    if (r.status === 200 || r.status === 201) {
      const v = videoOf(r.text);
      if (!v?.id) throw new Error('יוטיוב לא אישר את ההעלאה.');
      onProgress(total, total);
      return v;
    }
    if (r.status === 308) { offset = nextFrom(r.range, end); fails = 0; onProgress(offset, total); continue; }
    if (r.status >= 500) { const v = await recover(); if (v?.id) return v; continue; }
    throw new Error(reasonOf(r));
  }
}

/** Send a file from the phone to YouTube. */
export function sendFile(uploadUrl, file, onProgress = () => {}) {
  const total = file.size;
  return sendPieces(uploadUrl, total, { piece: (from) => file.slice(from, Math.min(from + CHUNK, total)), floor: () => 0 }, onProgress);
}

/**
 * Send bytes that are still being made (the highlights cut) to YouTube.
 * `total` is their exact number, known up front; `stream` is a ReadableStream
 * of Uint8Array that gives them in order, once. Only the piece being sent is
 * kept in memory (8 MB), so after a dropped connection the upload can go on
 * from anywhere inside that piece, but not from before it.
 * A stream that fails (the cut did not come out right) rejects with its error
 * before the last piece is sent, so YouTube never holds a whole video then.
 */
export function sendStream(uploadUrl, total, stream, onProgress = () => {}) {
  const reader = stream.getReader();
  let held = new Uint8Array(0), start = 0, ended = false;
  const piece = async (from) => {
    if (from < start) throw new Error('The upload was cut off and cannot go on from this point. Pick the video again.');   // the page translates it
    const want = Math.min(CHUNK, total - from);
    const parts = [held.subarray(Math.min(from - start, held.length))];
    let have = parts[0].length, skip = Math.max(0, from - start - held.length);
    while (have < want && !ended) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      const fresh = skip ? value.subarray(Math.min(skip, value.length)) : value;
      skip -= value.length - fresh.length;
      if (fresh.length) { parts.push(fresh); have += fresh.length; }
    }
    // One block: the piece, and whatever the last read brought beyond it.
    const all = new Uint8Array(have);
    parts.reduce((at, part) => { all.set(part, at); return at + part.length; }, 0);
    held = all; start = from;
    // The stream ended before the size it promised: the last piece never goes, so YouTube holds no whole video.
    if (have < want) throw new Error('The cut did not come out right, so nothing was uploaded. Pick the video again.');
    return all.subarray(0, want);
  };
  return sendPieces(uploadUrl, total, { piece, floor: () => start }, onProgress)
    .finally(() => reader.cancel().catch(() => {}));
}
