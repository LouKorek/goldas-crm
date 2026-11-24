// Lou's YouTube channel and Golda's uploads to it.
//
// Two users of this file:
//   System › YouTube (components/admin/YouTubeConnect.jsx): the status of the
//     connection, the one Google "Allow", the style Golda learned.
//   The upload page (/yt/<token>, pages/YouTubeUpload.jsx): a video too big
//     for WhatsApp goes from the phone straight to YouTube. That page has no
//     sign-in; the token in its link is its key.
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
/** What this link uploads: { status, player, title, privacy, link }. */
export const uploadInfo = (token) => uploadCall('GET', null, token);
/** Opens the upload on YouTube with the agreed details → its address. */
export const openUploadSession = (token, file) =>
  uploadCall('POST', { t: token, action: 'session', size: file.size, type: file.type || 'video/mp4' }).then((r) => r.uploadUrl);
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
 * Send the file to YouTube in pieces. A dropped connection is not the end:
 * the page asks YouTube how much arrived and goes on from there.
 * onProgress(sentBytes, totalBytes). Resolves with the new video ({ id }).
 */
export async function sendFile(uploadUrl, file, onProgress = () => {}) {
  const total = file.size;
  let offset = 0, fails = 0;
  // After a failure: how much does YouTube hold? (It may even have the whole file.)
  const recover = async () => {
    if (++fails > MAX_FAILS) throw new Error('החיבור נפל יותר מדי פעמים. בדוק את הרשת ונסה שוב.');
    await sleep(Math.min(2000 * fails, 15000));
    try {
      const q = await put(uploadUrl, null, `bytes */${total}`);
      if (q.status === 200 || q.status === 201) return videoOf(q.text);
      if (q.status === 308) offset = nextFrom(q.range, 0);
      else if (q.status === 404 || q.status === 410) throw Object.assign(new Error('ההעלאה פגה. פתח את הקישור מחדש ונסה שוב.'), { final: true });
    } catch (e) { if (e.final) throw e; }
    return null;
  };
  for (;;) {
    const end = Math.min(offset + CHUNK, total);
    let r;
    try {
      const from = offset;
      r = await put(uploadUrl, file.slice(from, end), `bytes ${from}-${end - 1}/${total}`, (n) => onProgress(Math.min(from + n, total), total));
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
