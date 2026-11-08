const CLUBS = ['מכבי חיפה', 'הפועל באר שבע', 'בית"ר ירושלים', 'מכבי תל אביב', 'Real Betis', 'FC Porto'];
const POS = ['GK', 'CB', 'RB', 'LB', 'DM', 'CM', 'AM', 'RW', 'LW', 'ST'];
const ST = ['Not Contacted', 'Waiting Response', 'Initial Talks', 'Mandate Received', 'Offered to Club', 'Negotiation'];
const CATS = ['men', 'women', 'youth', 'jewish'];
const NAMES = ['Daniel de la Cruz', 'עומרי תקלה', 'Lucas Silva', 'דן רינגל', 'Maya Cohen', 'נועה לוי', 'Ethan Gold', 'יואב מזרחי'];
const players = [
  ...Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, stage: 'tracking', category: CATS[i % 4], playerName: `${NAMES[i % 8]} ${i}`, gender: i % 4 === 1 ? 'Women' : 'Men',
    status: ST[i % ST.length], primaryPosition: POS[i % 10], dob: `${1998 + (i % 12)}-0${1 + (i % 9)}-1${i % 9}`, currentClub: CLUBS[i % 6], height: String(170 + i), foot: 'Right',
    agentName: 'Agent X', agentPhone: '+380950663545', salary: '1000', nationalities: ['Israel'], leagueCountry: 'Israel', leagueTier: 'Tier 1', league: 'Israel 1' })),
  // Older candidates saved before the market field existed.
  { id: 'old1', stage: 'tracking', playerName: 'Legacy Man', gender: 'Men', status: 'Not Contacted', primaryPosition: 'CB' },
  // A stale stored stage (status says in talks) and a real "Not relevant".
  { id: 'stale1', stage: 'not_relevant', category: 'men', playerName: 'Stale Stage', gender: 'Men', status: 'Initial Talks', primaryPosition: 'RW' },
  { id: 'gone1', stage: 'not_relevant', category: 'men', playerName: 'Gone Player', gender: 'Men', status: 'Not Relevant', primaryPosition: 'LB' },
  { id: 'old2', stage: 'in_process', playerName: 'Legacy Woman', gender: 'Women', status: 'Initial Talks', primaryPosition: 'ST' },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, stage: 'represented', category: 'men', fullName: `שחקן מיוצג ${i}`, gender: 'Men', primaryPosition: POS[i], currentClub: CLUBS[i % 6], contractStatus: 'Under Contract', contractEnd: '2027-06-30', dob: '2002-01-01' })),
];
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
export const FIXTURES = {
  players,
  meetings: [
    { id: 'm1', title: "Gold A&S | Harwin's (Jonah)", date: day(0), time: '21:00', endTime: '21:45', location: '', notes: '', linkedPlayers: ['p1'], guests: ['Jonah'], meetUrl: 'https://meet.google.com/abc-defg-hij' },
    { id: 'm2', title: "Gold A&S | Dubinsky's (Shay)", date: day(1), time: '18:00', endTime: '18:45', location: 'G כוכב הצפון', linkedPlayers: [] },
    { id: 'm3', title: 'כנס סוכנים', date: day(2), endDate: day(3), allDay: true, location: 'תל אביב' },
  ],
  deals: Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, playerId: `c${i}`, playerName: players[i].playerName, clubName: CLUBS[(i + 2) % 6], stage: ST[i % 6], enteredStageAt: '2026-10-01', createdAt: '2026-09-01' })),
  club_requirements: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, clubName: CLUBS[i], gender: i % 2 ? 'Women' : 'Men', requiredPosition: POS[i], status: 'open', validUntil: '2026-12-31', ageMin: 18, ageMax: 28, salary: '2000' })),
  contacts: Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, clubName: CLUBS[i], contactName: `איש קשר ${i}`, contactRole: 'Sporting Director', contactPhone: '+972501234567' })),
};
