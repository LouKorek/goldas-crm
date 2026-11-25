// The backup of the whole database, its own check, and the way back.
//
// A backup is JSON Lines (format jsonl-v1): one line per document,
//   { "p": "players/abc", "d": { ...fields } }
// with Firestore types written as { __ts }, { __geo }, { __ref }, { __b64 }.
// It is kept in Firestore itself under backups/{id}:
//   chunks/{0000..}  { i, text, from, to }   the text in pieces under 1 MB
//   index/{0000..}   { i, text }             where each record starts and ends
// and a second, compressed copy goes to Netlify's own storage (Blobs), so a
// backup survives even if the database is lost.
//
// A backup counts only after it has been read back and compared with what
// was written (verifyBackup). Restoring writes documents back exactly as
// they were; documents created after the backup are never deleted.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { admin, getDb } = require('./firestore.js');

const KEEP = 8;
// Soft-deleted records (the recycle bin) are purged for good this many days
// after deletion, after they have been in at least one weekly backup.
const RECYCLE_DAYS = 30;
const RECYCLE_COLLECTIONS = ['players', 'clubs', 'deals', 'club_requirements', 'contacts', 'matches', 'tasks', 'trainings'];
// A Firestore document holds 1 MiB at most, counted in UTF-8 bytes (Hebrew is
// two bytes a letter), so the text is cut by bytes, not by characters.
const CHUNK_BYTES = 900_000;
const SKIP = new Set(['backups', 'internal_nonces', 'jobs', 'wa_inbox']);
const MAX_TOTAL_CHARS = 150_000_000; // ~150 MB of JSON; beyond that the backup is marked partial
// With no good backup for this long, the admins are told (the schedule is weekly).
const STALE_DAYS = 8;
// What a person looks for when one record has to come back.
const RECORD_COLLECTIONS = ['players', 'clubs', 'contacts', 'deals', 'club_requirements', 'tasks', 'matches', 'trainings', 'meetings', 'interactions'];
// The system's own state (keys, connections, logs). A full restore puts back
// only what is missing there, so a week-old connection never replaces a live one.
const SYSTEM_COLLECTIONS = new Set(['app_meta', 'app_secrets', 'audit', 'wa_sessions', 'wa_outbox', 'wa_contacts', 'meta_oauth_states', 'client_errors']);
const OFFSITE_STORE = 'crm-backups';
const GOOD = new Set(['ok', 'partial', 'done']);

const pad = (n) => String(n).padStart(4, '0');
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const millis = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v ? Date.parse(v) || Number(v) || 0 : 0);

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

/** The opposite of toPlain: a backup line's data as Firestore values again. */
const revive = (v, db) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => revive(x, db));
  const keys = Object.keys(v);
  if (keys.length === 1) {
    if (keys[0] === '__ts') return admin.firestore.Timestamp.fromMillis(v.__ts);
    if (keys[0] === '__geo') return new admin.firestore.GeoPoint(v.__geo[0], v.__geo[1]);
    if (keys[0] === '__b64') return Buffer.from(v.__b64, 'base64');
    if (keys[0] === '__ref') return db.doc(v.__ref);
  }
  const o = {}; for (const k of keys) o[k] = revive(v[k], db); return o;
};

/** Cut text into pieces of at most maxBytes UTF-8 bytes, never inside a character. */
function splitForFirestore(text, maxBytes = CHUNK_BYTES) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let n = Math.min(maxBytes, text.length - i);
    let part = text.slice(i, i + n);
    let bytes = Buffer.byteLength(part, 'utf8');
    while (bytes > maxBytes) {
      n = Math.max(1, Math.min(n - 1, Math.floor((n * maxBytes) / bytes)));
      part = text.slice(i, i + n);
      bytes = Buffer.byteLength(part, 'utf8');
    }
    // An emoji is two code units; a piece must not end on the first of them.
    const last = part.charCodeAt(part.length - 1);
    if (last >= 0xd800 && last <= 0xdbff && part.length > 1 && i + part.length < text.length) part = part.slice(0, -1);
    parts.push(part);
    i += part.length;
  }
  return parts;
}

/** A short name for a record, for the person choosing what to restore. */
function labelOf(d) {
  if (!d || typeof d !== 'object') return '';
  const full = [d.firstName, d.lastName].filter(Boolean).join(' ');
  const v = d.name || d.fullName || full || d.title || d.playerName || d.clubName || d.club || d.subject || d.email || '';
  return typeof v === 'string' ? v.slice(0, 120) : '';
}

/**
 * Where each top-level document starts and ends in the text. Its
 * subcollections follow it directly, so [s, e) is the whole record.
 */
function indexText(text) {
  const index = [];
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    // The path is the first field of the line: {"p":"players/abc","d":{...
    const m = /^\{"p":"([^"]+)"/.exec(text.slice(at, Math.min(end, at + 600)));
    if (m && m[1].split('/').length === 2) {
      let label = '';
      if (RECORD_COLLECTIONS.includes(m[1].split('/')[0])) { try { label = labelOf(JSON.parse(text.slice(at, end)).d); } catch { /* the check reports it */ } }
      index.push({ p: m[1], n: label, s: at });
    }
    at = end + 1;
  }
  return closeIndex(index, text.length);
}
const closeIndex = (index, total) => index.map((x, i) => ({ ...x, e: i + 1 < index.length ? index[i + 1].s : total }));

/** Records whose name or id holds the words, from the collections people restore. */
function findRecords(index, q, limit = 40) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const x of index) {
    const [col, id] = x.p.split('/');
    if (!RECORD_COLLECTIONS.includes(col)) continue;
    const hay = `${x.n} ${id} ${col}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    out.push({ path: x.p, collection: col, id, name: x.n || '' });
    if (out.length >= limit) break;
  }
  return out;
}

/** Which backups to delete: all but the newest KEEP good ones, and failed attempts after two days. */
function pruneList(backups, now = Date.now()) {
  const sorted = [...backups].sort((a, b) => millis(b.startedAt) - millis(a.startedAt));
  const good = sorted.filter((b) => GOOD.has(b.status));
  const drop = good.slice(KEEP).map((b) => b.id);
  for (const b of sorted) if (!GOOD.has(b.status) && now - millis(b.startedAt) > 2 * 86400000) drop.push(b.id);
  return drop;
}

/** Is there a good, checked backup recent enough? For the admins' operations alert. */
function backupHealth(backups, now = Date.now()) {
  const good = [...(backups || [])].filter((b) => GOOD.has(b.status) && b.verified !== false)
    .sort((a, b) => millis(b.startedAt) - millis(a.startedAt))[0];
  if (!good) return { ok: false, lastGoodAt: null, ageDays: null };
  const at = millis(good.finishedAt) || millis(good.startedAt);
  const ageDays = Math.floor((now - at) / 86400000);
  return { ok: ageDays < STALE_DAYS, lastGoodAt: at, ageDays, offsite: !!good.offsite };
}

/**
 * Is it time for the automatic backup? It is asked every night and runs when
 * the newest good backup is about a week old or there is none, so a night
 * that failed is made up for the next night instead of the next week.
 */
function isDue(backups, now = Date.now()) {
  const h = backupHealth(backups, now);
  return !h.lastGoodAt || now - h.lastGoodAt >= 6.5 * 86400000;
}

// ── Writing a backup ────────────────────────────────────────────────
async function dumpCollection(col, out, state, depth = 0) {
  const docs = (await col.get()).docs;
  for (let i = 0; i < docs.length; i += 25) {
    const group = docs.slice(i, i + 25);
    // Asking each document for its subcollections is the slow part; 25 at a time.
    const subs = await Promise.all(group.map((d) => d.ref.listCollections()));
    for (let k = 0; k < group.length; k++) {
      const d = group[k];
      const data = d.data();
      const line = JSON.stringify({ p: d.ref.path, d: toPlain(data) }) + '\n';
      if (state.chars + line.length > MAX_TOTAL_CHARS) { state.partial = true; return; }
      if (depth === 0) state.index.push({ p: d.ref.path, n: RECORD_COLLECTIONS.includes(col.id) ? labelOf(data) : '', s: state.chars });
      state.chars += line.length; state.docs += 1;
      out.push(line);
      for (const s of subs[k]) { await dumpCollection(s, out, state, depth + 1); if (state.partial) return; }
    }
  }
}

/** Read a backup back from Firestore and compare it with what was meant to be written. */
async function verifyBackup(ref, { chunks, docs, chars, sha256 }) {
  const hash = crypto.createHash('sha256');
  let carry = ''; let lines = 0; let total = 0;
  for (let n = 0; n < chunks; n++) {
    const snap = await ref.collection('chunks').doc(pad(n)).get();
    if (!snap.exists) return { ok: false, error: `piece ${n} of ${chunks} is missing` };
    const t = snap.data().text || '';
    hash.update(t, 'utf8'); total += t.length;
    const buf = carry + t;
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) { carry = buf; continue; }
    for (const l of buf.slice(0, cut).split('\n')) {
      if (!l) continue;
      let row;
      try { row = JSON.parse(l); } catch { return { ok: false, error: `line ${lines + 1} cannot be read back` }; }
      if (!row || typeof row.p !== 'string' || !row.d) return { ok: false, error: `line ${lines + 1} has no document` };
      lines++;
    }
    carry = buf.slice(cut + 1);
  }
  if (carry) return { ok: false, error: 'the last line is cut' };
  if (total !== chars) return { ok: false, error: `read back ${total} characters, wrote ${chars}` };
  if (lines !== docs) return { ok: false, error: `read back ${lines} documents, wrote ${docs}` };
  if (sha256 && hash.digest('hex') !== sha256) return { ok: false, error: 'the text read back differs from the text written' };
  return { ok: true, lines };
}

// ── The copy outside the database (Netlify Blobs) ───────────────────
function offsiteStore(event) {
  const blobs = require('@netlify/blobs');
  if (event && event.blobs) blobs.connectLambda(event);
  return blobs.getStore(OFFSITE_STORE);
}
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gzipParts = (parts) => new Promise((resolve, reject) => {
  const gz = zlib.createGzip({ level: 6 });
  const out = [];
  gz.on('data', (c) => out.push(c)); gz.on('error', reject); gz.on('end', () => resolve(Buffer.concat(out)));
  for (const p of parts) gz.write(Buffer.from(p, 'utf8'));
  gz.end();
});

async function saveOffsite(parts, meta, event, store = null) {
  const s = store || offsiteStore(event);
  const body = await gzipParts(parts);
  const key = `${new Date(meta.startedAtMs).toISOString().slice(0, 10)}_${meta.id}.jsonl.gz`;
  await s.set(key, toArrayBuffer(body), { metadata: { id: meta.id, docs: meta.docs, chars: meta.chars, sha256: meta.sha256, startedAt: meta.startedAtMs } });
  const { blobs = [] } = await s.list();
  const old = blobs.map((b) => b.key).filter((k) => k.endsWith('.jsonl.gz')).sort().reverse().slice(KEEP);
  for (const k of old) await s.delete(k).catch(() => {});
  return { key, bytes: body.length };
}

async function listOffsite(event, store = null) {
  const s = store || offsiteStore(event);
  const { blobs = [] } = await s.list();
  return blobs.map((b) => b.key).filter((k) => k.endsWith('.jsonl.gz')).sort().reverse()
    .map((key) => ({ key, date: key.slice(0, 10), id: key.slice(11).replace(/\.jsonl\.gz$/, '') }));
}

async function readOffsite(key, event, store = null) {
  const s = store || offsiteStore(event);
  const data = await s.get(key, { type: 'arrayBuffer' });
  if (!data) throw new Error(`no outside copy named ${key}`);
  return zlib.gunzipSync(Buffer.from(data)).toString('utf8');
}

async function deleteBackup(db, ref) {
  for (const sub of ['chunks', 'index']) {
    const docs = (await ref.collection(sub).get()).docs;
    for (let i = 0; i < docs.length; i += 300) {
      const batch = db.batch();
      docs.slice(i, i + 300).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await ref.delete();
}

/**
 * Take a backup, read it back, copy it outside the database, prune old ones.
 * Throws when the backup did not pass its own check, so the run shows as failed.
 */
async function runBackup(job, { event = null, prune = true, offsite: copyOut = true, reason = '', store = null, db = getDb() } = {}) {
  const ref = db.collection('backups').doc();
  const startedAt = admin.firestore.Timestamp.now();
  await ref.set({ status: 'running', startedAt, ...(reason ? { reason } : {}) });
  try {
    const cols = (await db.listCollections()).filter((c) => !SKIP.has(c.id));
    let out = []; const state = { chars: 0, docs: 0, partial: false, index: [] };
    for (const c of cols) {
      await dumpCollection(c, out, state);
      job.note(`${c.id}: ${state.docs} docs so far`);
      if (state.partial) break;
    }
    const text = out.join('');
    out = null;
    const sha256 = sha(text);
    const parts = splitForFirestore(text);
    let from = 0;
    for (let n = 0; n < parts.length; n++) {
      await ref.collection('chunks').doc(pad(n)).set({ i: n, text: parts[n], from, to: from + parts[n].length });
      from += parts[n].length;
    }
    const index = closeIndex(state.index, text.length);
    const indexParts = splitForFirestore(JSON.stringify(index));
    for (let n = 0; n < indexParts.length; n++) await ref.collection('index').doc(pad(n)).set({ i: n, text: indexParts[n] });

    const check = await verifyBackup(ref, { chunks: parts.length, docs: state.docs, chars: text.length, sha256 });
    job.note(check.ok ? `read back and compared: ${check.lines} documents` : `check failed: ${check.error}`);

    let offsite = null; let offsiteError = null;
    if (check.ok && copyOut) {
      try { offsite = await saveOffsite(parts, { id: ref.id, startedAtMs: startedAt.toMillis(), docs: state.docs, chars: text.length, sha256 }, event, store); job.note(`outside copy: ${offsite.key} (${offsite.bytes} bytes)`); }
      catch (e) { offsiteError = String(e && e.message || e).slice(0, 300); job.note(`outside copy failed: ${offsiteError}`); }
    }
    await ref.set({
      status: !check.ok ? 'error' : state.partial ? 'partial' : 'ok', startedAt, finishedAt: admin.firestore.Timestamp.now(),
      collections: cols.map((c) => c.id), docs: state.docs, chars: text.length, chunks: parts.length, format: 'jsonl-v1',
      indexed: index.length, sha256, verified: check.ok, verifiedAt: admin.firestore.Timestamp.now(),
      ...(check.ok ? {} : { error: check.error }), offsite: offsite ? { ...offsite, at: admin.firestore.Timestamp.now() } : null, offsiteError,
    }, { merge: true });
    if (!check.ok) throw new Error(`the backup did not pass its own check: ${check.error}`);

    let pruned = 0;
    if (prune) {
      const all = (await db.collection('backups').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
      for (const id of pruneList(all).filter((x) => x !== ref.id)) { await deleteBackup(db, db.collection('backups').doc(id)); pruned++; }
    }
    return { id: ref.id, docs: state.docs, chunks: parts.length, chars: text.length, partial: state.partial, verified: true, offsite: offsite ? offsite.key : null, offsiteError, pruned };
  } catch (e) {
    await ref.set({ status: 'error', error: String(e && e.message || e).slice(0, 500), finishedAt: admin.firestore.Timestamp.now() }, { merge: true }).catch(() => {});
    throw e;
  }
}

// Recycle-bin items deleted more than RECYCLE_DAYS ago are removed, now that
// the backup just taken holds them.
async function purgeRecycleBin(job, db = getDb()) {
  const cutoff = Date.now() - RECYCLE_DAYS * 86400000;
  let purged = 0;
  for (const col of RECYCLE_COLLECTIONS) {
    const snap = await db.collection(col).where('deletedAt', '!=', null).get().catch(() => null);
    if (!snap) continue;
    const old = snap.docs.filter((d) => { const t = d.data().deletedAt; const ms = t?.toMillis?.() || Date.parse(t) || 0; return ms && ms < cutoff; });
    for (let i = 0; i < old.length; i += 400) {
      const batch = db.batch();
      old.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    purged += old.length;
    if (old.length) job.note(`${col}: purged ${old.length} from the recycle bin`);
  }
  return purged;
}

// ── Reading a backup ────────────────────────────────────────────────
async function readAllText(ref) {
  const docs = (await ref.collection('chunks').orderBy('i').get()).docs;
  return docs.map((d) => d.data().text || '').join('');
}

/** The record index of a backup; backups from before the index are read whole (small ones only, when asked). */
async function loadIndex(ref, meta, { maxLegacyChunks = Infinity } = {}) {
  if (meta.indexed) {
    const docs = (await ref.collection('index').orderBy('i').get()).docs;
    return { index: JSON.parse(docs.map((d) => d.data().text || '').join('') || '[]'), text: null };
  }
  if ((meta.chunks || 0) > maxLegacyChunks) return { index: null, text: null, legacy: true };
  const text = await readAllText(ref);
  return { index: indexText(text), text };
}

/** The text between two offsets, reading only the pieces that hold it. */
async function readRange(ref, s, e) {
  const docs = (await ref.collection('chunks').where('to', '>', s).orderBy('to').get()).docs;
  let out = '';
  for (const d of docs) {
    const c = d.data();
    if (c.from >= e) break;
    out += c.text.slice(Math.max(0, s - c.from), Math.min(c.text.length, e - c.from));
  }
  return out;
}

const parseLines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r && r.p && r.d);

/** Write backup rows back, in batches small enough for one request. */
async function writeRows(db, rows) {
  let batch = db.batch(); let n = 0; let size = 0; let written = 0;
  const flush = async () => { if (n) { await batch.commit(); written += n; batch = db.batch(); n = 0; size = 0; } };
  for (const r of rows) {
    const weight = JSON.stringify(r.d).length;
    if (n && (n >= 200 || size + weight > 4_000_000)) await flush();
    batch.set(db.doc(r.p), revive(r.d, db));
    n++; size += weight;
  }
  await flush();
  return written;
}

const audit = (db, by, entry) => db.collection('audit').add({
  action: 'restore', via: 'backup', by: by?.email || 'system', byName: by?.name || by?.email || 'system',
  at: admin.firestore.FieldValue.serverTimestamp(), ...entry,
}).catch(() => {});

/**
 * Put one record back as it was in a backup: the document, everything under
 * it, and the files it points to that no longer exist.
 */
async function restoreRecord({ backupId, path, by, db = getDb() }) {
  const ref = db.collection('backups').doc(backupId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('the backup was not found');
  const meta = snap.data();
  const { index, text } = await loadIndex(ref, meta);
  const range = async (x) => (text ? text.slice(x.s, x.e) : readRange(ref, x.s, x.e));
  const entry = index.find((x) => x.p === path);
  if (!entry) throw new Error(`${path} is not in this backup`);
  const own = await range(entry);
  const rows = parseLines(own);
  const fileIds = [...new Set([...own.matchAll(/"fileId":"([^"]+)"/g)].map((m) => m[1]))];
  let files = 0;
  for (const id of fileIds) {
    const f = index.find((x) => x.p === `files/${id}`);
    if (!f || (await db.doc(`files/${id}`).get()).exists) continue;
    rows.push(...parseLines(await range(f)));
    files++;
  }
  const written = await writeRows(db, rows);
  const [collection, docId] = path.split('/');
  await audit(db, by, { collection, docId, docName: entry.n || '', summary: `שוחזר מגיבוי ${new Date(millis(meta.startedAt)).toISOString().slice(0, 10)} (${written} מסמכים${files ? `, ${files} קבצים` : ''})`, backupId });
  return { path, name: entry.n || '', written, files };
}

/** Go over a backup line by line without holding more than one piece of it. */
async function eachLine(ref, meta, fn) {
  let carry = '';
  for (let n = 0; n < (meta.chunks || 0); n++) {
    const snap = await ref.collection('chunks').doc(pad(n)).get();
    if (!snap.exists) throw new Error(`piece ${n} of the backup is missing`);
    const buf = carry + (snap.data().text || '');
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) { carry = buf; continue; }
    for (const l of buf.slice(0, cut).split('\n')) if (l) await fn(JSON.parse(l));
    carry = buf.slice(cut + 1);
  }
  if (carry) await fn(JSON.parse(carry));
}

/**
 * Put everything back from a backup (or from an outside copy). Business data
 * is written as it was; the system's own state only where it is missing.
 * A fresh backup is taken first, so the restore itself can be undone (kept in
 * the database only: the outside copies stay the weekly ones).
 */
async function restoreAll({ backupId = null, offsiteKey = null, by, job, event = null, store = null, safety = true, db = getDb() }) {
  let before = null;
  // A backup that cannot be read back in full is refused before anything is written.
  if (backupId) {
    const ref = db.collection('backups').doc(backupId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('the backup was not found');
    const check = await verifyBackup(ref, snap.data());
    if (!check.ok) throw new Error(`this backup cannot be read back in full (${check.error}); nothing was changed`);
  }
  if (safety) {
    try { before = (await runBackup(job, { event, prune: false, offsite: false, reason: 'before-restore', store, db })).id; job.note(`backup before the restore: ${before}`); }
    catch (e) { if (!offsiteKey) throw new Error(`the backup before the restore failed, nothing was changed: ${e.message}`); job.note(`backup before the restore failed: ${e.message}`); }
  }
  const counts = {}; let kept = 0; let written = 0;
  let pending = []; let pendingSystem = [];
  const flush = async () => { if (pending.length) { written += await writeRows(db, pending); pending = []; } };
  const flushSystem = async () => {
    if (!pendingSystem.length) return;
    const snaps = await db.getAll(...pendingSystem.map((r) => db.doc(r.p)));
    const missing = pendingSystem.filter((r, i) => !snaps[i].exists);
    kept += pendingSystem.length - missing.length;
    written += await writeRows(db, missing);
    for (const r of missing) counts[r.p.split('/')[0]] = (counts[r.p.split('/')[0]] || 0) + 1;
    pendingSystem = [];
  };
  let weight = 0;
  const take = async (row) => {
    if (!row || !row.p || !row.d) return;
    const col = row.p.split('/')[0];
    if (SKIP.has(col)) return;
    if (SYSTEM_COLLECTIONS.has(col)) { pendingSystem.push(row); if (pendingSystem.length >= 200) await flushSystem(); return; }
    pending.push(row); counts[col] = (counts[col] || 0) + 1;
    weight += JSON.stringify(row.d).length;
    if (pending.length >= 200 || weight > 20_000_000) { await flush(); weight = 0; job.note(`${written} documents written`); }
  };
  let source;
  if (offsiteKey) {
    source = offsiteKey;
    for (const l of (await readOffsite(offsiteKey, event, store)).split('\n')) if (l) await take(JSON.parse(l));
  } else {
    const ref = db.collection('backups').doc(backupId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('the backup was not found');
    source = `${new Date(millis(snap.data().startedAt)).toISOString().slice(0, 10)} (${backupId})`;
    await eachLine(ref, snap.data(), take);
  }
  await flush(); await flushSystem();
  await audit(db, by, { collection: '*', docId: backupId || offsiteKey, docName: 'כל המערכת', summary: `שחזור מלא מגיבוי ${source}: ${written} מסמכים נכתבו, ${kept} רשומות מערכת נשארו כמו שהן`, backupId: backupId || null, offsiteKey: offsiteKey || null, before });
  return { source, written, kept, counts, before };
}

module.exports = {
  KEEP, STALE_DAYS, RECORD_COLLECTIONS, SYSTEM_COLLECTIONS, CHUNK_BYTES,
  toPlain, revive, splitForFirestore, labelOf, indexText, findRecords, pruneList, backupHealth, isDue,
  runBackup, verifyBackup, purgeRecycleBin, loadIndex, readRange, restoreRecord, restoreAll,
  listOffsite, readOffsite, saveOffsite, offsiteStore,
};
