// Golda's queue keeper. Every ten minutes it looks for messages that fell
// through: handed off but never picked up, stuck past a run's budget, failed
// on a transient error, or answered but not delivered, and pushes each one to
// the background worker again (lib/golda-worker.js pickRetries decides).
// Messages that failed for good stay as they are; the Golda screen shows them.
const { schedule } = require('@netlify/functions');
const { getDb } = require('./lib/firestore.js');
const { internalHeaders } = require('./lib/auth.js');
const { pickRetries } = require('./lib/golda-worker.js');

exports.handler = schedule('*/10 * * * *', async () => {
  const db = getDb();
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
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
  return { statusCode: 200, body: `${rows.length} recent, ${retry.length} to retry, ${kicked} kicked` };
});
