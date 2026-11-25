// Golda's queue keeper. Every ten minutes it looks for messages that fell
// through: handed off but never picked up, stuck past a run's budget, failed
// on a transient error, or answered but not delivered, and pushes each one to
// the background worker again (lib/golda-worker.js pickRetries decides).
// Messages that failed for good stay as they are; the Golda screen shows them.
//
// The same ten-minute beat also watches the calendar: when a meeting is about
// an hour away, it wakes golda-briefing-background to send Lou its brief
// (lib/golda-meeting-brief.js). The check itself is two small reads.
//
// And it is the safety net for live player pages: a first opening that could
// not wake its own notice (player-page.js) is picked up here, so Lou hears
// about it within ten minutes at the latest. One small query.
const { schedule } = require('@netlify/functions');
const { getDb } = require('./lib/firestore.js');
const { internalHeaders } = require('./lib/auth.js');
const { pickRetries } = require('./lib/golda-worker.js');
const { dueNow } = require('./lib/golda-meeting-brief.js');

/** Wakes the briefing worker when a meeting is coming up; never fails the queue check. */
async function kickMeetingBriefs(db, base) {
  try {
    const due = await dueNow(db, new Date());
    if (!due.length) return 0;
    await fetch(`${base}/.netlify/functions/golda-briefing-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('golda-meeting-brief')) }, body: JSON.stringify({ task: 'meeting-briefs' }),
    });
    return due.length;
  } catch (e) {
    console.error('[golda-queue] meeting brief check failed:', e.message);
    return 0;
  }
}

/** Wakes the notice worker when a live page's first opening is still waiting to be told. */
async function kickPageNotices(db, base) {
  try {
    const waiting = (await db.collection('player_pages').where('noticeState', '==', 'pending').get()).docs.length;
    if (!waiting) return 0;
    await fetch(`${base}/.netlify/functions/player-page-notify-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('player-page-notice')) }, body: '{}',
    });
    return waiting;
  } catch (e) {
    console.error('[golda-queue] live page notice check failed:', e.message);
    return 0;
  }
}

exports.handler = schedule('*/10 * * * *', async () => {
  const db = getDb();
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  const briefs = await kickMeetingBriefs(db, base);
  const pageNotices = await kickPageNotices(db, base);
  const since = Date.now() - 2 * 86400000;
  const snap = await db.collection('wa_inbox').where('timestamp', '>', Math.floor(since / 1000)).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const retry = pickRetries(rows);
  let kicked = 0;
  for (const m of retry.slice(0, 10)) {
    try {
      const res = await fetch(`${base}/.netlify/functions/whatsapp-agent-background`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('golda-queue')) }, body: JSON.stringify({ messageId: m.id }),
      });
      if (res.ok || res.status === 202) kicked++;
    } catch (e) { console.error('[golda-queue] kick failed:', m.id, e.message); }
  }
  return { statusCode: 200, body: `${rows.length} recent, ${retry.length} to retry, ${kicked} kicked, ${briefs} meeting brief(s) due, ${pageNotices} live page notice(s) waiting` };
});
