// The recycle bin: everything soft-deleted in the last 30 days, across the
// collections that support it, with restore and (admin) permanent delete.
import { listenCollection, restoreDoc_, purgeDoc_, SOFT_DELETE } from 'lib/db';
import { playerName } from '@goldas/domain';

export const RECYCLE_LABELS = {
  players: 'שחקן', clubs: 'מועדון', deals: 'עסקה', club_requirements: 'דרישה',
  contacts: 'איש קשר', matches: 'משחק', tasks: 'משימה', trainings: 'אימון',
};

export const recycleTitle = (path, r) => {
  switch (path) {
    case 'players': return playerName(r);
    case 'clubs': return r.name;
    case 'deals': return `${r.playerName} ↔ ${r.clubName}`;
    case 'club_requirements': return `${r.clubName || ''} · ${r.requiredPosition || ''}`;
    case 'contacts': return `${r.contactName || ''} (${r.clubName || ''})`;
    case 'matches': return `${r.homeTeam || ''} – ${r.awayTeam || ''} ${r.date || ''}`;
    case 'tasks': return r.title || r.text || '';
    default: return r.name || r.title || r.id;
  }
};

export const listenRecycleBin = (callback) => {
  const paths = [...SOFT_DELETE];
  const state = {};
  const emit = () => callback(paths.flatMap((p) => (state[p] || []).map((r) => ({ ...r, _path: p }))));
  const unsubs = paths.map((p) => listenCollection(p, (rows) => { state[p] = rows.filter((r) => r.deletedAt); emit(); }, { includeDeleted: true }));
  return () => unsubs.forEach((u) => u());
};

export const restoreItem = (item) => restoreDoc_(item._path, item.id);
export const purgeItem = (item) => purgeDoc_(item._path, item.id);
