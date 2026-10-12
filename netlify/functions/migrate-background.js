// Runs the pending data migrations (backup first) in the background, where a
// function may take up to 15 minutes. Started by migrate.js (admin button)
// or by deploy-succeeded (production deploy); both pass an internal nonce.
const { withAuth } = require('./lib/auth.js');
const { _runAll } = require('./migrate.js');

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async (event, context) => {
  const q = event.queryStringParameters || {};
  const trigger = q.trigger || (context.auth.via === 'user' ? context.auth.user.email : 'internal');
  try {
    const r = await _runAll(trigger);
    console.log(`[migrate] ${JSON.stringify(r.ran || [])}`);
  } catch (e) {
    console.error('[migrate] failed:', e);
  }
  return { statusCode: 202, body: 'started' };
});
