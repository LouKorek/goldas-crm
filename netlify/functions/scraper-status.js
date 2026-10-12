// Read-only ScraperAPI account status — credits used / limit / renewal date.
// Shown on the TM Watch screen and the admin quotas tab so credit surprises
// never happen again. Exposes only harmless usage numbers, never the key.
const { withAuth } = require('./lib/auth.js');
const { scraperAccount } = require('./lib/scraper-account.js');

exports.handler = withAuth({ action: 'read' }, async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(await scraperAccount()),
}));
