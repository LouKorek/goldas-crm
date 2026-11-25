// Where Golda keeps what she is about to change on the website, and what she
// published.
//
//   website_drafts/{writer}            the changes waiting for the writer's yes
//       { changes, changedTurn, changedAt, by, undoArmed }
//     /photos/{player-slug}            a card photo made for one of the changes
//       { path, b64, cutout, at }
//   website_publishes/{id}             every publish, with the site's list of
//       { at, by, deployId, lines, …   files before and after it (the undo)
//         before, after, undone }
//   app_meta/website                   what the app shows: the last publish,
//                                      the recent ones, the connection check
//
// Nothing here is a secret: the photos are about to be public and the lists
// hold only file fingerprints.
const DRAFTS = 'website_drafts';
const PUBLISHES = 'website_publishes';
const RECENT = 10;

const key = (email) => String(email || '').trim().toLowerCase().replace(/\//g, '_') || 'unknown';
const photoId = (path) => String(path).replace(/^\//, '').replace(/\.jpg$/, '');
// Firestore refuses `undefined`; a change carries only what was said.
const plain = (o) => JSON.parse(JSON.stringify(o));
const metaRef = (db) => db.collection('app_meta').doc('website');

async function getDraft(db, email) {
  const ref = db.collection(DRAFTS).doc(key(email));
  const snap = await ref.get();
  const d = snap.exists ? snap.data() : {};
  return { ref, changes: Array.isArray(d.changes) ? d.changes : [], changedTurn: d.changedTurn ?? null, changedAt: d.changedAt || null, undoArmed: d.undoArmed || null };
}

async function saveDraft(draft, { changes, turn, by }) {
  await draft.ref.set({ changes: plain(changes), changedTurn: turn, changedAt: Date.now(), by: plain(by), undoArmed: null });
}

async function putPhoto(draft, path, { bytes, cutout }) {
  await draft.ref.collection('photos').doc(photoId(path)).set({ path, b64: Buffer.from(bytes).toString('base64'), cutout: !!cutout, at: Date.now() });
}
const dropPhoto = (draft, path) => draft.ref.collection('photos').doc(photoId(path)).delete();

/** Map(path → Buffer) of the stored photos among these paths. */
async function loadPhotos(draft, paths) {
  const out = new Map();
  await Promise.all([...new Set(paths)].map(async (path) => {
    const s = await draft.ref.collection('photos').doc(photoId(path)).get();
    if (s.exists && s.data().b64) out.set(path, Buffer.from(s.data().b64, 'base64'));
  }));
  return out;
}

/** Empty the draft: its photos, then the draft itself. */
async function clearDraft(draft) {
  const photos = await draft.ref.collection('photos').get();
  await Promise.all(photos.docs.map((d) => d.ref.delete()));
  await draft.ref.delete();
}

const armUndo = (draft, id, turn) => draft.ref.set({ undoArmed: { id, turn } }, { merge: true });

async function getMeta(db) {
  const s = await metaRef(db).get();
  return s.exists ? s.data() : {};
}
const saveMeta = (db, patch) => metaRef(db).set(plain(patch), { merge: true });

/** Keep a publish (or an undo, which is a publish too) and show it in the app. */
async function recordPublish(db, { by, deployId, lines, before, after, playerCount, undoOf = null }) {
  const at = Date.now();
  const ref = await db.collection(PUBLISHES).add(plain({
    at, by, deployId, lines, playerCount: playerCount ?? null, undoOf, undone: false,
    // File paths ("/index.html") are not field names: the lists are kept as text.
    before: JSON.stringify(before), after: JSON.stringify(after),
  }));
  const entry = { id: ref.id, at, by: by?.name || by?.email || '', lines, undoOf, undone: false };
  const meta = await getMeta(db);
  const recent = [entry, ...(Array.isArray(meta.recent) ? meta.recent : [])].slice(0, RECENT);
  await saveMeta(db, { last: entry, recent, ...(playerCount != null ? { playerCount } : {}) });
  return entry;
}

async function getPublish(db, id) {
  const s = await db.collection(PUBLISHES).doc(id).get();
  if (!s.exists) return null;
  const d = s.data();
  return { id: s.id, ...d, before: JSON.parse(d.before || '{}'), after: JSON.parse(d.after || '{}') };
}

async function markUndone(db, id) {
  await db.collection(PUBLISHES).doc(id).set({ undone: true, undoneAt: Date.now() }, { merge: true });
  const meta = await getMeta(db);
  const flag = (e) => (e && e.id === id ? { ...e, undone: true } : e);
  await saveMeta(db, { last: flag(meta.last) || null, recent: (meta.recent || []).map(flag) });
}

module.exports = { getDraft, saveDraft, putPhoto, dropPhoto, loadPhotos, clearDraft, armUndo, getMeta, saveMeta, recordPublish, getPublish, markUndone, photoId };
