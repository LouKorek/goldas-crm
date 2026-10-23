// The Israeli fixtures, read by the server itself.
//
// Until October 2026 football.org.il could only be read from Chrome on Lou's
// computer (the browser sync), so a day the computer was asleep was a day
// without fixtures. This function reads the same pages through Exa
// (lib/ifa-exa.js) and publishes through the same import, with the same
// checks, as the browser sync: nothing is written unless the whole read
// passes them. The Chrome routine still works and remains the fallback that
// can resolve a brand-new player's squad.
//
//   POST /.netlify/functions/ifa-server-sync-background          publish
//   POST ...?dryRun=1                                              checks only
//
// Called by ifa-server-cron with an internal nonce every morning, or by a
// signed-in admin / manager (run_sync), or with x-sync-secret. Background
// function: Netlify answers 202 at once; the result lands in
// app_meta/ifaBrowserSync (stats.via = 'exa-api' | 'exa-mcp') and in the
// jobs list on the admin Health screen as "ifa-server-sync".

const { withAuth } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');
const { _lib } = require('./sync-matches-background.js');
const { buildTargets } = require('./ifa-targets.js');
const { runImport } = require('./ifa-import-background.js');
const { makeReader, scrapeTargets } = require('./lib/ifa-exa.js');

const { getDb } = _lib;

async function runServerSync({ dryRun = false, now = new Date(), env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const db = getDb();
  const { targets } = await buildTargets(db);
  const reader = makeReader({ env, fetchImpl });
  log(`[ifa-server-sync] ${targets.length} targets via ${reader.via}${dryRun ? ' (dry run)' : ''}`);
  const payload = await scrapeTargets(targets, { reader, now, log });
  const read = payload.results.filter((r) => r.gamesOk).length;
  const fixtures = payload.results.reduce((n, r) => n + (r.fixtures ? r.fixtures.length : 0), 0);
  log(`[ifa-server-sync] read ${read}/${targets.length} pages, ${fixtures} upcoming fixtures, pages=${JSON.stringify(payload.pages)}`);
  const imp = await runImport(db, payload, { dryRun, via: reader.via });
  const refused = imp.summary?.refused || null;
  const message = refused
    ? `${reader.via}: refused — ${refused.join('; ')}`
    : dryRun
      ? `${reader.via}: dry run, ${imp.summary?.toWrite || 0} players would be written, ${fixtures} fixtures`
      : `${reader.via}: ${imp.stats?.written || 0} players, ${imp.stats?.upserts || 0} upserts, ${imp.stats?.removed || 0} removed`;
  return {
    ok: !refused, message, via: reader.via, dryRun,
    targets: targets.length, read, fixtures, pages: payload.pages, costDollars: payload.costDollars,
    refused, stats: imp.stats || null,
    errors: payload.results.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`),
  };
}

exports.handler = withAuth({ action: 'run_sync', internal: true, secrets: [{ header: 'x-sync-secret', env: 'CRM_SYNC_SECRET' }] }, async (event) => {
  const q = event.queryStringParameters || {};
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const dryRun = q.dryRun === '1' || q.dryRun === 'true' || !!body.dryRun;
  try {
    const result = await runJob('ifa-server-sync', async (job) => {
      const r = await runServerSync({ dryRun });
      job.note(r.message);
      if (!r.ok) throw Object.assign(new Error(r.message), { result: r });
      return r;
    }, { dryRun });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (e) {
    console.error('ifa-server-sync-background failed:', e?.result ? e.message : e);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
});

exports.runServerSync = runServerSync;
