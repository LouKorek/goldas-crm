// System › Quotas: what Golda's model calls cost, and the day's ceiling on
// the work she does on her own (lib/golda-cost.js). Admin only.
//
//   GET  → { capUsd, defaultCapUsd, capMin, capMax, pricesAsOf,
//            today: { date, totalUsd, backgroundUsd, byKind, calls, estimatedCalls, capped, cappedAt },
//            days: [{ date, totalUsd, backgroundUsd, calls }],   the last 14 days, oldest first
//            periodUsd }                                         those 14 days together
//   POST { capUsd }  a number from 0 to 100 (US dollars a day; 0 stops her own
//            work) → the same answer with the new ceiling
//
// The ledger is a collection only the server reads and writes, so the screen
// asks here instead of reading it. Sums of money only: the ledger holds no
// message, name or prompt.
const { withAuth, json } = require('./lib/auth.js');
const { getDb } = require('./lib/firestore.js');
const cost = require('./lib/golda-cost.js');

async function handle(event, ctx, { db = getDb(), now = Date.now() } = {}) {
  if (event.httpMethod === 'GET') return json(200, await cost.meter(db, { now }));
  if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  if (!cost.validCap(body && body.capUsd)) return json(400, { error: `capUsd must be a number from ${cost.CAP_MIN} to ${cost.CAP_MAX}` });
  await cost.setCap(db, body.capUsd, { by: ctx.auth && ctx.auth.user ? ctx.auth.user.email : '', now });
  return json(200, await cost.meter(db, { now }));
}

exports.handler = withAuth({ action: 'manage_settings' }, (event, ctx) => handle(event, ctx));
exports._internal = { handle };
