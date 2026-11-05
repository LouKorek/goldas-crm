// The alerts the shell shows. One set of listeners for the whole app, shared
// by the bell badge and the Notifications screen, so the number on the bell
// and the list behind it always come from the same data and the same engine
// (the one Home and the daily email use). The screen no longer opens its own
// listeners, so it never shows "all clear" while its own copy is still loading.
import { useEffect, useState } from 'react';
import { listenCollection, PATHS } from './db';
import { listenPlayers } from '../data/players';
import { DEFAULT_SETTINGS, loadSettings, unifiedAlerts } from './alerts';

const SOURCES = ['players', 'matches', 'deals', 'requirements', 'tasks', 'jobs'];
const state = { players: [], matches: [], deals: [], requirements: [], tasks: [], jobs: [], settings: DEFAULT_SETTINGS };
const seen = new Set();
const subscribers = new Set();
let unsub = null;
let email = '';
let snapshot = { result: unifiedAlerts({ ...state }), loaded: false, settings: DEFAULT_SETTINGS };

function recompute() {
  let result;
  try { result = unifiedAlerts({ ...state }); } catch { result = { alerts: [], byType: {}, total: 0 }; }
  snapshot = { result, loaded: SOURCES.every((k) => seen.has(k)), settings: state.settings };
  subscribers.forEach((fn) => fn(snapshot));
}

function start(forEmail) {
  if (unsub && email === forEmail) return;
  stop();
  email = forEmail;
  const set = (k) => (rows) => { state[k] = rows; seen.add(k); recompute(); };
  const u = [
    listenPlayers({ stage: 'represented' }, set('players')),
    listenCollection(PATHS.MATCHES, set('matches')),
    listenCollection(PATHS.DEALS, set('deals')),
    listenCollection(PATHS.CLUB_REQUIREMENTS, set('requirements')),
    listenCollection(PATHS.TASKS, (rows) => set('tasks')(rows.filter((x) => x.owner === forEmail))),
    listenCollection('jobs', set('jobs')),
  ];
  loadSettings().then((s) => { state.settings = s; recompute(); }).catch(() => {});
  unsub = () => u.forEach((f) => { try { f(); } catch {} });
}

function stop() {
  if (unsub) unsub();
  unsub = null;
  seen.clear();
}

/** After the alert timing is saved, recount with the new settings at once. */
export function setAlertSettings(s) {
  state.settings = s;
  recompute();
}

/** { result: { alerts, byType, total }, loaded, settings } shared by the whole app. */
export function useAlerts(userEmail) {
  const [snap, setSnap] = useState(snapshot);
  useEffect(() => {
    if (!userEmail) return undefined;
    subscribers.add(setSnap);
    start(userEmail);
    setSnap(snapshot);
    return () => {
      subscribers.delete(setSnap);
      if (!subscribers.size) stop();
    };
  }, [userEmail]);
  return snap;
}

export function useAlertCount(userEmail) {
  return useAlerts(userEmail).result.total;
}
