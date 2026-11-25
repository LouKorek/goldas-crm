// Golda and the agency's website: the page edits, the card photo, the publish
// through the panel's server (a stand-in here) and her three tools against an
// in-memory Firestore.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const page = require('../website-html.js');
const photo = require('../website-photo.js');
const { siteClient, sha1 } = require('../website-publish.js');
const { websiteTools } = require('../golda-website.js');
const drafts = require('../website-drafts.js');
const { resvgModule } = require('../youtube-thumb.js');
const { toolsFor } = require('../wa-agent.js');

// ── a small page shaped like the live one ───────────────────────────────────
const FLAG = (code, name) => `<img src="https://flagcdn.com/h40/${code}.png" alt="${name}" title="${name}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;display:inline-block;" loading="lazy" decoding="async">`;
const CARD = (name, club, pos, born, foot, flags, src) => `<div class="player-card">
        <div class="player-img-wrap">
          <img alt="${name}" class="player-photo" src="${src}" loading="lazy" decoding="async">
          <span class="player-pos-badge">${pos}</span>
          <div class="player-nat-overlay">${flags}</div>
          <div class="player-view-hint">View Profile</div>
        </div>
        <div class="player-info">
          <div class="player-name">${name}</div>
          <div class="player-club">${club}</div>
          <div class="player-meta">
            <div class="player-meta-item"><strong>Born</strong> ${born}</div>
            <div class="player-meta-item"><strong>Foot</strong> ${foot}</div>
          </div>
        </div>
      </div>`;
const PAGE = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Gold A&amp;S | Football Agency</title>
<meta name="description" content="Elite football representation.">
<meta property="og:description" content="Shared description.">
<style>.x{color:#c9a227}</style>
</head>
<body>
<section class="hero"><p class="hero-eyebrow">Gold A&amp;S – Football Agency</p>
<h1>Global Reach.<br><em style="color:var(--gold)">Personal Approach.</em></h1>
<p class="hero-sub">Elite football representation.</p></section>
<section id="about"><div class="about-text"><p class="section-label">Who We Are</p>
<h2 class="section-title">Built on Trust.<br><em>Driven by Ambition.</em></h2>
<p>First paragraph.</p>
<p>Second paragraph<br>on two lines.</p></div></section>
<section id="agent"><div class="credential-item"><span class="cred-dot"></span>FIFA Licensed Agent</div>
<p class="agent-value">A quote with <strong>bold</strong> words.</p></section>
<section id="players"><p class="section-label">Our Talents</p>
    <div class="players-grid" id="playersGrid">
      ${CARD('Eyal Prashizky', "Ironi Modi'in (U17)", 'GK', '2010', 'Right', FLAG('il', 'Israel'), 'data:image/jpeg;base64,AAAA')}
      ${CARD('Gavin Karam', 'Hapoel Kfar Saba', 'DM / CM', '2007', 'Right', FLAG('il', 'Israel') + FLAG('us', 'United States'), '/player-gavin-karam.jpg')}
      ${CARD('Yair Shemesh', 'Ironi Karmiel', 'DM / CM', '2006', 'R', FLAG('il', 'Israel'), '/player-yair-shemesh.jpg')}
    </div>
</section>
<section id="contact"><a class="contact-link" href="mailto:lou@gold-as.com"><span class="contact-link-label">Email</span><span class="contact-link-value">lou@gold-as.com</span></a>
<a class="contact-link" href="https://wa.me/972500000000"><span class="contact-link-label">WhatsApp</span><span class="contact-link-value">+972 50 000 0000</span></a></section>
<script>const order = [...document.querySelectorAll('.player-card')];</script>
</body></html>
`;

test('the page is read as cards, texts and links', () => {
  const s = page.readSite(PAGE);
  assert.deepEqual(s.players.map((p) => p.name), ['Eyal Prashizky', 'Gavin Karam', 'Yair Shemesh']);
  assert.deepEqual(s.players[1], { name: 'Gavin Karam', club: 'Hapoel Kfar Saba', position: 'DM / CM', born: '2007', foot: 'Right', flags: [{ code: 'il', name: 'Israel' }, { code: 'us', name: 'United States' }], photo: '/player-gavin-karam.jpg' });
  assert.equal(s.players[0].photo, '(inside the page)');
  const text = (id) => s.texts.find((t) => t.id === id);
  assert.deepEqual([text('hero.title').value, text('hero.title').gold], ['Global Reach.', 'Personal Approach.']);
  assert.equal(text('about.paragraph.2').value, 'Second paragraph\non two lines.');
  assert.equal(text('agent.credential.1').value, 'FIFA Licensed Agent');
  assert.equal(text('agent.quote').locked, true);
  assert.deepEqual(s.links.map((l) => [l.id, l.kind, l.href]), [['link.1', 'email', 'mailto:lou@gold-as.com'], ['link.2', 'whatsapp', 'https://wa.me/972500000000']]);
  assert.equal(s.seo.find((t) => t.id === 'seo.description').value, 'Elite football representation.');
});

test('a change touches only its own characters', () => {
  assert.equal(page.applyChanges(PAGE, []).html, PAGE);
  const r = page.applyChanges(PAGE, [
    { type: 'update_player', player: 'yair shemesh', foot: 'Right', club: 'Ironi Karmiel (U19)' },
    { type: 'set_text', id: 'hero.sub', value: 'Representation <for> life & career.' },
    { type: 'set_link', id: 'link.2', href: 'https://wa.me/972501111111' },
  ]);
  const lines = (s) => s.split('\n');
  const changed = lines(PAGE).map((l, i) => (l === lines(r.html)[i] ? null : lines(r.html)[i])).filter(Boolean);
  assert.equal(lines(r.html).length, lines(PAGE).length);
  assert.deepEqual(changed.map((l) => l.trim()), [
    '<p class="hero-sub">Representation &lt;for&gt; life &amp; career.</p></section>',
    '<div class="player-club">Ironi Karmiel (U19)</div>',
    '<div class="player-meta-item"><strong>Foot</strong>Right</div>',
    '<a class="contact-link" href="https://wa.me/972501111111"><span class="contact-link-label">WhatsApp</span><span class="contact-link-value">+972 50 000 0000</span></a></section>',
  ]);
  assert.deepEqual(r.summary[0], { type: 'update_player', player: 'Yair Shemesh', before: { club: 'Ironi Karmiel', foot: 'R' }, after: { club: 'Ironi Karmiel (U19)', foot: 'Right' } });
});

test('a card is added after the last one, in the same shape, and a removed one leaves no hole', () => {
  const add = { type: 'add_player', name: 'Dan Cohen', club: 'Maccabi Haifa (U19)', position: 'CB', born: '2008', foot: 'Left', flags: ['il', 'de'] };
  const r = page.applyChanges(PAGE, [add, { type: 'remove_player', player: 'Gavin Karam' }]);
  const s = page.readSite(r.html);
  assert.deepEqual(s.players.map((p) => p.name), ['Eyal Prashizky', 'Yair Shemesh', 'Dan Cohen']);
  assert.deepEqual(s.players[2], { name: 'Dan Cohen', club: 'Maccabi Haifa (U19)', position: 'CB', born: '2008', foot: 'Left', flags: [{ code: 'il', name: 'Israel' }, { code: 'de', name: 'Germany' }], photo: '/player-dan-cohen.jpg' });
  assert.deepEqual(r.newPhotoPaths, ['/player-dan-cohen.jpg']);
  assert.deepEqual(r.removedPhotoPaths, ['/player-gavin-karam.jpg']);
  assert.equal(r.playerCount, 3);
  assert.ok(!/\n\s*\n\s*\n/.test(r.html), 'no blank run where the card was');
  assert.ok(r.html.includes('<img alt="Dan Cohen" class="player-photo" src="/player-dan-cohen.jpg" loading="lazy" decoding="async">'));
  // everything outside the players grid is byte for byte the same
  const outside = (h) => h.slice(0, h.indexOf('<div class="players-grid"')) + h.slice(h.indexOf('</section>', h.indexOf('players-grid')));
  assert.equal(outside(r.html), outside(PAGE));
});

test('what cannot be done safely is refused with the reason', () => {
  const bad = (changes, re) => assert.throws(() => page.applyChanges(PAGE, changes), re);
  bad([{ type: 'add_player', name: 'Gavin Karam', club: 'X', position: 'CB', born: '2008', foot: 'Left', flags: ['il'] }], /already has a card/);
  bad([{ type: 'add_player', name: 'New One', club: 'X', position: 'CB', born: '08', foot: 'Left', flags: ['il'] }], /year of birth/);
  bad([{ type: 'add_player', name: 'New One', club: 'X', position: 'CB', born: '2008', foot: 'Left', flags: ['israel'] }], /not a country code/);
  bad([{ type: 'update_player', player: 'Nobody', club: 'X' }], /no card for "Nobody".*Eyal Prashizky/);
  bad([{ type: 'update_player', player: 'Gavin', club: 'A' }, { type: 'remove_player', player: 'Gavin Karam' }], /changed twice/);
  bad([{ type: 'set_text', id: 'agent.quote', value: 'plain' }], /formatting inside/);
  bad([{ type: 'set_text', id: 'nope', value: 'x' }], /no text "nope"/);
  bad([{ type: 'set_link', id: 'link.1', href: 'https://evil.example' }], /email link has to look like mailto:/);
});

test('a two-part heading keeps its gold part and a bullet stays in front of its words', () => {
  const r = page.applyChanges(PAGE, [{ type: 'set_text', id: 'hero.title', value: 'Worldwide.' }, { type: 'set_text', id: 'agent.credential.1', value: 'Licensed by FIFA' }]);
  assert.ok(r.html.includes('<h1>Worldwide.<br><em style="color:var(--gold)">Personal Approach.</em></h1>'));
  assert.ok(r.html.includes('<div class="credential-item"><span class="cred-dot"></span>Licensed by FIFA</div>'));
});

// ── the card photo ──────────────────────────────────────────────────────────
async function png(svg, width) {
  const { Resvg } = await resvgModule();
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng());
}
const decode = (bytes) => require('jpeg-js').decode(bytes, { useTArray: true });
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
const near = (a, b, d = 14) => a.every((v, i) => Math.abs(v - b[i]) <= d);

test('a cut-out picture becomes a card photo placed like the ones on the site', async () => {
  // a red "player" 200x500 somewhere inside a transparent 800x1000 picture
  const cut = await png('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect x="350" y="300" width="200" height="500" fill="rgb(200,30,30)"/></svg>', 800);
  const r = await photo.renderPlayerPhoto(cut);
  assert.equal(r.cutout, true);
  assert.equal(r.note, '');
  const img = decode(r.bytes);
  assert.deepEqual([img.width, img.height], [photo.CARD_W, photo.CARD_H]);
  const red = [200, 30, 30], green = photo.CARD_BG;
  const top = photo.CARD_H - photo.BOTTOM_GAP - photo.SUBJECT_H, bottom = photo.CARD_H - photo.BOTTOM_GAP, mid = Math.round(photo.CARD_W / 2);
  assert.ok(near(pixel(img, mid, top + 6), red), 'the player starts 728 px above his feet');
  assert.ok(near(pixel(img, mid, bottom - 6), red), 'his feet stand 186 px above the edge');
  assert.ok(near(pixel(img, mid, top - 6), green) && near(pixel(img, mid, bottom + 6), green), 'card green above and below');
  // 200x500 scaled to 728 tall is 291 wide, centred
  assert.ok(near(pixel(img, mid - 140, 550), red) && near(pixel(img, mid - 152, 550), green));
  assert.ok(near(pixel(img, 4, 4), green));
});

test('a picture with its own background is fitted whole and says so', async () => {
  const cut = await png('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="rgb(40,90,200)"/></svg>', 600);
  const r = await photo.renderPlayerPhoto(cut);
  assert.equal(r.cutout, false);
  assert.match(r.note, /no transparent background/);
  const img = decode(r.bytes);
  assert.ok(near(pixel(img, 330, photo.CARD_H - photo.BOTTOM_GAP - 10), [40, 90, 200]));
  assert.ok(near(pixel(img, 330, photo.CARD_H - 20), photo.CARD_BG));
});

test('a picture that cannot make a card is refused', async () => {
  await assert.rejects(photo.renderPlayerPhoto(Buffer.from('not a picture at all, just some words here')), /PNG, JPG or WebP/);
  const tiny = await png('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>', 100);
  await assert.rejects(photo.renderPlayerPhoto(tiny), /too small/);
  const empty = await png('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"></svg>', 400);
  await assert.rejects(photo.renderPlayerPhoto(empty), /completely transparent/);
});

// ── the panel's server, as a stand-in ───────────────────────────────────────
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))) });
function fakePanel({ html = PAGE, allowed = true, why = 'email not allowed' } = {}) {
  const blobs = new Map();
  const put = (path, bytes) => { const sha = sha1(bytes); blobs.set(sha, Buffer.from(bytes)); return sha; };
  const state = { files: {}, deploys: [], calls: [], tokens: [], pending: null };
  for (const [path, body] of [['/index.html', html], ['/manage-g7k2x.html', '<html>panel</html>'], ['/training-compensation.html', '<html>tc</html>'], ['/player-gavin-karam.jpg', 'gavin'], ['/player-yair-shemesh.jpg', 'yair']]) state.files[path] = put(path, Buffer.from(body));
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host === 'site.test') return state.files[u.pathname] ? res(200, blobs.get(state.files[u.pathname])) : res(404, 'nope');
    const action = u.searchParams.get('action');
    state.calls.push(action);
    if (action === 'config') return res(200, { google_client_id: 'panel-client.apps.googleusercontent.com' });
    state.tokens.push(opts.headers?.authorization);
    if (!allowed) return res(401, { error: 'unauthorized', why });
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (action === 'files') return res(200, { files: Object.entries(state.files).map(([path, sha]) => ({ path, sha })) });
    if (action === 'deploy') {
      state.pending = { id: `dep${state.deploys.length + 1}`, files: body.files, required: [...new Set(Object.values(body.files))].filter((sha) => !blobs.has(sha)) };
      return res(200, { deploy_id: state.pending.id, required: state.pending.required });
    }
    if (action === 'upload') { put(body.path, Buffer.from(body.content_b64, 'base64')); return res(200, { ok: true }); }
    if (action === 'status') {
      const missing = Object.values(state.pending.files).filter((sha) => !blobs.has(sha));
      if (missing.length) return res(200, { state: 'uploading' });
      state.files = { ...state.pending.files }; state.deploys.push(state.pending);
      return res(200, { state: 'ready' });
    }
    return res(400, { error: 'unknown' });
  };
  const client = siteClient({ fetchImpl, env: { WEBSITE_ADMIN_API: 'https://panel.test/api', WEBSITE_URL: 'https://site.test', FIREBASE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: 'golda@crm.iam.gserviceaccount.com', private_key: 'k' }) },
    mint: async (aud) => `note-for:${aud}`, wait: async () => {}, now: () => 1000 });
  return { state, client, blobs, live: () => blobs.get(state.files['/index.html']).toString('utf8') };
}

test('a publish sends only what changed and leaves the rest of the site as it was', async () => {
  const panel = fakePanel();
  const before = { ...panel.state.files };
  const jpg = Buffer.from('new card photo');
  const done = await panel.client.publish({
    changes: [{ type: 'add_player', name: 'Dan Cohen', club: 'Maccabi Haifa (U19)', position: 'CB', born: '2008', foot: 'Left', flags: ['il'] }, { type: 'remove_player', player: 'Gavin Karam' }],
    photos: new Map([['/player-dan-cohen.jpg', jpg]]),
  });
  assert.equal(done.uploaded, 2);
  assert.equal(done.playerCount, 3);
  assert.deepEqual(done.before, before);
  const now = panel.state.files;
  assert.equal(now['/manage-g7k2x.html'], before['/manage-g7k2x.html']);
  assert.equal(now['/training-compensation.html'], before['/training-compensation.html']);
  assert.equal(now['/player-yair-shemesh.jpg'], before['/player-yair-shemesh.jpg']);
  assert.equal(now['/player-dan-cohen.jpg'], sha1(jpg));
  assert.ok(!('/player-gavin-karam.jpg' in now));
  assert.deepEqual(page.readSite(panel.live()).players.map((p) => p.name), ['Eyal Prashizky', 'Yair Shemesh', 'Dan Cohen']);
  // she speaks to the panel as the service account, with a note made for the panel's own Google client
  assert.ok(panel.state.tokens.every((t) => t === 'Bearer note-for:panel-client.apps.googleusercontent.com'));
  assert.equal(panel.state.calls.filter((c) => c === 'config').length, 1);
});

test('undo publishes the earlier list again, unless the site moved on', async () => {
  const panel = fakePanel();
  const done = await panel.client.publish({ changes: [{ type: 'set_text', id: 'hero.sub', value: 'Changed.' }] });
  assert.ok(panel.live().includes('<p class="hero-sub">Changed.</p>'));
  const back = await panel.client.restore(done.before, { expect: done.after });
  assert.equal(back.uploaded, 0);
  assert.equal(panel.live(), PAGE);
  // Lou publishes from the panel in between: the undo steps aside
  const again = await panel.client.publish({ changes: [{ type: 'set_text', id: 'hero.sub', value: 'Changed.' }] });
  panel.state.files = { ...panel.state.files, '/player-new.jpg': 'abc' };
  await assert.rejects(panel.client.restore(again.before, { expect: again.after }), (e) => e.code === 'moved');
});

test('a publish that would do nothing, or cannot be sure of the live page, stops', async () => {
  const panel = fakePanel();
  await assert.rejects(panel.client.publish({ changes: [] }), /nothing would change/);
  await assert.rejects(panel.client.publish({ changes: [{ type: 'add_player', name: 'Dan Cohen', club: 'X', position: 'CB', born: '2008', foot: 'Left', flags: ['il'] }] }), /photo \/player-dan-cohen\.jpg is missing/);
  // the page the site serves is not the one in its file list (a publish is in flight)
  panel.state.files['/index.html'] = sha1(Buffer.from('something else'));
  await assert.rejects(panel.client.publish({ changes: [{ type: 'set_text', id: 'hero.sub', value: 'x' }] }), /middle of another publish/);
  assert.equal(panel.state.deploys.length, 0);
});

test('until the panel knows her, Golda says what is missing instead of failing', async () => {
  const panel = fakePanel({ allowed: false });
  const c = await panel.client.check();
  assert.deepEqual({ ok: c.ok, serviceEmail: c.serviceEmail, waitingForPanel: c.waitingForPanel }, { ok: false, serviceEmail: 'golda@crm.iam.gserviceaccount.com', waitingForPanel: true });
  assert.match(c.why, /does not know Golda yet/);
  assert.equal((await fakePanel().client.check()).ok, true);
  // reading the public page needs no pass at all
  assert.ok((await panel.client.publicPage()).includes('players-grid'));
});

// ── her tools ───────────────────────────────────────────────────────────────
function fakeDb() {
  const data = new Map(); let n = 0;
  const col = (path) => { if (!data.has(path)) data.set(path, new Map()); return data.get(path); };
  const doc = (path, id) => ({
    id,
    get: async () => { const v = col(path).get(id); return { id, exists: v !== undefined, data: () => (v === undefined ? undefined : structuredClone(v)) }; },
    set: async (v, o) => { assert.doesNotThrow(() => JSON.stringify(v)); col(path).set(id, o && o.merge ? { ...(col(path).get(id) || {}), ...v } : { ...v }); },
    delete: async () => { col(path).delete(id); },
    collection: (sub) => collection(`${path}/${id}/${sub}`),
  });
  const collection = (path) => ({
    doc: (id) => doc(path, id),
    add: async (v) => { const id = `new${++n}`; col(path).set(id, { ...v }); return { id }; },
    get: async () => ({ docs: [...col(path)].map(([id, v]) => ({ id, data: () => ({ ...v }), ref: doc(path, id) })) }),
  });
  return { data, collection };
}
const admin = { firestore: { FieldValue: { serverTimestamp: () => 'now' } } };
const lou = { email: 'lou@example.com', name: 'לו', role: 'admin' };
const PICTURE = { buffer: Buffer.from('picture'), mimeType: 'image/png', filename: 'dan.png' };
function golda({ db = fakeDb(), panel = fakePanel(), turn = 1, media = null, role = 'admin', identity = lou } = {}) {
  const state = { outFiles: [] };
  const tools = websiteTools({ db, admin, identity, media, session: { turn }, role, state, site: panel.client,
    render: async (bytes) => ({ bytes: Buffer.from(`card:${bytes}`), cutout: true, note: '' }) });
  return { db, panel, state, tools };
}
const DAN = { type: 'add_player', name: 'Dan Cohen', club: 'Maccabi Haifa (U19)', position: 'CB', born: '2008', foot: 'Left', flags: ['il'] };

test('only an admin gets the website tools', async () => {
  const names = (role) => toolsFor(role).map((t) => t.name).filter((n) => n.startsWith('website_'));
  assert.deepEqual(names('admin'), ['website_read', 'website_edit', 'website_publish']);
  for (const role of ['manager', 'agent', 'viewer']) assert.deepEqual(names(role), []);
  const g = golda({ role: 'manager' });
  await assert.rejects(g.tools.website_edit({ changes: [DAN] }), /only an admin/);
  await assert.rejects(g.tools.website_publish({ action: 'publish' }), /only an admin/);
});

test('a new card: the draft, the photo, the yes in a later message, live', async () => {
  const db = fakeDb(), panel = fakePanel();
  // message 1: the details and the picture
  const m1 = golda({ db, panel, turn: 1, media: PICTURE });
  const out = await m1.tools.website_edit({ changes: [{ ...DAN, photo: 'attached' }] });
  const result = JSON.parse(out.__content[0].text);
  assert.deepEqual(result.changes, ['1. new card: Dan Cohen | Maccabi Haifa (U19) | CB | born 2008 | Left foot | Israel']);
  assert.equal(result.live, false);
  assert.equal(result.playersAfter, 4);
  assert.equal(out.__content.at(-1).type, 'image');
  assert.deepEqual(m1.state.outFiles.map((f) => [f.filename, f.mimeType, f.buffer.toString()]), [['player-dan-cohen.jpg', 'image/jpeg', 'card:picture']]);
  assert.equal(panel.state.deploys.length, 0, 'nothing is live after a draft');
  // the same message cannot also publish
  await assert.rejects(m1.tools.website_publish({ action: 'publish' }), /has not answered the draft yet/);
  // message 2: the yes
  const m2 = golda({ db, panel, turn: 2 });
  const done = await m2.tools.website_publish({ action: 'publish' });
  assert.equal(done.published, true);
  assert.equal(done.playersNow, 4);
  const cards = page.readSite(panel.live()).players;
  assert.deepEqual(cards.at(-1), { name: 'Dan Cohen', club: 'Maccabi Haifa (U19)', position: 'CB', born: '2008', foot: 'Left', flags: [{ code: 'il', name: 'Israel' }], photo: '/player-dan-cohen.jpg' });
  assert.equal(panel.blobs.get(panel.state.files['/player-dan-cohen.jpg']).toString(), 'card:picture');
  // the draft is gone, the publish is kept and shown
  assert.equal((await drafts.getDraft(db, lou.email)).changes.length, 0);
  assert.equal(db.data.get('website_drafts/lou@example.com/photos').size, 0);
  const meta = await drafts.getMeta(db);
  assert.deepEqual(meta.last.lines, ['new card: Dan Cohen | Maccabi Haifa (U19) | CB | born 2008 | Left foot | Israel']);
  const audit = [...db.data.get('audit').values()][0];
  assert.deepEqual([audit.collection, audit.via, audit.onBehalfOf, 'before' in audit], ['website', 'golda', 'lou@example.com', false]);
  await assert.rejects(m2.tools.website_publish({ action: 'publish' }), /no draft to publish/);
});

test('a new card waits for its picture, which may come in the next message', async () => {
  const db = fakeDb(), panel = fakePanel();
  const first = await golda({ db, panel, turn: 1 }).tools.website_edit({ changes: [DAN] });
  assert.deepEqual(first.missingPhotos, ['Dan Cohen']);
  assert.match(first.instruction, /ask for the missing picture/);
  await assert.rejects(golda({ db, panel, turn: 2 }).tools.website_publish({ action: 'publish' }), /no photo yet/);
  await assert.rejects(golda({ db, panel, turn: 2 }).tools.website_edit({ changes: [{ type: 'update_player', player: 'Dan Cohen', photo: 'attached' }] }), /no picture came with this message/);
  // the picture arrives: it joins the same draft line, and the yes has to come after it
  const second = await golda({ db, panel, turn: 3, media: PICTURE }).tools.website_edit({ changes: [{ type: 'update_player', player: 'dan cohen', photo: 'attached', foot: 'Right' }] });
  const r = JSON.parse(second.__content[0].text);
  assert.deepEqual(r.changes, ['1. new card: Dan Cohen | Maccabi Haifa (U19) | CB | born 2008 | Right foot | Israel']);
  assert.equal(r.missingPhotos, undefined);
  await assert.rejects(golda({ db, panel, turn: 3 }).tools.website_publish({ action: 'publish' }), /has not answered/);
  assert.equal((await golda({ db, panel, turn: 4 }).tools.website_publish({ action: 'publish' })).published, true);
});

test('changes asked over several messages become one draft and one publish', async () => {
  const db = fakeDb(), panel = fakePanel();
  await golda({ db, panel, turn: 1 }).tools.website_edit({ changes: [{ type: 'update_player', player: 'Shemesh', foot: 'Right' }, { type: 'set_text', id: 'hero.sub', value: 'First try.' }] });
  const g = golda({ db, panel, turn: 2, media: PICTURE });
  const out = await g.tools.website_edit({ changes: [
    { type: 'update_player', player: 'Yair Shemesh', club: 'Ironi Karmiel (U19)', photo: 'attached' },   // joins the first line
    { type: 'set_text', id: 'hero.sub', value: 'Second try.' },                                           // replaces the earlier words
    { type: 'remove_player', player: 'Gavin Karam' },
  ] });
  const r = JSON.parse(out.__content[0].text);
  assert.deepEqual(r.changes, [
    '1. Yair Shemesh: club "Ironi Karmiel" → "Ironi Karmiel (U19)"; foot "R" → "Right"; new photo',
    '2. Hero: sub heading: "Elite football representation." → "Second try."',
    '3. card removed: Gavin Karam (Hapoel Kfar Saba)',
  ]);
  // a replaced photo gets a file of its own, never the one the card shows now
  assert.equal(g.state.outFiles[0].filename, 'player-yair-shemesh-2.jpg');
  // reading shows the open draft; dropping a line keeps the rest
  const read = await golda({ db, panel, turn: 3 }).tools.website_read({ part: 'draft' });
  assert.equal(read.draft.lines.length, 3);
  const after = await golda({ db, panel, turn: 3 }).tools.website_edit({ drop: [3] });
  assert.equal(after.changes.length, 2);
  await golda({ db, panel, turn: 4 }).tools.website_publish({ action: 'publish' });
  assert.equal(panel.state.deploys.length, 1);
  const s = page.readSite(panel.live());
  assert.deepEqual(s.players.map((p) => [p.name, p.club, p.foot, p.photo]).at(-1), ['Yair Shemesh', 'Ironi Karmiel (U19)', 'Right', '/player-yair-shemesh-2.jpg']);
  assert.equal(s.players.length, 3);
  assert.ok(!('/player-yair-shemesh.jpg' in panel.state.files), 'the old photo file goes with the change');
  assert.equal(s.texts.find((t) => t.id === 'hero.sub').value, 'Second try.');
});

test('a draft that would not fit the live site is not kept, and discard empties it', async () => {
  const db = fakeDb(), panel = fakePanel();
  await assert.rejects(golda({ db, panel }).tools.website_edit({ changes: [{ ...DAN, born: '08' }] }), /year of birth/);
  await assert.rejects(golda({ db, panel }).tools.website_edit({ changes: [{ type: 'update_player', player: 'Nobody', club: 'X' }] }), /no card for "Nobody"/);
  assert.equal((await drafts.getDraft(db, lou.email)).changes.length, 0);
  await golda({ db, panel, media: PICTURE }).tools.website_edit({ changes: [{ ...DAN, photo: 'attached' }] });
  // taking a card out of the draft that the draft itself added just drops it
  const out = await golda({ db, panel, turn: 2 }).tools.website_edit({ changes: [{ type: 'remove_player', player: 'Dan Cohen' }] });
  assert.equal(out.discarded, true);
  assert.equal(db.data.get('website_drafts/lou@example.com/photos').size, 0);
  assert.equal((await golda({ db, panel, turn: 2 }).tools.website_edit({ discard: true })).note, 'There was no draft.');
});

test('undo asks first, then brings the site back, and steps aside when Lou published since', async () => {
  const db = fakeDb(), panel = fakePanel();
  await assert.rejects(golda({ db, panel }).tools.website_publish({ action: 'undo' }), /nothing to undo/);
  await golda({ db, panel, turn: 1 }).tools.website_edit({ changes: [{ type: 'set_text', id: 'hero.sub', value: 'Changed.' }] });
  await golda({ db, panel, turn: 2 }).tools.website_publish({ action: 'publish' });
  const ask = await golda({ db, panel, turn: 3 }).tools.website_publish({ action: 'undo' });
  assert.deepEqual(ask.wouldUndo, ['Hero: sub heading: "Elite football representation." → "Changed."']);
  assert.ok(panel.live().includes('Changed.'), 'asking undoes nothing');
  // a second call in the same message is still only a question
  assert.ok((await golda({ db, panel, turn: 3 }).tools.website_publish({ action: 'undo' })).wouldUndo);
  const done = await golda({ db, panel, turn: 4 }).tools.website_publish({ action: 'undo' });
  assert.equal(done.undone, true);
  assert.equal(panel.live(), PAGE);
  const meta = await drafts.getMeta(db);
  assert.deepEqual([meta.recent.length, meta.recent[1].undone, meta.last.lines[0]], [2, true, 'undone: Hero: sub heading: "Elite football representation." → "Changed."']);
  // publish again, then the panel publishes: the undo refuses instead of erasing Lou's change
  await golda({ db, panel, turn: 5 }).tools.website_edit({ changes: [{ type: 'set_text', id: 'hero.sub', value: 'Again.' }] });
  await golda({ db, panel, turn: 6 }).tools.website_publish({ action: 'publish' });
  await golda({ db, panel, turn: 7 }).tools.website_publish({ action: 'undo' });
  panel.state.files = { ...panel.state.files, '/player-from-panel.jpg': 'abc' };
  await assert.rejects(golda({ db, panel, turn: 8 }).tools.website_publish({ action: 'undo' }), /published again since then from Lou's panel/);
  assert.ok(panel.live().includes('Again.'));
});

test('status says whether she can publish and keeps the answer for the app', async () => {
  const db = fakeDb();
  const no = await golda({ db, panel: fakePanel({ allowed: false }) }).tools.website_publish({ action: 'status' });
  assert.equal(no.canPublish, false);
  assert.match(no.problem, /does not know Golda yet/);
  assert.deepEqual((({ ok, waitingForPanel, serviceEmail }) => ({ ok, waitingForPanel, serviceEmail }))((await drafts.getMeta(db)).connection), { ok: false, waitingForPanel: true, serviceEmail: 'golda@crm.iam.gserviceaccount.com' });
  assert.equal((await golda({ db }).tools.website_publish({ action: 'status' })).canPublish, true);
  const read = await golda({ db }).tools.website_read({});
  assert.deepEqual([read.playerCount, read.players[1].flags, read.draft], [3, ['il', 'us'], { empty: true }]);
});

test('a file fingerprint is the SHA-1 Netlify uses', () => {
  assert.equal(sha1(Buffer.from('abc')), crypto.createHash('sha1').update('abc').digest('hex'));
});
