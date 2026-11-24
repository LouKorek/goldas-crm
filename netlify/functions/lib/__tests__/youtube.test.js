// Golda's YouTube uploads, end to end against an in-memory Firestore and a
// stand-in for Google: the one-time permission, the style, the draft and its
// yes, the upload, the link swap, the playlist and the cover.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEAL_KEY = 'test-key-material-for-unit-tests';
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{"project_id":"x"}';

const yt = require('../youtube.js');
const ytAuth = require('../youtube-auth.js');
const ytStyle = require('../youtube-style.js');
const thumb = require('../youtube-thumb.js');
const jobs = require('../youtube-jobs.js');
const site = require('../site.js');
const { youtubeTools } = require('../golda-youtube.js');
const { isSealed } = require('../seal.js');

function fakeDb(seed = {}) {
  const data = {}; let n = 0;
  for (const [c, docs] of Object.entries(seed)) data[c] = new Map(Object.entries(docs));
  const col = (c) => { if (!data[c]) data[c] = new Map(); return data[c]; };
  const at = (v, f) => f.split('.').reduce((x, k) => (x == null ? x : x[k]), v);
  const doc = (c, id) => ({
    id,
    // like Firestore, a snapshot keeps what it read even if the document is deleted afterwards
    get: async () => { const v = col(c).has(id) ? { ...col(c).get(id) } : undefined; return { id, exists: v !== undefined, data: () => v }; },
    set: async (v, o) => { col(c).set(id, o && o.merge ? { ...(col(c).get(id) || {}), ...v } : { ...v }); },
    update: async (v) => { col(c).set(id, { ...col(c).get(id), ...v }); },
    delete: async () => { col(c).delete(id); },
  });
  const query = (c, filters = []) => ({
    where: (f, op, v) => query(c, [...filters, [f, v]]),
    limit: () => query(c, filters),
    get: async () => {
      const rows = [...col(c)].filter(([, v]) => filters.every(([f, w]) => at(v, f) === w));
      return { empty: !rows.length, docs: rows.map(([id, v]) => ({ id, data: () => ({ ...v }), ref: doc(c, id) })) };
    },
  });
  return {
    data,
    collection: (c) => ({ ...query(c), doc: (id) => doc(c, id || `auto${++n}`), add: async (v) => { const id = `new${++n}`; col(c).set(id, { ...v }); return { id }; } }),
  };
}
const admin = { firestore: { FieldValue: { serverTimestamp: () => 'now' } } };
const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))),
});

const NOAM = { name: 'Noam Barzilay', gender: 'Men', nationalities: ['Israel'], dob: '2008-02-14', primaryPosition: 'LB', secondaryPositions: ['CB'], foot: 'Left', height: 184, currentClub: 'Hapoel Hod Hasharon U19', videoLink: 'https://youtu.be/OLDOLDOLD11' };
const JUNE = new Date('2026-06-26T10:00:00Z');

// ── the site's address ──────────────────────────────────────────────────────
test('a preview answers on its own address, a stranger gets the site', () => {
  assert.equal(site.originOf({ headers: { host: 'deploy-preview-73--goldas-crm.netlify.app' } }, {}), 'https://deploy-preview-73--goldas-crm.netlify.app');
  assert.equal(site.originOf({ headers: { host: 'evil.example' } }, {}), 'https://goldas-crm.netlify.app');
  assert.equal(site.isOurOrigin('https://goldas-crm.netlify.app'), true);
  assert.equal(site.isOurOrigin('https://goldas-crm.netlify.app.evil.example'), false);
  assert.equal(site.isOurOrigin('http://goldas-crm.netlify.app'), false);
});

// ── the YouTube calls ───────────────────────────────────────────────────────
test('videoIdOf reads every kind of YouTube address', () => {
  for (const u of ['https://youtu.be/pURAVoN7Szs', 'https://www.youtube.com/watch?v=pURAVoN7Szs&t=3', 'https://youtube.com/shorts/pURAVoN7Szs', 'https://www.youtube.com/embed/pURAVoN7Szs']) assert.equal(yt.videoIdOf(u), 'pURAVoN7Szs');
  assert.equal(yt.videoIdOf('https://vimeo.com/123'), null);
});

test('startUpload opens a session with the agreed details and returns its address', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return res(200, {}, { location: 'https://upload.example/session1' }); };
  const loc = await yt.startUpload('tok', { title: 'T'.repeat(140), description: 'D', privacy: 'public', tags: ['a'] }, { size: 10, mimeType: 'video/mp4', origin: 'https://goldas-crm.netlify.app', fetchImpl });
  assert.equal(loc, 'https://upload.example/session1');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.snippet.title.length, 100);
  assert.equal(body.snippet.categoryId, '17');
  assert.equal(body.status.privacyStatus, 'public');
  assert.equal(seen.opts.headers['X-Upload-Content-Length'], '10');
  assert.equal(seen.opts.headers.Origin, 'https://goldas-crm.netlify.app');
  assert.match(seen.url, /uploadType=resumable/);
});

test('an unknown privacy never becomes public', async () => {
  let body;
  const fetchImpl = async (url, opts) => { body = JSON.parse(opts.body); return res(200, {}, { location: 'x' }); };
  await yt.startUpload('tok', { title: 'a', privacy: 'everyone' }, { fetchImpl });
  assert.equal(body.status.privacyStatus, 'unlisted');
});

test('sendChunks sends the file in pieces and announces the total with the last', async () => {
  const ranges = [];
  const fetchImpl = async (url, opts) => {
    ranges.push(opts.headers['Content-Range']);
    return /\/\*$/.test(opts.headers['Content-Range']) ? res(308, {}) : res(200, { id: 'NEWVIDEO001' });
  };
  async function* body() { yield Buffer.alloc(700, 1); yield Buffer.alloc(700, 2); yield Buffer.alloc(100, 3); }
  const v = await yt.sendChunks('https://upload.example/s', body(), { fetchImpl, chunkSize: 512 });
  assert.equal(v.id, 'NEWVIDEO001');
  assert.deepEqual(ranges, ['bytes 0-511/*', 'bytes 512-1023/*', 'bytes 1024-1499/1500']);
});

test('sendChunks refuses an empty file and reports what YouTube said', async () => {
  await assert.rejects(yt.sendChunks('u', (async function* none() { /* nothing */ }()), { fetchImpl: async () => res(200, {}) }), /empty/);
  const fetchImpl = async () => res(403, { error: { message: 'no', errors: [{ reason: 'quotaExceeded' }] } });
  await assert.rejects(yt.sendChunks('u', Buffer.from('abc'), { fetchImpl }), (e) => e.reason === 'quotaExceeded' && e.status === 403);
});

test('playlists says which of the given videos sit in each one', async () => {
  const fetchImpl = async (url) => {
    if (/\/playlists\?/.test(url)) return res(200, { items: [{ id: 'PL1', snippet: { title: "Men's Football" }, contentDetails: { itemCount: 4 }, status: { privacyStatus: 'public' } }, { id: 'PL2', snippet: { title: 'Empty' }, contentDetails: { itemCount: 0 } }] });
    if (/playlistId=PL1/.test(url)) return res(200, { items: [{ contentDetails: { videoId: 'a' } }, { contentDetails: { videoId: 'zzz' } }] });
    throw new Error(`unexpected ${url}`);
  };
  const lists = await yt.playlists('tok', { among: ['a', 'b'], fetchImpl });
  assert.deepEqual(lists.map((l) => [l.id, l.count, l.videoIds]), [['PL1', 4, ['a']], ['PL2', 0, []]]);
});

test('addToPlaylist names the playlist and the video', async () => {
  let seen;
  await yt.addToPlaylist('tok', 'PL1', 'NEWVIDEO001', { fetchImpl: async (url, opts) => { seen = { url, body: JSON.parse(opts.body), method: opts.method }; return res(200, {}); } });
  assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.body.snippet, { playlistId: 'PL1', resourceId: { kind: 'youtube#video', videoId: 'NEWVIDEO001' } });
});

// ── the one-time permission ─────────────────────────────────────────────────
const CLIENT = { clientId: '1005130599757-abc123def.apps.googleusercontent.com', clientSecret: 'test-secret-not-real-0001' };

test('the Google client is stored sealed and bad values are refused', async () => {
  const db = fakeDb();
  await assert.rejects(ytAuth.setClient(db, { clientId: 'nope', clientSecret: CLIENT.clientSecret }), /client id/);
  await assert.rejects(ytAuth.setClient(db, { clientId: CLIENT.clientId, clientSecret: 'short' }), /client secret/);
  await ytAuth.setClient(db, CLIENT);
  const stored = db.data.app_secrets.get('youtube');
  assert.ok(isSealed(stored.clientSecret));
  assert.ok(!JSON.stringify([...db.data.app_meta]).includes(CLIENT.clientSecret), 'the public status never holds the secret');
  assert.deepEqual(await ytAuth.client(db, {}), CLIENT);
});

test('the consent address asks for playlists only when chosen, and returns to where it started', async () => {
  const db = fakeDb();
  await ytAuth.setClient(db, CLIENT);
  const plain = new URL(await ytAuth.startUrl(db, 'lou@example.com', { env: {} }));
  assert.equal(plain.searchParams.get('scope'), ytAuth.SCOPES.join(' '));
  assert.equal(plain.searchParams.get('redirect_uri'), 'https://goldas-crm.netlify.app/.netlify/functions/youtube-connect');
  assert.equal(plain.searchParams.get('access_type'), 'offline');
  assert.equal(plain.searchParams.get('login_hint'), null);
  const wide = new URL(await ytAuth.startUrl(db, 'lou@example.com', { env: {}, playlists: true, origin: 'https://deploy-preview-9--goldas-crm.netlify.app' }));
  assert.ok(wide.searchParams.get('scope').split(' ').includes(ytAuth.MANAGE));
  assert.equal(wide.searchParams.get('redirect_uri'), 'https://deploy-preview-9--goldas-crm.netlify.app/.netlify/functions/youtube-connect');
  assert.equal(db.data.yt_oauth_states.get(wide.searchParams.get('state')).redirect, wide.searchParams.get('redirect_uri'));
  const evil = new URL(await ytAuth.startUrl(db, 'x', { env: {}, origin: 'https://evil.example' }));
  assert.equal(evil.searchParams.get('redirect_uri'), 'https://goldas-crm.netlify.app/.netlify/functions/youtube-connect');
});

function google({ scope = ytAuth.SCOPES.join(' '), refresh = 'refresh-token-1' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null });
    if (/oauth2\.googleapis\.com\/token/.test(url)) return res(200, { access_token: `access-${calls.length}`, expires_in: 3600, scope, ...(refresh && /authorization_code/.test(opts.body) ? { refresh_token: refresh } : {}) });
    if (/channels\?/.test(url)) return res(200, { items: [{ id: 'UCchannel', snippet: { title: 'LOUPI' }, contentDetails: { relatedPlaylists: { uploads: 'UUuploads' } }, status: { longUploadsStatus: 'allowed' } }] });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

test('the code from Google becomes a sealed key, once, and the status says what is allowed', async () => {
  ytAuth._resetCacheForTests();
  const db = fakeDb();
  await ytAuth.setClient(db, CLIENT);
  const origin = 'https://deploy-preview-9--goldas-crm.netlify.app';
  const state = new URL(await ytAuth.startUrl(db, 'lou@example.com', { env: {}, origin })).searchParams.get('state');
  const g = google();
  const info = await ytAuth.finish(db, { code: 'code1', state }, { env: {}, fetchImpl: g.fetchImpl });
  assert.equal(info.channel.id, 'UCchannel');
  assert.equal(info.playlistsAllowed, false);
  assert.equal(g.calls[0].body.redirect_uri, `${origin}/.netlify/functions/youtube-connect`, 'the same address the consent screen was opened with');
  const stored = db.data.app_secrets.get('youtube');
  assert.ok(isSealed(stored.refreshToken));
  assert.ok(!JSON.stringify([...db.data.app_meta]).includes('refresh-token-1'));
  await assert.rejects(ytAuth.finish(db, { code: 'code1', state }, { env: {}, fetchImpl: g.fetchImpl }), /expired/, 'a state works once');
  assert.equal(await ytAuth.accessToken(db, { env: {}, fetchImpl: g.fetchImpl }), 'access-1', 'the token from the sign-in is reused while it lasts');
});

test('without the upload permission nothing is stored; with the wider one playlists are allowed', async () => {
  ytAuth._resetCacheForTests();
  const db = fakeDb();
  await ytAuth.setClient(db, CLIENT);
  let state = new URL(await ytAuth.startUrl(db, 'a', { env: {} })).searchParams.get('state');
  await assert.rejects(ytAuth.finish(db, { code: 'c', state }, { env: {}, fetchImpl: google({ scope: ytAuth.SCOPES[1] }).fetchImpl }), /upload permission/);
  assert.equal(db.data.app_secrets.get('youtube').refreshToken, undefined);
  state = new URL(await ytAuth.startUrl(db, 'a', { env: {}, playlists: true })).searchParams.get('state');
  const info = await ytAuth.finish(db, { code: 'c', state }, { env: {}, fetchImpl: google({ scope: `${ytAuth.SCOPES.join(' ')} ${ytAuth.MANAGE}` }).fetchImpl });
  assert.equal(info.playlistsAllowed, true);
});

test('a withdrawn permission marks the connection as broken', async () => {
  ytAuth._resetCacheForTests();
  const db = fakeDb();
  await ytAuth.setClient(db, CLIENT);
  await db.collection('app_secrets').doc('youtube').set({ refreshToken: 'plain-refresh' }, { merge: true });
  await db.collection('app_meta').doc('youtube').set({ connected: true }, { merge: true });
  const fetchImpl = async () => res(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
  await assert.rejects(ytAuth.accessToken(db, { env: {}, fetchImpl }), /invalid_grant/);
  assert.equal(db.data.app_meta.get('youtube').connected, false);
  assert.equal(await ytAuth.accessToken(fakeDb(), { env: {} }), null, 'never connected → null, no call');
});

// ── the style ───────────────────────────────────────────────────────────────
test("a draft for Noam comes out exactly as Lou wrote his own video", () => {
  const d = ytStyle.draftFor(null, NOAM, { now: JUNE });
  assert.equal(d.title, 'Noam Barzilay | LB / CB | 2025/26');
  assert.equal(d.description, 'Noam Barzilay\n🌍 Israel\n🗓️ Feb 14, 2008 (18)\n📍 LB / CB\n📏 1.84m\n🦵 L');
  assert.equal(d.categoryId, '17');
});

test('every placeholder has a value shape, and missing facts leave no empty lines', () => {
  const v = ytStyle.valuesFor({ name: 'Alon Milwidsky', nationalities: ['Israel', 'Germany'], dob: '2005-02-14', primaryPosition: 'GK', foot: 'Right', height: '1.83' }, { now: new Date('2026-11-24T08:00:00Z') });
  assert.deepEqual(Object.keys(v).sort(), [...ytStyle.PLACEHOLDERS].sort());
  assert.equal(v.nationalityFlags, 'Israel 🇮🇱 Germany 🇩🇪');
  assert.deepEqual([v.height, v.heightM, v.heightCm, v.footShort, v.age], ['1.83m', '1.83', '183', 'R', '21']);
  assert.deepEqual([v.season, v.seasonLong, v.birthDateDots, v.birthDateDMY], ['2026/27', '2026-2027', '14.02.2005', '14/02/2005']);
  assert.deepEqual([v.firstName, v.lastName], ['Alon', 'Milwidsky']);
  const bare = ytStyle.draftFor(null, { name: 'Solo' }, { now: JUNE });
  assert.equal(bare.title, 'Solo | 2025/26');
  assert.equal(bare.description, 'Solo');
  assert.equal(ytStyle.heightCm('abc'), null);
  assert.equal(ytStyle.heightCm(18), null, 'a number that is no height');
});

test('the owner\'s own spelling of a position is used, and explicit words win', () => {
  const style = { style: { ...ytStyle.FALLBACK_STYLE, positionAliases: { CDM: 'DM' } } };
  const d = ytStyle.draftFor(style, { name: 'Asia Dercksen', primaryPosition: 'CB', secondaryPositions: ['CDM', 'CB'] }, { now: JUNE });
  assert.equal(d.title, 'Asia Dercksen | CB / DM | 2025/26');
  const o = ytStyle.draftFor(style, NOAM, { title: 'My own title', description: 'My words', privacy: 'private', now: JUNE });
  assert.deepEqual([o.title, o.description, o.privacy], ['My own title', 'My words', 'private']);
});

test('the playlist follows the kind of player, or what the writer named', () => {
  const doc = { style: { playlists: [{ id: 'PL1', title: "Men's Football", for: 'men' }, { id: 'PL3', title: "Women's Football", for: 'women' }] }, channelPlaylists: [{ id: 'PL1', title: "Men's Football" }, { id: 'PL2', title: 'Goals' }] };
  assert.equal(ytStyle.playlistFor(doc, { gender: 'Men' }, 'players').id, 'PL1');
  assert.equal(ytStyle.playlistFor(doc, { gender: '' }, 'pipeline_youth').id, 'PL1', 'youth go with the men when there is no youth playlist');
  assert.equal(ytStyle.playlistFor(doc, {}, 'pipeline_women').id, 'PL3');
  assert.equal(ytStyle.playlistFor(doc, {}, 'players', 'goals').id, 'PL2');
  assert.equal(ytStyle.playlistFor(doc, {}, 'players', 'none'), null);
  assert.throws(() => ytStyle.playlistFor(doc, {}, 'players', 'no such list'), /no playlist called/);
  assert.equal(ytStyle.playlistFor({ style: { playlists: [{ id: 'PL1', title: 'M', for: 'men' }] } }, { gender: 'Women' }, 'players'), null, "a woman's video is not filed under the men");
});

test('cleanStyle keeps only what the code understands', () => {
  const s = ytStyle.cleanStyle({
    title: { template: '{name} | {positions} | {season}' }, privacy: 'secret', categoryId: 'sports',
    positionAliases: { CDM: 'DM', XX: 'Y', CB: '<b>' },
    playlists: [{ id: 'PL1', for: 'men' }, { id: 'INVENTED', for: 'all' }, { id: 'PL1', for: 'men' }],
    thumbnail: { custom: true, layout: 'panel', side: 'right', topLine: '{seasonLong}', nameLines: ['{lastName}', '{firstName}', 'x'], rows: ['{birthDateDMY}'], nameAccentColor: 'blue', barOpacity: 7, logo: 'middle' },
  }, { lists: [{ id: 'PL1', title: "Men's Football" }] });
  assert.equal(s.privacy, 'unlisted');
  assert.equal(s.categoryId, '17');
  assert.deepEqual(s.positionAliases, { CDM: 'DM' });
  assert.deepEqual(s.playlists, [{ id: 'PL1', title: "Men's Football", for: 'men' }]);
  assert.deepEqual([s.thumbnail.layout, s.thumbnail.nameLines.length, s.thumbnail.nameAccentColor, s.thumbnail.barOpacity, s.thumbnail.logo], ['panel', 2, thumb.DEFAULT_SPEC.nameAccentColor, 1, 'none']);
});

function channelFetch(videos, lists = []) {
  return async (url) => {
    if (/\/playlistItems\?/.test(url) && /UUuploads/.test(url)) return res(200, { items: videos.map((v) => ({ contentDetails: { videoId: v.id } })) });
    if (/\/videos\?/.test(url)) return res(200, { items: videos.map((v) => ({ id: v.id, snippet: { title: v.title, description: v.description || '', categoryId: '17', thumbnails: {} }, status: { privacyStatus: v.privacy }, contentDetails: { duration: 'PT2M' } })) });
    if (/\/playlists\?/.test(url)) return res(200, { items: lists.map((l) => ({ id: l.id, snippet: { title: l.title }, contentDetails: { itemCount: l.videoIds.length } })) });
    const m = url.match(/playlistId=([^&]+)/);
    if (m) return res(200, { items: (lists.find((l) => l.id === m[1])?.videoIds || []).map((id) => ({ contentDetails: { videoId: id } })) });
    throw new Error(`unexpected ${url}`);
  };
}
const fakeModel = (input) => ({ beta: { messages: { stream: () => ({ finalMessage: async () => ({ content: input ? [{ type: 'tool_use', name: 'save_style', input }] : [] }) }) } } });
const CHANNEL_VIDEOS = [
  { id: 'v1', title: 'Noam Barzilay | LB / CB | 2025/26', privacy: 'public' },
  { id: 'v2', title: 'Alon Milwidsky | GK | 2025', privacy: 'public' },
  { id: 'x1', title: 'Variants Cards - Crowdfunding', privacy: 'private' },
  { id: 'x2', title: 'Variants Cards - Crowdfunding 2', privacy: 'private' },
  { id: 'x3', title: 'Variants Cards - Crowdfunding 3', privacy: 'private' },
];

test('learning the style ignores unrelated uploads: privacy and playlist come from the player videos', async () => {
  const db = fakeDb();
  const lists = [{ id: 'PL1', title: "Men's Football", videoIds: ['v1', 'v2'] }];
  const doc = await ytStyle.learnStyle(db, {
    token: 't', channel: { id: 'UC', title: 'LOUPI', uploads: 'UUuploads' }, fetchImpl: channelFetch(CHANNEL_VIDEOS, lists),
    anthropic: fakeModel({ summaryHe: 'סגנון', playerVideoIds: ['v1', 'v2', 'made-up'], title: { template: '{name} | {positions} | {season}' }, description: { template: '{name}\n🌍 {nationality}' }, privacy: 'private', playlists: [], thumbnail: { custom: true, layout: 'panel' } }),
  });
  assert.equal(doc.learned, true);
  assert.equal(doc.playerVideos, 2);
  assert.equal(doc.style.privacy, 'public', 'most uploads are private, but no player video is');
  assert.deepEqual(doc.style.playlists, [{ id: 'PL1', title: "Men's Football", for: 'men' }], 'found from where the player videos sit');
  assert.deepEqual(doc.examples.map((e) => e.id), ['v1', 'v2']);
  assert.deepEqual((await ytStyle.getStyle(db)).channelPlaylists, [{ id: 'PL1', title: "Men's Football", count: 2 }]);
});

test('when the model fails the channel still gets the base style with its own privacy', async () => {
  const db = fakeDb();
  const doc = await ytStyle.learnStyle(db, { token: 't', channel: { uploads: 'UUuploads' }, fetchImpl: channelFetch(CHANNEL_VIDEOS.slice(0, 2)), anthropic: fakeModel(null) });
  assert.equal(doc.learned, false);
  assert.match(doc.problem, /no style/);
  assert.equal(doc.style.privacy, 'public');
  assert.equal(doc.style.title.template, ytStyle.FALLBACK_STYLE.title.template);
  const empty = await ytStyle.learnStyle(fakeDb(), { token: 't', channel: { uploads: 'UUuploads' }, fetchImpl: channelFetch([]) });
  assert.equal(empty.style.privacy, 'unlisted', 'an empty channel: nothing goes public by default');
});

test('the model is given every placeholder with an example', () => {
  for (const p of ytStyle.PLACEHOLDERS) assert.ok(ytStyle._internal.SYSTEM.includes(`{${p}}`), p);
  assert.deepEqual(ytStyle.STYLE_TOOL.input_schema.properties.thumbnail.properties.layout.enum, thumb.LAYOUTS);
});

// ── the cover ───────────────────────────────────────────────────────────────
const VALUES = ytStyle.valuesFor(NOAM, { now: JUNE });

test('fill drops the separators around what is missing, never a link\'s slashes', () => {
  assert.equal(thumb.fill('{name} | {positions} | {season}', { name: 'A', positions: '', season: '2025/26' }), 'A | 2025/26');
  assert.equal(thumb.fill('{name} - {club}', { name: 'A' }), 'A');
  assert.equal(thumb.fill('See https://gold-as.com/{name}', { name: 'x' }), 'See https://gold-as.com/x');
  assert.equal(thumb.fillOrDrop('Height : {heightM} CM', {}), null);
  assert.equal(thumb.fillOrDrop('Height : {heightM} CM', { heightM: '1.84' }), 'Height : 1.84 CM');
  assert.equal(thumb.noEmoji('🌍 Israel 🇮🇱 German 🇩🇪'), 'Israel German');
});

test('the bars cover: the name large, one bar per known fact', () => {
  const lay = thumb.layoutCover({ spec: {}, values: VALUES });
  const svg = lay.over.join('');
  assert.match(svg, />NOAM</); assert.match(svg, />BARZILAY</);
  assert.equal(lay.over.filter((p) => p.startsWith('<rect')).length, 4);
  assert.match(svg, /DATE OF BIRTH : 14\.02\.2008/);
  const few = thumb.layoutCover({ spec: {}, values: { name: 'Solo', firstName: 'Solo' } });
  assert.equal(few.over.filter((p) => p.startsWith('<rect')).length, 0, 'no empty bars');
});

test('the panel cover puts the picture on the other half, and Hebrew is not upper-cased or set in the Latin face', () => {
  const spec = { layout: 'panel', side: 'right', topLine: '{seasonLong}', nameLines: ['{lastName}', '{firstName}'], rows: ['{birthDateDMY}', '{club}'] };
  const lay = thumb.layoutCover({ spec, values: VALUES });
  assert.ok(lay.photo.width < thumb.W);
  assert.match(lay.over.join(''), />2025-2026</);
  const he = thumb.layoutCover({ spec, values: { ...VALUES, firstName: 'נועם', lastName: 'ברזילי' } }).over.join('');
  assert.match(he, /font-family="Heebo"[^>]*direction="rtl"[^>]*>ברזילי</);
});

test('a plain cover draws nothing over the picture; old specs still read', () => {
  const plain = thumb.layoutCover({ spec: thumb.plainSpec(), values: VALUES });
  assert.deepEqual([plain.over.length, plain.under.length], [0, 0]);
  const old = thumb.layoutCover({ spec: { textLines: ['{name}', '{positions}'] }, values: VALUES });
  assert.match(old.over.join(''), />NOAM BARZILAY</);
  assert.doesNotMatch(thumb.buildSvg({ spec: {}, values: { name: '<script>' } }), /<script>/);
});

test('renderCover draws a 1280x720 JPG under YouTube\'s limit with the real fonts', async () => {
  // A small grey picture stands in for the video frame.
  const jpeg = require('jpeg-js');
  const frame = jpeg.encode({ data: Buffer.alloc(64 * 36 * 4, 120), width: 64, height: 36 }, 80).data;
  for (const spec of [{}, { layout: 'panel', side: 'left', topLine: '{seasonLong}' }, { layout: 'band' }, thumb.plainSpec()]) {
    const r = await thumb.renderCover({ background: frame, spec, values: VALUES, fetchImpl: async () => { throw new Error('the fonts come with the repository'); } });
    assert.deepEqual([r.width, r.height, r.type], [1280, 720, 'image/jpeg']);
    assert.deepEqual([r.bytes[0], r.bytes[1]], [0xff, 0xd8]);
    assert.ok(r.bytes.length < yt.THUMB_MAX);
  }
});

// ── a job ───────────────────────────────────────────────────────────────────
const BY = { email: 'lou@example.com', name: 'Lou', phone: '972500000000', phoneId: 'PH1', channel: 'whatsapp' };
const draftArgs = (over = {}) => ({
  record: NOAM, target: { collection: 'players', physical: 'players', id: 'p1', name: 'Noam Barzilay' },
  meta: { title: 'Noam Barzilay | LB / CB | 2025/26', description: 'd', privacy: 'public' }, values: VALUES,
  source: { kind: 'page' }, cover: { mode: 'style' }, playlist: { id: 'PL1', title: "Men's Football" }, by: { ...BY, draftTurn: 3 }, ...over,
});

test('a new draft replaces the writer\'s previous one; confirming decides who sends the file', async () => {
  const db = fakeDb();
  const first = await jobs.createDraft(db, draftArgs());
  const second = await jobs.createDraft(db, draftArgs({ source: { kind: 'whatsapp', mediaId: 'M1' } }));
  assert.equal((await jobs.getJob(db, first.id)).status, 'cancelled');
  assert.equal((await jobs.latestOpen(db, BY.email)).id, second.id);
  assert.equal(second.oldLink, NOAM.videoLink);
  const server = await jobs.confirm(db, second, { env: {} });
  assert.deepEqual([server.mode, server.status, server.page], ['server', 'uploading', null]);
  const third = await jobs.createDraft(db, draftArgs());
  const page = await jobs.confirm(db, third, { env: {} });
  assert.equal(page.mode, 'page');
  assert.match(page.page, /^https:\/\/goldas-crm\.netlify\.app\/yt\/[a-f0-9]{48}$/);
  await assert.rejects(jobs.confirm(db, { ...third, status: 'uploading' }), /already uploading/);
  assert.equal((await jobs.jobByToken(db, third.token)).id, third.id);
  assert.equal(await jobs.jobByToken(db, third.token, Date.now() + jobs.PAGE_TTL_MS + 1000), null, 'the page link dies after 48 hours');
  assert.equal(await jobs.jobByToken(db, 'not-a-token'), null);
});

test('after the upload the record points at the new video, the old link is kept, and the video is filed', async () => {
  const db = fakeDb({ players: { p1: { ...NOAM } }, app_meta: { youtube: { connected: true, playlistsAllowed: true } } });
  const job = await jobs.createDraft(db, draftArgs());
  const sent = []; const api = [];
  const fetchImpl = async (url, opts) => { api.push([opts.method, url, JSON.parse(opts.body)]); return res(200, {}); };
  const r = await jobs.afterUpload(db, job, 'NEWVIDEO001', { admin, token: 't', fetchImpl, notify: async (j, text) => sent.push(text) });
  assert.equal(db.data.players.get('p1').videoLink, 'https://youtu.be/NEWVIDEO001');
  assert.equal(r.swap.before, NOAM.videoLink);
  const audit = [...db.data.audit.values()][0];
  assert.deepEqual([audit.before.videoLink, audit.after.videoLink, audit.via, audit.onBehalfOf], [NOAM.videoLink, 'https://youtu.be/NEWVIDEO001', 'golda', BY.email]);
  assert.equal(api[0][2].snippet.playlistId, 'PL1');
  const done = await jobs.getJob(db, job.id);
  assert.deepEqual([done.status, done.videoId, done.oldLink, done.playlistAdded], ['uploaded', 'NEWVIDEO001', NOAM.videoLink, true]);
  assert.match(sent[0], /https:\/\/youtu\.be\/NEWVIDEO001/);
  assert.match(sent[0], new RegExp(NOAM.videoLink));
  assert.match(sent[0], /Men's Football/);
});

test('with no permission for playlists the upload still succeeds and says so', async () => {
  const db = fakeDb({ players: { p1: { ...NOAM } }, app_meta: { youtube: { connected: true, playlistsAllowed: false } } });
  const job = await jobs.createDraft(db, draftArgs());
  const sent = [];
  const r = await jobs.afterUpload(db, job, 'NEWVIDEO001', { admin, token: 't', fetchImpl: async () => { throw new Error('must not be called'); }, notify: async (j, text) => sent.push(text) });
  assert.equal(r.list.added, false);
  assert.match(sent[0], /לא הוספתי/);
  assert.equal(db.data.players.get('p1').videoLink, 'https://youtu.be/NEWVIDEO001');
  // A record deleted meanwhile: the video is up, the link is not written anywhere.
  const db2 = fakeDb({ players: { p1: { ...NOAM, deletedAt: 1 } } });
  const j2 = await jobs.createDraft(db2, draftArgs({ playlist: null }));
  const r2 = await jobs.afterUpload(db2, j2, 'NEWVIDEO001', { admin, token: 't', notify: async () => {} });
  assert.equal(r2.swap.swapped, false);
  assert.equal(db2.data.players.get('p1').videoLink, NOAM.videoLink);
});

test('the server upload passes the WhatsApp video on and reports a failure in Hebrew', async () => {
  ytAuth._resetCacheForTests();
  const seed = () => ({ players: { p1: { ...NOAM } }, app_meta: { youtube: { connected: true } }, app_secrets: { youtube: { clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret, refreshToken: 'r' } } });
  const db = fakeDb(seed());
  const job = await jobs.createDraft(db, draftArgs({ source: { kind: 'whatsapp', mediaId: 'M1', mimeType: 'video/mp4' }, playlist: null }));
  const fetchImpl = async (url, opts = {}) => {
    if (/oauth2/.test(url)) return res(200, { access_token: 'a', expires_in: 3600 });
    if (/uploadType=resumable/.test(url)) return res(200, {}, { location: 'https://upload.example/s' });
    if (/upload\.example/.test(url)) return res(200, { id: 'NEWVIDEO001' });
    throw new Error(`unexpected ${opts.method} ${url}`);
  };
  const wa = { downloadMedia: async (id) => ({ buffer: Buffer.alloc(2048, 7), mimeType: 'video/mp4', id }) };
  const r = await jobs.runServerUpload(db, job, { admin, wa, notify: async () => {}, env: {}, fetchImpl });
  assert.equal(r.videoId, 'NEWVIDEO001');
  assert.equal((await jobs.getJob(db, job.id)).status, 'uploaded');

  ytAuth._resetCacheForTests();
  const db2 = fakeDb(seed());
  const j2 = await jobs.createDraft(db2, draftArgs({ source: { kind: 'url', url: 'https://files.example/v.mp4' }, playlist: null }));
  const sent = [];
  const page = async (url) => (/oauth2/.test(url) ? res(200, { access_token: 'a', expires_in: 3600 }) : res(200, {}, { 'content-type': 'text/html; charset=utf-8' }));
  await assert.rejects(jobs.runServerUpload(db2, j2, { admin, wa, notify: async (j, t) => sent.push(t), env: {}, fetchImpl: page }), /web page/);
  assert.equal((await jobs.getJob(db2, j2.id)).status, 'failed');
  assert.match(sent[0], /הקישור פותח דף/);
  assert.equal(db2.data.players.get('p1').videoLink, NOAM.videoLink, 'a failed upload changes nothing');
});

test('the cover step: drawn in the style once YouTube processed the video, and honest when YouTube refuses', async () => {
  ytAuth._resetCacheForTests();
  const seed = { app_meta: { youtube: { connected: true }, youtubeStyle: { style: { thumbnail: { custom: true, layout: 'panel' } } } }, app_secrets: { youtube: { clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret, refreshToken: 'r' } } };
  const db = fakeDb(seed);
  const job = { ...(await jobs.createDraft(db, draftArgs())), status: 'uploaded', videoId: 'NEWVIDEO001' };
  await jobs.patchJob(db, job.id, { status: 'uploaded', videoId: 'NEWVIDEO001' });
  let state = 'uploaded'; let set = null; const drawn = [];
  const fetchImpl = async (url, opts = {}) => {
    if (/oauth2/.test(url)) return res(200, { access_token: 'a', expires_in: 3600 });
    if (/\/videos\?/.test(url)) return res(200, { items: [{ status: { uploadStatus: state } }] });
    if (/i\.ytimg\.com/.test(url)) return res(200, Buffer.alloc(5000, 9));
    if (/thumbnails\/set/.test(url)) { set = { type: opts.headers['content-type'], size: opts.body.length }; return res(200, {}); }
    throw new Error(`unexpected ${url}`);
  };
  const render = async (a) => { drawn.push(a); return { bytes: Buffer.alloc(3000, 1), type: 'image/jpeg' }; };
  assert.deepEqual(await jobs.finish(db, job, { fetchImpl, env: {}, render, waitMs: 0, pollMs: 1 }), { again: true }, 'still processing: come back later');
  state = 'processed';
  const sent = [];
  const r = await jobs.finish(db, job, { fetchImpl, env: {}, render, waitMs: 50, pollMs: 1, notify: async (j, t) => sent.push(t) });
  assert.deepEqual(r, { done: true, coverSet: true });
  assert.equal(drawn[0].spec.layout, 'panel');
  assert.equal(drawn[0].values.name, 'Noam Barzilay');
  assert.deepEqual(set, { type: 'image/jpeg', size: 3000 });
  assert.equal((await jobs.getJob(db, job.id)).coverSet, true);

  await jobs.patchJob(db, job.id, { status: 'uploaded' });
  const refuse = async (url, opts) => (/thumbnails\/set/.test(url) ? res(403, { error: { message: 'forbidden' } }) : fetchImpl(url, opts));
  const r2 = await jobs.finish(db, job, { fetchImpl: refuse, env: {}, render, waitMs: 50, pollMs: 1, notify: async (j, t) => sent.push(t) });
  assert.equal(r2.coverSet, false);
  assert.match(sent[1], /youtube\.com\/verify/);
  assert.equal((await jobs.getJob(db, job.id)).status, 'done', 'the video stays up; only the cover is missing');
});

// ── Golda's tool ────────────────────────────────────────────────────────────
function golda({ role = 'admin', turn = 1, media = null, pub = {}, record = NOAM, kicks = [] } = {}) {
  const db = fakeDb({
    players: { p1: { ...record } },
    app_meta: { youtube: { connected: true, channel: { id: 'UC', title: 'LOUPI' }, playlistsAllowed: true, ...pub }, youtubeStyle: { style: { ...ytStyle.FALLBACK_STYLE, privacy: 'public', playlists: [{ id: 'PL1', title: "Men's Football", for: 'men' }] }, channelPlaylists: [{ id: 'PL1', title: "Men's Football" }], examples: [] } },
  });
  const make = (t, m = media) => youtubeTools({ db, admin, identity: BY, media: m, session: { turn: t }, role, resolve: async (c, id) => db.data.players.get(id), kick: async (b) => kicks.push(b) });
  return { db, make, tools: make(turn), kicks };
}

test('only an admin may upload, or a manager once Lou allowed it', async () => {
  await assert.rejects(golda({ role: 'manager' }).tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' }), /may not upload/);
  await assert.rejects(golda({ role: 'scout' }).tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' }), /may not upload/);
  const ok = await golda({ role: 'manager', pub: { managersMayUpload: true } }).tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' });
  assert.equal(ok.drafted, true);
  await assert.rejects(golda({ pub: { connected: false } }).tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' }), /not connected/);
});

test('the draft shows everything; the yes must come in a later message', async () => {
  const g = golda({ turn: 5 });
  const d = await g.tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' });
  assert.match(d.title, /^Noam Barzilay \| LB \/ CB \| \d{4}\/\d{2}$/);
  assert.deepEqual([d.privacy, d.playlist, d.currentVideoLink], ['public', "Men's Football", NOAM.videoLink]);
  assert.match(d.video, /not received yet/);
  await assert.rejects(g.tools.youtube_upload({ action: 'confirm' }), /has not answered the draft yet/, 'the same message cannot be the yes');
  assert.equal(g.kicks.length, 0);
  const c = await g.make(6).youtube_upload({ action: 'confirm' });
  assert.equal(c.awaitingFile, true);
  assert.match(c.page, /\/yt\/[a-f0-9]{48}$/);
  const st = await g.make(7).youtube_upload({ action: 'status' });
  assert.deepEqual([st.status, st.page], ['awaiting_file', c.page]);
  assert.deepEqual(await g.make(8).youtube_upload({ action: 'cancel' }), { cancelled: true, player: 'Noam Barzilay' });
  await assert.rejects(g.make(9).youtube_upload({ action: 'confirm' }), /no such upload/);
});

test('a video sent on WhatsApp is uploaded by the server after the yes', async () => {
  const video = { mimeType: 'video/mp4', mediaId: 'M1', phoneId: 'PH1', buffer: Buffer.alloc(3 * 1048576), filename: 'noam.mp4' };
  const g = golda({ turn: 2, media: video });
  const d = await g.tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1', privacy: 'unlisted', playlist: 'none' });
  assert.match(d.video, /3 MB/);
  assert.deepEqual([d.privacy, d.playlist], ['unlisted', '(none)']);
  const c = await g.make(3, null).youtube_upload({ action: 'confirm' });
  assert.equal(c.started, true);
  assert.deepEqual(g.kicks, [{ phase: 'upload', jobId: d.jobId }]);
  const job = await jobs.getJob(g.db, d.jobId);
  assert.deepEqual([job.status, job.source.kind, job.source.mediaId, job.playlist], ['uploading', 'whatsapp', 'M1', null]);
});

test('a download link must be https; a photo for the cover is drawn on only when asked', async () => {
  const g = golda({ turn: 1 });
  await assert.rejects(g.tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1', sourceUrl: 'http://x/v.mp4' }), /https/);
  await assert.rejects(g.tools.youtube_upload({ action: 'draft' }), /collection and id/);
  const d = await g.tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' });
  await assert.rejects(g.make(2).youtube_upload({ action: 'cover' }), /no image came/);
  const photo = { mimeType: 'image/jpeg', mediaId: 'IMG1', phoneId: 'PH1' };
  const saved = await g.make(2, photo).youtube_upload({ action: 'cover', cover: 'style' });
  assert.equal(saved.coverSaved, true);
  assert.deepEqual((await jobs.getJob(g.db, d.jobId)).cover, { mode: 'image', mediaId: 'IMG1', phoneId: 'PH1', withText: true });
});

test('without the playlist permission the draft says the video will not be filed', async () => {
  const g = golda({ pub: { playlistsAllowed: false } });
  const d = await g.tools.youtube_upload({ action: 'draft', collection: 'players', id: 'p1' });
  assert.match(d.playlist, /not filed/);
  assert.equal((await jobs.getJob(g.db, d.jobId)).playlist, null);
  const s = await g.tools.youtube_style({});
  assert.match(s.playlistNote, /no permission for playlists/);
  assert.deepEqual(s.playlists, [{ title: "Men's Football", for: 'men' }]);
});
