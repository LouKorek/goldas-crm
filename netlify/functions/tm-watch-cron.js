// Daily trigger for the Transfermarkt watch. Background functions and
// schedule() don't mix reliably (same lesson as the matches sync), so this
// tiny scheduled function just kicks the background worker over HTTP.
// 04:30 UTC = 06:30/07:30 Israel — results are in the inbox by morning.
const { schedule } = require('@netlify/functions');

exports.handler = schedule('30 4 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/tm-watch-background`, { method: 'POST' });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    return { statusCode: 500, body: String(e) };
  }
});
