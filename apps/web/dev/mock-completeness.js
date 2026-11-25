// Harness stand-in for data/completeness: a match sync report in which Yair
// Shemesh (r3) is stuck on his IFA squad, so his games do not reach the calendar.
export const listenSyncReport = (cb) => {
  setTimeout(() => cb({ runAt: new Date(Date.now() - 3 * 3600000).toISOString(), list: [{ playerId: 'r3', name: 'Yair Shemesh', reason: 'ifa-team-not-matched' }] }), 50);
  return () => {};
};
export const scoreTone = (score) => (score >= 80 ? 'var(--green-ok)' : score >= 50 ? 'var(--amber)' : 'var(--red)');
export const scoreBg = (score) => (score >= 80 ? 'var(--green-bg)' : score >= 50 ? 'var(--amber-bg)' : 'var(--red-bg)');
