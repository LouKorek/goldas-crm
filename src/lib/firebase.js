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

export const USERS = {
  'lou.korek@gmail.com':       { name: 'Lou Korek',    role: 'Agent' },
  'yuval.benor2003@gmail.com': { name: 'Yuval Ben Or', role: 'Scout' },
};

export const ALLOWED_EMAILS = Object.keys(USERS);
