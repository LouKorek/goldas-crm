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
    title: '{name} | {positions} | {season}',
    description: '{name}\n🌍 {nationality}\n🗓️ {birthDate} ({age})\n📍 {positions}\n📏 {height}\n🦵 {footShort}',
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
// The upload page is not part of the harness; these keep the dependency scan whole.
export const uploadInfo = async () => ({ status: 'awaiting_file', player: 'Noam Barzilay', title: 'Noam Barzilay | LB / CB | 2026/27', privacy: 'public' });
export const openUploadSession = async () => '';
export const uploadFinished = async () => ({ link: 'https://youtu.be/video0' });
export const sendFile = async () => ({ id: 'video0' });
