// YouTube Data API calls the server makes for Golda, all with an access token
// from lib/youtube-auth.js:
//
//   recentUploads(token, playlist, max)   the channel's latest videos with
//                                         title, description, tags, privacy
//                                         and cover address (to learn the style)
//   startUpload(token, meta, opts)        opens a resumable upload session and
//                                         returns its address; with `origin` the
//                                         browser on that site may send the bytes
//   sendChunks(uploadUrl, chunks)         sends a stream of Buffers in 8 MB
//                                         pieces; returns the new video resource
//   getVideo(token, id)                   status + processing of one video
//   playlists(token)                      the channel's playlists, with which of
//                                         the given videos sit in each
//   addToPlaylist(token, listId, videoId) puts a video in a playlist (needs the
//                                         "manage" permission, not just upload)
//   setThumbnail(token, id, bytes, type)  the cover (≤ 2 MB, JPG or PNG)
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const CHUNK = 8 * 1024 * 1024;               // a multiple of 256 KB, as resumable uploads require
const THUMB_MAX = 2 * 1024 * 1024;

const watchUrl = (id) => `https://youtu.be/${id}`;
const coverUrls = (id) => ['maxresdefault', 'sddefault', 'hqdefault'].map((n) => `https://i.ytimg.com/vi/${id}/${n}.jpg`);

/** The video id in any YouTube address (watch, youtu.be, shorts, embed), or null. */
function videoIdOf(url) {
  const s = String(url || '');
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function api(token, path, { fetchImpl = fetch, method = 'GET', body } = {}) {
  const res = await fetchImpl(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw ytError(res.status, json);
  return json;
}

function ytError(status, json) {
  const reason = json?.error?.errors?.[0]?.reason || '';
  const e = new Error(`YouTube ${status}${reason ? ` ${reason}` : ''}: ${json?.error?.message || ''}`.slice(0, 300));
  e.status = status; e.reason = reason;
  return e;
}

async function recentUploads(token, playlistId, max = 12, { fetchImpl = fetch } = {}) {
  if (!playlistId) return [];
  const list = await api(token, `/playlistItems?part=contentDetails&maxResults=${Math.min(50, max)}&playlistId=${encodeURIComponent(playlistId)}`, { fetchImpl });
  const ids = (list.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const vids = await api(token, `/videos?part=snippet,status,contentDetails&id=${ids.join(',')}`, { fetchImpl });
  return (vids.items || []).map((v) => {
    const th = v.snippet?.thumbnails || {};
    return {
      id: v.id,
      title: v.snippet?.title || '',
      description: v.snippet?.description || '',
      tags: v.snippet?.tags || [],
      categoryId: v.snippet?.categoryId || '',
      language: v.snippet?.defaultLanguage || v.snippet?.defaultAudioLanguage || '',
      publishedAt: v.snippet?.publishedAt || '',
      privacy: v.status?.privacyStatus || '',
      madeForKids: !!v.status?.madeForKids,
      duration: v.contentDetails?.duration || '',
      cover: (th.maxres || th.standard || th.high || th.medium || th.default || {}).url || '',
    };
  });
}

/**
 * Open a resumable upload. meta = { title, description, tags, categoryId,
 * language, privacy, madeForKids }. Returns the session address.
 */
async function startUpload(token, meta, { size = 0, mimeType = 'video/*', origin = null, fetchImpl = fetch } = {}) {
  const resource = {
    snippet: {
      title: String(meta.title || '').slice(0, 100),
      description: String(meta.description || '').slice(0, 5000),
      ...(meta.tags?.length ? { tags: meta.tags.slice(0, 30) } : {}),
      categoryId: String(meta.categoryId || '17'),       // 17 = Sports
      ...(meta.language ? { defaultLanguage: meta.language, defaultAudioLanguage: meta.language } : {}),
    },
    status: {
      privacyStatus: ['public', 'unlisted', 'private'].includes(meta.privacy) ? meta.privacy : 'unlisted',
      selfDeclaredMadeForKids: !!meta.madeForKids,
      embeddable: true,
    },
  };
  const headers = {
    Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'video/*',
    ...(size ? { 'X-Upload-Content-Length': String(size) } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
  const res = await fetchImpl(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, { method: 'POST', headers, body: JSON.stringify(resource) });
  if (!res.ok) throw ytError(res.status, await res.json().catch(() => ({})));
  const loc = res.headers.get('location');
  if (!loc) throw new Error('YouTube opened no upload session');
  return loc;
}

/** Group an async iterable of Buffers into CHUNK-sized Buffers (the last may be smaller). */
async function* rechunk(source, size = CHUNK) {
  let parts = [], have = 0;
  for await (const piece of source) {
    let buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    while (buf.length) {
      const take = Math.min(size - have, buf.length);
      parts.push(buf.subarray(0, take)); have += take; buf = buf.subarray(take);
      if (have === size) { yield Buffer.concat(parts); parts = []; have = 0; }
    }
  }
  if (have) yield Buffer.concat(parts);
}

/**
 * Send the bytes to an upload session. `source` is a Buffer or an async
 * iterable of Buffers (a fetch body). Pieces go one by one, so a large file
 * never sits whole in memory; the total is announced with the last piece.
 */
async function sendChunks(uploadUrl, source, { fetchImpl = fetch, chunkSize = CHUNK } = {}) {
  const iter = Buffer.isBuffer(source) ? (async function* one() { yield source; }()) : source;
  let offset = 0, pending = null, last = null;
  const put = async (buf, isLast) => {
    const end = offset + buf.length - 1;
    const total = isLast ? String(offset + buf.length) : '*';
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetchImpl(uploadUrl, { method: 'PUT', headers: { 'Content-Length': String(buf.length), 'Content-Range': buf.length ? `bytes ${offset}-${end}/${total}` : `bytes */${total}` }, body: buf });
      } catch (e) { if (attempt === 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      if (res.status === 308) { offset += buf.length; return null; }
      if (res.ok) { offset += buf.length; return res.json(); }
      if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw ytError(res.status, await res.json().catch(() => ({})));
    }
    return null;
  };
  for await (const chunk of rechunk(iter, chunkSize)) {
    if (pending) await put(pending, false);
    pending = chunk;
  }
  if (!pending) throw new Error('the video file is empty');
  last = await put(pending, true);
  if (!last?.id) throw new Error('YouTube did not confirm the upload');
  return last;
}

async function getVideo(token, id, { fetchImpl = fetch } = {}) {
  const r = await api(token, `/videos?part=status,processingDetails,snippet&id=${encodeURIComponent(id)}`, { fetchImpl });
  return (r.items || [])[0] || null;
}

async function setThumbnail(token, id, bytes, type = 'image/jpeg', { fetchImpl = fetch } = {}) {
  if (!bytes?.length) throw new Error('empty cover');
  if (bytes.length > THUMB_MAX) throw new Error('the cover is over 2 MB');
  const res = await fetchImpl(`${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(id)}&uploadType=media`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': type, 'Content-Length': String(bytes.length) }, body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw ytError(res.status, json);
  return json;
}

/**
 * The channel's playlists: [{ id, title, count, privacy, videoIds }]. videoIds
 * holds which of `among` (video ids) are in the playlist, read from its first
 * 50 entries; that is how the style learns where the owner files his videos.
 */
async function playlists(token, { among = [], max = 15, fetchImpl = fetch } = {}) {
  const r = await api(token, `/playlists?part=snippet,contentDetails,status&mine=true&maxResults=${Math.min(50, max)}`, { fetchImpl });
  const lists = (r.items || []).map((p) => ({
    id: p.id, title: p.snippet?.title || '', count: Number(p.contentDetails?.itemCount) || 0, privacy: p.status?.privacyStatus || '', videoIds: [],
  }));
  const want = new Set(among);
  if (want.size) {
    await Promise.all(lists.map(async (l) => {
      if (!l.count) return;
      try {
        const items = await api(token, `/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(l.id)}`, { fetchImpl });
        l.videoIds = (items.items || []).map((i) => i.contentDetails?.videoId).filter((id) => want.has(id));
      } catch { /* a playlist that cannot be read teaches nothing */ }
    }));
  }
  return lists;
}

async function addToPlaylist(token, playlistId, videoId, { fetchImpl = fetch } = {}) {
  return api(token, '/playlistItems?part=snippet', {
    fetchImpl, method: 'POST', body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
  });
}

/**
 * The frame YouTube picked for a processed video (the best size there is), or
 * null. A private video's frame is not at the public address: only the
 * addresses YouTube gives the channel's owner (`video.snippet.thumbnails`)
 * open it, so those come first.
 */
async function autoCover(id, { fetchImpl = fetch, video = null } = {}) {
  const own = ['maxres', 'standard', 'high', 'medium'].map((k) => video?.snippet?.thumbnails?.[k]?.url).filter((u) => /^https:\/\/[a-z0-9-]+\.ytimg\.com\//.test(u || ''));
  for (const url of [...new Set([...own, ...coverUrls(id)])]) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 2000) return { bytes, type: 'image/jpeg', url };
    } catch { /* next size */ }
  }
  return null;
}

module.exports = {
  recentUploads, startUpload, sendChunks, rechunk, getVideo, setThumbnail, autoCover, playlists, addToPlaylist,
  watchUrl, videoIdOf, coverUrls, CHUNK, THUMB_MAX, _internal: { ytError },
};
