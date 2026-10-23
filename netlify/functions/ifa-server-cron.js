// Morning trigger for the server-side read of the Israeli fixtures.
//
// Same shape as sync-matches-cron: background functions and schedule() don't
// mix reliably, so the scheduled function kicks the background worker over
// HTTP with a single-use internal nonce and returns.
//
// 03:00 UTC = 05:00 Israel in winter, 06:00 in summer — before the 03:10
// matches cron, which leaves Israeli players alone while this read is fresh,
// and long before Lou's 07:30 briefing.
//
// Netlify's bundler reads the cron expression out of this file at build time,
// so it has to be a string literal right here (an imported value fails the
// deploy: "Unable to find cron expression for scheduled function"). The same
// expression is kept in lib/ifa-exa.js (SCHEDULE.cron), where Golda's
// quiet-hours rule derives from it; ifa-exa.test.js checks the two agree.

const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('0 3 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/ifa-server-sync-background`, {
      method: 'POST',
      headers: await internalHeaders('ifa-server-cron'),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
