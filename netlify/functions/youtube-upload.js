// The upload page's endpoint (/yt/<token>, apps/web/src/pages/YouTubeUpload.jsx).
// A video too big for WhatsApp goes from the writer's phone straight to
// YouTube: this function only opens the upload session (with the title and
// description Golda and the writer agreed on) and hears when it is done.
//
// No sign-in: the token in the link is the key. It is random (192 bits),
// belongs to one confirmed job, lives 48 hours, and can do one thing only:
// put that one video on the channel with the agreed details.
//
//   GET  ?t=<token>                              → what is being uploaded
//   POST { t, action: 'session', size, type }    → { uploadUrl }
//   POST { t, action: 'done', videoId }          → { link }
//
// A highlights job (the writer asked Golda for chosen moments of a match): the
// GET also answers `highlights: { moments: [{ start, end }], total }`, read
// from the job and checked again here. The page cuts those moments out of the
// match file on the phone and uploads only them, so its session request says
// what it cut: { …, type: 'video/mp4', cut: { seconds, clips } }. A session
// for such a job without a cut, or with one longer than the moments allow, is
// refused: the whole match never goes up through a highlights link.
const { json, internalHeaders } = require('./lib/auth.js');
const { getDb, admin } = require('./lib/firestore.js');
const jobs = require('./lib/youtube-jobs.js');
const yt = require('./lib/youtube.js');
const ytAuth = require('./lib/youtube-auth.js');
const outbox = require('./lib/wa-outbox.js');
const { originOf, isOurOrigin } = require('./lib/site.js');

const MAX_BYTES = 12 * 1024 * 1024 * 1024;
// A clip starts at the keyframe before its moment, so the cut runs a little
// longer than the moments: at most this many seconds per moment (the page
// refuses a file whose keyframes are further apart), plus a little for the ends.
const CUT_LEAD = 30;
const CUT_SLACK = 10;
const BAD_MOMENTS = 'הרגעים שנשמרו לקישור הזה לא תקינים. בקש מגולדה קישור חדש.';

const view = (job, highlights) => ({
  status: job.status, player: job.target?.name || '', title: job.meta?.title || '', privacy: job.meta?.privacy || '',
  link: job.videoUrl || null,
  ...(highlights ? { highlights: { moments: highlights.moments, total: highlights.total } } : {}),
});

/** What the page says it cut, when it fits the job's moments; null otherwise. */
function cutOf(body, highlights) {
  const seconds = Number(body.cut && body.cut.seconds), clips = Number(body.cut && body.cut.clips);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(clips) || clips < 1) return null;
  const count = highlights.moments.length;
  if (clips > count || seconds > highlights.total + count * CUT_LEAD + CUT_SLACK) return null;
  return { seconds: Math.round(seconds * 10) / 10, clips };
}

exports.handler = async (event) => {
  const db = getDb();
  try {
    if (event.httpMethod === 'GET') {
      const job = await jobs.jobByToken(db, (event.queryStringParameters || {}).t);
      if (!job) return json(404, { error: 'הקישור הזה כבר לא בתוקף. בקש מגולדה קישור חדש.' });
      const highlights = jobs.highlightsOf(job);
      if (highlights && !highlights.ok) return json(409, { error: BAD_MOMENTS });
      return json(200, view(job, highlights));
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
    const job = await jobs.jobByToken(db, body.t);
    if (!job) return json(404, { error: 'הקישור הזה כבר לא בתוקף. בקש מגולדה קישור חדש.' });

    if (body.action === 'session') {
      const size = Number(body.size) || 0;
      if (!size || size > MAX_BYTES) return json(400, { error: 'הקובץ ריק או גדול מדי.' });
      if (body.type && !/^video\//.test(body.type)) return json(400, { error: 'זה לא קובץ וידאו.' });
      const highlights = jobs.highlightsOf(job);
      let cut = null;
      if (highlights) {
        if (!highlights.ok) return json(409, { error: BAD_MOMENTS });
        cut = cutOf(body, highlights);
        if (!cut || body.type !== 'video/mp4') return json(400, { error: 'הקישור הזה מעלה רק את הרגעים הנבחרים. רענן את הדף ובחר שוב את סרטון המשחק.' });
      }
      // The session is opened for the page's own address (the site or a preview of it),
      // so the browser there may send the bytes to YouTube.
      const origin = (event.headers || {}).origin || '';
      const uploadUrl = await jobs.openPageSession(db, job, { size, mimeType: body.type || 'video/*', cut },
        { origin: isOurOrigin(origin) ? origin : originOf(event) });
      return json(200, { uploadUrl });
    }

    if (body.action === 'done') {
      if (job.status === 'uploaded' || job.status === 'done') return json(200, { link: job.videoUrl });
      if (job.status !== 'awaiting_file') return json(409, { error: 'הקישור הזה כבר לא פעיל.' });
      const id = String(body.videoId || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(400, { error: 'bad video id' });
      // Only a video that really is on the connected channel may become the record's link.
      const token = await ytAuth.accessToken(db);
      const pub = await ytAuth.publicStatus(db);
      const v = token ? await yt.getVideo(token, id) : null;
      if (!v || v.snippet?.channelId !== pub.channel?.id) return json(400, { error: 'הסרטון לא נמצא בערוץ.' });
      const notify = async (j, text) => (j.by?.phone ? outbox.deliver(db, { to: j.by.phone, body: text, via: j.by.phoneId || null, kind: 'youtube' }) : null);
      const { link } = await jobs.afterUpload(db, job, id, { admin, notify, token });
      await fetch(`${originOf(event)}/.netlify/functions/youtube-upload-background`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('youtube-finish')) },
        body: JSON.stringify({ phase: 'finish', jobId: job.id }),
      }).catch((e) => console.warn('[youtube-upload] could not start the cover step:', e.message));
      return json(200, { link });
    }
    return json(400, { error: 'unknown action' });
  } catch (e) {
    console.error('[youtube-upload]', e.message);
    return json(500, { error: jobs.reasonHe(e) });
  }
};
