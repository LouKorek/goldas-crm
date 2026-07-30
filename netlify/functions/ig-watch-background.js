// Instagram tracking for @goldas_loukorek via Meta's OFFICIAL Graph API.
//
// Why the API and not scraping: Instagram serves a login wall to every
// datacenter IP (verified against direct requests, three proxy modes and an
// external reader service — all returned 403 or the login page), and the
// proxy provider blocks social domains outright. The Graph API is the
// sanctioned route: free, stable, and it exposes reach/impressions/profile
// views that scraping never could.
//
// Required Netlify environment variables:
//   IG_ACCESS_TOKEN  — long-lived Instagram/Facebook user access token
//   IG_USER_ID       — the Instagram Business account id (numeric)
//
// Storage (unchanged, so the Social screen keeps working as-is):
//   igDaily/{YYYY-MM-DD}  — daily snapshot of the account counters
//   igPosts/{id}          — one doc per post, engagement refreshed daily
//   app_meta/igWatch      — latest counters + run status

const admin = require('firebase-admin');

const USERNAME = 'goldas_loukorek';
const TZ = 'Asia/Jerusalem';
const GRAPH = 'https://graph.facebook.com/v21.0';

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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // YYYY-MM-DD
}

async function graph(path, params = {}) {
  const token = (process.env.IG_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('IG_ACCESS_TOKEN is not set in Netlify');
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${GRAPH}${path}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new Error(`Graph ${path}: ${e.message || res.status}${e.code ? ` (code ${e.code})` : ''}`);
  }
  return body;
}

// Resolve the Instagram Business account id — from the env var when given,
// otherwise by walking the Pages the token can see.
async function resolveUserId(log) {
  const explicit = (process.env.IG_USER_ID || '').trim();
  if (explicit) return explicit;
  const pages = await graph('/me/accounts', { fields: 'name,instagram_business_account' });
  for (const page of pages.data || []) {
    if (page.instagram_business_account?.id) {
      log.push(`resolved IG account via page "${page.name}"`);
      return page.instagram_business_account.id;
    }
  }
  throw new Error('No Instagram Business account is linked to this token — connect the Instagram account to a Facebook Page.');
}

const TYPE_MAP = { IMAGE: 'image', CAROUSEL_ALBUM: 'carousel', VIDEO: 'video', REELS: 'video' };

async function run() {
  const db = getDb();
  const metaRef = db.collection('app_meta').doc('igWatch');
  const log = [];
  try {
    const userId = await resolveUserId(log);

    // Account counters.
    const acc = await graph(`/${userId}`, {
      fields: 'username,followers_count,follows_count,media_count',
    });

    // Latest posts with their engagement.
    const media = await graph(`/${userId}/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count',
      limit: '25',
    });

    const now = admin.firestore.Timestamp.now();
    const today = localDate();

    await db.collection('igDaily').doc(today).set({
      date: today,
      followers: acc.followers_count ?? null,
      following: acc.follows_count ?? null,
      postCount: acc.media_count ?? null,
      source: 'graph-api',
      ts: now,
    }, { merge: true });

    const posts = (media.data || []).map(m => ({
      shortcode: m.id,
      url: m.permalink || '',
      type: TYPE_MAP[m.media_product_type === 'REELS' ? 'REELS' : m.media_type] || 'image',
      caption: (m.caption || '').slice(0, 300),
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
      takenAt: m.timestamp ? new Date(m.timestamp).toISOString() : null,
      thumb: m.thumbnail_url || m.media_url || '',
    }));

    await Promise.all(posts.map(async (p) => {
      const ref = db.collection('igPosts').doc(p.shortcode);
      const prev = await ref.get();
      await ref.set({
        ...p,
        lastUpdated: now,
        ...(prev.exists && prev.data().firstSeen ? {} : { firstSeen: now }),
      }, { merge: true });
    }));

    await metaRef.set({
      username: acc.username || USERNAME,
      followers: acc.followers_count ?? null,
      following: acc.follows_count ?? null,
      postCount: acc.media_count ?? null,
      lastRunAt: now, lastError: null,
      lastRunLog: [...log, `graph-api: ${posts.length} posts`].join(' | '),
    }, { merge: true });

    return { statusCode: 200, body: `ok: ${acc.followers_count} followers, ${posts.length} posts` };
  } catch (e) {
    await metaRef.set({
      lastError: String(e.message || e),
      lastRunAt: admin.firestore.Timestamp.now(),
      lastRunLog: log.join(' | '),
    }, { merge: true }).catch(() => {});
    console.error('ig-watch failed:', e);
    return { statusCode: 500, body: String(e) };
  }
}

exports.handler = async () => run();
