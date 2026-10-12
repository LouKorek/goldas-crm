// The migrations read and write Firestore through this tiny interface, so
// the same code runs against a real database and against the in-memory copy
// the unit tests use.
//
//   store.load(col)                  → [{ id, ...data }] (every document)
//   store.set(col, id, data, merge)  → queued write
//   store.flush()                    → commit queued writes (batches of 400)
//   store.now()                      → ISO timestamp used in records
const BATCH = 400;

function firestoreStore(db, admin) {
  const queue = [];
  const cache = new Map();
  return {
    dry: false,
    async load(col) {
      if (!cache.has(col)) {
        const snap = await db.collection(col).get();
        cache.set(col, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      }
      return cache.get(col);
    },
    set(col, id, data, merge = true) { queue.push({ col, id, data, merge }); },
    pending() { return queue.length; },
    async flush() {
      let n = 0;
      while (queue.length) {
        const part = queue.splice(0, BATCH);
        const batch = db.batch();
        for (const w of part) batch.set(db.collection(w.col).doc(w.id), w.data, { merge: w.merge });
        await batch.commit();
        n += part.length;
      }
      cache.clear();
      return n;
    },
    now: () => new Date().toISOString(),
    serverNow: () => (admin ? admin.firestore.Timestamp.now() : new Date().toISOString()),
  };
}

/** In-memory store for tests: `data` is { collection: { id: doc } }. */
function memoryStore(data = {}) {
  const queue = [];
  const db = JSON.parse(JSON.stringify(data));
  return {
    db,
    dry: false,
    async load(col) { return Object.entries(db[col] || {}).map(([id, d]) => ({ id, ...JSON.parse(JSON.stringify(d)) })); },
    set(col, id, data, merge = true) { queue.push({ col, id, data, merge }); },
    pending() { return queue.length; },
    async flush() {
      const n = queue.length;
      for (const w of queue.splice(0)) {
        db[w.col] = db[w.col] || {};
        db[w.col][w.id] = w.merge ? { ...(db[w.col][w.id] || {}), ...w.data } : { ...w.data };
      }
      return n;
    },
    now: () => '2026-10-12T12:00:00.000Z',
    serverNow: () => '2026-10-12T12:00:00.000Z',
  };
}

module.exports = { firestoreStore, memoryStore, BATCH };
