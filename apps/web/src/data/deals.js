// A deal is one candidate (or player) against one club. Phase 1 keeps deals
// in step with the candidate's status and linked clubs; the kanban comes in
// the market phase.
import { listenCollection, addDoc_, updateDoc_, PATHS, currentUserMeta } from 'lib/db';
import { clubKey, isDealStage, playerName } from '@goldas/domain';
import { addInteraction } from './interactions';

export const listenDeals = (filter, callback) => {
  const { playerId, clubId, clubName, open } = filter || {};
  const key = clubName ? clubKey(clubName) : '';
  return listenCollection(PATHS.DEALS, (rows) => {
    callback(rows.filter((d) =>
      (!playerId || d.playerId === playerId) &&
      (!clubId || d.clubId === clubId) &&
      (!key || d.clubKey === key) &&
      (!open || !d.closedAt)));
  });
};

const entry = (stage, by, note = '') => ({ stage, at: new Date().toISOString(), by, note });

export const openDeal = async (player, club, stage) => {
  const { email } = currentUserMeta();
  const st = isDealStage(stage) ? stage : (isDealStage(player.status) ? player.status : 'Not Contacted');
  const ref = await addDoc_(PATHS.DEALS, {
    playerId: player.id, playerName: playerName(player), category: player.category || 'men',
    clubId: club.clubId || club.id || '', clubName: club.clubName || club.name || '', clubKey: clubKey(club.clubName || club.name),
    stage: st, history: [entry(st, email, 'נפתח')], enteredStageAt: new Date().toISOString(),
    transferFee: player.transferFee || '', salary: player.salary || '', owner: email, source: 'manual', closedAt: null,
  });
  addInteraction({ kind: 'system', playerId: player.id, dealId: ref.id, text: `עסקה נפתחה מול ${club.clubName || club.name}`, by: email });
  return ref;
};

export const advanceDeal = async (deal, stage, note = '') => {
  if (!isDealStage(stage) || stage === deal.stage) return;
  const { email } = currentUserMeta();
  const closed = stage === 'Not Relevant' || stage === 'Contract Signed';
  await updateDoc_(PATHS.DEALS, deal.id, {
    stage, history: [...(deal.history || []), entry(stage, email, note)], enteredStageAt: new Date().toISOString(),
    closedAt: closed ? new Date().toISOString() : null,
  });
  addInteraction({ kind: 'stage_change', playerId: deal.playerId, dealId: deal.id, text: `${deal.clubName}: ${deal.stage} → ${stage}`, by: email });
};

export const closeDeal = (deal, note = '') => advanceDeal(deal, 'Not Relevant', note);

/** Mirror a candidate's status onto their open deals (one read, best effort). */
export const syncDealsForPlayer = async (player, status) => {
  if (!isDealStage(status)) return;
  const { getDocs, collection, query, where } = await import('firebase/firestore');
  const { db } = await import('lib/firebase');
  const snap = await getDocs(query(collection(db, PATHS.DEALS), where('playerId', '==', player.id)));
  await Promise.all(snap.docs.map((d) => {
    const deal = { id: d.id, ...d.data() };
    if (deal.closedAt || deal.deletedAt) return null;
    return advanceDeal(deal, status, 'עודכן מסטטוס המועמד');
  }));
};
