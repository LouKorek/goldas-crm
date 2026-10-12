// Interactions are the timeline of a player, a deal or a club: calls,
// meetings, notes and the stage changes the system records on its own.
import { listenCollection, addDoc_, PATHS, canEditNow } from 'lib/db';

export const addInteraction = ({ kind = 'note', playerId = '', dealId = '', clubId = '', text, by = '' }) => {
  if (!canEditNow()) return Promise.resolve();
  return addDoc_(PATHS.INTERACTIONS, { kind, playerId, dealId, clubId, text: String(text || ''), by, at: new Date().toISOString() })
    .catch((e) => console.warn('interaction write failed:', e?.message));
};

export const listenInteractions = ({ playerId, dealId, clubId }, callback) =>
  listenCollection(PATHS.INTERACTIONS, (rows) => {
    const out = rows.filter((r) =>
      (playerId && r.playerId === playerId) || (dealId && r.dealId === dealId) || (clubId && r.clubId === clubId));
    out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    callback(out);
  });
