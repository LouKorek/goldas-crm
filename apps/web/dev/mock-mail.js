// Harness stand-in for data/mail (vite.harness.config.js).
//   ?gms=connected (default)  a connected mailbox; every record shows a few threads
//   ?gms=empty                connected, but nothing kept with the record
//   ?gms=new                  not connected (the Google client is ?yts=ready / connected)
//   ?gms=noaddr               connected, but no contact or club has an address yet
//   ?gms=api                  the Gmail API is off on the Google project
const state = new URLSearchParams(location.search).get('gms') || 'connected';
const H = 36e5;
const now = Date.now();
const ADDRESS = 'lou@goldas.co.il';
const LOU = { name: 'Lou Korek', email: ADDRESS };
const SD = { name: 'איש קשר 0', email: 'sd@maccabi-haifa.co.il' };
const CEO = { name: '', email: 'ceo@maccabi-haifa.co.il' };

const PUBLIC = {
  connected: { connected: true, address: ADDRESS, connectedAt: now - 9 * 24 * H, connectedBy: 'lou@example.com', state: 'ok', lastSyncAt: now - 0.2 * H, linkedCount: 37, book: { emails: 2, domains: 3 }, api: { state: 'on' } },
  new: { connected: false },
  noaddr: { connected: true, address: ADDRESS, connectedAt: now - 2 * H, connectedBy: 'lou@example.com', state: 'no_addresses', lastSyncAt: now - 0.1 * H, linkedCount: 0, book: { emails: 0, domains: 0 } },
  api: { connected: true, address: null, connectedAt: now - H, connectedBy: 'lou@example.com', state: 'needs_api', api: { state: 'off', message: 'Permission denied to enable service [gmail.googleapis.com]' }, lastError: { at: now, message: 'The Gmail API is off on the Google project' } },
};
PUBLIC.empty = PUBLIC.connected;

const msg = (id, threadId, hoursAgo, out, from, to, subject, snippet, extra = {}) => ({
  id, threadId, at: now - hoursAgo * H, direction: out ? 'out' : 'in', from, to, cc: [], subject, snippet,
  hasAttachments: !!(extra.attachments || []).length, attachments: [], dealIds: [], clubIds: ['club0'], contactIds: ['k0'], corrected: false, ...extra,
});
const THREADS = [
  { threadId: 't1', subject: 'Re: שחקן מיוצג 2 — הצעה מעודכנת', messages: [
    msg('m3', 't1', 3, false, SD, [LOU], 'Re: שחקן מיוצג 2 — הצעה מעודכנת', 'שלום לו, קיבלנו את ההצעה. המאמן רוצה לראות עוד שני משחקים לפני שנחזור עם תשובה סופית לגבי השכר והאופציה לשנה נוספת.', { dealIds: ['d8'] }),
    msg('m2', 't1', 27, true, LOU, [SD, CEO], 'Re: שחקן מיוצג 2 — הצעה מעודכנת', 'מצרף את הקליפ המעודכן ואת הפרטים שביקשתם. נשמח לסגור עד סוף החודש.', { dealIds: ['d8'], attachments: ['highlights-2026.mp4', 'cv.pdf'] }),
    msg('m1', 't1', 50, false, CEO, [LOU], 'שחקן מיוצג 2 — הצעה', 'Following our call, please find attached our first offer for the player.', { dealIds: ['d8'], attachments: ['offer.pdf'], corrected: true }),
  ] },
  { threadId: 't2', subject: 'Scouting list January window', messages: [
    msg('m4', 't2', 80, true, LOU, [SD], 'Scouting list January window', 'Hi, here are the three goalkeepers we spoke about. All three are available on loan in January.'),
  ] },
  { threadId: 't3', subject: '', messages: [
    msg('m5', 't3', 200, false, SD, [LOU], '', 'Thanks, received.'),
  ] },
];
const thread = (th) => ({ ...th, lastAt: th.messages[0].at, count: th.messages.length,
  people: [...new Set(th.messages.flatMap((m) => [m.from, ...m.to]).filter((p) => p.email !== ADDRESS).map((p) => p.name || p.email))] });

export const listenGmail = (cb) => { setTimeout(() => cb(PUBLIC[state] || PUBLIC.connected), 50); return () => {}; };
export const fetchRecordMail = async (kind) => {
  await new Promise((r) => setTimeout(r, 300));
  const pub = PUBLIC[state] || PUBLIC.connected;
  if (!pub.connected) return { connected: false, address: null, threads: [] };
  if (state === 'empty' || state === 'noaddr') return { connected: true, address: ADDRESS, threads: [] };
  // As the server does: mail on a deal only for an admin (?role=manager drops it).
  const admin = (new URLSearchParams(location.search).get('role') || 'admin') === 'admin';
  const list = (kind === 'deal' ? THREADS.slice(0, 1) : THREADS)
    .map((th) => ({ ...th, messages: th.messages.filter((m) => admin || !m.dealIds.length) })).filter((th) => th.messages.length);
  return { connected: true, address: ADDRESS, threads: list.map(thread) };
};
export const setMailDeals = async () => ({});
export const hideMail = async () => ({});
export const resetMail = async () => ({});
export const startGmailConnect = async () => ({ url: location.href });
export const syncGmailNow = async () => ({ started: true });
export const disconnectGmail = async () => ({});
export const gmailThreadUrl = (address, threadId) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(address || '')}#all/${threadId}`;
