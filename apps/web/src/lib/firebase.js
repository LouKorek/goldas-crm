import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyBXQSSi_Q5IrGJjwnnWHjMF2UIhiv4WtCw",
  authDomain: "gold-as-crm.firebaseapp.com",
  projectId: "gold-as-crm",
  storageBucket: "gold-as-crm.firebasestorage.app",
  messagingSenderId: "1005130599757",
  appId: "1:1005130599757:web:bcf673a305ce6460733b04"
};

const app = initializeApp(firebaseConfig);
export const db      = getFirestore(app);
export const auth    = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

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
