// Admin: start any scheduled job now, from the Health tab. The jobs with a
// background worker of their own are kicked the way their crons kick them;
// the rest run through ops-background. Answers at once; the run shows up in
// `jobs` within seconds, which the screen listens to.
//
//   POST { job: 'sync-matches' | 'tm-watch' | 'ig-watch' | 'backup' | 'nightly-engines' | 'send-alerts' | 'golda-briefing' }
const { withAuth, json, internalHeaders } = require('./lib/auth.js');

const WORKERS = { 'sync-matches': 'sync-matches-background', 'tm-watch': 'tm-watch-background', 'ig-watch': 'ig-watch-background' };
const OPS = new Set(['backup', 'nightly-engines', 'send-alerts', 'golda-briefing']);

exports.handler = withAuth({ action: 'manage_settings' }, async (event, ctx) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }
  const job = String(body.job || '');
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  const purpose = `admin-run:${ctx.auth.user.email}`;
  let res;
  if (WORKERS[job]) {
    res = await fetch(`${base}/.netlify/functions/${WORKERS[job]}`, { method: 'POST', headers: await internalHeaders(purpose) });
  } else if (OPS.has(job)) {
    res = await fetch(`${base}/.netlify/functions/ops-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(await internalHeaders(purpose)) }, body: JSON.stringify({ task: job }),
    });
  } else {
    return json(400, { error: `unknown job ${job}` });
  }
  if (!res.ok && res.status !== 202) return json(502, { error: `could not start ${job} (${res.status})` });
  return json(200, { started: job });
});
exports._internal = { WORKERS, OPS: [...OPS] };
