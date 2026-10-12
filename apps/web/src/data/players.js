// The unified players collection. Every person the agency touches is one
// document with a stage (relationship) and a category (market).
import { listenCollection, addDoc_, updateDoc_, PATHS, currentUserMeta } from 'lib/db';
import { stageFromStatus, categoryFromPlayer, playerName } from '@goldas/domain';
import { addInteraction } from './interactions';
import { syncDealsForPlayer } from './deals';

const withName = (p) => ({ ...p, name: playerName(p) });

/**
 * listenPlayers({ stage, stages, category, notStage }, cb)
 * One listener on the collection, filtered in memory (a few hundred docs at
 * most), so no composite index is ever needed.
 */
export const listenPlayers = (filter, callback) => {
  const { stage, stages, category, notStage } = filter || {};
  return listenCollection(PATHS.PLAYERS, (rows) => {
    const out = rows.map(withName).filter((p) => {
      const st = p.stage || 'represented';           // records from before the merge
      if (stage && st !== stage) return false;
      if (stages && !stages.includes(st)) return false;
      if (notStage && st === notStage) return false;
      if (category && (p.category || categoryFromPlayer(p)) !== category) return false;
      return true;
    });
    callback(out);
  });
};

/** Fields every player document must carry, derived from whatever the form sent. */
export const normalizePlayer = (data, defaults = {}) => {
  const d = { ...defaults, ...data };
  const stage = d.stage || (d.status ? stageFromStatus(d.status) : defaults.stage) || 'represented';
  const category = d.category || categoryFromPlayer(d);
  const name = playerName(d);
  return { ...d, stage, category, name, fullName: d.fullName || name, playerName: d.playerName || name };
};

export const addPlayer = (data, defaults) => addDoc_(PATHS.PLAYERS, normalizePlayer(data, defaults));

export const updatePlayer = async (id, data, previous) => {
  const patch = { ...data };
  if (data.fullName !== undefined || data.playerName !== undefined || data.name !== undefined) patch.name = playerName({ ...previous, ...data });
  if (data.status !== undefined && previous && previous.stage !== 'represented') patch.stage = stageFromStatus(data.status);
  await updateDoc_(PATHS.PLAYERS, id, patch);
  if (previous && data.status !== undefined && data.status !== previous.status) {
    const { email } = currentUserMeta();
    addInteraction({ kind: 'stage_change', playerId: id, text: `${previous.status || '—'} → ${data.status}`, by: email });
    syncDealsForPlayer({ ...previous, ...patch, id }, data.status).catch(() => {});
  }
};

/** Candidate -> represented, one click. Keeps every field; only the stage moves. */
export const promoteToRepresented = async (player) => {
  const { email } = currentUserMeta();
  const name = playerName(player);
  await updateDoc_(PATHS.PLAYERS, player.id, {
    stage: 'represented',
    name, fullName: name,
    gender: player.gender || (player.category === 'women' ? 'Women' : 'Men'),
    contractStatus: player.contractStatus || 'Under Contract',
    promotedAt: new Date().toISOString(), promotedBy: email,
  });
  addInteraction({ kind: 'promotion', playerId: player.id, text: `${name} הפך לשחקן מיוצג`, by: email });
};

export const setPlayerStage = async (player, stage) => {
  const { email } = currentUserMeta();
  await updateDoc_(PATHS.PLAYERS, player.id, { stage });
  addInteraction({ kind: 'stage_change', playerId: player.id, text: `שלב: ${player.stage || '—'} → ${stage}`, by: email });
};
