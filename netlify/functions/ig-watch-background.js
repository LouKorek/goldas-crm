// Instagram tracking for @goldas_loukorek via Meta's official Instagram API
// with Instagram Login (graph.instagram.com).
//
// Why this route: scraping is a dead end — Instagram serves a login wall to
// every datacenter IP. The Facebook-Login variant of the API would work too
// but requires the Instagram account to be linked to a Facebook Page; this
// one does not, so no Page had to be created.
//
// Required Netlify environment variable:
//   IG_ACCESS_TOKEN  — long-lived Instagram user token (60 days, auto-renewed
//                      here and cached in Firestore so it never lapses)
//
// Storage (unchanged, so the Social screen keeps working as-is):
//   igDaily/{YYYY-MM-DD}  — daily snapshot of the account counters
//   igPosts/{id}          — one doc per post, engagement refreshed daily
//   app_meta/igWatch      — latest counters, run status, cached token

const admin = require('firebase-admin');

const USERNAME = 'goldas_loukorek';
const TZ = 'Asia/Jerusalem';
const GRAPH = 'https://graph.instagram.com/v21.0';
const REFRESH_AFTER_DAYS = 45;   // tokens live 60 days; renew well before

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

async function ig(path, token, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${GRAPH}${path}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const e = body.error || {};
    throw new Error(`IG ${path}: ${e.message || res.status}${e.code ? ` (code ${e.code})` : ''}`);
  }
  return body;
}

// The env var is only the bootstrap token. Once refreshed, the newer token is
// kept in Firestore — otherwise access would lapse after 60 days.
async function getToken(metaRef, log) {
  const snap = await metaRef.get();
  const cached = snap.exists ? snap.data() : {};
  const envToken = (process.env.IG_ACCESS_TOKEN || '').trim();
  let token = cached.token || envToken;
  if (!token) throw new Error('IG_ACCESS_TOKEN is not set in Netlify');

  const refreshedAt = cached.tokenRefreshedAt?.toDate?.() || null;
  const ageDays = refreshedAt ? (Date.now() - refreshedAt.getTime()) / 86400000 : Infinity;
  if (ageDays < REFRESH_AFTER_DAYS) return token;

  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
    );
    const body = await res.json();
    if (body.access_token) {
      token = body.access_token;
      await metaRef.set({
        token,
        tokenRefreshedAt: admin.firestore.Timestamp.now(),
        tokenExpiresInDays: Math.round((body.expires_in || 0) / 86400),
      }, { merge: true });
      log.push('token refreshed');
    } else {
      log.push(`token refresh skipped: ${body.error?.message || 'no token returned'}`);
    }
  } catch (e) {
    log.push(`token refresh failed: ${e.message}`);
  }
  return token;
}

const TYPE_MAP = { IMAGE: 'image', CAROUSEL_ALBUM: 'carousel', VIDEO: 'video', REELS: 'video' };

async function run() {
  const db = getDb();
  const metaRef = db.collection('app_meta').doc('igWatch');
  const log = [];
  try {
    const token = await getToken(metaRef, log);

    const acc = await ig('/me', token, {
      fields: 'user_id,username,followers_count,follows_count,media_count',
    });

    // The post archive is fully retrievable, so pull all of it rather than a
    // recent slice — every post the account ever published, with its current
    // likes and comments.
    const mediaItems = [];
    {
      let page = await ig('/me/media', token, {
        fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count',
        limit: '100',
      });
      for (let guard = 0; guard < 20; guard++) {
        mediaItems.push(...(page.data || []));
        const next = page.paging?.cursors?.after;
        if (!next || !(page.data || []).length) break;
        page = await ig('/me/media', token, {
          fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count',
          limit: '100', after: next,
        });
      }
    }
    const media = { data: mediaItems };

    const now = admin.firestore.Timestamp.now();
    const today = localDate();

    await db.collection('igDaily').doc(today).set({
      date: today,
      followers: acc.followers_count ?? null,
      following: acc.follows_count ?? null,
      postCount: acc.media_count ?? null,
      source: 'instagram-api',
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

    // Instagram keeps 30 days of daily insight values, so the first run can
    // reach back a month instead of starting from zero. Absolute follower
    // totals are not part of that history — only per-day movement — so those
    // days are stored as their own series rather than faked into the curve.
    let backfilled = 0;
    try {
      const until = Math.floor(Date.now() / 1000);
      const since = until - 29 * 86400;
      const res = await ig(`/${acc.user_id}/insights`, token, {
        metric: 'follower_count,reach,profile_views',
        period: 'day', since: String(since), until: String(until),
      });
      const byDate = new Map();
      for (const m of res.data || []) {
        const key = { follower_count: 'newFollowers', reach: 'reach', profile_views: 'profileViews' }[m.name];
        if (!key) continue;
        for (const v of m.values || []) {
          const d = String(v.end_time || '').slice(0, 10);
          if (!d) continue;
          if (!byDate.has(d)) byDate.set(d, {});
          byDate.get(d)[key] = v.value ?? null;
        }
      }
      await Promise.all([...byDate].map(([d, vals]) =>
        db.collection('igDaily').doc(d).set({ date: d, ...vals, insightsAt: now }, { merge: true })
      ));
      backfilled = byDate.size;
      log.push(`insights: ${backfilled} days`);
    } catch (e) {
      log.push(`insights unavailable: ${e.message}`);
    }

    await metaRef.set({
      username: acc.username || USERNAME,
      followers: acc.followers_count ?? null,
      following: acc.follows_count ?? null,
      postCount: acc.media_count ?? null,
      lastRunAt: now, lastError: null,
      lastRunLog: [...log, `instagram-api: ${posts.length} posts`].join(' | '),
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
