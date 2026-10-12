// A deal is one candidate (or player) against one club. The stage machine
// lives in the domain package (engines/deals.ts); this file does the writes.
import { listenCollection, addDoc_, updateDoc_, PATHS, currentUserMeta } from 'lib/db';
import { clubKey, isDealStage, playerName, canTransition, applyTransition } from '@goldas/domain';
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

export const openDeal = async (player, club, stage, extra = {}) => {
  const { email } = currentUserMeta();
  const st = isDealStage(stage) ? stage : (isDealStage(player.status) ? player.status : 'Not Contacted');
  const ref = await addDoc_(PATHS.DEALS, {
    playerId: player.id, playerName: playerName(player), category: player.category || 'men',
    clubId: club.clubId || club.id || '', clubName: club.clubName || club.name || '', clubKey: clubKey(club.clubName || club.name),
    stage: st, history: [entry(st, email, 'נפתח')], enteredStageAt: new Date().toISOString(),
    transferFee: player.transferFee || '', salary: player.salary || '', owner: email, source: 'manual', closedAt: null,
    requirementId: extra.requirementId || '', ...extra,
  });
  addInteraction({ kind: 'system', playerId: player.id, dealId: ref.id, clubId: club.clubId || club.id || '', text: `עסקה נפתחה מול ${club.clubName || club.name}`, by: email });
  return ref;
};

/** What the UI must ask before moving `deal` to `stage` (or why it cannot). */
export const checkTransition = (deal, stage, opts) => canTransition(deal, stage, opts);

/**
 * Move a deal to a stage through the state machine. Returns the engine's
 * effects so the screen can offer the follow-ups (promote, free requirement).
 */
export const advanceDeal = async (deal, stage, note = '', opts = {}) => {
  if (!isDealStage(stage) || stage === deal.stage) return null;
  const { email } = currentUserMeta();
  const r = applyTransition(deal, stage, email, new Date(), note, opts);
  await updateDoc_(PATHS.DEALS, deal.id, r.patch);
  addInteraction({ kind: r.interaction.kind, playerId: deal.playerId, dealId: deal.id, clubId: deal.clubId || '', text: r.interaction.text, by: email });
  if (r.effects.freeRequirement && deal.requirementId) {
    updateDoc_(PATHS.CLUB_REQUIREMENTS, deal.requirementId, { status: 'open' }).catch(() => {});
  }
  return r.effects;
};

export const closeDeal = (deal, note = '') => advanceDeal(deal, 'Not Relevant', note);

/** Reopen a closed deal into a stage of choice. */
export const reopenDeal = (deal, stage = 'Negotiation', note = 'נפתח מחדש') => advanceDeal(deal, stage, note, { confirmed: true });

/** Mirror a candidate's status onto their open deals (one read, best effort). */
export const syncDealsForPlayer = async (player, status) => {
  if (!isDealStage(status)) return;
  const { getDocs, collection, query, where } = await import('firebase/firestore');
  const { db } = await import('lib/firebase');
  const snap = await getDocs(query(collection(db, PATHS.DEALS), where('playerId', '==', player.id)));
  await Promise.all(snap.docs.map((d) => {
    const deal = { id: d.id, ...d.data() };
    if (deal.closedAt || deal.deletedAt) return null;
    return advanceDeal(deal, status, 'עודכן מסטטוס המועמד', { confirmed: true });
  }));
};
