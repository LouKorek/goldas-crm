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

// Edits stay in this page's memory (never the real database), so the forms
// can be tried in the harness. A dotted key ("monthlyReports.2026-10") sets
// one entry of a map, like Firestore.
export const updateDoc_ = async (path, id, data) => {
  const rows = FIXTURES[path] || [];
  if (!rows.some((r) => r.id === id)) throw new Error('not found (harness)');
  FIXTURES[path] = rows.map((r) => {
    if (r.id !== id) return r;
    const next = { ...r };
    for (const [k, v] of Object.entries(data || {})) {
      const parts = k.split('.');
      let o = next;
      for (const p of parts.slice(0, -1)) o = (o[p] = { ...(o[p] || {}) });
      o[parts[parts.length - 1]] = v;
    }
    return next;
  });
  setTimeout(() => emit(path), 0);
};
