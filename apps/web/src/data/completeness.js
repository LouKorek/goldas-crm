// The player checklist in the app: the definition is in @goldas/domain
// (engines/completeness.ts); this only brings what it needs from Firestore.
// The match sync's last report (app_meta/syncWarnings, already read by the
// Matches and Calendar screens) tells whether a player's games reach the
// calendar; without it that item is "not known yet".
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';

/** Listens to the match sync's report. cb(report | null). Returns the unsubscribe. */
export function listenSyncReport(cb) {
  return onSnapshot(doc(db, 'app_meta', 'syncWarnings'), (s) => cb(s.exists() ? s.data() : null), () => cb(null));
}

/** The colour of a score, as the alert colours elsewhere: green, amber, red. */
export const scoreTone = (score) => (score >= 80 ? 'var(--green-ok)' : score >= 50 ? 'var(--amber)' : 'var(--red)');
export const scoreBg = (score) => (score >= 80 ? 'var(--green-bg)' : score >= 50 ? 'var(--amber-bg)' : 'var(--red-bg)');
