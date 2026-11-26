// The market radar's scan (lib/golda-radar.js runRadar), in the background (up
// to 15 minutes) because it searches the web with the model.
//
// Called by golda-radar-cron every three hours, and from System › Health ("run
// now"). A scheduled call outside 07:00 to 22:00 Israel time ends at once and
// records nothing; "run now" scans whatever the hour. Either way the scan asks
// the day's cost ceiling first, and only one runs at a time (a lock in
// app_meta/goldaRadar). It saves findings; it sends nothing: the cards leave
// from the hourly run (golda-briefing.js), one at a time.
//
// The job's notes and summary hold counts only.
const { getDb } = require('./lib/firestore.js');
const { withAuth } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');
const radar = require('./lib/golda-radar.js');

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event) => {
  let reason = '';
  try { reason = String(JSON.parse((event && event.body) || '{}').reason || ''); } catch { /* none */ }
  const scheduled = reason === 'cron';
  const now = new Date();
  if (scheduled && !radar.isScanHour(now)) return { statusCode: 200, body: 'outside the scan hours' };
  const db = getDb();
  if (!(await radar.lockScan(db, now.getTime()))) return { statusCode: 200, body: 'already running' };
  try {
    await runJob('golda-radar', (job) => radar.runRadar(db, now, job, { force: !scheduled }), { trigger: scheduled ? 'schedule' : 'manual' });
  } catch (e) {
    // runRadar's own failure says only its kind ("radar scan failed: HTTP 529"); any other error's text could carry a name.
    console.error('[golda-radar] failed:', e && /^radar scan failed: /.test(String(e.message)) ? e.message : (e && (e.code || e.name)) || 'error');
  } finally {
    await radar.unlockScan(db);
  }
  return { statusCode: 200, body: 'done' };
});
