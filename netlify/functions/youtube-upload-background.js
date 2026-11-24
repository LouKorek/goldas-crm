// The long parts of a YouTube upload, away from Golda's reply:
//
//   POST { phase: 'upload', jobId }  the server sends the video it got on
//                                    WhatsApp (or from a link) to YouTube,
//                                    replaces the record's video link, tells
//                                    the writer, then starts 'finish'
//   POST { phase: 'finish', jobId }  waits for YouTube to process the video
//                                    and sets the cover; when YouTube needs
//                                    longer than one run, it calls itself again
//   POST { phase: 'learn' }          reads the channel's latest videos and
//                                    stores the style (lib/youtube-style.js)
//
// Called by Golda's tool, the upload page's endpoint and youtube-connect, with
// an internal nonce; an admin may call it too.
const { withAuth, json, internalHeaders } = require('./lib/auth.js');
const { getDb, admin } = require('./lib/firestore.js');
const { runJob } = require('./lib/jobs.js');
const jobs = require('./lib/youtube-jobs.js');
const ytAuth = require('./lib/youtube-auth.js');
const ytStyle = require('./lib/youtube-style.js');
const wa = require('./lib/wa-api.js');
const outbox = require('./lib/wa-outbox.js');
const { originOf } = require('./lib/site.js');

const notify = (db) => async (job, body) => {
  if (!job.by?.phone) return null;
  return outbox.deliver(db, { to: job.by.phone, body, via: job.by.phoneId || null, kind: 'youtube' });
};

async function again(event, jobId) {
  await fetch(`${originOf(event)}/.netlify/functions/youtube-upload-background`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('youtube-finish')) },
    body: JSON.stringify({ phase: 'finish', jobId }),
  });
}

async function finishPhase(db, event, jobId) {
  const job = await jobs.getJob(db, jobId);
  if (!job) return { skipped: 'no such job' };
  const r = await jobs.finish(db, job, { wa, notify: notify(db) });
  if (r.again) {
    const tries = (job.finishTries || 0) + 1;
    if (tries >= jobs.FINISH_TRIES) {
      await jobs.patchJob(db, jobId, { status: 'done', coverSet: false, coverError: 'YouTube was still processing the video' });
      await notify(db)(job, `הסרטון של ${job.target.name} באוויר, אבל יוטיוב עוד מעבד אותו ולכן לא שמתי קאבר. אפשר לבקש ממני שוב מאוחר יותר.`).catch(() => {});
      return { done: true, coverSet: false };
    }
    await jobs.patchJob(db, jobId, { finishTries: tries });
    await again(event, jobId);
  }
  return r;
}

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const db = getDb();
  try {
    if (body.phase === 'learn') {
      await runJob('youtube-style', async (job) => {
        const token = await ytAuth.accessToken(db);
        if (!token) { job.note('not connected'); return { skipped: true }; }
        const pub = await ytAuth.publicStatus(db);
        const doc = await ytStyle.learnStyle(db, { token, channel: pub.channel });
        job.note(`${doc.fromVideos} videos${doc.problem ? ` – ${doc.problem}` : ''}`);
        return { videos: doc.fromVideos, learned: doc.learned };
      }, { trigger: 'manual' });
      return json(200, { ok: true });
    }
    if (!body.jobId) return json(400, { error: 'jobId is required' });
    if (body.phase === 'upload') {
      const job = await jobs.getJob(db, body.jobId);
      if (!job || job.status !== 'uploading') return json(200, { skipped: job ? `status ${job.status}` : 'no such job' });
      if (job.startedAt) return json(200, { skipped: 'already started' });
      await jobs.patchJob(db, job.id, { startedAt: Date.now() });
      const r = await jobs.runServerUpload(db, job, { admin, wa, notify: notify(db) });
      await again(event, job.id);             // the cover gets a run of its own (it waits for YouTube)
      return json(200, r);
    }
    if (body.phase === 'finish') return json(200, await finishPhase(db, event, body.jobId));
    return json(400, { error: `unknown phase ${body.phase}` });
  } catch (e) {
    console.error(`[youtube] ${body.phase} failed:`, e.message);
    return json(500, { error: String(e.message || e).slice(0, 300) });
  }
});
