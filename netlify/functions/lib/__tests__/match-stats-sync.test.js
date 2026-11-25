// Per-match player data (matches/{id}.playerStats) survives the match sync:
// an update rewrites only the sync's own fields, a match that holds stats is
// never deleted or unlinked from the player whose numbers it holds, and when
// duplicates of one squad are merged the stats move to the copy that stays.
const test = require('node:test');
const assert = require('node:assert/strict');

// FieldValue sentinels the small database below understands.
const fsPath = require.resolve('../firestore.js');
const admin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => 'now',
      delete: () => ({ __op: 'delete' }),
      arrayUnion: (...v) => ({ __op: 'union', v }),
      arrayRemove: (...v) => ({ __op: 'remove', v }),
    },
    Timestamp: { now: () => 'now' },
  },
};
require.cache[fsPath] = {
  id: fsPath, filename: fsPath, loaded: true,
  exports: { admin, getDb: () => null, listRepresented: async () => [], isLive: (d) => !(d && d.deletedAt), OWNER_EMAIL: 'owner@x' },
};

const { syncMatchesForPlayer, holdsStats } = require('../../sync-matches-background.js')._lib;
const { _internal } = require('../../ifa-import-background.js');

// One collection ('matches') with update / create / set-merge / delete,
// array sentinels, dotted field paths and batches, like Firestore.
function matchesDb(seed) {
  const docs = new Map(Object.entries(seed).map(([id, v]) => [id, structuredClone(v)]));
  const apply = (cur, upd) => {
    const out = structuredClone(cur || {});
    for (const [k, v] of Object.entries(upd)) {
      if (v && v.__op === 'union') out[k] = [...new Set([...(out[k] || []), ...v.v])];
      else if (v && v.__op === 'remove') out[k] = (out[k] || []).filter((x) => !v.v.includes(x));
      else if (v && v.__op === 'delete') delete out[k];
      else if (k.includes('.')) { const [a, b] = k.split('.'); out[a] = { ...(out[a] || {}), [b]: v }; }
      else out[k] = v;
    }
    return out;
  };
  const ref = (id) => ({
    id,
    update: async (u) => { if (!docs.has(id)) throw new Error('NOT_FOUND'); docs.set(id, apply(docs.get(id), u)); },
    create: async (v) => { if (docs.has(id)) throw Object.assign(new Error('already exists'), { code: 6 }); docs.set(id, apply({}, v)); },
    set: async (v, o) => { docs.set(id, apply(o && o.merge ? docs.get(id) : {}, v)); },
    delete: async () => { docs.delete(id); },
  });
  const pass = (d, [f, op, v]) => (op === '==' ? d[f] === v : op === 'array-contains' ? (d[f] || []).includes(v) : true);
  const query = (filters) => ({
    where: (f, op, v) => query([...filters, [f, op, v]]),
    limit: () => query(filters),
    get: async () => {
      const list = [...docs].filter(([, d]) => filters.every((x) => pass(d, x))).map(([id, d]) => ({ id, ref: ref(id), data: () => structuredClone(d) }));
      return { docs: list, forEach: (fn) => list.forEach(fn) };
    },
  });
  return {
    docs,
    collection: () => ({ ...query([]), doc: ref }),
    batch: () => { const ops = []; return { update: (r, u) => ops.push(() => r.update(u)), commit: async () => { for (const op of ops) await op(); } }; },
  };
}

const iso = (offsetDays) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return d.toISOString().slice(0, 10); };
const TODAY = iso(0);
const base = { source: 'ifa', sourceTeamId: 't1', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי ניסנוב', deletedAt: null };
const stat = { minutes: 70, goals: 1, rating: 7, by: 'lou', at: '2026-11-20T08:00:00Z' };

test('holdsStats reads a player\'s entry, or any entry', () => {
  assert.equal(holdsStats({ playerStats: { a: { minutes: 0 } } }, 'a'), true);
  assert.equal(holdsStats({ playerStats: { a: { minutes: 0 } } }, 'b'), false);
  assert.equal(holdsStats({ playerStats: { a: {} } }), false);
  assert.equal(holdsStats({}), false);
});

test('a sync update rewrites its own fields and leaves playerStats alone', async () => {
  const db = matchesDb({ m1: { ...base, date: TODAY, sourceMatchId: '111', time: '', linkedPlayers: ['a'], playerStats: { a: stat } } });
  await syncMatchesForPlayer(db, { id: 'a' }, 'ifa', [{ ...base, sourceMatchId: '111', date: TODAY, time: '17:30', stadiumName: 'X' }]);
  const m = db.docs.get('m1');
  assert.equal(m.time, '17:30');
  assert.deepEqual(m.playerStats, { a: stat });
});

test('a match that holds the player\'s stats is not deleted when the fetch drops it', async () => {
  const db = matchesDb({
    held: { ...base, date: TODAY, sourceMatchId: '222', linkedPlayers: ['a'], playerStats: { a: stat } },
    plain: { ...base, date: iso(3), sourceMatchId: '333', linkedPlayers: ['a'] },
  });
  const r = await syncMatchesForPlayer(db, { id: 'a' }, 'ifa', []);
  assert.equal(r.removed, 1);
  assert.ok(db.docs.has('held'), 'the match with stats stays');
  assert.deepEqual(db.docs.get('held').linkedPlayers, ['a'], 'and the player stays linked');
  assert.equal(db.docs.has('plain'), false, 'a match without stats still goes');
});

test('the last linked player is unlinked but the match is kept when another player\'s stats are on it', async () => {
  const db = matchesDb({ m: { ...base, date: TODAY, sourceMatchId: '444', linkedPlayers: ['a'], playerStats: { b: stat } } });
  await syncMatchesForPlayer(db, { id: 'a' }, 'ifa', []);
  assert.ok(db.docs.has('m'));
  // A second player on the match is still simply unlinked.
  const db2 = matchesDb({ m: { ...base, date: TODAY, sourceMatchId: '555', linkedPlayers: ['a', 'b'], playerStats: { b: stat } } });
  await syncMatchesForPlayer(db2, { id: 'a' }, 'ifa', []);
  assert.deepEqual(db2.docs.get('m').linkedPlayers, ['b']);
});

test('carriedStats moves entries the kept copy lacks, the newest winning', () => {
  const keep = { id: 'k', playerStats: { a: { minutes: 90 } } };
  const others = [
    { id: 'o1', playerStats: { a: { minutes: 10 }, b: { goals: 1, at: '2026-11-01T00:00:00Z' } } },
    { id: 'o2', playerStats: { b: { goals: 2, at: '2026-11-02T00:00:00Z' }, c: {} } },
  ];
  assert.deepEqual(_internal.carriedStats(keep, others), { b: { goals: 2, at: '2026-11-02T00:00:00Z' } });
  assert.deepEqual(_internal.carriedStats({ id: 'k' }, []), {});
});

test('merging duplicates carries playerStats onto the surviving record', async () => {
  const db = matchesDb({
    old: { ...base, date: TODAY, sourceMatchId: `${TODAY}|h|a`, time: '', linkedPlayers: ['a', 'b'], createdAt: '2026-09-01T00:00:00Z', playerStats: { a: stat } },
    neu: { ...base, date: TODAY, sourceMatchId: '1121999', time: '17:30', linkedPlayers: ['b'], createdAt: '2026-10-12T00:00:00Z', playerStats: { b: { minutes: 0 } } },
  });
  const r = await _internal.mergeSquadDuplicates(db, 't1');
  assert.equal(r.merged, 1);
  const keep = db.docs.get('neu');
  assert.deepEqual(keep.playerStats, { a: stat, b: { minutes: 0 } });
  assert.deepEqual(keep.linkedPlayers.sort(), ['a', 'b']);
  assert.ok(db.docs.get('old').deletedAt, 'the other copy goes to the recycle bin');
});
