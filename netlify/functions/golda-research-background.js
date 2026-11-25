// Golda's research dossier, the part that takes minutes: the web searches, the
// cleaning, the PDF and its delivery to whoever asked (lib/golda-research.js
// runResearch). A background function, so it has fifteen minutes; the run
// stops asking after ten and leaves the rest for the PDF and the sending.
//
// Woken by the research_start tool with { id }, and by the ten-minute queue
// check (golda-queue-cron.js) for a job that got stuck. With no id (the
// System screen's "run now") it takes the oldest stuck job, if there is one.
// Internal callers only; an admin may run it too.
const { withAuth, json } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const { runJob } = require('./lib/jobs.js');
const research = require('./lib/golda-research.js');

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event) => {
  let id = '';
  try { id = String((JSON.parse(event.body || '{}') || {}).id || ''); } catch { id = ''; }
  if (id && !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(400, { error: 'bad id' });
  const db = getDb();
  try {
    const r = await runJob(research.JOB, async (job) => {
      let target = id;
      if (!target) {
        const stuck = await research.stuckJobs(db);
        target = stuck[0] ? stuck[0].id : '';
        job.note(`${stuck.length} stuck job(s)`);
      }
      if (!target) return { status: 'idle' };
      return research.runResearch(db, target, { job });
    }, { trigger: id ? 'request' : 'manual' });
    return json(200, { ok: true, status: r && r.status });
  } catch (e) {
    console.error('[golda-research]', e && e.name);
    return json(500, { error: 'failed' });
  }
});
