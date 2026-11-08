// The hourly Golda briefing run (golda-briefing.js), in the background (up to
// 15 minutes) because the morning briefing is written by the model. Only the
// cron in golda-briefing.js calls it, with a single-use internal nonce.
const { withAuth } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');

exports.handler = withAuth({ internal: true, action: 'manage_settings' }, async () => {
  try {
    const r = await runJob('golda-briefing', (job) => require('./golda-briefing.js')._internal.run(job, new Date()));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.error('[golda-briefing-background] failed:', e);
    return { statusCode: 500, body: String(e.message || e) };
  }
});
