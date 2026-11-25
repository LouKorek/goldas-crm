// Admin: look inside a backup and start a restore, from the Backups screen.
//
//   POST { op: 'find', backupId, q }          records in that backup whose name holds q
//   POST { op: 'offsite' }                    the copies kept outside the database
//   POST { op: 'one', backupId, path }        put one record back as it was
//   POST { op: 'all', backupId | offsiteKey } put everything back
//
// 'one' and 'all' only start backup-restore-background (a restore can take
// minutes) and answer at once; the run shows in `jobs` as backup-restore and
// leaves a line in the audit log. Admin only (manage_settings).
const { withAuth, json, internalHeaders } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const backup = require('./lib/backup.js');

exports.handler = withAuth({ action: 'manage_settings' }, async (event, ctx) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const db = getDb();
  const op = String(body.op || '');

  if (op === 'offsite') {
    try { return json(200, { copies: await backup.listOffsite(event) }); }
    catch (e) { return json(200, { copies: [], error: String(e.message || e).slice(0, 200) }); }
  }

  if (op === 'find') {
    const ref = db.collection('backups').doc(String(body.backupId || ''));
    const snap = await ref.get();
    if (!snap.exists) return json(404, { error: 'the backup was not found' });
    // A backup from before the record index is read whole, which a plain
    // function has time for only when it is small.
    const { index, legacy } = await backup.loadIndex(ref, snap.data(), { maxLegacyChunks: 12 });
    if (legacy) return json(200, { legacy: true, records: [] });
    return json(200, { records: backup.findRecords(index, body.q) });
  }

  if (op === 'one' || op === 'all') {
    const job = op === 'one'
      ? { op, backupId: String(body.backupId || ''), path: String(body.path || '') }
      : { op, backupId: body.backupId ? String(body.backupId) : null, offsiteKey: body.offsiteKey ? String(body.offsiteKey) : null };
    if (op === 'one' && (!job.backupId || job.path.split('/').length !== 2)) return json(400, { error: 'backupId and path are required' });
    if (op === 'all' && !job.backupId === !job.offsiteKey) return json(400, { error: 'exactly one of backupId and offsiteKey is required' });
    const by = { email: ctx.auth.user.email, name: ctx.auth.user.name || ctx.auth.user.email };
    const base = process.env.URL || 'https://goldas-crm.netlify.app';
    const res = await fetch(`${base}/.netlify/functions/backup-restore-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders(`restore:${by.email}`)) }, body: JSON.stringify({ ...job, by }),
    });
    if (!res.ok && res.status !== 202) return json(502, { error: `could not start the restore (${res.status})` });
    return json(200, { started: op });
  }

  return json(400, { error: `unknown op ${op}` });
});
