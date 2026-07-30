// Instagram public-profile watch for @goldas_loukorek.
//
// PUBLIC DATA ONLY — the daily snapshot reads exactly what any logged-out
// visitor sees: follower / following / post counts and the latest public
// posts (type, caption, likes, comments, date). No login, no session, no
// cookies — nothing ever touches the agency account itself.
//
// Storage:
//   igDaily/{YYYY-MM-DD}  — one snapshot per day (counts)
//   igPosts/{shortcode}   — one doc per post, engagement refreshed daily
//   app_meta/igWatch      — latest counts + run status
//
// The Social dashboard (/social) derives everything else client-side:
// trends per date range, daily deltas, and post↔follower-change impact.
//
// Env: FIREBASE_SERVICE_ACCOUNT_KEY, SCRAPER_API_KEY (optional but advised).

const admin = require('firebase-admin');

const USERNAME = 'goldas_loukorek';
const TZ = 'Asia/Jerusalem';

let _db;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
  _db = admin.firestore();
  return _db;
}

function localDate(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(now); // YYYY-MM-DD
}

// "12.5K" / "1,234" / "2M" → number
function parseCount(s) {
  if (typeof s === 'number') return s;
  if (!s) return null;
  const t = String(s).replace(/,/g, '').trim();
  const m = /^([\d.]+)\s*([KM]?)$/i.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(m[2].toUpperCase() === 'M' ? n * 1e6 : m[2].toUpperCase() === 'K' ? n * 1e3 : n);
}

async function fetchVia(url, { json = false, viaProxy = true, render = false } = {}) {
  const apiKey = (process.env.SCRAPER_API_KEY || '').trim();
  if (viaProxy && !apiKey) throw new Error('no proxy key');
  const params = viaProxy
    ? new URLSearchParams({ api_key: apiKey, url, ...(render ? { render: 'true' } : {}) })
    : null;
  const finalUrl = viaProxy ? `https://api.scraperapi.com/?${params.toString()}` : url;
  const res = await fetch(finalUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': json ? 'application/json' : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(json ? { 'x-ig-app-id': '936619743392459' } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Strategy 1: Instagram's public web-profile JSON (counts + latest 12 posts).
async function fetchProfileJson(viaProxy, render = false) {
  const raw = await fetchVia(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${USERNAME}`,
    { json: true, viaProxy, render });
  const j = JSON.parse(raw);
  const u = j?.data?.user;
  if (!u || u.edge_followed_by == null) throw new Error('unexpected shape');
  const posts = (u.edge_owner_to_timeline_media?.edges || []).map(({ node: n }) => ({
    shortcode: n.shortcode,
    url: `https://www.instagram.com/p/${n.shortcode}/`,
    type: n.__typename === 'GraphSidecar' ? 'carousel' : n.is_video ? 'video' : 'image',
    caption: (n.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 300),
    likes: n.edge_liked_by?.count ?? n.edge_media_preview_like?.count ?? null,
    comments: n.edge_media_to_comment?.count ?? null,
    takenAt: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000).toISOString() : null,
    thumb: n.thumbnail_src || '',
  }));
  return {
    followers: u.edge_followed_by?.count ?? null,
    following: u.edge_follow?.count ?? null,
    postCount: u.edge_owner_to_timeline_media?.count ?? null,
    posts,
    source: `web_profile_info${viaProxy ? (render ? '+proxy(render)' : '+proxy') : '+direct'}`,
  };
}

// Strategy 2: the profile page's og:description meta — counts only.
// e.g. "123 Followers, 45 Following, 67 Posts - ..."
async function fetchProfileHtml(viaProxy, render = false) {
  const html = await fetchVia(`https://www.instagram.com/${USERNAME}/`, { viaProxy, render });
  const og = /property="og:description"\s+content="([^"]+)"/.exec(html)
          || /content="([^"]+)"\s+property="og:description"/.exec(html);
  if (!og) throw new Error('no og:description');
  const m = /([\d.,KM]+)\s+Followers?,\s*([\d.,KM]+)\s+Following,\s*([\d.,KM]+)\s+Posts?/i.exec(og[1]);
  if (!m) throw new Error(`og unparsable: ${og[1].slice(0, 80)}`);
  return {
    followers: parseCount(m[1]),
    following: parseCount(m[2]),
    postCount: parseCount(m[3]),
    posts: [],
    source: `og:description${viaProxy ? (render ? '+proxy(render)' : '+proxy') : '+direct'}`,
  };
}

async function collect(log) {
  // Free attempts first — a proxy credit is only spent if Instagram refuses
  // the plain request. The rendered proxy is the last resort: it costs more
  // credits, but it is the only thing that gets through when Instagram
  // serves a JavaScript-only shell.
  const attempts = [
    ['json direct',        () => fetchProfileJson(false)],
    ['og direct',          () => fetchProfileHtml(false)],
    ['json proxy',         () => fetchProfileJson(true)],
    ['og proxy',           () => fetchProfileHtml(true)],
    ['og proxy rendered',  () => fetchProfileHtml(true, true)],
  ];
  const failures = [];
  for (const [name, attempt] of attempts) {
    try {
      const r = await attempt();
      if (r.followers != null) { log.push(`source: ${r.source}`); return r; }
      failures.push(`${name}: no counts in response`);
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  }
  // Surface exactly which door was shut, so the screen shows something
  // actionable instead of a blanket failure.
  throw new Error(failures.join(' | '));
}

async function run() {
  const db = getDb();
  const metaRef = db.collection('app_meta').doc('igWatch');
  const log = [];
  try {
    const snap = await collect(log);
    const now = admin.firestore.Timestamp.now();
    const today = localDate();

    await db.collection('igDaily').doc(today).set({
      date: today,
      followers: snap.followers,
      following: snap.following,
      postCount: snap.postCount,
      source: snap.source,
      ts: now,
    }, { merge: true });

    // Upsert posts; firstSeen is written once and never overwritten.
    await Promise.all(snap.posts.map(async (p) => {
      const ref = db.collection('igPosts').doc(p.shortcode);
      const prev = await ref.get();
      await ref.set({
        ...p,
        lastUpdated: now,
        ...(prev.exists && prev.data().firstSeen ? {} : { firstSeen: now }),
      }, { merge: true });
    }));

    await metaRef.set({
      username: USERNAME,
      followers: snap.followers, following: snap.following, postCount: snap.postCount,
      lastRunAt: now, lastError: null, lastRunLog: log.join(' | '),
    }, { merge: true });

    console.log(log.join('\n'));
    return { statusCode: 200, body: `ok: ${snap.followers} followers, ${snap.posts.length} posts (${snap.source})` };
  } catch (e) {
    await metaRef.set({ lastError: String(e), lastRunAt: admin.firestore.Timestamp.now(), lastRunLog: log.join(' | ') }, { merge: true }).catch(() => {});
    console.error('ig-watch failed:', e, log.join(' | '));
    return { statusCode: 500, body: String(e) };
  }
}

exports.handler = async () => run();
