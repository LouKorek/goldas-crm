// Runs Golda for one queued WhatsApp message, in the background (up to 15
// minutes) so the webhook can answer Meta immediately. The work itself is in
// lib/golda-worker.js, shared with the in-app chat.
const { withAuth } = require('./lib/auth.js');
const { processMessage } = require('./lib/golda-worker.js');

// Only the webhook and the queue cron of this site may call this (single-use internal nonce).
exports.handler = withAuth({ internal: true, action: 'manage_settings' }, async (event) => {
  const { messageId } = JSON.parse(event.body || '{}');
  const r = await processMessage(messageId);
  return { statusCode: r.status, body: r.body };
});
