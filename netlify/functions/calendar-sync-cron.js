// Every ten minutes: kick the calendar sync worker. It checks cheaply whether
// anything changed on either side and only then does the full pass (see
// calendar-sync-background.js). Same shape as the other crons: schedule()
// and background functions don't mix, so this just calls the worker.
const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('*/10 * * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/calendar-sync-background`, {
      method: 'POST', headers: await internalHeaders('calendar-sync-cron'), body: '{}',
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
