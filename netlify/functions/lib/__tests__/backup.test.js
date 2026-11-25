// The backup that checks itself, the copy outside the database, and the way
// back: one record, or everything. Runs against a small in-memory Firestore.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{}';

const { admin } = require('../firestore.js');
const B = require('../backup.js');
const { opsAlerts } = require('../golda-briefing.js');

// ── A tiny Firestore ────────────────────────────────────────────────
function fakeDb(seed = {}, idPrefix = 'auto') {
  const docs = new Map(Object.entries(seed));
  let auto = 0;
  const snapOf = (path) => ({ exists: docs.has(path), id: path.split('/').pop(), ref: docRef(path), data: () => docs.get(path) });
  const subNames = (prefix, depth) => [...new Set([...docs.keys()].filter((k) => k.startsWith(prefix) && k.split('/').length >= depth + 1).map((k) => k.split('/')[depth - 1]))];
  function query(colPath, filters = [], order = null) {
    const depth = colPath.split('/').length + 1;
    const run = () => {
      let rows = [...docs.keys()].filter((k) => k.startsWith(`${colPath}/`) && k.split('/').length === depth).map(snapOf);
      for (const [f, op, v] of filters) rows = rows.filter((r) => (op === '>' ? r.data()[f] > v : op === '!=' ? r.data()[f] != null && r.data()[f] !== v : r.data()[f] === v));
      if (order) rows.sort((a, b) => (a.data()[order] > b.data()[order] ? 1 : a.data()[order] < b.data()[order] ? -1 : 0));
      else rows.sort((a, b) => (a.id > b.id ? 1 : -1));
      return rows;
    };
    return {
      where: (f, op, v) => query(colPath, [...filters, [f, op, v]], order),
      orderBy: (f) => query(colPath, filters, f),
      get: async () => { const d = run(); return { docs: d, size: d.length, empty: !d.length }; },
    };
  }
  function colRef(path) {
    return { id: path.split('/').pop(), path, doc: (id) => docRef(`${path}/${id || `${idPrefix}${++auto}`}`), add: async (data) => { const r = docRef(`${path}/${idPrefix}${++auto}`); await r.set(data); return r; }, ...query(path) };
  }
  function docRef(path) {
    return {
      path, id: path.split('/').pop(),
      set: async (data, opts) => { docs.set(path, opts && opts.merge ? { ...(docs.get(path) || {}), ...data } : data); },
      get: async () => snapOf(path),
      delete: async () => { docs.delete(path); },
      collection: (name) => colRef(`${path}/${name}`),
      listCollections: async () => subNames(`${path}/`, path.split('/').length + 1).map((n) => colRef(`${path}/${n}`)),
    };
  }
  return {
    docs,
    collection: (name) => colRef(name),
    doc: (path) => docRef(path),
    listCollections: async () => subNames('', 1).map((n) => colRef(n)),
    getAll: async (...refs) => refs.map((r) => snapOf(r.path)),
    batch: () => { const ops = []; return { set: (r, d) => ops.push(() => docs.set(r.path, d)), delete: (r) => ops.push(() => docs.delete(r.path)), commit: async () => ops.forEach((f) => f()) }; },
  };
}
function fakeStore() {
  const m = new Map();
  return { m, set: async (k, v) => { m.set(k, v); }, get: async (k) => m.get(k) || null, list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }), delete: async (k) => { m.delete(k); } };
}
const job = () => { const notes = []; return { notes, note: (s) => notes.push(s) }; };
const ts = (iso) => admin.firestore.Timestamp.fromMillis(Date.parse(iso));
const seed = () => ({
  'players/p1': { name: 'איתן רוזן', club: 'מכבי חיפה', contractEnd: ts('2027-06-30T00:00:00Z'), files: [{ name: 'חוזה.pdf', fileId: 'f1' }] },
  'players/p1/notes/n1': { text: 'הערה 😀 עם אימוג׳י' },
  'players/p2': { name: 'Rafael Libsman', club: 'Hapoel' },
  'files/f1': { name: 'חוזה.pdf', chunks: 2 },
  'files/f1/chunks/0': { data: 'QUJD' },
  'files/f1/chunks/1': { data: 'REVG' },
  'app_meta/whatsapp': { connected: true, stage: 'live' },
  'audit/a1': { action: 'update', collection: 'players', docId: 'p1' },
  'jobs/j1': { name: 'tm-watch', status: 'ok' },
});
const backupsOf = (db) => [...db.docs.keys()].filter((k) => /^backups\/[^/]+$/.test(k));

test('text is cut by bytes, never inside a character, and joins back exactly', () => {
  const text = `${'שלום עולם '.repeat(300)}😀😀😀${'abc'.repeat(200)}`;
  const parts = B.splitForFirestore(text, 1000);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 3);
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p, 'utf8') <= 1000, 'a piece is over the byte limit');
    assert.equal(Buffer.from(p, 'utf8').toString('utf8'), p, 'a piece ends inside an emoji');
  }
});

test('a backup is read back, compared, indexed and copied outside the database', async () => {
  const db = fakeDb(seed()); const store = fakeStore(); const j = job();
  const r = await B.runBackup(j, { db, store });
  assert.equal(r.verified, true);
  assert.equal(r.docs, 8, 'everything but the jobs collection');
  const meta = db.docs.get(`backups/${r.id}`);
  assert.equal(meta.status, 'ok');
  assert.equal(meta.verified, true);
  assert.equal(meta.indexed, 5, 'two players, one file, one app_meta, one audit');
  assert.equal(meta.offsite.key, r.offsite);
  assert.equal(store.m.size, 1);
  // The outside copy holds the same text as the pieces in the database.
  const outside = await B.readOffsite(r.offsite, null, store);
  assert.equal(outside.length, meta.chars);
  assert.match(outside, /"p":"players\/p1\/notes\/n1"/);
  assert.doesNotMatch(outside, /"p":"jobs\//);
  assert.ok(j.notes.some((n) => /read back and compared: 8 documents/.test(n)));
});

test('a backup that cannot be read back is marked failed and the run throws', async () => {
  const db = fakeDb(seed()); const store = fakeStore();
  // Lose the first piece as it is written.
  const realCollection = db.collection;
  db.collection = (name) => {
    const c = realCollection(name);
    if (name !== 'backups') return c;
    const realDoc = c.doc;
    c.doc = (id) => { const d = realDoc(id); const sub = d.collection; d.collection = (n) => { const s = sub(n); if (n === 'chunks') { const sd = s.doc; s.doc = (cid) => { const x = sd(cid); const set = x.set; x.set = async (data) => set({ ...data, text: data.text.slice(0, -5) }); return x; }; } return s; }; return d; };
    return c;
  };
  await assert.rejects(() => B.runBackup(job(), { db, store }), /did not pass its own check/);
  const meta = db.docs.get(backupsOf(db)[0]);
  assert.equal(meta.status, 'error');
  assert.equal(meta.verified, false);
  assert.equal(store.m.size, 0, 'a failed backup is not copied outside');
});

test('one record comes back as it was, with what is under it and its missing files', async () => {
  const db = fakeDb(seed()); const store = fakeStore();
  const { id } = await B.runBackup(job(), { db, store });
  // The damage: the player is overwritten, his note and his file are gone.
  db.docs.set('players/p1', { name: 'טעות' });
  db.docs.delete('players/p1/notes/n1');
  for (const k of ['files/f1', 'files/f1/chunks/0', 'files/f1/chunks/1']) db.docs.delete(k);
  db.docs.set('players/p2', { name: 'Rafael Libsman', club: 'changed after the backup' });

  const ref = db.collection('backups').doc(id);
  const { index } = await B.loadIndex(ref, db.docs.get(`backups/${id}`));
  assert.deepEqual(B.findRecords(index, 'איתן'), [{ path: 'players/p1', collection: 'players', id: 'p1', name: 'איתן רוזן' }]);
  assert.equal(B.findRecords(index, 'f1').length, 0, 'files are not offered as records');

  const r = await B.restoreRecord({ backupId: id, path: 'players/p1', by: { email: 'lou@example.com', name: 'Lou' }, db });
  assert.equal(r.written, 5);
  assert.equal(r.files, 1);
  const p1 = db.docs.get('players/p1');
  assert.equal(p1.name, 'איתן רוזן');
  assert.equal(p1.contractEnd.toMillis(), Date.parse('2027-06-30T00:00:00Z'), 'a date comes back as a Firestore date');
  assert.equal(db.docs.get('players/p1/notes/n1').text, 'הערה 😀 עם אימוג׳י');
  assert.equal(db.docs.get('files/f1/chunks/1').data, 'REVG');
  assert.equal(db.docs.get('players/p2').club, 'changed after the backup', 'other records are not touched');
  const log = [...db.docs.entries()].find(([k, v]) => k.startsWith('audit/') && v.action === 'restore');
  assert.equal(log[1].docId, 'p1');
  assert.equal(log[1].by, 'lou@example.com');
  await assert.rejects(() => B.restoreRecord({ backupId: id, path: 'players/nobody', db }), /not in this backup/);
});

test('a full restore writes business data back, keeps live system state, and backs up first', async () => {
  const db = fakeDb(seed()); const store = fakeStore();
  const { id } = await B.runBackup(job(), { db, store });
  db.docs.set('players/p1', { name: 'טעות' });
  db.docs.delete('players/p2');
  db.docs.set('players/p3', { name: 'New after the backup' });
  db.docs.set('app_meta/whatsapp', { connected: true, stage: 'moved to 055' });
  db.docs.delete('audit/a1');

  const j = job();
  const r = await B.restoreAll({ backupId: id, by: { email: 'lou@example.com' }, job: j, store, db });
  assert.equal(db.docs.get('players/p1').name, 'איתן רוזן');
  assert.equal(db.docs.get('players/p2').club, 'Hapoel');
  assert.equal(db.docs.get('players/p3').name, 'New after the backup', 'nothing is deleted');
  assert.equal(db.docs.get('app_meta/whatsapp').stage, 'moved to 055', 'a live connection is not replaced by an old one');
  assert.equal(db.docs.get('audit/a1').docId, 'p1', 'missing system records come back');
  assert.equal(r.kept, 1);
  assert.ok(r.before && r.before !== id, 'a backup was taken before the restore');
  assert.equal(db.docs.get(`backups/${r.before}`).reason, 'before-restore');
  assert.equal(backupsOf(db).length, 2);
});

test('a full restore refuses a damaged backup before changing anything', async () => {
  const db = fakeDb(seed()); const store = fakeStore();
  const { id } = await B.runBackup(job(), { db, store });
  db.docs.delete(`backups/${id}/chunks/0000`);
  db.docs.set('players/p1', { name: 'טעות' });
  await assert.rejects(() => B.restoreAll({ backupId: id, job: job(), store, db }), /cannot be read back in full/);
  assert.equal(db.docs.get('players/p1').name, 'טעות');
  assert.equal(backupsOf(db).length, 1, 'no backup-before-restore either');
});

test('everything can come back from the outside copy when the database is empty', async () => {
  const db = fakeDb(seed()); const store = fakeStore();
  const { offsite } = await B.runBackup(job(), { db, store });
  const empty = fakeDb({}, 'new');
  assert.deepEqual((await B.listOffsite(null, store)).map((c) => c.key), [offsite]);
  const r = await B.restoreAll({ offsiteKey: offsite, job: job(), store, db: empty });
  assert.equal(empty.docs.get('players/p1').name, 'איתן רוזן');
  assert.equal(empty.docs.get('app_meta/whatsapp').stage, 'live', 'system state comes back where it is missing');
  assert.equal(empty.docs.get('files/f1/chunks/0').data, 'QUJD');
  assert.equal(r.written, 8);
});

test('a backup from before the index (older format) can still give one record back', async () => {
  const db = fakeDb(seed()); const store = fakeStore();
  const { id } = await B.runBackup(job(), { db, store });
  const meta = db.docs.get(`backups/${id}`);
  delete meta.indexed; delete meta.sha256;
  for (const k of [...db.docs.keys()]) if (k.startsWith(`backups/${id}/index/`)) db.docs.delete(k);
  db.docs.set('players/p2', { name: 'wrong' });
  const r = await B.restoreRecord({ backupId: id, path: 'players/p2', db });
  assert.equal(r.written, 1);
  assert.equal(db.docs.get('players/p2').club, 'Hapoel');
  const big = await B.loadIndex(db.collection('backups').doc(id), { ...meta, chunks: 99 }, { maxLegacyChunks: 12 });
  assert.equal(big.legacy, true);
});

test('only the newest good backups are kept; failed attempts go after two days', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const day = 86400000;
  const list = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `ok${i}`, status: 'ok', startedAt: new Date(now - i * 7 * day).toISOString() })),
    { id: 'cut-today', status: 'running', startedAt: new Date(now - 3600000).toISOString() },
    { id: 'cut-old', status: 'running', startedAt: new Date(now - 3 * day).toISOString() },
    { id: 'err-old', status: 'error', startedAt: new Date(now - 9 * day).toISOString() },
  ];
  assert.deepEqual(B.pruneList(list, now).sort(), ['cut-old', 'err-old', 'ok8', 'ok9']);
});

test('the automatic backup is due when the newest good one is a week old, or there is none', () => {
  const now = Date.parse('2026-11-29T01:30:00Z');
  const at = (days) => new Date(now - days * 86400000).toISOString();
  assert.equal(B.isDue([], now), true);
  assert.equal(B.isDue([{ status: 'ok', verified: true, startedAt: at(7) }], now), true, 'the weekly run');
  assert.equal(B.isDue([{ status: 'ok', verified: true, startedAt: at(1) }], now), false);
  assert.equal(B.isDue([{ status: 'running', startedAt: at(1) }, { status: 'error', verified: false, startedAt: at(1) }, { status: 'ok', startedAt: at(8) }], now), true, 'a night that failed is made up for');
});

test('the admins are told when there is no good backup for more than a week', () => {
  const now = new Date('2026-11-25T09:00:00Z');
  const at = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  assert.equal(opsAlerts({ backups: [{ status: 'ok', verified: true, startedAt: at(3) }], now }).length, 0);
  assert.equal(opsAlerts({ backups: [{ status: 'ok', startedAt: at(6) }, { status: 'running', startedAt: at(1) }], now }).length, 0, 'an older backup without the check still counts');
  const stale = opsAlerts({ backups: [{ status: 'running', startedAt: at(3) }, { status: 'ok', verified: true, startedAt: at(10) }], now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].key, 'backup|2026-11-25');
  assert.match(stale[0].text, /מלפני 10 ימים/);
  const none = opsAlerts({ backups: [{ status: 'error', verified: false, startedAt: at(1) }], now });
  assert.match(none[0].text, /אין למערכת אף גיבוי תקין/);
  assert.equal(opsAlerts({ now }).length, 0, 'nothing is said when the backups could not be read');
});
