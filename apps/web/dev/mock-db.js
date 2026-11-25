// Harness only: the real lib/db with listenCollection served from fixtures.
export * from '../src/lib/db.js';
import { FIXTURES } from './fixtures.js';

const listeners = {};
const emit = (path) => (listeners[path] || []).forEach((cb) => cb((FIXTURES[path] || []).filter((r) => !r.deletedAt)));

export const listenCollection = (path, callback) => {
  (listeners[path] = listeners[path] || []).push(callback);
  setTimeout(() => emit(path), 0);
  return () => { listeners[path] = (listeners[path] || []).filter((x) => x !== callback); };
};

// Edits stay in this page's memory (never the real database): a dotted key
// ("monthlyReports.2026-10") sets one entry of a map, like Firestore.
export const updateDoc_ = async (path, id, data) => {
  const row = (FIXTURES[path] || []).find((r) => r.id === id);
  if (!row) throw new Error('not found (harness)');
  for (const [k, v] of Object.entries(data || {})) {
    const parts = k.split('.');
    let o = row;
    for (const p of parts.slice(0, -1)) o = (o[p] = { ...(o[p] || {}) });
    o[parts[parts.length - 1]] = v;
  }
  setTimeout(() => emit(path), 0);
};
