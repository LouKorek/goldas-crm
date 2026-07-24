import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  onSnapshot, query, serverTimestamp
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { USERS, OWNER_EMAIL } from './firebase';

// ── Session access (set by App.js after login) ───────────────────
// Single in-memory record of who is signed in and their role, so the write
// helpers below can enforce view-only access and stamp edits with a name.
let SESSION = { email: null, name: null, role: 'viewer' };
export const setSessionAccess = (a) => { SESSION = { ...SESSION, ...a }; };
export const clearSessionAccess = () => { SESSION = { email: null, name: null, role: 'viewer' }; };
export const canEditNow = () => SESSION.role === 'admin' || SESSION.role === 'manager';

export const currentUserMeta = () => {
  const email = auth.currentUser?.email || SESSION.email || 'unknown';
  const name  = SESSION.name || USERS[email]?.name || email;
  const role  = SESSION.role || USERS[email]?.role || 'viewer';
  return { email, name, role };
};

// Centralised in-app write guard. Throws for viewers so a read-only user can
// never create, edit, or delete records through the app's own code paths.
const assertCanEdit = () => {
  if (!canEditNow()) {
    throw new Error('View-only access: you do not have permission to make changes.');
  }
};

export const listenCollection = (path, callback) => {
  const q = query(collection(db, path));
  return onSnapshot(q,
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => { console.error('Firestore error:', path, err); callback([]); }
  );
};

export const addDoc_ = async (path, data) => {
  assertCanEdit();
  const { email, name } = currentUserMeta();
  const { id: _id, ...cleanData } = data; // strip any stray id field
  return addDoc(collection(db, path), {
    ...cleanData,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: email,
    lastEditedBy: email,
    lastEditedByName: name,
    lastEditedAt: serverTimestamp(),
  });
};

export const updateDoc_ = async (path, id, data) => {
  assertCanEdit();
  const { email, name } = currentUserMeta();
  return updateDoc(doc(db, path, id), {
    ...data,
    updatedAt: serverTimestamp(),
    lastEditedBy: email,
    lastEditedByName: name,
    lastEditedAt: serverTimestamp(),
  });
};

export const deleteDoc_ = (path, id) => { assertCanEdit(); return deleteDoc(doc(db, path, id)); };

// ── File storage (free, Firestore-only) ───────────────────────────
// Files are stored as base64 in their OWN documents, split into chunks, so we
// never exceed Firestore's 1 MB-per-document limit and never embed a large blob
// inside an array (which the server rejects with "invalid nested entity").
// The player/record only keeps a tiny reference: { fileId, name, size, type, … }.
const FILE_CHUNK = 600 * 1024;          // base64 chars per chunk doc (< 1 MB)
const FILE_MAX   = 15 * 1024 * 1024;    // 15 MB max original file size

export const uploadFile = (file, path, customName) => {
  return new Promise((resolve, reject) => {
    if (!canEditNow()) {
      reject(new Error('View-only access: you do not have permission to upload files.'));
      return;
    }
    if (file.size > FILE_MAX) {
      reject(new Error('File too large. Please use files under 15 MB.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onload = async (e) => {
      try {
        const dataUrl = e.target.result;               // "data:...;base64,...."
        const fileId  = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const owner   = currentUserMeta().email;
        const chunks  = [];
        for (let i = 0; i < dataUrl.length; i += FILE_CHUNK) {
          chunks.push(dataUrl.slice(i, i + FILE_CHUNK));
        }
        // Write each chunk as its own document, then the metadata doc last
        // (so a half-written file is never referenced).
        await Promise.all(chunks.map((data, i) =>
          setDoc(doc(db, 'files', fileId, 'chunks', String(i)), { data })
        ));
        await setDoc(doc(db, 'files', fileId), {
          name: customName || file.name,
          originalName: file.name,
          type: file.type,
          size: file.size,
          parts: chunks.length,
          uploadedAt: new Date().toISOString(),
          uploadedBy: owner,
        });
        resolve({
          fileId,
          name: customName || file.name,
          originalName: file.name,
          uploadedAt: new Date().toISOString(),
          uploadedBy: owner,
          size: file.size,
          type: file.type,
        });
      } catch (err) {
        reject(new Error(err?.message || 'Upload failed.'));
      }
    };
    reader.readAsDataURL(file);
  });
};

// Reassemble a stored file into its original base64 data URL.
export const loadFileData = async (fileId) => {
  const metaSnap = await getDoc(doc(db, 'files', fileId));
  if (!metaSnap.exists()) throw new Error('File not found.');
  const parts = metaSnap.data().parts || 0;
  let out = '';
  for (let i = 0; i < parts; i++) {
    const cs = await getDoc(doc(db, 'files', fileId, 'chunks', String(i)));
    if (!cs.exists()) throw new Error('File is incomplete.');
    out += cs.data().data;
  }
  return out;
};

// Resolve a file reference (new chunked shape OR legacy { url } shape) to a
// usable data URL for viewing/downloading.
export const resolveFileUrl = async (ref) => {
  if (!ref) return null;
  if (ref.url) return ref.url;            // legacy: base64 stored inline
  if (ref.fileId) return loadFileData(ref.fileId);
  return null;
};

export const PATHS = {
  PLAYERS:           'players',
  PIPELINE_MEN:      'pipeline_men',
  PIPELINE_WOMEN:    'pipeline_women',
  PIPELINE_YOUTH:    'pipeline_youth',
  PIPELINE_JEWISH:   'pipeline_jewish',
  CLUB_REQUIREMENTS: 'club_requirements',
  MATCHES:           'matches',
  CONTACTS:          'contacts',
  APP_USERS:         'app_users',
  TASKS:             'tasks',
  TM_WATCH:          'tmWatch',
};

// ── User management (app_users collection) ────────────────────────
// Each doc is keyed by the user's email and holds { email, name, role,
// active }. The owner is always an admin and is ensured/seeded on login.
const USERS_COL = PATHS.APP_USERS;
const normEmail = (e) => String(e || '').trim().toLowerCase();

// Resolve a signed-in email to their access record. The owner is always an
// active admin; everyone else must have an active app_users doc.
export const fetchUserAccess = async (email) => {
  const e = normEmail(email);
  if (e === normEmail(OWNER_EMAIL)) {
    return { allowed: true, role: 'admin', name: USERS[OWNER_EMAIL]?.name || 'Owner', email: e };
  }
  try {
    const snap = await getDoc(doc(db, USERS_COL, e));
    if (snap.exists()) {
      const d = snap.data();
      if (d.active === false) return { allowed: false };
      return { allowed: true, role: d.role || 'viewer', name: d.name || e, email: e };
    }
  } catch (err) {
    console.error('fetchUserAccess error:', err);
  }
  return { allowed: false };
};

// Seed the collection the first time the owner signs in: ensure the owner's
// admin doc and the legacy users exist. Safe to call repeatedly — it only
// creates docs that are missing and never overwrites an existing one.
export const ensureSeedUsers = async () => {
  for (const [email, info] of Object.entries(USERS)) {
    const e = normEmail(email);
    try {
      const ref = doc(db, USERS_COL, e);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          email: e, name: info.name, role: info.role, active: true,
          addedBy: normEmail(OWNER_EMAIL), addedAt: serverTimestamp(),
        });
      }
    } catch (err) { console.error('ensureSeedUsers error:', err); }
  }
};

export const listenAppUsers = (callback) =>
  onSnapshot(query(collection(db, USERS_COL)),
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => { console.error('app_users listen error:', err); callback([]); });

// Admin-only writes. Guarded so only an admin session can manage users.
const assertAdmin = () => {
  if (SESSION.role !== 'admin') throw new Error('Only an admin can manage users.');
};

export const addAppUser = async ({ email, name, role, emailAlerts }) => {
  assertAdmin();
  const e = normEmail(email);
  if (!e) throw new Error('Email is required.');
  if (e === normEmail(OWNER_EMAIL)) throw new Error('The owner already has full access.');
  const r = role === 'manager' ? 'manager' : 'viewer';
  await setDoc(doc(db, USERS_COL, e), {
    email: e, name: (name || '').trim() || e, role: r, active: true,
    emailAlerts: emailAlerts !== false,   // default true
    addedBy: SESSION.email, addedAt: serverTimestamp(),
  }, { merge: true });
};

// Toggle the "receive email alerts" flag for any user — including the owner —
// without going through the general updateAppUser (which forbids editing the
// owner's role/name).
export const setUserEmailAlerts = async (email, enabled) => {
  assertAdmin();
  const e = normEmail(email);
  if (!e) throw new Error('Email is required.');
  await updateDoc(doc(db, USERS_COL, e), {
    emailAlerts: !!enabled, updatedAt: serverTimestamp(),
  });
};

export const updateAppUser = async (email, data) => {
  assertAdmin();
  const e = normEmail(email);
  if (e === normEmail(OWNER_EMAIL)) throw new Error('The owner cannot be modified.');
  await updateDoc(doc(db, USERS_COL, e), { ...data, updatedAt: serverTimestamp() });
};

export const removeAppUser = async (email) => {
  assertAdmin();
  const e = normEmail(email);
  if (e === normEmail(OWNER_EMAIL)) throw new Error('The owner cannot be removed.');
  await deleteDoc(doc(db, USERS_COL, e));
};
