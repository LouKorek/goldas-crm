import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  onSnapshot, query, serverTimestamp
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { USERS } from './firebase';

export const currentUserMeta = () => {
  const email = auth.currentUser?.email || 'unknown';
  const user  = USERS[email] || { name: email, role: 'User' };
  return { email, name: user.name, role: user.role };
};

export const listenCollection = (path, callback) => {
  const q = query(collection(db, path));
  return onSnapshot(q,
    snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err  => { console.error('Firestore error:', path, err); callback([]); }
  );
};

export const addDoc_ = async (path, data) => {
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
  const { email, name } = currentUserMeta();
  return updateDoc(doc(db, path, id), {
    ...data,
    updatedAt: serverTimestamp(),
    lastEditedBy: email,
    lastEditedByName: name,
    lastEditedAt: serverTimestamp(),
  });
};

export const deleteDoc_ = (path, id) => deleteDoc(doc(db, path, id));

// ── File storage (free, Firestore-only) ───────────────────────────
// Files are stored as base64 in their OWN documents, split into chunks, so we
// never exceed Firestore's 1 MB-per-document limit and never embed a large blob
// inside an array (which the server rejects with "invalid nested entity").
// The player/record only keeps a tiny reference: { fileId, name, size, type, … }.
const FILE_CHUNK = 600 * 1024;          // base64 chars per chunk doc (< 1 MB)
const FILE_MAX   = 15 * 1024 * 1024;    // 15 MB max original file size

export const uploadFile = (file, path, customName) => {
  return new Promise((resolve, reject) => {
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
};
