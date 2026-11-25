// The hourly Golda briefing run (golda-briefing.js), in the background (up to
// 15 minutes) because the morning briefing is written by the model. The cron
// in golda-briefing.js calls it with a single-use internal nonce.
//
// It also sends the brief before a meeting: golda-queue-cron, which checks
// every ten minutes, calls it with { task: 'meeting-briefs' } when a meeting is
// about an hour away (lib/golda-meeting-brief.js). That check is recorded as a
// job only when a brief went out or failed, so it does not fill the jobs list.
//
// The same check wakes it with { task: 'player-sends' } when a message to a
// connected player is due (lib/golda-player-sends.js), recorded the same way
// as the job golda-player-sends.
const { withAuth } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');
const { getDb } = require('./lib/firestore.js');

async function meetingBriefs() {
  const notes = [];
  const r = await require('./lib/golda-meeting-brief.js').runMeetingBriefs(getDb(), new Date(), { job: { note: (s) => notes.push(s) } });
  if (notes.length) {
    await runJob('golda-meeting-brief', async (job) => {
      notes.forEach((n) => job.note(n));
      if (r.failed && !r.sent) throw new Error(notes.join('; ').slice(0, 500));
      return r;
    }, { trigger: 'cron' }).catch((e) => console.error('[golda-meeting-brief]', e.message));
  }
  return r;
}

async function playerSends() {
  const notes = [];
  const r = await require('./lib/golda-player-sends.js').runPlayerSends(getDb(), new Date(), { job: { note: (s) => notes.push(s) } });
  if (notes.length) {
    await runJob('golda-player-sends', async (job) => {
      notes.forEach((n) => job.note(n));
      if (r.failed && !r.sent) throw new Error(notes.join('; ').slice(0, 500));
      return r;
    }, { trigger: 'cron' }).catch((e) => console.error('[golda-player-sends]', e.message));
  }
  return r;
}

exports.handler = withAuth({ internal: true, action: 'manage_settings' }, async (event) => {
  let body = {};
  try { body = event && event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  try {
    const r = body.task === 'meeting-briefs' ? await meetingBriefs()
      : body.task === 'player-sends' ? await playerSends()
      : await runJob('golda-briefing', (job) => require('./golda-briefing.js')._internal.run(job, new Date()));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.error('[golda-briefing-background] failed:', e);
    return { statusCode: 500, body: String(e.message || e) };
  }
});
