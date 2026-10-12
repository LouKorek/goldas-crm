// Weekly backup of the whole database into Firestore itself, as chunked JSON
// under `backups/{id}` (+ `chunks` subcollection), so a bad edit or a wrong
// "clear" can be undone without any outside storage. Keeps the last KEEP
// backups. Runs Sundays 01:30 UTC; can also be started by an admin.
//
// Each chunk is a document holding up to CHUNK_CHARS of the JSON text, well
// under Firestore's 1 MB document limit. Restore = concatenate chunks in
// order and JSON.parse (an admin tool for that comes with the ops phase).
const { schedule } = require('@netlify/functions');
const { admin, getDb } = require('./lib/firestore.js');
const { runJob } = require('./lib/jobs.js');

const KEEP = 8;
const CHUNK_CHARS = 800_000;
const SKIP = new Set(['backups', 'internal_nonces', 'jobs', 'wa_inbox']);
const MAX_TOTAL_CHARS = 150_000_000; // ~150 MB of JSON; beyond that the backup is marked partial

const toPlain = (v) => {
  if (v === null || v === undefined) return v;
  if (v instanceof admin.firestore.Timestamp) return { __ts: v.toMillis() };
  if (v instanceof admin.firestore.GeoPoint) return { __geo: [v.latitude, v.longitude] };
  if (v instanceof admin.firestore.DocumentReference) return { __ref: v.path };
  if (Buffer.isBuffer(v)) return { __b64: v.toString('base64') };
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object') {
    if (typeof v.toDate === 'function') return { __ts: v.toDate().getTime() };
    const o = {}; for (const k of Object.keys(v)) o[k] = toPlain(v[k]); return o;
  }
  return v;
};

async function dumpCollection(col, out, state) {
  const docs = await col.get();
  for (const d of docs.docs) {
    const line = JSON.stringify({ p: d.ref.path, d: toPlain(d.data()) }) + '\n';
    state.chars += line.length; state.docs += 1;
    if (state.chars > MAX_TOTAL_CHARS) { state.partial = true; return; }
    out.push(line);
    const subs = await d.ref.listCollections();
    for (const s of subs) await dumpCollection(s, out, state);
  }
}

async function runBackup(job) {
  const db = getDb();
  const ref = db.collection('backups').doc();
  const startedAt = admin.firestore.Timestamp.now();
  await ref.set({ status: 'running', startedAt });
  const cols = (await db.listCollections()).filter((c) => !SKIP.has(c.id));
  const out = []; const state = { chars: 0, docs: 0, partial: false };
  for (const c of cols) {
    await dumpCollection(c, out, state);
    job.note(`${c.id}: ${state.docs} docs so far`);
    if (state.partial) break;
  }
  const text = out.join('');
  let n = 0;
  for (let i = 0; i < text.length; i += CHUNK_CHARS, n++) {
    await ref.collection('chunks').doc(String(n).padStart(4, '0')).set({ i: n, text: text.slice(i, i + CHUNK_CHARS) });
  }
  await ref.set({
    status: state.partial ? 'partial' : 'ok', startedAt, finishedAt: admin.firestore.Timestamp.now(),
    collections: cols.map((c) => c.id), docs: state.docs, chars: text.length, chunks: n, format: 'jsonl-v1',
  }, { merge: true });

  // Prune: keep the newest KEEP backups.
  const all = await db.collection('backups').orderBy('startedAt', 'desc').get();
  for (const old of all.docs.slice(KEEP)) {
    const chunks = await old.ref.collection('chunks').get();
    const batch = db.batch();
    chunks.docs.forEach((c) => batch.delete(c.ref));
    batch.delete(old.ref);
    await batch.commit();
  }
  return { id: ref.id, docs: state.docs, chunks: n, chars: text.length, partial: state.partial, pruned: Math.max(0, all.size - KEEP) };
}

exports.handler = schedule('30 1 * * 0', async () => {
  try {
    const r = await runJob('backup-weekly', runBackup);
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.error('backup failed:', e);
    return { statusCode: 500, body: String(e) };
  }
});

exports._runBackup = runBackup;
