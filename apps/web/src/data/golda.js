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

/** My 👍 (1) / 👎 (-1) on one of Golda's answers, or 0 to take it back. */
export const sendGoldaFeedback = (inboxId, rating) =>
  callFunctionJson('golda-feedback', { method: 'POST', body: { inboxId, rating } });

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

/**
 * How Golda's proactive messages reach my number (lib/wa-outbox.js on the
 * server): when I last wrote to her (WhatsApp's 24-hour window), the last
 * delivery or failure, the re-engagement template, and the texts that wait.
 */
export const listenMyDelivery = (phone, callback) => {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) { callback(null); return () => {}; }
  let contact = null; let pending = [];
  const emit = () => callback({ contact, pending });
  const off1 = onSnapshot(doc(db, 'wa_contacts', p), (s) => { contact = s.exists() ? s.data() : {}; emit(); }, (e) => { console.error('contact listen error:', e); contact = {}; emit(); });
  const off2 = onSnapshot(query(collection(db, 'wa_outbox'), where('to', '==', p), where('state', '==', 'queued')),
    (snap) => { pending = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0)); emit(); },
    (e) => { console.error('outbox listen error:', e); pending = []; emit(); });
  return () => { off1(); off2(); };
};

/** Golda's re-engagement template status (app_meta/whatsapp.template, lib/wa-templates.js). */
export const listenWhatsappMeta = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'whatsapp'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('whatsapp meta listen error:', e); callback({}); });

/** The messages Golda could not handle lately (for the Actions tab). */
export const listenRecentInbox = (email, callback) =>
  onSnapshot(query(collection(db, 'wa_inbox'), where('email', '==', String(email || '').toLowerCase())),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50)),
    (e) => { console.error('inbox list error:', e); callback([]); });

// ── Voice notes ───────────────────────────────────────────────────
// Golda transcribes WhatsApp voice notes with Google Speech-to-Text on the
// gold-as-crm project. The server cannot switch that service on by itself, so
// an admin does it once from their own browser: one Google popup (Cloud
// scope), the API is enabled, the project's billing is linked when Google
// requires it (Speech-to-Text has 60 free minutes a month, then a few cents a
// minute), and the server checks that it now answers. No token leaves the browser.
const PROJECT = 'gold-as-crm';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function gFetch(token, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const billingProblem = (r) => /billing/i.test(`${r.data?.error?.message || ''} ${JSON.stringify(r.data?.error?.details || [])}`);

export const checkVoiceNotes = () => callFunctionJson('golda-speech-check', { method: 'POST', body: {} });

/** Returns { ok, step, message, link? } for the screen. */
export async function enableVoiceNotes() {
  const { GoogleAuthProvider, reauthenticateWithPopup } = await import('firebase/auth');
  const { auth } = await import('lib/firebase');
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/cloud-platform');
  if (auth.currentUser?.email) provider.setCustomParameters({ login_hint: auth.currentUser.email });
  const result = await reauthenticateWithPopup(auth.currentUser, provider);
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) return { ok: false, step: 'signin', message: 'Google לא החזיר הרשאה. נסה שוב.' };

  const enableUrl = `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/speech.googleapis.com:enable`;
  let en = await gFetch(token, enableUrl, { method: 'POST', body: '{}' });
  if (!en.ok && en.status !== 409 && billingProblem(en)) {
    // Speech-to-Text needs a billing account on the project.
    const info = await gFetch(token, `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`);
    if (!info.data?.billingEnabled) {
      const list = await gFetch(token, 'https://cloudbilling.googleapis.com/v1/billingAccounts');
      const open = (list.data?.billingAccounts || []).filter((a) => a.open);
      if (!open.length) {
        return { ok: false, step: 'billing', message: 'ל-Google חסר אמצעי תשלום בפרויקט. פתח את הקישור, הוסף כרטיס, ואז לחץ שוב על הכפתור.',
          link: `https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}` };
      }
      const link = await gFetch(token, `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`, { method: 'PUT', body: JSON.stringify({ billingAccountName: open[0].name }) });
      if (!link.ok) return { ok: false, step: 'billing', message: link.data?.error?.message || `חיבור החיוב נכשל (${link.status})`, link: `https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT}` };
    }
    en = await gFetch(token, enableUrl, { method: 'POST', body: '{}' });
  }
  if (!en.ok && en.status !== 409) return { ok: false, step: 'api', message: en.data?.error?.message || `הפעלת שירות התמלול נכשלה (${en.status})` };

  // The switch takes a little while to reach the service; check a few times.
  let r = null;
  for (let i = 0; i < 4; i++) {
    await sleepMs(i ? 10000 : 6000);
    r = await checkVoiceNotes().catch((e) => ({ state: 'error', message: e.message }));
    if (r.state === 'ok') return { ok: true, step: 'done', message: 'התמלול פעיל. אפשר לשלוח לגולדה הודעה קולית.' };
  }
  return { ok: false, step: 'check', message: `השירות הופעל אבל עוד לא עונה (${r?.message || r?.state}). נסה "בדוק שוב" בעוד דקה.` };
}
