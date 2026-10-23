// Morning trigger for the server-side read of the Israeli fixtures.
//
// Same shape as sync-matches-cron: background functions and schedule() don't
// mix reliably, so the scheduled function kicks the background worker over
// HTTP with a single-use internal nonce and returns.
//
// 03:00 UTC = 05:00 Israel in winter, 06:00 in summer — before the 03:10
// matches cron, which leaves Israeli players alone while this read is fresh,
// and long before Lou's 07:30 briefing. The schedule itself lives in
// lib/ifa-exa.js (SCHEDULE), next to the quiet-hours rule Golda derives from
// it, so the two cannot drift apart.

const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');
const { SCHEDULE } = require('./lib/ifa-exa.js');

exports.handler = schedule(SCHEDULE.cron, async () => {
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
