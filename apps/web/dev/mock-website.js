// Harness stand-in for data/website: ?web=ok shows Golda connected with a few
// publishes, ?web=waiting the panel's server that does not know her yet,
// ?web=broken a failed check, anything else the first-time screen.
const state = new URLSearchParams(location.search).get('web') || 'new';
const H = 3600e3;
const DOC = {
  new: {},
  ok: {
    connection: { ok: true, at: Date.now() - 2 * H, why: '', waitingForPanel: false, serviceEmail: 'golda@example.iam.gserviceaccount.com' }, playerCount: 25,
    recent: [
      { id: 'p3', at: Date.now() - 3 * H, by: 'לו קורק', lines: ['new card: Noam Barzilay | Hapoel Haifa (U19) | LB / CB | born 2007 | Left foot | Israel'], undoOf: null, undone: false },
      { id: 'p2', at: Date.now() - 27 * H, by: 'לו קורק', lines: ['undone: Yair Shemesh: foot "R" → "Right"'], undoOf: 'p1', undone: false },
      { id: 'p1', at: Date.now() - 28 * H, by: 'לו קורק', lines: ['Yair Shemesh: foot "R" → "Right"'], undoOf: null, undone: true },
    ],
  },
  waiting: { connection: { ok: false, at: Date.now() - 60e3, why: "Lou's website panel does not know Golda yet: its server has to be given her address once", waitingForPanel: true, serviceEmail: 'golda@example.iam.gserviceaccount.com' } },
  broken: { connection: { ok: false, at: Date.now() - 60e3, why: "the website panel's server did not answer", waitingForPanel: false, serviceEmail: 'golda@example.iam.gserviceaccount.com' }, playerCount: 24 },
};
export const WEBSITE_URL = 'https://gold-as.com';
export const listenWebsite = (cb) => { setTimeout(() => cb(DOC[state] || {}), 50); return () => {}; };
export const checkWebsite = async () => DOC[state]?.connection || { ok: false };
