// The automatic backup's clock: every night at 01:30 UTC it asks the
// background worker whether a backup is due (ops-background 'backup-weekly':
// due when the newest good one is a week old, so a failed night is made up
// for the next night). A backup of the whole database takes minutes and a
// scheduled function is cut off after seconds, which is how the automatic
// backup used to die quietly; so this only asks, the way the other long jobs
// are started. The work itself is lib/backup.js.
const { schedule } = require('@netlify/functions');
const { internalHeaders } = require('./lib/auth.js');

exports.handler = schedule('30 1 * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/ops-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders('backup-weekly')) }, body: JSON.stringify({ task: 'backup-weekly' }),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    console.error('backup trigger failed:', e);
    return { statusCode: 500, body: String(e) };
  }
});
