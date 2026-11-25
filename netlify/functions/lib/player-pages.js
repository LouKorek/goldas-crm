// Live player pages: a private link the owner asks Golda for and sends to a
// club himself. Whoever holds the link sees one player's public profile
// (/p/<token>, apps/web/src/pages/PlayerPage.jsx) until the link expires or is
// revoked. The PDF sheet stays the default answer to "send me the player's
// page"; a live page exists only when the owner asks for one.
//
// player_pages/{sha256(token)}
//   playerId, playerName, club, general, lang ('en'|'he'), tokenSealed,
//   createdAt, expiresAt, days, createdBy { email, name, channel },
//   revokedAt, revokedBy,
//   opens, firstOpenAt, firstOpenDevice, lastOpenAt, lastOpenDevice,
//   openLog [{ at, device }]            the last 100 openings, nothing else
//   noticeState pending|sending|sent|failed|skipped, noticeSentAt, noticeTries
//   statsCache { at, season, totals }
//
// The link's token is 192 random bits. The document is filed under the hash
// of the token, so finding a link is one document read and no secret is ever
// compared as a string; the token itself is kept sealed (lib/seal.js) so the
// CRM can show the link to an editor again, and a reader of the database or
// of a backup alone holds no working link.
//
// What a link shows is built field by field in publicPlayer(): nothing that
// is not named there leaves the server, whatever the player record holds.
// Times are epoch milliseconds. This collection is touched by functions only.
const crypto = require('crypto');
const { israelDate, playerName, seasonStartYear, seasonLabel, natTeamStatusOf } = require('@goldas/domain');
const { seal, unseal } = require('./seal.js');
const { siteUrl } = require('./site.js');

const COL = 'player_pages';
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const KEEP_OPENINGS = 100;
const MAX_ACTIVE_PER_PLAYER = 40;
const REPEAT_MS = 60 * 1000;             // a reload within a minute is the same opening
const STATS_TTL_MS = 6 * 3600 * 1000;    // the season's totals are recomputed at most this often per link
const PHOTO_MAX_CHARS = 4 * 1024 * 1024; // a profile photo as a data: URL (about 3 MB of image)
const PHOTO_MAX_PARTS = 8;
const DAY = 86400000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const newToken = () => crypto.randomBytes(24).toString('base64url');
const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);
const idOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const pageUrl = (token, base = siteUrl()) => `${base}/p/${token}`;

/** Text as it may be shown: one line, trimmed, capped. */
const clean = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** How many days a link lives: 14 when nothing was asked, never more than 90. */
function daysFor(asked) {
  const n = Math.floor(Number(asked));
  if (!Number.isFinite(n) || n < 1) return { days: DEFAULT_DAYS, clamped: false, defaulted: true };
  return n > MAX_DAYS ? { days: MAX_DAYS, clamped: true, defaulted: false } : { days: n, clamped: false, defaulted: false };
}

const stateOf = (link, now = Date.now()) => (!link ? 'missing' : link.revokedAt ? 'revoked' : !(Number(link.expiresAt) > now) ? 'expired' : 'active');

/** 'phone' or 'desktop', and nothing else: the user agent itself is never stored. */
const deviceOf = (userAgent) => (/Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(String(userAgent || '')) ? 'phone' : 'desktop');

// ── Links ────────────────────────────────────────────────────────────

/**
 * Makes a link for one player. `by` is who asked: { email, name, channel }.
 * Returns { id, token, url, club, general, lang, days, clamped, expiresAt }.
 */
async function createLink(db, { player, club, days, lang, by = {}, now = Date.now(), base } = {}) {
  if (!player || !player.id || player.deletedAt) throw new Error('player not found');
  const live = (await db.collection(COL).where('playerId', '==', player.id).get()).docs
    .filter((d) => stateOf(d.data(), now) === 'active').length;
  if (live >= MAX_ACTIVE_PER_PLAYER) throw new Error(`this player already has ${live} live links; revoke some first`);
  const span = daysFor(days);
  const clubName = clean(club, 60);
  const token = newToken();
  const id = idOf(token);
  const doc = {
    playerId: player.id, playerName: clean(playerName(player), 80),
    club: clubName, general: !clubName, lang: lang === 'he' ? 'he' : 'en',
    tokenSealed: seal(token),
    createdAt: now, expiresAt: now + span.days * DAY, days: span.days,
    createdBy: { email: String(by.email || ''), name: String(by.name || ''), channel: String(by.channel || '') },
    revokedAt: null, revokedBy: null,
    opens: 0, firstOpenAt: null, lastOpenAt: null, openLog: [],
    noticeState: null,
  };
  await db.collection(COL).doc(id).set(doc);
  return { id, token, url: pageUrl(token, base), club: clubName, general: !clubName, lang: doc.lang, days: span.days, clamped: span.clamped, defaulted: span.defaulted, expiresAt: doc.expiresAt };
}

/**
 * The link a token opens, or null. Unknown, malformed, revoked and expired
 * all come back as null: the caller cannot tell them apart, and neither can
 * whoever sent the token. One document read.
 */
async function linkByToken(db, token, now = Date.now()) {
  if (!validToken(token)) return null;
  const id = idOf(token);
  const snap = await db.collection(COL).doc(id).get();
  if (!snap.exists) return null;
  const link = { id, ...snap.data() };
  return stateOf(link, now) === 'active' ? link : null;
}

/**
 * Counts one opening. Runs in a transaction so two openings in the same
 * second are both counted and the first one is the first exactly once.
 * Returns { counted, first } or null when the link stopped being valid.
 */
async function recordOpening(db, id, { device = 'desktop', now = Date.now() } = {}) {
  const ref = db.collection(COL).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const link = snap.data();
    if (stateOf(link, now) !== 'active') return null;
    if (link.lastOpenAt && now - link.lastOpenAt < REPEAT_MS) return { counted: false, first: false };
    const first = !(Number(link.opens) > 0);
    const openLog = [...(Array.isArray(link.openLog) ? link.openLog : []), { at: now, device }].slice(-KEEP_OPENINGS);
    tx.update(ref, {
      opens: (Number(link.opens) || 0) + 1, lastOpenAt: now, lastOpenDevice: device, openLog,
      ...(first ? { firstOpenAt: now, firstOpenDevice: device, noticeState: 'pending' } : {}),
    });
    return { counted: true, first };
  });
}

/** Stops a link at once. Returns the link as it was, or null when there is none. */
async function revokeLink(db, id, { by = {}, now = Date.now() } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(id || ''))) return null;
  const ref = db.collection(COL).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const link = { id, ...snap.data() };
  if (!link.revokedAt) await ref.update({ revokedAt: now, revokedBy: String(by.email || '') });
  return link;
}

/**
 * A link as the CRM and Golda may see it. The address itself is included
 * only for someone who may edit, and only while the link still works.
 */
function viewOf(link, { now = Date.now(), withUrl = false, base } = {}) {
  const state = stateOf(link, now);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  let url = null;
  if (withUrl && state === 'active' && link.tokenSealed) {
    try { url = pageUrl(unseal(link.tokenSealed), base); } catch { url = null; }
  }
  return {
    id: link.id, playerId: link.playerId, playerName: link.playerName || '',
    club: link.club || '', general: !link.club, lang: link.lang === 'he' ? 'he' : 'en',
    state, createdAt: iso(link.createdAt), expiresAt: iso(link.expiresAt), revokedAt: iso(link.revokedAt), days: link.days || null,
    createdByName: link.createdBy?.name || '',
    opens: Number(link.opens) || 0, firstOpenAt: iso(link.firstOpenAt), lastOpenAt: iso(link.lastOpenAt),
    openings: (Array.isArray(link.openLog) ? link.openLog : []).slice(-KEEP_OPENINGS).reverse()
      .map((o) => ({ at: iso(o.at), device: o.device === 'phone' ? 'phone' : 'desktop' })),
    url,
  };
}

/** A player's links, newest first. */
async function listLinks(db, playerId, opts = {}) {
  if (!playerId) return [];
  const docs = (await db.collection(COL).where('playerId', '==', String(playerId)).get()).docs;
  return docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((l) => viewOf(l, opts));
}

// ── What a link shows ────────────────────────────────────────────────

/** An http(s) address safe to hand to a browser, or ''. */
function safeUrl(raw) {
  const v = String(raw ?? '').trim();
  if (!v || v.length > 500 || /\s/.test(v)) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return '';
    return u.href;
  } catch { return ''; }
}

function youtubeId(url) {
  const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(String(url || ''));
  return m && /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname) ? m[1] : '';
}

/** Whole years between a YYYY-MM-DD birthday and a YYYY-MM-DD day. */
function ageOn(dob, today) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 10 && age <= 60 ? age : null;
}

const hasPhoto = (p) => {
  const f = Array.isArray(p.photoFiles) ? p.photoFiles[0] : null;
  return !!f && (typeof f.fileId === 'string' && !!f.fileId || /^data:image\/(jpeg|png|webp);base64,/.test(String(f.url || '')));
};

/**
 * The allow-list. Everything a link may show about a player is named here,
 * one field at a time; the player record itself never leaves this function.
 * Not here, on purpose: notes, contract and salary, passport, phone numbers,
 * the agent, representation dates, files, the full date of birth.
 */
function publicPlayer(p = {}, now = new Date()) {
  const out = { name: clean(playerName(p), 80) };

  const dob = /^\d{4}-\d{2}-\d{2}/.test(String(p.dob || '')) ? String(p.dob).slice(0, 10) : '';
  if (dob) {
    const age = ageOn(dob, israelDate(now));
    if (age) { out.age = age; out.birthYear = Number(dob.slice(0, 4)); }
  }

  const position = clean(p.primaryPosition, 30);
  if (position) out.position = position;
  const others = (Array.isArray(p.secondaryPositions) ? p.secondaryPositions : []).map((x) => clean(x, 30)).filter(Boolean).slice(0, 4);
  if (others.length) out.otherPositions = others;

  if (['Right', 'Left', 'Both'].includes(p.foot)) out.foot = p.foot;

  const height = Number(p.height);
  if (Number.isFinite(height) && height >= 130 && height <= 225) out.heightCm = Math.round(height);

  const nationalities = (Array.isArray(p.nationalities) ? p.nationalities : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 4);
  if (nationalities.length) out.nationalities = nationalities;

  const club = clean(p.currentClub, 60);
  if (club) {
    out.club = club;
    const league = p.leagueMode === 'manual'
      ? clean(p.leagueManual, 60)
      : [clean(p.leagueCountry, 40), clean(p.leagueTier, 20).replace('Tier ', '')].filter(Boolean).join(' ');
    if (league) out.league = league;
  } else out.freeAgent = true;

  const status = natTeamStatusOf(p.natTeamStatus);
  const country = clean(p.natTeamCountry || nationalities[0], 40);
  if (status && country) out.nationalTeam = { country, former: status.startsWith('Former'), youth: status.endsWith('Youth') };

  const video = safeUrl(p.videoLink);
  if (video) out.video = { url: video, youtubeId: youtubeId(video) || null };
  const profile = safeUrl(p.profileLink);
  if (profile) out.profile = { url: profile, transfermarkt: /(^|\.)transfermarkt\.[a-z.]+$/i.test(new URL(profile).hostname) };

  out.photo = hasPhoto(p);
  return out;
}

/**
 * The record the public CV is drawn from: made from the allow-list only, in
 * the shape lib/golda-pdf.js expects. So the download cannot print the
 * scouting notes or the full date of birth, which the agency's own sheet has.
 */
function cvPlayer(pub, { women = false } = {}) {
  const nt = pub.nationalTeam;
  return {
    fullName: pub.name, category: women ? 'women' : 'men',
    age: pub.age || null, birthYear: pub.birthYear || null,
    nationalities: pub.nationalities || [],
    primaryPosition: pub.position || '', secondaryPositions: pub.otherPositions || [],
    foot: pub.foot || '', height: pub.heightCm ? String(pub.heightCm) : '',
    currentClub: pub.club || '', leagueMode: 'manual', leagueManual: pub.league || '',
    natTeamCountry: nt ? nt.country : '', natTeamStatus: nt ? `${nt.former ? 'Former' : 'Current'} ${nt.youth ? 'Youth' : 'Senior'}` : '',
    videoLink: pub.video ? pub.video.url : '', profileLink: pub.profile ? pub.profile.url : '',
  };
}

/** The player's photo as a data: URL, or null. Only photoFiles[0], only an image, bounded reads. */
async function loadPhoto(db, p = {}) {
  const f = Array.isArray(p.photoFiles) ? p.photoFiles[0] : null;
  if (!f) return null;
  const ok = (s) => (typeof s === 'string' && s.length <= PHOTO_MAX_CHARS && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null);
  if (f.url) return ok(f.url);
  if (typeof f.fileId !== 'string' || !f.fileId) return null;
  const meta = await db.collection('files').doc(f.fileId).get();
  if (!meta.exists) return null;
  const parts = Number(meta.data().parts) || 0;
  if (parts < 1 || parts > PHOTO_MAX_PARTS || !/^image\/(jpeg|png|webp)$/.test(String(meta.data().type || ''))) return null;
  const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => db.collection('files').doc(f.fileId).collection('chunks').doc(String(i)).get()));
  if (chunks.some((c) => !c.exists)) return null;
  return ok(chunks.map((c) => c.data().data).join(''));
}

// ── This season's totals ─────────────────────────────────────────────
// A tiny local reader. REPLACE with summarizeStats from @goldas/domain once
// that lands (another change adds playerStats to matches and the summary to
// the domain package); until then this reads the same data leniently and
// shows nothing when there is none.
const STAT_KEYS = ['games', 'starts', 'minutes', 'goals', 'assists', 'yellow', 'red', 'cleanSheets'];
const STAT_ALIASES = { appearances: 'games', apps: 'games', played: 'games', started: 'starts', mins: 'minutes', yellowCards: 'yellow', yellows: 'yellow', redCards: 'red', reds: 'red', cleanSheet: 'cleanSheets' };

function statsRowOf(match, playerId) {
  const ps = match && match.playerStats;
  if (!ps || typeof ps !== 'object') return null;
  if (Array.isArray(ps)) return ps.find((r) => r && String(r.playerId || r.id || '') === String(playerId)) || null;
  return ps[playerId] && typeof ps[playerId] === 'object' ? ps[playerId] : null;
}

/** { season, totals } for the matches of the season that started on seasonStart (YYYY-MM-DD), or null. */
function seasonTotals(matches, playerId, { seasonStart, season } = {}) {
  const totals = {};
  let rows = 0;
  for (const m of matches || []) {
    if (!m || m.deletedAt || (seasonStart && String(m.date || '') < seasonStart)) continue;
    const row = statsRowOf(m, playerId);
    if (!row) continue;
    rows++;
    const seen = {};
    for (const [k, v] of Object.entries(row)) {
      const key = STAT_ALIASES[k] || k;
      if (!STAT_KEYS.includes(key)) continue;
      const n = v === true ? 1 : Number(v);
      if (Number.isFinite(n) && n > 0 && n < 100000) seen[key] = Math.round(n);
    }
    // A row with minutes or anything else recorded is a game played, even when "games" was not written.
    if (!seen.games && Object.keys(seen).length) seen.games = 1;
    for (const [k, n] of Object.entries(seen)) totals[k] = (totals[k] || 0) + n;
  }
  if (!rows || !Object.keys(totals).length) return null;
  return { season: season || '', totals };
}

/**
 * The season's totals for a link's player, read at most once every six hours
 * per link (kept on the link), so an opening does not read the matches.
 */
async function statsFor(db, link, { now = Date.now() } = {}) {
  const cached = link.statsCache;
  if (cached && now - (cached.at || 0) < STATS_TTL_MS) return cached.totals ? { season: cached.season || '', totals: cached.totals } : null;
  const at = new Date(now);
  const seasonStart = `${seasonStartYear(at)}-07-01`;
  const snap = await db.collection('matches').where('linkedPlayers', 'array-contains', link.playerId).get();
  const found = seasonTotals(snap.docs.map((d) => d.data()), link.playerId, { seasonStart, season: seasonLabel(at) });
  await db.collection(COL).doc(link.id).update({ statsCache: { at: now, season: found ? found.season : '', totals: found ? found.totals : null } });
  return found;
}

// ── "A club opened the page" ─────────────────────────────────────────

const two = (n) => String(n).padStart(2, '0');
/** 25/11 14:32 in Israel time. */
function whenHe(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${two(parts.day)}/${two(parts.month)} ${two(parts.hour === '24' ? '00' : parts.hour)}:${two(parts.minute)}`;
}

/** The one line the owner gets the first time a link is opened. */
function noticeText(link) {
  const when = whenHe(link.firstOpenAt || Date.now());
  const from = link.firstOpenDevice === 'phone' ? 'מטלפון' : 'ממחשב';
  const player = link.playerName || 'השחקן';
  return link.club
    ? `👀 *${link.club}* פתחו את הדף החי של ${player} (${when}, ${from}).`
    : `👀 הלינק הכללי לדף החי של ${player} נפתח לראשונה (${when}, ${from}).`;
}

/**
 * Tells the owner about links opened for the first time. Each link is claimed
 * in a transaction before anything is sent, so two runs at once cannot both
 * send, and a link is told about once at most: a run that dies mid-send leaves
 * the link as "sending" and it is not tried again.
 *   send  tests inject it: (owner, body, kind, buttons) → { state }
 */
async function sendNotices(db, { now = Date.now(), send = null, limit = 10 } = {}) {
  const pending = (await db.collection(COL).where('noticeState', '==', 'pending').get()).docs.slice(0, limit);
  if (!pending.length) return { sent: 0, pending: 0 };
  const { whatsappRecipients } = require('./golda-identity.js');
  const { ownerOf, nudge } = require('./golda-nudge.js');
  const users = (await db.collection('app_users').get()).docs.map((d) => ({ id: d.id, email: d.id, ...d.data() }));
  const owner = ownerOf(whatsappRecipients(users));
  let sent = 0;
  for (const d of pending) {
    const ref = db.collection(COL).doc(d.id);
    const link = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().noticeState !== 'pending') return null;
      tx.update(ref, { noticeState: owner ? 'sending' : 'skipped', noticeTries: (Number(snap.data().noticeTries) || 0) + 1 });
      return { id: d.id, ...snap.data() };
    });
    if (!link || !owner) continue;
    try {
      await nudge(db, owner, { body: noticeText(link), kind: 'player_page', remember: true }, { now, send });
      await ref.update({ noticeState: 'sent', noticeSentAt: now });
      sent++;
    } catch (e) {
      console.error('[player-pages] notice failed:', e.message);
      await ref.update({ noticeState: 'failed' }).catch(() => {});
    }
  }
  return { sent, pending: pending.length, owner: !!owner };
}

module.exports = {
  COL, DEFAULT_DAYS, MAX_DAYS, KEEP_OPENINGS, MAX_ACTIVE_PER_PLAYER, REPEAT_MS, STATS_TTL_MS, TOKEN_RE,
  newToken, validToken, idOf, pageUrl, daysFor, stateOf, deviceOf,
  createLink, linkByToken, recordOpening, revokeLink, viewOf, listLinks,
  publicPlayer, cvPlayer, loadPhoto, safeUrl, youtubeId,
  seasonTotals, statsFor, noticeText, sendNotices, whenHe,
};
