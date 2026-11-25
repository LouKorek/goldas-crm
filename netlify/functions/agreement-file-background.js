// Finishes signed representation agreements: builds and files the signed PDF
// when the signing request could not (lib/agreements.js fileAgreement, up to
// twelve tries), and tells the owner once that it was signed. Away from the
// signing page, so a signer never waits for WhatsApp.
//
// Woken by agreement-sign.js right after a signature, and by the ten-minute
// queue check (golda-queue-cron.js) while anything is still waiting.
// Internal callers only; an admin may run it too.
const { withAuth, json } = require('./lib/auth.js');
const { getDb, admin } = require('./lib/firestore.js');
const agreements = require('./lib/agreements.js');

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async () => {
  try {
    const r = await agreements.runPending(getDb(), { FieldValue: admin.firestore.FieldValue });
    return json(200, r);
  } catch (e) {
    console.error('[agreement-file]', e.name);
    return json(500, { error: 'failed' });
  }
});
