// The number on the bell. One set of listeners for the whole shell, shared
// by every subscriber, feeding the same alert engine as Home and the
// Notifications screen, so the badge, the list and the daily email agree.
import { useEffect, useState } from 'react';
import { listenCollection, PATHS } from './db';
import { listenPlayers } from '../data/players';
import { DEFAULT_SETTINGS, loadSettings, unifiedAlerts } from './alerts';

const state = { players: [], matches: [], deals: [], requirements: [], tasks: [], jobs: [], settings: DEFAULT_SETTINGS };
let subscribers = new Set();
let unsub = null;
let email = '';
let total = 0;

function recompute() {
  try {
    const r = unifiedAlerts({ ...state });
    total = r.total;
  } catch { total = 0; }
  subscribers.forEach((fn) => fn(total));
}

function start(forEmail) {
  if (unsub && email === forEmail) return;
  stop();
  email = forEmail;
  const set = (k) => (rows) => { state[k] = rows; recompute(); };
  const u = [
    listenPlayers({ stage: 'represented' }, set('players')),
    listenCollection(PATHS.MATCHES, set('matches')),
    listenCollection(PATHS.DEALS, set('deals')),
    listenCollection(PATHS.CLUB_REQUIREMENTS, set('requirements')),
    listenCollection(PATHS.TASKS, (rows) => { state.tasks = rows.filter((x) => x.owner === forEmail); recompute(); }),
    listenCollection('jobs', set('jobs')),
  ];
  loadSettings().then((s) => { state.settings = s; recompute(); }).catch(() => {});
  unsub = () => u.forEach((f) => { try { f(); } catch {} });
}

function stop() {
  if (unsub) unsub();
  unsub = null;
}

export function useAlertCount(userEmail) {
  const [n, setN] = useState(total);
  useEffect(() => {
    if (!userEmail) return undefined;
    subscribers.add(setN);
    start(userEmail);
    setN(total);
    return () => {
      subscribers.delete(setN);
      if (!subscribers.size) stop();
    };
  }, [userEmail]);
  return n;
}
