// Harness stand-in for data/admin: the System screen on sample runs and
// backups. ?bk=empty shows a database with no backups and two copies kept
// outside it; anything else a week of backups in every state.
export * from '../src/data/admin.js';
const state = new URLSearchParams(location.search).get('bk') || 'week';
const H = 3600e3, D = 24 * H, now = Date.now();
const later = (cb, v) => { setTimeout(() => cb(v), 50); return () => {}; };
const run = (name, hoursAgo, status = 'ok', extra = {}) => ({ id: `${name}-${hoursAgo}`, name, status, startedAt: new Date(now - hoursAgo * H), durationMs: 4200, trigger: 'schedule', ...extra });
const RUNS = [
  run('golda-briefing', 0.5), run('meta-onboard', 0.3), run('golda-queue', 0.1), run('golda-briefing', 1.5),
  run('sync-matches', 9), run('ifa-server-sync', 9.2), run('nightly-engines', 9.2), run('send-alerts', 6.5),
  run('tm-watch', 7.5, 'error', { error: 'ScraperAPI 429' }), run('ig-watch', 8.2), run('migrate', 30, 'ok', { trigger: 'deploy' }),
];
const STATUS = {
  'backup-weekly': { last: { status: 'ok', startedAt: new Date(now - 3 * D), durationMs: 94000, trigger: 'schedule' } },
  'backup-restore': { last: { status: 'ok', startedAt: new Date(now - 5 * H), durationMs: 2100, trigger: 'manual' } },
};
const backup = (id, daysAgo, f = {}) => ({ id, startedAt: new Date(now - daysAgo * D), status: 'ok', docs: 4812, chars: 9.4 * 1048576, chunks: 11, collections: new Array(19).fill('c'), ...f });
const BACKUPS = [
  backup('b7c1e09a', 3, { verified: true, offsite: { key: 'k', bytes: 2.1e6 } }),
  backup('a41d77f2', 10, { verified: true, offsiteError: 'store unavailable' }),
  backup('9e02bb13', 11, { status: 'running', chunks: 0, docs: 0, chars: 0, collections: [] }),
  backup('5fd0a3c8', 17, { status: 'error', error: 'check failed: 4810 of 4812 lines', verified: false }),
  backup('2c9e4410', 24, { status: 'done', partial: true }),
];
const FOUND = [
  { path: 'players/p1', collection: 'players', id: 'p1', name: 'נועם ברזילי' },
  { path: 'contacts/c8', collection: 'contacts', id: 'c8', name: 'נועם לוי' },
  { path: 'tasks/t3', collection: 'tasks', id: 't3', name: 'לשלוח לנועם את סיכום הפגישה' },
];
export const listenJobs = (cb) => later(cb, RUNS);
export const listenJobStatus = (cb) => later(cb, STATUS);
export const listenBackups = (cb) => later(cb, state === 'empty' ? [] : BACKUPS);
export const listenAudit = (cb) => later(cb, []);
export const listenClientErrors = (cb) => later(cb, []);
export const listenTmWatchMeta = (cb) => later(cb, {});
export const listenDeploys = (cb) => later(cb, {});
export const listenGoldaUsage = (cb) => later(cb, { count: 0, inputTokens: 0, outputTokens: 0, sessions: 0 });
export const listenMetaConnect = (cb) => later(cb, {});
export const fetchScraperStatus = async () => ({});
export const runJobNow = async () => ({ ok: true });
export const downloadBackup = async (b) => ({ name: `goldas-backup-${b.id}.jsonl`, chars: 1 });
export const findInBackup = async (id, q) => (id === '2c9e4410' ? { legacy: true, records: [] } : { records: q.includes('נועם') ? FOUND : [] });
export const restoreRecord = async () => ({ ok: true });
export const restoreEverything = async () => ({ ok: true });
export const fetchOffsiteCopies = async () => ({ copies: [{ key: '2026-11-22_b7c1e09a.jsonl.gz', date: '2026-11-22', id: 'b7c1e09a' }, { key: '2026-11-15_a41d77f2.jsonl.gz', date: '2026-11-15', id: 'a41d77f2' }] });
