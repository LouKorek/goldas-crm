// Harness fixtures for the relationship map (Contacts → map): a story that
// shows a way of three steps and a cold list, inside a book of about 250
// contacts at 40 clubs so the map can be judged at a realistic size.
//   /dev/app.html?path=/contacts?view=map&club=k:rb   the way to Real Betis:
//     agency → אבי כהן (call 6 days ago) → Benny Levi (introduced) → Real Betis
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const iso = (n) => `${day(n)}T09:00:00Z`;
const CHANNELS = ['call', 'whatsapp', 'meeting', 'email'];
const ROLES = ['Sporting Director', 'Head Coach', 'CEO', 'Scout', 'Assistant Coach', 'Owner'];
const FIRST = ['יוסי', 'משה', 'רונן', 'אלון', 'גיל', 'עמית', 'Marco', 'João', 'Luis', 'Pedro', 'Hans', 'Tomasz', 'שרון', 'ליאור', 'Nikos', 'Ivan'];
const LAST = ['לוי', 'מזרחי', 'פרץ', 'ביטון', 'Rossi', 'Silva', 'García', 'Müller', 'Nowak', 'Papadopoulos', 'אוחיון', 'גבאי'];
const CLUB_NAMES = ['Hapoel Haifa', 'Maccabi Netanya', 'Bnei Sakhnin', 'Hapoel Jerusalem', 'Ironi Kiryat Shmona', 'Maccabi Petah Tikva', 'Hapoel Hadera', 'Ashdod SC',
  'Benfica', 'Sporting CP', 'Braga', 'Olympiacos', 'PAOK', 'AEK Athens', 'Legia Warsaw', 'Lech Poznan', 'Slavia Prague', 'Sparta Prague', 'Red Star Belgrade',
  'Partizan', 'Dinamo Zagreb', 'Hajduk Split', 'Ferencvaros', 'Rapid Wien', 'Sturm Graz', 'Basel', 'Young Boys', 'Club Brugge', 'Anderlecht', 'Genk',
  'AZ Alkmaar', 'Twente', 'Utrecht', 'Copenhagen', 'Midtjylland', 'Malmö', 'Rosenborg', 'Celtic', 'Anorthosis', 'APOEL'];

// A small deterministic random so the harness looks the same every time.
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

const clubs = [
  { id: 'rb', name: 'Real Betis', key: 'real betis', aliases: ['Betis'] },
  { id: 'mh', name: 'מכבי חיפה', key: 'מכבי חיפה', aliases: ['Maccabi Haifa'] },
  ...CLUB_NAMES.map((name, i) => ({ id: `cl${i}`, name, key: name.toLowerCase() })),
];

const story = [
  { id: 'n-avi', contactName: 'אבי כהן', clubName: 'הפועל אשדוד', contactRole: 'Sporting Director', contactPhone: '+972501110001',
    touches: [{ id: 't1', at: iso(-6), channel: 'call', by: 'lou@example.com', note: 'דיברנו על בלם לעונה הבאה' }],
    knows: [{ contactId: 'n-benny', kind: 'introduced', note: 'עבדו יחד בספרד', at: iso(-20), by: 'lou@example.com' }] },
  { id: 'n-benny', contactName: 'Benny Levi', clubId: 'rb', clubName: 'Real Betis', contactRole: 'Scout', contactPhone: '+34600111222' },
  { id: 'n-carmel', contactName: 'כרמל אזולאי', clubId: 'mh', clubName: 'מכבי חיפה', contactRole: 'Head Coach', contactPhone: '+972501110003',
    touches: [{ id: 't2', at: iso(-210), channel: 'whatsapp', by: 'lou@example.com' }] },
  { id: 'n-dor', contactName: 'דור שמעוני', clubName: 'Benfica', contactRole: 'Scout', contactPhone: '+972501110004' },
  { id: 'n-hila', contactName: 'הילה ברק', clubName: 'מכבי חיפה', contactRole: 'CEO', contactPhone: '+972501110005',
    touches: [{ id: 't3', at: iso(-400), channel: 'email', by: 'lou@example.com' }],
    knows: [{ contactId: 'n-carmel', kind: 'knows', at: iso(-400) }] },
  { id: 'n-gal', contactName: 'גל רוזן', clubName: 'Hapoel Haifa', contactRole: 'Sporting Director', contactPhone: '+972501110006' },
];

const crowd = Array.from({ length: 240 }, (_, i) => {
  const age = Math.floor(rnd() * 620);
  const none = rnd() < 0.18;
  const club = rnd() < 0.08 ? '' : pick(CLUB_NAMES);
  return {
    id: `n${i}`, contactName: `${pick(FIRST)} ${pick(LAST)} ${i}`, clubName: club, contactRole: pick(ROLES), contactPhone: `+97252${String(3000000 + i)}`,
    ...(none ? {} : { touches: [{ id: `tc${i}`, at: iso(-age), channel: pick(CHANNELS), by: 'lou@example.com' }] }),
  };
});
// Some of the crowd know each other.
for (let i = 0; i < 40; i++) {
  const a = crowd[Math.floor(rnd() * crowd.length)];
  const b = crowd[Math.floor(rnd() * crowd.length)];
  if (a !== b) a.knows = [...(a.knows || []), { contactId: b.id, kind: rnd() < 0.3 ? 'introduced' : 'knows', at: iso(-Math.floor(rnd() * 300)) }];
}

const meetings = [
  { id: 'nm1', title: 'ארוחת צהריים בהרצליה', date: day(-35), time: '13:00', endTime: '14:30', location: 'הרצליה', linkedContacts: ['n-dor', 'n-gal'], linkedPlayers: [] },
  { id: 'nm2', title: 'כנס סקאוטים', date: day(-120), allDay: true, linkedContacts: ['n3', 'n7', 'n11', 'n-hila'], linkedPlayers: [] },
];

const requirements = [
  { id: 'nr1', clubName: 'Hapoel Haifa', gender: 'Men', requiredPosition: 'CB', status: 'open', contactName: 'גל רוזן', contactPhone: '050-1110006', createdAt: iso(-75), validUntil: day(60) },
];

export function addNetworkFixtures(FIXTURES) {
  FIXTURES.clubs = [...(FIXTURES.clubs || []), ...clubs];
  FIXTURES.contacts = [...(FIXTURES.contacts || []), ...story, ...crowd];
  FIXTURES.meetings = [...(FIXTURES.meetings || []), ...meetings];
  FIXTURES.club_requirements = [...(FIXTURES.club_requirements || []), ...requirements];
}
