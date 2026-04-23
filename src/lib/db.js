import {
  collection, doc, addDoc, updateDoc, deleteDoc,
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

// Upload file as base64 stored in Firestore (no Storage needed)
export const uploadFile = (file, path, customName) => {
  return new Promise((resolve, reject) => {
    // Check file size - limit to 900KB to stay within Firestore 1MB doc limit
    if (file.size > 900 * 1024) {
      reject(new Error('File too large. Please use files under 900KB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      resolve({
        url: e.target.result, // base64 data URL
        name: customName || file.name,
        originalName: file.name,
        uploadedAt: new Date().toISOString(),
        uploadedBy: currentUserMeta().email,
        size: file.size,
        type: file.type,
      });
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
};

export const PATHS = {
  PLAYERS:           'players',
  PIPELINE_MEN:      'pipeline_men',
  PIPELINE_WOMEN:    'pipeline_women',
  PIPELINE_YOUTH:    'pipeline_youth',
  PIPELINE_JEWISH:   'pipeline_jewish',
  CLUB_REQUIREMENTS: 'club_requirements',
  MATCHES:           'matches',
};
