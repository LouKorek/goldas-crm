// Golda for players: who counts as a player, what he may see, and that his
// reports reach the admins (and only them) in the day.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.OWNER_EMAIL = 'lou.korek@gmail.com';
const { matchSender } = require('../golda-identity.js');
const gp = require('../golda-player.js');

const users = [{ id: 'lou.korek@gmail.com', email: 'lou.korek@gmail.com', name: 'לו קורק', role: 'admin', whatsapp: '972500000001' }];
const players = [
  { id: 'p1', fullName: 'Shay Dubinsky', goldaAccess: true, goldaPhone: '0521234567', stage: 'represented' },
  { id: 'p2', fullName: 'Off Player', goldaAccess: false, goldaPhone: '972521111111' },
  { id: 'p3', fullName: 'Prospect', goldaAccess: true, goldaPhone: '972522222222', stage: 'prospect' },
  { id: 'p4', fullName: 'Staff Too', goldaAccess: true, goldaPhone: '972500000001' },
];

test('only a represented player an admin switched on is a player; the team always wins', () => {
  const id = matchSender('972521234567', users, '', players);
  assert.equal(id.role, 'player');
  assert.equal(id.playerId, 'p1');
  assert.equal(id.email, '');
  assert.equal(matchSender('972521111111', users, '', players), null);
  assert.equal(matchSender('972522222222', users, '', players), null);
  assert.equal(matchSender('972500000001', users, '', players).role, 'admin');
});

test('the profile a player sees leaves out money terms, notes, files and passport number', () => {
  const prof = gp.profileOf({ fullName: 'Shay Dubinsky', currentClub: 'Hapoel X', contractEnd: '2027-06-30', passportExpiry: '2031-09-02', passportNumber: '42960120',
    notes: 'internal', contractTerms: { salary: 10000 }, contractFiles: [{ fileId: 'f' }], dealNotes: 'x' });
  assert.deepEqual(Object.keys(prof).sort(), ['contractEnd', 'currentClub', 'name', 'passportExpiry']);
});

test('his schedule: his own games and trainings in range only', () => {
  const s = gp.scheduleOf({
    matches: [
      { date: '2026-11-10', time: '19:00', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p1'] },
      { date: '2026-11-10', homeTeam: 'C', awayTeam: 'D', linkedPlayers: ['p9'] },
      { date: '2027-03-01', homeTeam: 'E', awayTeam: 'F', linkedPlayers: ['p1'] },
    ],
    trainings: [],
  }, 'p1', '2026-11-08');
  assert.deepEqual(s.map((x) => x.game), ['A – B']);
});

function fakeDb(seed) {
  const added = [];
  const coll = (name) => ({
    doc: (id) => ({ get: async () => ({ exists: !!seed[name]?.[id], id, data: () => seed[name][id] }) }),
    where: () => ({ get: async () => ({ docs: Object.entries(seed[name] || {}).map(([id, v]) => ({ id, data: () => v })) }) }),
    add: async (v) => { added.push({ name, v }); return { id: `n${added.length}` }; },
  });
  return { collection: coll, added };
}

test('a report becomes a note for the agency; he gets no CRM tools', async () => {
  const db = fakeDb({ players: { p1: players[0] }, matches: {}, trainings: {} });
  let call = 0; let toolsSeen; let system;
  const client = { beta: { messages: { stream: (req) => ({ finalMessage: async () => {
    call++; toolsSeen = req.tools.map((t) => t.name); system = req.system;
    if (call === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'tell_agent', input: { summary: 'נפצע בקרסול באימון', urgent: true } }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'החלמה מהירה, העברתי ללו.' }] };
  } }) } } };
  const admin = { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } };
  const out = await gp.runPlayerAgent({ db, admin, identity: { role: 'player', playerId: 'p1', name: 'Shay Dubinsky', phone: '972521234567' }, text: 'נפצעתי', client });
  assert.deepEqual(toolsSeen.sort(), ['my_cv', 'tell_agent']);
  assert.match(system, /Never talk about other players/);
  assert.equal(out.reply, 'החלמה מהירה, העברתי ללו.');
  assert.equal(db.added.length, 1);
  assert.equal(db.added[0].name, 'golda_player_notes');
  assert.equal(db.added[0].v.urgent, true);
  assert.equal(db.added[0].v.delivered, false);
  const msg = gp.buildPlayerNotesMessage('לו', [db.added[0].v]);
  assert.match(msg, /🔴 \*Shay Dubinsky:\* נפצע בקרסול/);
});
