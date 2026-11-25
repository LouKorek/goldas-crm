// A small in-memory Firestore for the tests of Golda's own-initiative messages:
// documents, sub-collections, merge, auto ids, equality and range queries.
// fakeDb({ players: { p1: {...} }, 'wa_sessions/9725/threads': { main: {...} } })
function fakeDb(seed = {}) {
  const data = new Map();
  let n = 0;
  const col = (path) => { if (!data.has(path)) data.set(path, new Map()); return data.get(path); };
  for (const [path, docs] of Object.entries(seed)) for (const [id, v] of Object.entries(docs)) col(path).set(id, structuredClone(v));

  const doc = (path, id) => ({
    id,
    get: async () => { const v = col(path).get(id); return { id, exists: v !== undefined, data: () => (v === undefined ? undefined : structuredClone(v)) }; },
    set: async (v, o) => { col(path).set(id, structuredClone(o && o.merge ? { ...(col(path).get(id) || {}), ...v } : v)); },
    update: async (v) => { col(path).set(id, structuredClone({ ...(col(path).get(id) || {}), ...v })); },
    delete: async () => { col(path).delete(id); },
    collection: (sub) => collection(`${path}/${id}/${sub}`),
  });
  const pass = (d, [f, op, v]) => (op === '==' ? d[f] === v : op === '>=' ? d[f] >= v : op === '>' ? d[f] > v : op === 'array-contains' ? (d[f] || []).includes(v) : true);
  const query = (path, filters = []) => ({
    where: (f, op, v) => query(path, [...filters, [f, op, v]]),
    orderBy: () => query(path, filters),
    limit: () => query(path, filters),
    get: async () => ({ docs: [...col(path)].filter(([, v]) => filters.every((x) => pass(v, x))).map(([id, v]) => ({ id, exists: true, data: () => structuredClone(v), ref: doc(path, id) })) }),
  });
  const collection = (path) => ({
    ...query(path),
    doc: (id = `auto${++n}`) => doc(path, id),
    add: async (v) => { const id = `new${++n}`; col(path).set(id, structuredClone(v)); return { id }; },
  });
  /** One document as plain data (undefined when it is not there). */
  const read = (path, id) => { const v = col(path).get(id); return v === undefined ? undefined : structuredClone(v); };
  const all = (path) => [...col(path)].map(([id, v]) => ({ id, ...structuredClone(v) }));
  // A transaction over the same documents: reads and writes go straight through (one test, one thread).
  const runTransaction = async (fn) => fn({
    get: (ref) => ref.get(), set: (ref, v, o) => { ref.set(v, o); }, update: (ref, v) => { ref.update(v); }, delete: (ref) => { ref.delete(); },
  });
  return { data, collection, read, all, runTransaction };
}

/** Replaces lib/firestore.js for modules that load it: no Firebase in a test. */
function stubFirestore(getDb = () => null) {
  const fsPath = require.resolve('../firestore.js');
  const admin = { firestore: { FieldValue: { serverTimestamp: () => 'now', delete: () => undefined } } };
  require.cache[fsPath] = {
    id: fsPath, filename: fsPath, loaded: true,
    exports: {
      admin, getDb, OWNER_EMAIL: 'lou.korek@gmail.com', isLive: (d) => !(d && d.deletedAt),
      listRepresented: async (db) => (await db.collection('players').get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => !p.deletedAt && (!p.stage || p.stage === 'represented')),
    },
  };
  return admin;
}

/** A sender for nudge(): records what would go out on WhatsApp. */
function recorder() {
  const out = [];
  const send = async (u, body, kind, buttons = []) => { out.push({ to: u.email, body, kind, buttons }); return { state: 'sent' }; };
  return { out, send };
}

const OWNER = { email: 'lou.korek@gmail.com', name: 'לו קורק', role: 'admin', whatsapp: '972500000001', channels: ['whatsapp'], briefingHour: 7 };
const MANAGER = { email: 'dani@x.com', name: 'דני לוי', role: 'manager', whatsapp: '972500000002', channels: ['whatsapp'], briefingHour: 7 };

module.exports = { fakeDb, stubFirestore, recorder, OWNER, MANAGER };
