// Harness stand-in for data/youtube: ?yts=connected shows a connected channel
// with a learned style, ?yts=ready a saved Google client waiting for the
// "Allow", anything else the first-time screen.
const state = new URLSearchParams(location.search).get('yts') || 'new';
const cover = (label, tone) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${tone}"/><text x="160" y="98" font-family="sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`)}`;
const PUBLIC = {
  new: {},
  ready: { clientReady: true },
  connected: { clientReady: true, connected: true, connectedAt: Date.now() - 3 * 864e5, connectedBy: 'lou@example.com', playlistsAllowed: true, managersMayUpload: false, channel: { id: 'UCx', title: 'LOUPI (Lou Korek)' } },
  broken: { clientReady: true, connected: false, lastError: { at: Date.now(), message: 'Google withdrew the permission; connect YouTube again' } },
};
const STYLE = {
  learnedAt: Date.now() - 3 * 864e5, fromVideos: 7, playerVideos: 4,
  style: {
    summaryHe: 'כותרת בתבנית "שם | עמדות | עונה". תיאור קצר בשורות עם אימוג\'י: אזרחות, תאריך לידה, עמדות, גובה ורגל. כל הסרטונים ציבוריים ונכנסים לפלייליסט Men\'s Football. הקאבר: תמונת השחקן עם השם בגדול ושורות פרטים.',
    title: { template: '{name} | {positions} | {season}', notes: '' },
    description: { template: '{name}\n🌍 {nationality}\n🗓️ {birthDate} ({age})\n📍 {positions}\n📏 {height}\n🦵 {footShort}', notes: '' },
    privacy: 'public', playlists: [{ id: 'PL1', title: "Men's Football", for: 'men' }],
  },
  examples: [['Noam Barzilay | LB / CB | 2025/26', '#12573f'], ['Alon Milwidsky | GK | 2025', '#3b4a6b'], ['Asia Dercksen | CB / DM | 2025', '#6b3b4a']].map(([title, tone], i) => ({ id: `video${i}`, title, cover: cover(title.split(' | ')[0], tone) })),
};
export const listenYouTube = (cb) => { setTimeout(() => cb(PUBLIC[state] || {}), 50); return () => {}; };
export const listenYouTubeStyle = (cb) => { setTimeout(() => cb(state === 'connected' ? STYLE : {}), 50); return () => {}; };
export const startYouTubeConnect = async () => ({ url: location.href });
export const saveYouTubeClient = async () => ({ clientReady: true });
export const relearnYouTubeStyle = async () => ({ started: true });
export const setManagersMayUpload = async () => ({});
// The upload page: ?path=/yt/<anything> shows it on its own (dev/app.jsx).
//   ?yt=plain (default)   an ordinary upload of one video
//   ?yt=highlights        a highlights job with three moments; ?yt=highlights30 with thirty
//   ?yt=done              already uploaded          ?yt=gone   a link that is no longer good
//   ?hold=reading|cutting|sending   stops at that step, so it can be looked at
//   ?cut=real             cuts the picked file for real (lib/highlights-cut.js) instead of acting it;
//                         ?cut=fail shows a file that cannot be cut
// Nothing is sent anywhere: the upload itself is acted out.
const q = new URLSearchParams(location.search);
const yt = q.get('yt') || 'plain';
export const hold = q.get('hold') || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const forever = () => new Promise(() => {});
const THREE = [{ start: 750, end: 770 }, { start: 2650, end: 2680 }, { start: 4259, end: 4277 }];
const THIRTY = Array.from({ length: 30 }, (_, i) => ({ start: 120 + i * 175, end: 120 + i * 175 + 20 + (i % 3) * 5 }));
const moments = yt === 'highlights30' ? THIRTY : THREE;
export const uploadInfo = async () => {
  await wait(150);
  if (yt === 'gone') throw Object.assign(new Error('הקישור הזה כבר לא בתוקף. בקש מגולדה קישור חדש.'), { status: 404 });
  return {
    status: yt === 'done' ? 'done' : 'awaiting_file', player: 'Noam Barzilay', title: 'Noam Barzilay | LB / CB | 2026/27', privacy: 'public',
    link: yt === 'done' ? 'https://youtu.be/video0' : null,
    ...(yt.startsWith('highlights') ? { highlights: { moments, total: moments.reduce((n, m) => n + m.end - m.start, 0) } } : {}),
  };
};
export const openUploadSession = async () => '';
export const uploadFinished = async () => ({ link: 'https://youtu.be/video0' });
async function act(total, onProgress) {
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await wait(120);
    onProgress(Math.round((total * i) / steps), total);
    if (hold === 'sending' && i === 14) await forever();
  }
  return { id: 'video0' };
}
export const sendFile = (url, file, onProgress = () => {}) => act(file.size, onProgress);
export const sendStream = async (url, total, stream, onProgress = () => {}) => {
  // Read what the cut gives (a real cut is made in full), then act the upload.
  const reader = stream.getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; }
  return act(total, onProgress);
};
