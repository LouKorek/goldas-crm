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
  // Represented players for the checklist card and the score on the players list:
  // r1 added last week (onboarding), r2 a complete veteran, r3 a veteran with gaps whose games do not reach the calendar.
  ...(() => {
    const FILE = [{ name: 'doc', fileId: 'f-demo', type: 'application/pdf', uploadedAt: '2026-01-01' }];
    const base = { stage: 'represented', gender: 'Men', contractStatus: 'Under Contract', contractEnd: '2027-06-30', reprEnd: '2027-06-30', passportExpiry: '2030-01-01', dob: '2006-04-12',
      primaryPosition: 'CM', currentClub: 'מכבי חיפה', foot: 'Right', nationalities: ['Israel'], leagueCountry: 'Israel', leagueTier: 'Tier 1', reprFiles: FILE, passportFiles: FILE, photoFiles: FILE,
      videoLink: 'https://youtu.be/demo', ifaTeamUrl: 'https://www.football.org.il/players/player/?player_id=1', profileLink: 'https://www.transfermarkt.com/x/profil/spieler/1', siteCard: { on: true, checkedAt: '2026-11-20' }, createdAt: '2024-03-01T10:00:00Z' };
    return [
      { ...base, id: 'r1', fullName: 'Noam Barzilai', createdAt: new Date(Date.now() - 6 * 86400000).toISOString(), reprFiles: [], photoFiles: [], passportFiles: [], videoLink: '', ifaTeamUrl: '', profileLink: '', siteCard: { on: false, checkedAt: '2026-11-20' }, foot: '' },
      { ...base, id: 'r2', fullName: 'Gavin Karam' },
      { ...base, id: 'r3', fullName: 'Yair Shemesh', videoLink: '', contractEnd: '', siteCard: undefined },
    ];
  })(),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, stage: 'represented', category: 'men', fullName: `שחקן מיוצג ${i}`, gender: 'Men', primaryPosition: POS[i], currentClub: CLUBS[i % 6], contractStatus: 'Under Contract', contractEnd: '2027-06-30', dob: '2002-01-01', ...(i === 1 ? { goldaAccess: true, goldaPhone: '0521234567' } : {}) })),
];
// The monthly report: p1 has a draft for the last full month (the month the dialog opens on).
const LAST_MONTH = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - 1, 15).toISOString().slice(0, 7); })();
Object.assign(players.find((p) => p.id === 'p1'), { monthlyReports: { [LAST_MONTH]: {
  did: ['שיחה עם המאמן על הדקות שלו ועל ההתקדמות באימונים', 'פגישה עם ההורים לסיכום תחילת העונה', 'שלחנו קטעי וידאו מעודכנים לשני סקאוטים בחו"ל'],
  next: 'בחודש הבא נמשיך לעקוב אחרי הדקות שלו בליגה, ונקבע איתכם שיחה קצרה באמצע החודש.', status: 'draft', by: 'owner@example.com', at: '2026-11-02T09:00:00Z' } } });
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
// Payments on deals (Finance screen): paid, one partial, one late, one due
// this week, two currencies, and an unpaid one on a Not Relevant deal.
const pay = (id, amount, currency, due, extra = {}) => ({
  id, label: '', amount, currency, dueDate: day(due), payer: { kind: 'club', name: '' }, paidAt: null, paidAmount: null, note: '',
  createdBy: 'lou@example.com', createdAt: '2026-09-01T09:00:00Z', ...extra,
});
const PAYMENTS = {
  d8: [
    pay('pay_a', 8000, 'EUR', -60, { label: 'עמלה — תשלום ראשון', payer: { kind: 'club', name: CLUBS[0] }, paidAt: day(-57) }),
    pay('pay_b', 6000, 'EUR', -5, { label: 'עמלה — תשלום שני', payer: { kind: 'club', name: CLUBS[0] } }),
    pay('pay_c', 6000, 'EUR', 120, { label: 'עמלה — תשלום שלישי', payer: { kind: 'club', name: CLUBS[0] } }),
  ],
  d5: [
    pay('pay_d', 12000, 'ILS', -35, { label: 'דמי חתימה', payer: { kind: 'player', name: 'שחקן' }, paidAt: day(-30) }),
    pay('pay_e', 30000, 'ILS', 3, { label: 'עמלה', payer: { kind: 'club', name: CLUBS[5 % 6] } }),
    pay('pay_f', 15000, 'ILS', 25, { label: 'בונוס הופעות', paidAt: day(-2), paidAmount: 5000 }),
  ],
  d3: [pay('pay_g', 4000, 'EUR', 40, { label: 'עמלה' })],
  d9: [pay('pay_h', 5000, 'EUR', -10, { label: 'עמלה' })],
};
export const FIXTURES = {
  players,
  meetings: [
    { id: 'm1', title: "Gold A&S | Harwin's (Jonah)", date: day(0), time: '21:00', endTime: '21:45', location: '', notes: '', linkedPlayers: ['p1'], guests: ['Jonah'], meetUrl: 'https://meet.google.com/abc-defg-hij' },
    { id: 'm2', title: "Gold A&S | Dubinsky's (Shay)", date: day(1), time: '18:00', endTime: '18:45', location: 'G כוכב הצפון', linkedPlayers: [] },
    { id: 'm3', title: 'כנס סוכנים', date: day(2), endDate: day(3), allDay: true, location: 'תל אביב' },
  ],
  deals: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, playerId: `c${i}`, playerName: players[i].playerName, clubName: CLUBS[(i + 2) % 6], stage: ST[i % 6], enteredStageAt: '2026-10-01', createdAt: '2026-09-01' })),
    { id: 'd8', playerId: 'p2', playerName: 'שחקן מיוצג 2', clubName: CLUBS[0], stage: 'Contract Signed', enteredStageAt: '2026-08-01', createdAt: '2026-06-01' },
    { id: 'd9', playerId: 'p3', playerName: 'שחקן מיוצג 3', clubName: CLUBS[1], stage: 'Not Relevant', enteredStageAt: '2026-10-20', createdAt: '2026-07-01', closedAt: '2026-10-20T10:00:00Z' },
  ].map((d) => ({ ...d, payments: PAYMENTS[d.id] || [] })),
  club_requirements: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, clubName: CLUBS[i], gender: i % 2 ? 'Women' : 'Men', requiredPosition: POS[i], status: 'open', validUntil: '2026-12-31', ageMin: 18, ageMax: 28, salary: '2000',
    ...(i === 0 ? { scouting: { at: '2026-11-15T08:31:00Z', candidates: [
      { name: 'Ido Shahar', age: 24, position: 'GK', club: 'Hapoel Hadera', why: 'חוזה מסתיים ביוני 2027, שוער ראשון בליגת העל, 11 שערים נקיים העונה', link: 'https://www.transfermarkt.com/ido-shahar/profil/spieler/1' },
      { name: 'Tomer Levi', age: 21, position: 'GK', club: 'Maccabi Petah Tikva U21', why: 'שוער שני, מחפש דקות; מועמד להשאלה', link: 'https://www.transfermarkt.com/tomer-levi/profil/spieler/2' },
    ] } } : {}) })),
  // Matches with per-match player data (playerStats) for p1 across two seasons,
  // one played match without data, and one upcoming.
  matches: [
    ...[[-150, 0, 0, 0, null], [-140, 15, 0, 0, 6], [-120, 90, 1, 0, 7.5], [-96, 72, 0, 1, 6.5], [-82, 90, 2, 1, 8.5], [-68, 0, 0, 0, null],
      [-54, 64, 0, 0, 6], [-40, 90, 0, 2, 7], [-26, 81, 1, 0, 7], [-12, 90, 0, 0, 6.5], [-5, 30, 0, 0, null]].map(([d, minutes, goals, assists, rating], i) => ({
      id: `x${i}`, date: day(d), time: '19:30', homeTeam: CLUBS[i % 6], awayTeam: CLUBS[(i + 3) % 6], source: i % 2 ? 'ifa' : 'manual', linkedPlayers: ['p1', 'p2'],
      watchedBy: i === 9 ? 'Lou, Dana' : '', competition: i % 3 === 0 ? 'ליגת העל' : '',
      playerStats: { p1: { minutes, goals, assists, ...(rating ? { rating } : {}), ...(i === 4 ? { note: 'Two goals and an assist, best game of the season.' } : {}), by: 'owner@example.com', at: '2026-11-01T08:00:00Z' },
        ...(i === 9 ? { p2: { minutes: 0 } } : {}) },
    })),
    { id: 'x20', date: day(-1), time: '20:00', homeTeam: CLUBS[0], awayTeam: CLUBS[1], source: 'ifa', linkedPlayers: ['p1', 'p3'], watchedBy: 'Lou' },
    { id: 'x21', date: day(4), time: '18:00', homeTeam: CLUBS[2], awayTeam: CLUBS[0], source: 'ifa', linkedPlayers: ['p1'] },
  ],
  contacts: Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, clubName: CLUBS[i], contactName: `איש קשר ${i}`, contactRole: 'Sporting Director', contactPhone: '+972501234567' })),
};
