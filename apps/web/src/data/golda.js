// Golda inside the app: her actions (from the one audit log), undo, the chat
// (through the same worker that serves WhatsApp) and each person's briefing
// preferences.
import { collection, doc, onSnapshot, query, where, updateDoc, deleteField, serverTimestamp } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { SOFT_DELETE, canEditNow, currentUserMeta, PATHS, updateUserPrefs } from 'lib/db';
import { callFunctionJson } from 'lib/api';

// Golda's old collection names map onto where the records live now.
export const PHYSICAL = { pipeline_men: 'players', pipeline_women: 'players', pipeline_youth: 'players', pipeline_jewish: 'players' };
const physical = (c) => PHYSICAL[c] || c;

/** Everything Golda changed, newest first (one listener, single-field filter). */
export const listenGoldaAudit = (callback) =>
  onSnapshot(query(collection(db, 'audit'), where('via', '==', 'golda')),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0))),
    (err) => { console.error('audit listen error:', err); callback([]); });

/** Reverse one of Golda's changes from the app, the way her own undo does. */
export const undoGoldaAction = async (entry) => {
  if (!canEditNow()) throw new Error('View-only access: you do not have permission to make changes.');
  if (entry.undone) return;
  const { email, name } = currentUserMeta();
  const ref = doc(db, physical(entry.collection), entry.docId);
  const stamp = { updatedAt: serverTimestamp(), lastEditedAt: serverTimestamp(), lastEditedBy: email, lastEditedByName: name };
  if (entry.action === 'create') {
    if (SOFT_DELETE.has(physical(entry.collection))) await updateDoc(ref, { deletedAt: serverTimestamp(), deletedBy: email, ...stamp });
    else { const { deleteDoc } = await import('firebase/firestore'); await deleteDoc(ref); }
  } else if (entry.action === 'delete') {
    const { setDoc } = await import('firebase/firestore');
    const { deletedAt: _a, deletedBy: _b, ...was } = entry.before || {};
    await setDoc(ref, { ...was, deletedAt: null, deletedBy: deleteField(), ...stamp }, { merge: true });
  } else {
    const restore = {};
    for (const [k, v] of Object.entries(entry.before || {})) restore[k] = v === null ? deleteField() : v;
    await updateDoc(ref, { ...restore, ...stamp });
  }
  await updateDoc(doc(db, 'audit', entry.id), { undone: true, undoneAt: serverTimestamp(), undoneBy: email });
};

/** Send a message to Golda from the app. Resolves with the inbox id to listen to. */
export const sendToGolda = async (text) => {
  const clientId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // A background function answers 202 at once; the reply lands in wa_inbox/{clientId}.
  await callFunctionJson('golda-chat-background', { method: 'POST', body: { text, clientId } });
  return clientId;
};

/** One queued app message: state and reply. */
export const listenInboxMessage = (id, callback) =>
  onSnapshot(doc(db, 'wa_inbox', id), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : null), (e) => console.error('inbox listen error:', e));

/** The current user's conversation with Golda (the "main" topic thread). */
export const listenGoldaThread = (sessionKey, callback) =>
  onSnapshot(doc(db, 'wa_sessions', sessionKey, 'threads', 'main'), (s) => callback(s.exists() ? (s.data().history || []) : []), (e) => { console.error('thread listen error:', e); callback([]); });

/** The session key the worker uses for this person (their number, or their email). */
export const sessionKeyFor = (user) => {
  const phone = String(user?.whatsapp || '').replace(/\D/g, '');
  return phone || `u_${String(user?.email || 'anon').replace(/[^a-z0-9]/gi, '_')}`;
};

/** My record on app_users (prefs live there). */
export const listenMyUser = (email, callback) =>
  onSnapshot(doc(db, PATHS.APP_USERS, String(email || '').toLowerCase()), (s) => callback(s.exists() ? { id: s.id, ...s.data() } : { email }), (e) => { console.error('user listen error:', e); callback({ email }); });

export const saveMyPrefs = (email, prefs) => updateUserPrefs(email, prefs);

/** The messages Golda could not handle lately (for the Actions tab). */
export const listenRecentInbox = (email, callback) =>
  onSnapshot(query(collection(db, 'wa_inbox'), where('email', '==', String(email || '').toLowerCase())),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50)),
    (e) => { console.error('inbox list error:', e); callback([]); });
