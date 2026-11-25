// Every three hours: kick the market radar's scan (golda-radar-background.js).
// The scan reads the web with the model, which takes longer than a scheduled
// function may run, so this only calls the worker, like the other crons.
// The worker itself scans only between 07:00 and 22:00 Israel time, so the
// night's kicks end at once and record nothing. At :10 past, away from the
// hourly briefing run at :30 that sends the cards.
const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('10 */3 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/golda-radar-background`, {
      method: 'POST', headers: await internalHeaders('golda-radar-cron'), body: JSON.stringify({ reason: 'cron' }),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    console.error('[golda-radar-cron] trigger failed:', e && e.message);
    return { statusCode: 500, body: String((e && e.message) || e) };
  }
});
