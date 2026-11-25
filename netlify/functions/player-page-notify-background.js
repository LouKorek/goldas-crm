// Tells the owner, in one WhatsApp line, that a live player page was opened
// for the first time (which club, which player, when). Away from the page's
// own endpoint, so a club never waits for WhatsApp.
//
// Woken by player-page.js on a link's first opening, and by the ten-minute
// queue check (golda-queue-cron.js) for any notice that was not picked up.
// Each link is told about once at most (lib/player-pages.js sendNotices).
// Internal callers only; an admin may run it too.
const { withAuth, json } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const pages = require('./lib/player-pages.js');

exports.handler = withAuth({ action: 'manage_settings', internal: true }, async () => {
  try {
    const r = await pages.sendNotices(getDb());
    return json(200, r);
  } catch (e) {
    console.error('[player-page-notify]', e.message);
    return json(500, { error: 'failed' });
  }
});
