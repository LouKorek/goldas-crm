// System › Website: can Golda publish to gold-as.com right now?
//
//   POST (admin) → { ok, why, waitingForPanel, serviceEmail, at }
//
// Asks the website panel's server for the site's list of files with Golda's
// pass (lib/website-publish.js), which changes nothing on the site, and keeps
// the answer in app_meta/website for the app to show. serviceEmail is the
// address the panel's server knows Golda by; it is not a secret.
const { withAuth, json } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const { siteClient } = require('./lib/website-publish.js');
const { saveMeta } = require('./lib/website-drafts.js');

exports.handler = withAuth({ action: 'manage_settings' }, async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const check = await siteClient().check();
  const connection = { ok: !!check.ok, at: Date.now(), why: check.why || '', waitingForPanel: !!check.waitingForPanel, serviceEmail: check.serviceEmail || '' };
  await saveMeta(getDb(), { connection });
  return json(200, connection);
});
