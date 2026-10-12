// "Run now" for the scheduled jobs that have no background worker of their
// own. The admin Health tab (through admin-run-job) asks for one task and
// this runs it with the same code the schedule runs, recorded in `jobs`
// like any other run. Background, so a long backup never hits the 10-second
// limit of a plain function.
//
//   POST { task: 'backup' | 'nightly-engines' | 'send-alerts' | 'golda-briefing' }
const { withAuth, json } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');

const TASKS = {
  backup: () => runJob('backup-weekly', async (job) => require('./backup-weekly.js')._runBackup(job), { trigger: 'manual' }),
  'nightly-engines': () => runJob('nightly-engines', require('./nightly-engines.js')._internal.nightly, { trigger: 'manual' }),
  'send-alerts': () => runJob('send-alerts', async (job) => { const r = await require('./send-alerts.js')._internal.sendDigest(job); job.note(r.body); return r; }, { trigger: 'manual' }),
  'golda-briefing': () => runJob('golda-briefing', (job) => require('./golda-briefing.js')._internal.run(job, new Date(), { force: true }), { trigger: 'manual' }),
};

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const task = TASKS[body.task];
  if (!task) return json(400, { error: `unknown task ${body.task}` });
  try { await task(); return json(200, { ok: true }); }
  catch (e) { console.error(`[ops] ${body.task} failed:`, e); return json(500, { error: String(e.message || e) }); }
});
exports.TASKS = Object.keys(TASKS);
