// Every fifteen minutes: kick the mail sync worker (gmail-sync-background.js).
// It does nothing when the mailbox is not connected, and asks Gmail only for
// mail with the addresses the CRM knows. Same shape as the other crons:
// schedule() and background functions don't mix, so this just calls the worker.
const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('*/15 * * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/gmail-sync-background`, {
      method: 'POST', headers: await internalHeaders('gmail-sync-cron'), body: '{}',
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
