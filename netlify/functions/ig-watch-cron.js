// Daily trigger for the Instagram public snapshot — 03:50 UTC, before the
// TM Watch chain, so both are fresh by morning.
const { schedule } = require('@netlify/functions');

exports.handler = schedule('50 3 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/ig-watch-background`, { method: 'POST' });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
