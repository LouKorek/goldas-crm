// 005 — Golda's allow list moves onto the users. The WA_ALLOWED_NUMBERS
// variable (digits with an optional name; an entry without a name is the
// owner) is copied onto the matching app_users records as their WhatsApp
// number, and WhatsApp is switched on as a channel for the owner, so the
// morning briefing starts without anyone typing a number. A record that
// already has a number is left alone, and a named entry whose name matches
// no user is left for the Team screen (the legacy list keeps serving it).
const { OWNER_EMAIL } = require('../firestore.js');
const { legacyEntries } = require('../golda-identity.js');

const id = '005-golda-numbers';
const title = 'מספרי הוואטסאפ של הצוות עוברים לכרטיסי המשתמשים';

async function plan(store, env = process.env.WA_ALLOWED_NUMBERS) {
  const users = await store.load('app_users');
  const byEmail = (e) => users.find((u) => String(u.email || u.id || '').toLowerCase() === e);
  const writes = [];
  const notes = [];
  let unmatched = 0;
  for (const e of legacyEntries(env)) {
    const u = e.name ? users.find((x) => x.active !== false && String(x.name || '').trim() === e.name) : byEmail(OWNER_EMAIL);
    if (!u) {
      if (e.name) { unmatched += 1; notes.push(`"${e.name}": אין משתמש בשם הזה; יש להזין את המספר במסך הצוות`); }
      else writes.push(['app_users', OWNER_EMAIL, { email: OWNER_EMAIL, name: 'לו', role: 'admin', active: true, whatsapp: e.num, channels: ['email', 'whatsapp'], briefingHour: 7 }, true]);
      continue;
    }
    if (u.whatsapp) continue;
    const docId = u.id || u.email;
    const patch = { whatsapp: e.num };
    const isOwner = String(u.email || u.id || '').toLowerCase() === OWNER_EMAIL;
    const channels = Array.isArray(u.channels) ? u.channels : ['email'];
    if (isOwner && !channels.includes('whatsapp')) patch.channels = [...channels, 'whatsapp'];
    if (!Number.isInteger(u.briefingHour)) patch.briefingHour = 7;
    writes.push(['app_users', docId, patch, true]);
  }
  const report = {
    summary: writes.length ? `${writes.length} משתמשים יקבלו את מספר הוואטסאפ שלהם מהרשימה הישנה${unmatched ? ` (${unmatched} ללא התאמה)` : ''}.` : `אין מספרים להעביר${unmatched ? ` (${unmatched} ללא התאמה)` : ''}.`,
    counts: { users: writes.length, unmatched },
    notes,
  };
  return { report, writes };
}

module.exports = { id, title, plan };
