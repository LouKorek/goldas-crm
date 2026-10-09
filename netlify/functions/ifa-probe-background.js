// Which way of reading football.org.il actually works today — measured on
// ONE page, before any full sync is allowed to spend credits finding out.
//
// The matches sync tries direct → render=false → render=true for every page
// it needs. When nobody knows which of those works, each player pays for the
// failures. This answers the question once, for the price of at most one
// page, and leaves the answer in app_meta/ifaProbe where the sync (and
// ifa-probe, which only reads) can see it.
//
//   /.netlify/functions/ifa-probe-background                 direct only, free
//   /.netlify/functions/ifa-probe-background?pay=plain       + render=false, 1 credit
//   /.netlify/functions/ifa-probe-background?pay=render      + render=true, 10 credits
//   &url=<football.org.il url>    page to test (default: Noam Barzilai's team games)
//   &player=<name fragment>       pick the default page from another player
//
// Stops at the first strategy that returns a real page, so pay=render only
// spends the 10 credits when the cheaper two have already failed. A paid run
// is refused within PAID_COOLDOWN_H of the last one, and whenever it would
// leave fewer than its own cost in the account — an open URL must not be a
// way to drain the quota.
//
// Background function: render=true can take longer than a synchronous
// function is allowed to live. Results: /.netlify/functions/ifa-probe

const admin   = require('firebase-admin');
const cheerio = require('cheerio');

const PAID_COOLDOWN_H = 6;
const COST = { direct: 0, plain: 1, render: 10 };
const LEVELS = { none: ['direct'], plain: ['direct', 'plain'], render: ['direct', 'plain', 'render'] };

const IFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
};

function getDb() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  return admin.firestore();
}

async function creditsLeft(apiKey) {
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://api.scraperapi.com/account?api_key=${apiKey}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.requestLimit == null) return null;
    return Math.max(0, Number(j.requestLimit) - Number(j.requestCount || 0));
  } catch { return null; }
}

// Same page the sync would read for this player: team games when the team is
// already resolved, otherwise whatever Lou pasted.
async function defaultTarget(db, nameFragment) {
  const snap = await db.collection('players').get();
  const re = nameFragment ? new RegExp(nameFragment, 'i') : /ברזילי|barzilai/i;
  const p = snap.docs.map(d => ({ id: d.id, ...d.data() })).find(x => re.test(x.fullName || ''));
  if (!p) return { error: `no player matching ${re}` };
  const teamId = p.autoFetch?.ifa?.teamId;
  let origin = 'https://www.football.org.il';
  try { origin = new URL(p.ifaTeamUrl).origin; } catch {}
  if (teamId) return { player: p.fullName, url: `${origin}/team-details/team-games/?team_id=${teamId}` };
  if (p.ifaTeamUrl) return { player: p.fullName, url: p.ifaTeamUrl };
  return { error: `${p.fullName} has no IFA link` };
}

async function attempt(strategy, targetUrl, apiKey) {
  const url = strategy === 'direct' ? targetUrl
    : `https://api.scraperapi.com/?${new URLSearchParams({
        api_key: apiKey, url: targetUrl,
        render: strategy === 'render' ? 'true' : 'false',
        country_code: 'il', device_type: 'desktop',
        ...(strategy === 'render' ? { wait: '6' } : {}),
      }).toString()}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: IFA_HEADERS, signal: AbortSignal.timeout(strategy === 'render' ? 90000 : 40000) });
    const html = await res.text();
    const blocked = /Just a moment|cf-browser-verification|Attention Required/i.test(html);
    const $ = cheerio.load(html);
    return {
      strategy, status: res.status, ms: Date.now() - t0, htmlLength: html.length,
      blocked, title: $('title').first().text().trim().slice(0, 120),
      fixtureRows: $('a.table_row.link_url').length,
      ok: res.ok && !blocked && html.length > 20000,
    };
  } catch (e) {
    return { strategy, ms: Date.now() - t0, ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

exports.handler = async (event) => {
  const db = getDb();
  const ref = db.collection('app_meta').doc('ifaProbe');
  const q = event.queryStringParameters || {};
  const pay = LEVELS[q.pay] ? q.pay : 'none';
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  // merge, so a rejected request can't wipe lastPaidAt and reset the cooldown.
  const write = (doc) => ref.set({ ...doc, at: admin.firestore.Timestamp.now() }, { merge: true });

  let target;
  if (q.url) {
    let u; try { u = new URL(q.url); } catch { u = null; }
    if (!u || !u.hostname.endsWith('football.org.il')) { await write({ error: 'url must be on football.org.il' }); return { statusCode: 400 }; }
    target = { url: u.toString() };
  } else {
    target = await defaultTarget(db, q.player);
    if (target.error) { await write({ error: target.error }); return { statusCode: 400 }; }
  }

  const prev = (await ref.get()).data() || {};
  let strategies = LEVELS[pay];
  const before = await creditsLeft(apiKey);
  let refusedPaid = null;
  if (pay !== 'none') {
    const lastPaid = prev.lastPaidAt?.toDate?.()?.getTime?.() || 0;
    const maxCost = strategies.reduce((s, k) => s + COST[k], 0);
    if (!apiKey) refusedPaid = 'no SCRAPER_API_KEY';
    else if (Date.now() - lastPaid < PAID_COOLDOWN_H * 3600000) refusedPaid = `a paid probe already ran in the last ${PAID_COOLDOWN_H}h`;
    else if (before != null && before < maxCost * 2) refusedPaid = `only ${before} credits left`;
    if (refusedPaid) strategies = ['direct'];
  }

  const attempts = [];
  for (const s of strategies) {
    const r = await attempt(s, target.url, apiKey);
    attempts.push(r);
    if (r.ok) break;
  }
  const winner = attempts.find(a => a.ok)?.strategy || null;
  const spentPaid = attempts.some(a => a.strategy !== 'direct');

  await write({
    error: null, player: target.player || null, url: target.url, pay, refusedPaid,
    attempts, winner, creditsBefore: before, creditsAfter: await creditsLeft(apiKey),
    lastPaidAt: spentPaid ? admin.firestore.Timestamp.now() : (prev.lastPaidAt || null),
  });
  console.log('[ifa-probe]', JSON.stringify({ url: target.url, winner, attempts }));
  return { statusCode: 200 };
};
