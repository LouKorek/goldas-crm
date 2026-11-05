// Every hour at :45 — moves Golda onto her own number as soon as Meta allows
// it (lib/meta-onboard.js). Once she is live there, the pass is a cheap
// status read. Runs in ops-background (recorded in `jobs`), kicked over HTTP
// with an internal nonce, like the other crons. The cron expression must be
// a literal here (Netlify reads it at build time).
const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('45 * * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/ops-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await internalHeaders('meta-onboard-cron')) },
      body: JSON.stringify({ task: 'meta-onboard' }),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
