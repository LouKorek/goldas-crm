// Trainings: one-off ({ date, time }) or weekly ({ rule, time }) sessions of
// a represented player or a youth group. Only the rule is stored; the
// calendar expands it (domain engines/recurrence.ts) and a single occurrence
// can be cancelled or moved without touching the rule.
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, restoreDoc_, PATHS, currentUserMeta } from 'lib/db';
import { cancelOccurrence, moveOccurrence, expandTrainings } from '@goldas/domain';

export const listenTrainings = (callback) => listenCollection(PATHS.TRAININGS, callback);

export const addTraining = (data) => {
  const { email } = currentUserMeta();
  return addDoc_(PATHS.TRAININGS, {
    title: '', place: '', notes: '', linkedPlayers: [], ageGroup: '', time: '',
    date: '', rule: null, exceptions: [], owner: email, source: 'manual', ...data,
  });
};

export const updateTraining = (id, patch) => updateDoc_(PATHS.TRAININGS, id, patch);
export const deleteTraining = (id) => deleteDoc_(PATHS.TRAININGS, id);
export const restoreTraining = (id) => restoreDoc_(PATHS.TRAININGS, id);

/** Skip one occurrence of a recurring training. */
export const cancelTrainingOccurrence = (tr, sourceDate) =>
  updateDoc_(PATHS.TRAININGS, tr.id, { exceptions: cancelOccurrence(tr, sourceDate) });

/** Move one occurrence to another date and/or time. */
export const moveTrainingOccurrence = (tr, sourceDate, date2, time) =>
  updateDoc_(PATHS.TRAININGS, tr.id, { exceptions: moveOccurrence(tr, sourceDate, date2, time) });

/** Restore an occurrence that was cancelled or moved. */
export const resetTrainingOccurrence = (tr, sourceDate) =>
  updateDoc_(PATHS.TRAININGS, tr.id, { exceptions: (tr.exceptions || []).filter((e) => e.date !== sourceDate) });

/** Occurrences of every training inside [from, to], each with its training. */
export const trainingsInRange = (list, from, to) => {
  const byId = new Map(list.map((x) => [x.id, x]));
  return expandTrainings(list.filter((x) => !x.deletedAt), from, to).map((o) => ({ ...o, training: byId.get(o.trainingId) }));
};
