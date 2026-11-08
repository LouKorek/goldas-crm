// Weekly scouting: which requirements, what the model's answer becomes, and
// the Sunday run end to end (fake search, in-memory Firestore).
const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../golda-scouting.js');

const now = new Date('2026-11-15T08:30:00Z');   // Sunday 10:30 Israel
const iso = (s) => new Date(s).toISOString();

test('scout time is Sunday 10:00 in Israel only', () => {
  assert.equal(sc.isScoutTime(new Date('2026-11-15T08:30:00Z')), true);
  assert.equal(sc.isScoutTime(new Date('2026-11-15T07:30:00Z')), false);
  assert.equal(sc.isScoutTime(new Date('2026-11-16T08:30:00Z')), false);
});

test('picks open, valid, not-recently-scouted requirements, never scouted first', () => {
  const reqs = [
    { id: 'a', clubName: 'A', status: 'open', createdAt: iso('2026-10-01'), scouting: { at: iso('2026-11-01') } },
    { id: 'b', clubName: 'B', status: 'open', createdAt: iso('2026-10-05') },
    { id: 'c', clubName: 'C', status: 'filled' },
    { id: 'd', clubName: 'D', status: 'open', validUntil: '2026-11-01' },
    { id: 'e', clubName: 'E', status: 'open', scouting: { at: iso('2026-11-12') } },
    { id: 'f', clubName: 'F', createdAt: iso('2026-10-02') },
    { id: 'g', clubName: 'G', status: 'open', deletedAt: iso('2026-11-01') },
  ];
  assert.deepEqual(sc.pickRequirements(reqs, now).map((r) => r.id), ['f', 'b', 'a']);
});

test('the model answer is cleaned: links required, junk ages dropped, three at most', () => {
  const text = 'Here:\n```json\n{"candidates":[{"name":"Ido Levi","age":23,"position":"Striker","club":"Hapoel X","why":"חוזה נגמר ביוני","link":"https://www.transfermarkt.com/x"},{"name":"No Link","age":22},{"name":"B","age":99,"link":"https://a.b"},{"name":"C","link":"https://c"},{"name":"D","link":"https://d"}]}\n```';
  const c = sc.parseCandidates(text);
  assert.equal(c.length, 3);
  assert.equal(c[0].name, 'Ido Levi');
  assert.equal(c[1].age, null);
  assert.equal(sc.parseCandidates('no json'), null);
});

test('scoutRequirement resumes a paused search, drops our own players, and never throws', async () => {
  let calls = 0;
  const client = { beta: { messages: { stream: (req) => ({ finalMessage: async () => {
    calls++;
    if (calls === 1) return { stop_reason: 'pause_turn', content: [{ type: 'text', text: '' }] };
    assert.equal(req.tools[0].type, 'web_search_20260209');
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"candidates":[{"name":"Assaf Cohen","link":"https://x"},{"name":"Ido Levi","age":23,"link":"https://y"}]}' }] };
  } }) } } };
  const r = await sc.scoutRequirement({ clubName: 'A', gender: 'Men', requiredPosition: 'Striker', ageMin: 18, ageMax: 25 }, { client, ours: ['Assaf Cohen'] });
  assert.equal(calls, 2);
  assert.equal(r.ai, true);
  assert.deepEqual(r.candidates.map((c) => c.name), ['Ido Levi']);
  const bad = await sc.scoutRequirement({ clubName: 'A' }, { client: { beta: { messages: { stream: () => { throw new Error('boom'); } } } } });
  assert.deepEqual(bad, { candidates: [], ai: false, reason: 'boom' });
});

test('runScouting saves found candidates on the requirement and skips failures', async () => {
  const saved = {};
  const db = { collection: () => ({ doc: (id) => ({ set: async (v) => { saved[id] = v; } }) }) };
  const notes = [];
  const scout = async (req) => (req.id === 'x' ? { candidates: [{ name: 'P', link: 'https://p', why: 'כי' }], ai: true } : { candidates: [], ai: false, reason: 'down' });
  const out = await sc.runScouting(db, { requirements: [{ id: 'x', clubName: 'X', status: 'open' }, { id: 'y', clubName: 'Y', status: 'open' }], players: [] }, now, { note: (s) => notes.push(s) }, { scout });
  assert.equal(out.length, 1);
  assert.equal(saved.x.scouting.candidates[0].name, 'P');
  assert.equal(saved.y, undefined);
  assert.match(notes.join('\n'), /Y: down/);
  const msg = sc.buildScoutingMessage('לו', [...out, { req: { clubName: 'Z' }, candidates: [] }]);
  assert.match(msg, /סקאוטינג שבועי, לו/);
  assert.match(msg, /https:\/\/p/);
  assert.match(msg, /לא מצאתי התאמה טובה ל: Z/);
  assert.match(msg, /לא נוצר קשר/);
});
