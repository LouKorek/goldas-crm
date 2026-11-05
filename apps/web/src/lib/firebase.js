import { initializeApp } from 'firebase/app';
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyBXQSSi_Q5IrGJjwnnWHjMF2UIhiv4WtCw",
  authDomain: "gold-as-crm.firebaseapp.com",
  projectId: "gold-as-crm",
  storageBucket: "gold-as-crm.firebasestorage.app",
  messagingSenderId: "1005130599757",
  appId: "1:1005130599757:web:bcf673a305ce6460733b04"
};

const app = initializeApp(firebaseConfig);
// Data is kept on the device (IndexedDB), so opening the app shows the last
// known lists at once and only the changes come over the network. Where the
// browser refuses local storage (private mode), it falls back to memory.
function makeDb() {
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    return getFirestore(app);
  }
}
export const db      = makeDb();
export const auth    = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// The browser sync (public/tools/ifa-browser-sync.js) runs inside the signed-in
// CRM tab on Lou's computer; it asks here for the user's ID token so the daily
// task needs no shared secret.
if (typeof window !== 'undefined') {
  window.GA_TOKEN = async () => {
    for (let i = 0; i < 40 && !auth.currentUser; i++) await new Promise((r) => setTimeout(r, 250));
    if (!auth.currentUser) throw new Error('not signed in to the CRM in this browser');
    return auth.currentUser.getIdToken();
  };
}

// The permanent owner/admin. Always allowed, always admin, and can never be
// removed or demoted from the Team screen.
export const OWNER_EMAIL = 'lou.korek@gmail.com';

// Legacy seed data — used ONLY to populate the Firestore `app_users` collection
// the first time the owner signs in. After that, the Team screen (Firestore) is
// the single source of truth for who can log in and with what role.
export const USERS = {
  'lou.korek@gmail.com':       { name: 'Lou Korek',    role: 'admin'   },
  'yuval.benor2003@gmail.com': { name: 'Yuval Ben Or', role: 'manager' },
};

export const ALLOWED_EMAILS = Object.keys(USERS);
