// The restore itself, started by backup-restore: one record, or everything.
// Background (15 minutes), recorded in `jobs` as backup-restore, with a line
// in the audit log saying who restored what from which backup. Reached only
// with an internal nonce, so nothing but the admin screen can start it.
const { withAuth, json } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');
const backup = require('./lib/backup.js');

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event, ctx) => {
  if (!ctx.auth.internal) return json(403, { error: 'internal only' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const by = body.by || null;
  try {
    const r = await runJob('backup-restore', async (job) => {
      if (body.op === 'one') {
        const one = await backup.restoreRecord({ backupId: body.backupId, path: body.path, by });
        job.note(`${one.path}: ${one.written} documents, ${one.files} files`);
        return one;
      }
      if (body.op === 'all') return backup.restoreAll({ backupId: body.backupId || null, offsiteKey: body.offsiteKey || null, by, job, event });
      throw new Error(`unknown op ${body.op}`);
    }, { trigger: 'manual', op: body.op, by: by?.email || null, target: body.path || body.backupId || body.offsiteKey || null });
    return json(200, r);
  } catch (e) {
    console.error('[restore] failed:', e);
    return json(500, { error: String(e.message || e) });
  }
});
