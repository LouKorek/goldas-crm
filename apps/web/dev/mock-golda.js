// Harness stand-in for data/golda: a chat where Golda made an Instagram
// graphic (the picture as a file chip, its ready caption with a copy button)
// for a fixture player. Nothing is sent anywhere.
const now = Date.now();
const later = (cb, v) => { const id = setTimeout(() => cb(v), 120); return () => clearTimeout(id); };
const CAPTION = 'ברכות לנועם ברזילי על החתימה במכבי נתניה!\nמאחלים הצלחה גדולה בהמשך הדרך.\n\n#כדורגל #חתימה\n#GoldAS @goldas_loukorek';
const HISTORY = [
  { role: 'assistant', at: now - 30 * 60e3, text: '*גרפיקה לאינסטגרם, לו?* 🎨\nנועם ברזילי חתם היום במכבי נתניה.\nלהכין לו גרפיקה בצבעי Gold A&S עם כיתוב מוכן? אני רק מכינה, ההעלאה אצלך.', buttons: ['כן, להכין', 'לא הפעם'] },
  { role: 'user', at: now - 28 * 60e3, text: 'כן, להכין' },
  {
    role: 'assistant', id: 'ans1', at: now - 27 * 60e3, text: 'הנה הגרפיקה של נועם, פוסט 1080×1350. הכיתוב מוכן להעתקה.', buttons: ['גם סטורי', 'לשנות טקסט'],
    files: [{ fileId: 'f1', name: 'נועם ברזילי - signing - post.jpg', type: 'image/jpeg', size: 162000, graphic: true, caption: CAPTION }],
  },
  { role: 'user', at: now - 20 * 60e3, text: 'Make one in English for Alexandros Konstantinopoulos-Papadimitriou Junior, he scored a brace against Hapoel Tel Aviv' },
  {
    role: 'assistant', id: 'ans2', at: now - 19 * 60e3, text: 'Here it is, as a post. The caption is ready to copy.', buttons: ['Story too', 'Change text'],
    files: [{ fileId: 'f2', name: 'Alexandros Konstantinopoulos-Papadimitriou Junior - goal - post.jpg', type: 'image/jpeg', size: 171000, graphic: true,
      caption: 'Alexandros Konstantinopoulos-Papadimitriou Junior scored a brace against Hapoel Tel Aviv in the 67th minute!\nFinal score: 2-1 · Premier League\n\n#GoldAS #football #goal\n@goldas_loukorek' }],
  },
];

export const PHYSICAL = { pipeline_men: 'players', pipeline_women: 'players', pipeline_youth: 'players', pipeline_jewish: 'players' };
export const listenGoldaAudit = (cb) => later(cb, []);
export const undoGoldaAction = async () => {};
export const sendToGolda = async () => `app_${now}`;
export const sendGoldaFeedback = async () => ({ ok: true });
export const listenInboxMessage = (_id, cb) => later(cb, null);
export const listenGoldaThread = (_key, cb) => later(cb, HISTORY);
export const sessionKeyFor = (user) => `u_${String(user?.email || 'anon').replace(/[^a-z0-9]/gi, '_')}`;
export const listenMyUser = (email, cb) => later(cb, { email, name: 'לו קורק' });
export const saveMyPrefs = async () => {};
export const listenMyDelivery = (_p, cb) => later(cb, null);
export const listenWhatsappMeta = (cb) => later(cb, {});
export const listenRecentInbox = (_e, cb) => later(cb, []);
export const checkVoiceNotes = async () => ({ ok: true });
export const enableVoiceNotes = async () => ({ ok: true });
