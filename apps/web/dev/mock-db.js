// Harness only: the real lib/db with listenCollection served from fixtures.
export * from '../src/lib/db.js';
import { FIXTURES } from './fixtures.js';
export const listenCollection = (path, callback) => {
  const rows = (FIXTURES[path] || []).filter((r) => !r.deletedAt);
  setTimeout(() => callback(rows), 0);
  return () => {};
};
