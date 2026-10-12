// 03 · Deals. The deal is a state machine over the nine stages the agency
// already uses. Every transition is recorded with a date and a person and
// produces an interaction; some transitions carry rules:
//   "Mandate Received" needs a document or an explicit confirmation;
//   "Contract Signed" offers to promote the candidate to represented;
//   "Not Relevant" closes the deal and frees the requirement.
// Waiting more than DEAL_STALE_DAYS in a stage raises an alert (engine 01).
import { DEAL_STAGES, DEAL_STAGE_LABELS, isDealStage, DEAL_STALE_DAYS, type DealStage } from '../stages.js';
import { daysBetween, israelDate } from './dates.js';

export interface DealHistoryEntry { stage: DealStage; at: string; by: string; note: string }
export interface DealLike {
  id?: string;
  stage: DealStage | string;
  history?: DealHistoryEntry[];
  enteredStageAt?: string;
  closedAt?: string | null;
  playerId?: string; playerName?: string; clubId?: string; clubName?: string; requirementId?: string;
  mandateFiles?: unknown[];
  mandateConfirmed?: boolean;
}

export const CLOSED_STAGES: readonly DealStage[] = ['Contract Signed', 'Not Relevant'];
export const isClosedStage = (s: unknown): boolean => (CLOSED_STAGES as readonly string[]).includes(String(s));

/** Index of a stage along the funnel (Not Relevant sits outside it). */
export const stageIndex = (s: unknown): number => (DEAL_STAGES as readonly string[]).indexOf(String(s));

export interface TransitionCheck {
  ok: boolean;
  /** Why not, when !ok. */
  reason?: { he: string; en: string };
  /** The transition is allowed but the user should confirm something first. */
  confirm?: { he: string; en: string };
}

/**
 * Whether `deal` may move to `to`. Any stage can be reached from any open
 * stage (the agency skips steps all the time), but a closed deal stays
 * closed, and a mandate needs proof or an explicit confirmation.
 */
export function canTransition(deal: DealLike, to: unknown, opts: { confirmed?: boolean } = {}): TransitionCheck {
  if (!isDealStage(to)) return { ok: false, reason: { he: 'שלב לא מוכר', en: 'Unknown stage' } };
  if (to === deal.stage) return { ok: false, reason: { he: 'העסקה כבר בשלב הזה', en: 'Deal is already in this stage' } };
  if (deal.closedAt && !opts.confirmed) return { ok: false, reason: { he: 'העסקה סגורה; פתח אותה מחדש קודם', en: 'Deal is closed; reopen it first' } };
  if (to === 'Mandate Received' && !(deal.mandateFiles?.length) && !deal.mandateConfirmed && !opts.confirmed) {
    return { ok: true, confirm: { he: 'מנדט דורש מסמך או אישור שלך שהמנדט התקבל', en: 'A mandate needs a document or your confirmation that it was received' } };
  }
  return { ok: true };
}

export interface TransitionResult {
  patch: Record<string, unknown>;
  interaction: { kind: 'stage_change'; text: string };
  /** Things the caller should offer or do next. */
  effects: { suggestPromote: boolean; freeRequirement: boolean; closed: boolean };
}

/** The write for a transition; throws when canTransition says no. */
export function applyTransition(deal: DealLike, to: DealStage, who: string, now: Date = new Date(), note = '', opts: { confirmed?: boolean } = {}): TransitionResult {
  const check = canTransition(deal, to, opts);
  if (!check.ok) throw new Error(check.reason?.en || 'Transition not allowed');
  const at = now.toISOString();
  const closed = isClosedStage(to);
  const history: DealHistoryEntry[] = [...(deal.history ?? []), { stage: to, at, by: who, note }];
  const patch: Record<string, unknown> = { stage: to, history, enteredStageAt: at, closedAt: closed ? at : null };
  if (to === 'Mandate Received' && opts.confirmed) patch.mandateConfirmed = true;
  return {
    patch,
    interaction: { kind: 'stage_change', text: `${deal.clubName ?? ''}: ${DEAL_STAGE_LABELS[deal.stage as DealStage] ?? deal.stage} → ${DEAL_STAGE_LABELS[to]}` },
    effects: { suggestPromote: to === 'Contract Signed', freeRequirement: to === 'Not Relevant' && !!deal.requirementId, closed },
  };
}

/** Whole days the deal has sat in its current stage. */
export const daysInStage = (deal: DealLike, now: Date = new Date()): number | null => {
  const at = deal.enteredStageAt ?? deal.history?.[deal.history.length - 1]?.at;
  if (!at) return null;
  const d = new Date(at);
  return isNaN(d.getTime()) ? null : daysBetween(israelDate(d), israelDate(now));
};

export const isStale = (deal: DealLike, now: Date = new Date(), threshold = DEAL_STALE_DAYS): boolean => {
  if (deal.closedAt) return false;
  const d = daysInStage(deal, now);
  return d !== null && d >= threshold;
};

/** Funnel counts per stage for a set of deals (closed ones included). */
export const funnel = (deals: DealLike[]): Record<DealStage, number> => {
  const out = Object.fromEntries(DEAL_STAGES.map((s) => [s, 0])) as Record<DealStage, number>;
  for (const d of deals) if (isDealStage(d.stage)) out[d.stage]++;
  return out;
};
