// Clubs are first-class: one document per club, with the spellings seen in
// the records as aliases and a saved logo, so lists never guess twice.
import { listenCollection, addDoc_, updateDoc_, PATHS } from 'lib/db';
import { clubKey, preferName } from '@goldas/domain';

export const listenClubs = (callback) =>
  listenCollection(PATHS.CLUBS, (rows) => {
    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'));
    callback(rows);
  });

/** Find a club among loaded rows by any spelling. */
export const findClub = (clubs, name) => {
  const key = clubKey(name);
  return key ? clubs.find((c) => c.key === key) || null : null;
};

/** Create the club when it is new; otherwise record the spelling as an alias. */
export const ensureClub = async (clubs, name, extra = {}) => {
  const n = String(name || '').trim();
  const key = clubKey(n);
  if (!key) return null;
  const existing = findClub(clubs, n);
  if (existing) {
    if (!(existing.aliases || []).includes(n) && existing.name !== n) {
      await updateDoc_(PATHS.CLUBS, existing.id, { aliases: [...(existing.aliases || []), n] }).catch(() => {});
    }
    return existing;
  }
  const ref = await addDoc_(PATHS.CLUBS, { name: n, key, aliases: [], country: 'Israel', leagueTier: '', logoUrl: '', notes: '', ...extra });
  return { id: ref.id, name: n, key, ...extra };
};

export const saveClubLogo = (club, logoUrl) =>
  logoUrl && !club.logoUrl ? updateDoc_(PATHS.CLUBS, club.id, { logoUrl }).catch(() => {}) : Promise.resolve();

export const mergeClubName = preferName;
