// The agency's website (gold-as.com) as Golda changes it: System › Website
// (components/admin/WebsiteStatus.jsx) shows whether she can publish and what
// she published.
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { callFunctionJson } from 'lib/api';

export const WEBSITE_URL = 'https://gold-as.com';

/** app_meta/website: connection { ok, at, why, waitingForPanel, serviceEmail }, last, recent, playerCount. */
export const listenWebsite = (callback) =>
  onSnapshot(doc(db, 'app_meta', 'website'), (s) => callback(s.exists() ? s.data() : {}), (e) => { console.error('website error:', e); callback({}); });

/** Ask the website now whether Golda may publish → the connection, also saved for the listener. */
export const checkWebsite = () => callFunctionJson('website-status', { method: 'POST', body: {} });
