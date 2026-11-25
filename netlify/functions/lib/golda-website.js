// Golda's three tools for the agency's public website (gold-as.com).
//
//   website_read      what the site says now: the player cards, the texts, the
//                     contact links, the open draft, the recent publishes
//   website_edit      collects changes in a draft and shows what they would do;
//                     the picture sent with the message becomes a card photo
//                     made exactly like the ones on the site. Nothing goes live.
//   website_publish   publish → the draft goes live, only in a LATER message
//                               than the draft (the writer's yes)
//                     undo    → the site as it was before the last publish,
//                               also only after a yes in a later message
//                     status  → can Golda reach the site, the last publish
//
// Changing the public site is an act outside the CRM, so it follows the same
// rule as deleting and as YouTube: the yes comes in its own message. Only an
// admin may use these tools.
//
// The page is edited by lib/website-html.js, the photo is made by
// lib/website-photo.js, and lib/website-publish.js sends it through the same
// door Lou's own panel uses.
const { readSite, applyChanges, findCard, photoPathFor, norm } = require('./website-html.js');
const drafts = require('./website-drafts.js');

const SITE_URL = 'https://gold-as.com';
const CARD_KEYS = ['name', 'club', 'position', 'born', 'foot', 'flags'];
const PHOTO_MAX = 700 * 1024;          // a card photo is kept in one Firestore document

const CHANGE_SCHEMA = { type: 'object', properties: {
  type: { type: 'string', enum: ['add_player', 'update_player', 'remove_player', 'set_text', 'set_link'] },
  player: { type: 'string', description: 'update_player / remove_player: the name on the card as the site shows it' },
  name: { type: 'string', description: "The player's name in English as it should appear (add_player; or a new name with update_player)" },
  club: { type: 'string', description: 'In English, with the age group in brackets for a youth team: "Hapoel Hadera (U19)"' },
  position: { type: 'string', description: 'Short codes, at most two, like the site: "GK", "CB", "DM / CM", "LW / AM"' },
  born: { type: 'string', description: 'Year of birth, four digits' },
  foot: { type: 'string', enum: ['Right', 'Left', 'Both'] },
  flags: { type: 'array', items: { type: 'string' }, description: 'Two-letter country codes of the flags on the card, the main one first: ["il"], ["il","de"]' },
  photo: { type: 'string', enum: ['attached'], description: 'Use the picture sent with THIS message as the card photo' },
  id: { type: 'string', description: 'set_text / set_link: the id from website_read' },
  value: { type: 'string', description: 'set_text: the new words (a line break is a new line). For a two-part heading: the plain first part' },
  gold: { type: 'string', description: 'set_text on a two-part heading: the second part, shown in gold' },
  href: { type: 'string', description: 'set_link: mailto:…, https://wa.me/<digits> or tel:+<digits>' },
}, required: ['type'], additionalProperties: false };

const WEBSITE_TOOL_DEFS = [
  { name: 'website_read', description: "The agency's public website gold-as.com as it is live right now. part=players: the player cards (name, club, position, born, foot, flags) and the open draft. part=texts: every text that can be changed, with its id and current words. part=links: the contact links (e-mail, WhatsApp, phone) with their ids. part=seo: the title and descriptions Google shows. part=draft: the changes waiting for the writer's yes. part=history: the recent publishes. Read before changing: a text or a link is changed by its id from here, and a card by the name shown here.",
    input_schema: { type: 'object', properties: { part: { type: 'string', enum: ['players', 'texts', 'links', 'seo', 'draft', 'history', 'all'] } }, additionalProperties: false } },
  { name: 'website_edit', description: "Prepare changes to gold-as.com in a draft. Nothing goes live here. changes is a list, each one of: add_player (name, club, position, born, foot, flags all required; photo:'attached' when the picture came with this message), update_player (player + only what changes; photo:'attached' replaces the photo), remove_player (player), set_text (id + value, and gold for a two-part heading), set_link (id + href). Several changes go in one call and into one draft, so they are published together. The result is the whole draft as it would change the live site; when a card photo was made you see it, and the writer gets it as a file with your answer. drop=[line numbers] takes lines out of the draft; discard=true empties it. Then show the writer the draft and ask for a yes.",
    input_schema: { type: 'object', properties: {
      changes: { type: 'array', items: CHANGE_SCHEMA },
      drop: { type: 'array', items: { type: 'integer' }, description: 'Line numbers of the draft (from 1) to take out' },
      discard: { type: 'boolean', description: 'Empty the whole draft' },
    }, additionalProperties: false } },
  { name: 'website_publish', description: "action=publish: put the writer's draft live on gold-as.com. Only after the writer agreed to the draft in a LATER message than the one it was prepared in. Takes about a minute. action=undo: bring the site back to how it was before the last publish; the first call says what would be undone, and only after the writer's yes in a later message a second call does it. action=status: whether Golda can reach the site, and the last publish.",
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['publish', 'undo', 'status'] } }, required: ['action'], additionalProperties: false } },
];

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isImage = (m) => !!m && /^image\/(jpeg|png|webp)$/.test(m.mimeType || '') && !!m.buffer?.length;
const show = (v) => (Array.isArray(v) ? v.join(' + ') : String(v ?? ''));

/** One line of a draft or a publish, in words. */
function line(s) {
  if (s.type === 'add_player') return `new card: ${s.name} | ${s.club} | ${s.position} | born ${s.born} | ${s.foot} foot | ${show(s.flags)}`;
  if (s.type === 'remove_player') return `card removed: ${s.player}${s.club ? ` (${s.club})` : ''}`;
  if (s.type === 'update_player') return `${s.player}: ${Object.keys(s.after).map((k) => (k === 'photoPath' ? 'new photo' : `${k} "${show(s.before[k])}" → "${show(s.after[k])}"`)).join('; ')}`;
  if (s.type === 'set_text') return `${s.label}: "${s.before}" → "${s.after}"`;
  if (s.type === 'set_link') return `${s.kind} link: ${s.before} → ${s.after}`;
  return s.type;
}

/** A stored change as lib/website-html.js takes it. */
const forPage = ({ hasPhoto, photo, ...c }) => c;
const withoutPhoto = (list) => list.filter((c) => c.type === 'add_player' && !c.hasPhoto).map((c) => c.name);

function websiteTools({ db, admin, identity = {}, media, session, role, channel = 'whatsapp', state, site: givenSite, render }) {
  const by = { email: identity.email || '', name: identity.name || '', channel };
  const turn = Number(session?.turn) || 0;
  let client = givenSite || null;
  const site = () => (client ||= require('./website-publish.js').siteClient());
  const makePhoto = render || ((bytes, opts) => require('./website-photo.js').renderPlayerPhoto(bytes, opts));
  const mayEdit = () => { if (role !== 'admin') throw new Error(`${identity.name || 'the writer'} may not change the website; only an admin can`); };

  async function draftView(draft, html) {
    if (!draft.changes.length) return { empty: true };
    const missingPhotos = withoutPhoto(draft.changes);
    try {
      const r = applyChanges(html || await site().publicPage(), draft.changes.map(forPage));
      return { lines: r.summary.map((s, i) => `${i + 1}. ${line(s)}`), playersAfter: r.playerCount, ...(missingPhotos.length ? { missingPhotos } : {}), preparedInThisMessage: draft.changedTurn === turn };
    } catch (e) {
      return { lines: draft.changes.map((c, i) => `${i + 1}. ${c.type} ${c.name || c.player || c.id || ''}`.trim()), problem: `the draft no longer fits the live site (${e.message}); discard it and prepare it again` };
    }
  }

  async function read({ part = 'players' } = {}) {
    mayEdit();
    const out = { site: SITE_URL };
    const want = (p) => part === 'all' || part === p;
    let html = null;
    if (part !== 'draft' && part !== 'history') {
      html = await site().publicPage();
      const s = readSite(html);
      if (want('players')) { out.players = s.players.map((p) => ({ name: p.name, club: p.club, position: p.position, born: p.born, foot: p.foot, flags: p.flags.map((f) => f.code).filter(Boolean) })); out.playerCount = s.players.length; }
      if (want('texts')) out.texts = s.texts;
      if (want('links')) out.links = s.links;
      if (want('seo')) out.seo = s.seo;
    }
    if (want('draft') || part === 'players') out.draft = await draftView(await drafts.getDraft(db, by.email), html);
    if (want('history')) {
      const meta = await drafts.getMeta(db);
      out.history = (meta.recent || []).map((e) => ({ at: new Date(e.at).toISOString(), by: e.by, changes: e.lines, ...(e.undoOf ? { wasAnUndo: true } : {}), ...(e.undone ? { undone: true } : {}) }));
    }
    return out;
  }

  async function edit(input = {}) {
    mayEdit();
    const draft = await drafts.getDraft(db, by.email);
    if (input.discard) {
      if (draft.changes.length) await drafts.clearDraft(draft);
      return { discarded: true, note: draft.changes.length ? 'The draft is empty now; nothing was published.' : 'There was no draft.' };
    }
    const incoming = Array.isArray(input.changes) ? input.changes : [];
    const drop = [...new Set((Array.isArray(input.drop) ? input.drop : []).map(Number))];
    if (!incoming.length && !drop.length) throw new Error('say what to change: changes=[…], drop=[…] or discard=true');

    const html = await site().publicPage();
    const live = readSite(html);
    const list = draft.changes.map((c) => ({ ...c }));
    const orphans = [];
    for (const n of drop.sort((a, b) => b - a)) {
      if (!Number.isInteger(n) || !list[n - 1]) throw new Error(`the draft has no line ${n}`);
      const [gone] = list.splice(n - 1, 1);
      if (gone.hasPhoto) orphans.push(gone.photoPath);
    }

    let made = null;
    // A photo never lands on a file another card shows (or showed until this publish).
    const freshPath = (name) => {
      const taken = new Set([...live.players.map((p) => p.photo), ...list.map((c) => c.photoPath).filter(Boolean)]);
      const base = photoPathFor(name).replace(/\.jpg$/, '');
      let path = `${base}.jpg`;
      for (let i = 2; taken.has(path); i++) path = `${base}-${i}.jpg`;
      return path;
    };
    const attach = async (target, name) => {
      if (made) throw new Error('one picture came with this message, so it can be the photo of one card only');
      if (!isImage(media)) throw new Error("no picture came with this message; ask the writer to send the player's picture with the request (best: a PNG with a transparent background, sent as a document so it stays a PNG)");
      let r = await makePhoto(media.buffer);
      if (r.bytes.length > PHOTO_MAX) r = await makePhoto(media.buffer, { quality: 72 });
      if (r.bytes.length > PHOTO_MAX) throw new Error('the card photo came out too heavy; send a simpler picture');
      if (!target.hasPhoto) target.photoPath = freshPath(name);
      target.hasPhoto = true;
      made = { path: target.photoPath, name, bytes: r.bytes, cutout: r.cutout, note: r.note || '' };
    };
    const fieldsOf = (raw) => {
      const f = {};
      for (const k of CARD_KEYS) {
        if (raw[k] == null || raw[k] === '') continue;
        f[k] = k === 'flags' ? (Array.isArray(raw.flags) ? raw.flags : [raw.flags]).map((x) => squash(typeof x === 'string' ? x : x?.code).toLowerCase()).filter(Boolean) : squash(raw[k]);
      }
      return f;
    };
    // A card this draft already adds or renames is found under its new name.
    const inDraft = (player) => {
      const w = norm(player);
      const named = list.filter((c) => (c.type === 'add_player' || c.type === 'update_player') && c.name);
      if (!w) return null;
      const exact = named.find((c) => norm(c.name) === w);
      if (exact) return exact;
      const close = named.filter((c) => c.type === 'add_player' && w.split(' ').every((x) => norm(c.name).split(' ').includes(x)));
      return close.length === 1 ? close[0] : null;
    };
    const updateFor = (card) => list.find((c) => c.type === 'update_player' && norm(c.player) === norm(card.name));
    const removalOf = (card) => list.find((c) => c.type === 'remove_player' && norm(c.player) === norm(card.name));

    for (const raw of incoming) {
      const type = raw?.type;
      if (type === 'add_player') {
        const name = squash(raw.name);
        if (!name) throw new Error('the name of the new player is missing');
        let t = list.find((c) => c.type === 'add_player' && norm(c.name) === norm(name));
        if (!t) { t = { type: 'add_player' }; list.push(t); }
        Object.assign(t, fieldsOf(raw));
        if (raw.photo === 'attached') await attach(t, t.name);
      } else if (type === 'update_player') {
        let t = inDraft(raw.player);
        if (!t) {
          const card = findCard(live.players, raw.player);
          if (removalOf(card)) throw new Error(`${card.name} is set to be removed in this draft; take that line out (drop) if the card should stay`);
          t = updateFor(card);
          if (!t) { t = { type: 'update_player', player: card.name }; list.push(t); }
        }
        Object.assign(t, fieldsOf(raw));
        if (raw.photo === 'attached') await attach(t, t.name || t.player);
      } else if (type === 'remove_player') {
        const d = inDraft(raw.player);
        if (d && d.type === 'add_player') { list.splice(list.indexOf(d), 1); if (d.hasPhoto) orphans.push(d.photoPath); continue; }
        const card = d ? { name: d.player } : findCard(live.players, raw.player);
        const u = updateFor(card);
        if (u) { list.splice(list.indexOf(u), 1); if (u.hasPhoto) orphans.push(u.photoPath); }
        if (!removalOf(card)) list.push({ type: 'remove_player', player: card.name });
      } else if (type === 'set_text' || type === 'set_link') {
        const id = squash(raw.id);
        if (!id) throw new Error(`${type} needs the id from website_read`);
        let t = list.find((c) => c.type === type && c.id === id);
        if (!t) { t = { type, id }; list.push(t); }
        if (type === 'set_link') t.href = squash(raw.href);
        else { if (raw.value != null) t.value = String(raw.value); if (raw.gold != null) t.gold = String(raw.gold); }
      } else throw new Error(`unknown change "${type}"`);
    }

    const stale = () => Promise.all(orphans.filter((p) => !list.some((c) => c.photoPath === p)).map((p) => drafts.dropPhoto(draft, p)));
    if (!list.length) { await drafts.clearDraft(draft); return { discarded: true, note: 'The draft is empty now; nothing was published.' }; }

    // Tried on the live page before it is kept, so a draft is always publishable.
    const r = applyChanges(html, list.map(forPage));
    if (made) await drafts.putPhoto(draft, made.path, made);
    await stale();
    await drafts.saveDraft(draft, { changes: list, turn, by });

    const missingPhotos = withoutPhoto(list);
    const result = {
      drafted: true, live: false, changes: r.summary.map((s, i) => `${i + 1}. ${line(s)}`), playersAfter: r.playerCount,
      ...(made ? { photo: { of: made.name, cutout: made.cutout, note: made.note || 'Cut out and placed like the other cards on the site.' } } : {}),
      ...(missingPhotos.length ? { missingPhotos, missingPhotosNote: 'A new card cannot go live without a photo: ask the writer for the picture of each of these players (a PNG with a transparent background, sent as a document), then add it with update_player and photo:"attached".' } : {}),
      instruction: missingPhotos.length
        ? 'Show the writer the draft and ask for the missing picture. Do not offer to publish yet.'
        : `Show the writer every line of the draft${made ? ' and say the finished card photo is attached to your answer' : ''}, say nothing is live yet, and ask for a yes with buttons. Only after their yes in a NEW message call website_publish with action=publish. To change the draft call website_edit again.`,
    };
    if (!made) return result;
    if (state && Array.isArray(state.outFiles) && state.outFiles.length < 3) {
      state.outFiles.push({ buffer: made.bytes, filename: `${drafts.photoId(made.path)}.jpg`, mimeType: 'image/jpeg' });
    }
    return { __content: [
      { type: 'text', text: JSON.stringify(result) },
      { type: 'text', text: `The card photo of ${made.name} as it would appear on the site (661x1100):` },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: made.bytes.toString('base64') } },
    ] };
  }

  const auditLine = async (entry, lines, note) => {
    if (!admin?.firestore?.FieldValue) return;
    await db.collection('audit').add({
      action: 'update', collection: 'website', docId: entry.id, name: 'gold-as.com', summary: lines.join(' · ').slice(0, 600), fields: [],
      by: by.email, byName: `${by.name} (Golda)`.trim(), via: 'golda', channel, actor: 'golda', onBehalfOf: by.email,
      sender: by.name, phone: identity.phone || '', at: admin.firestore.FieldValue.serverTimestamp(), undone: false, note,
    });
  };
  // The site is already changed when these run; a note that fails never hides that.
  const quietly = async (what, fn) => { try { return await fn(); } catch (e) { console.error(`[golda-website] ${what} failed:`, e.message); return null; } };

  async function publish() {
    mayEdit();
    const draft = await drafts.getDraft(db, by.email);
    if (!draft.changes.length) throw new Error('there is no draft to publish; prepare the changes with website_edit first');
    if (!(turn > (draft.changedTurn ?? turn))) throw new Error('the writer has not answered the draft yet: show it, ask, and publish only after their yes in a later message');
    const missing = withoutPhoto(draft.changes);
    if (missing.length) throw new Error(`the new card of ${missing.join(', ')} has no photo yet; ask the writer for the picture first`);
    const paths = draft.changes.filter((c) => c.hasPhoto).map((c) => c.photoPath);
    const photos = await drafts.loadPhotos(draft, paths);
    const lost = paths.filter((p) => !photos.has(p));
    if (lost.length) throw new Error('a photo of this draft was not kept; ask the writer to send the picture again');
    const done = await site().publish({ changes: draft.changes.map(forPage), photos });
    const lines = done.summary.map(line);
    const entry = await quietly('recording the publish', () => drafts.recordPublish(db, { by, deployId: done.deployId, lines, before: done.before, after: done.after, playerCount: done.playerCount }));
    await quietly('clearing the draft', () => drafts.clearDraft(draft));
    if (entry) await quietly('the audit line', () => auditLine(entry, lines, 'website publish'));
    return { published: true, site: SITE_URL, changes: lines, playersNow: done.playerCount,
      note: 'It is live. A phone that had the site open may show the old page until it is refreshed. The cards appear in a random order on every visit. The writer can ask you to undo this publish.' };
  }

  async function undo() {
    mayEdit();
    const meta = await drafts.getMeta(db);
    const last = meta.last;
    if (!last) throw new Error('Golda has not published anything on the site yet, so there is nothing to undo');
    if (last.undone) throw new Error('the last publish was already undone');
    const draft = await drafts.getDraft(db, by.email);
    const armed = draft.undoArmed;
    if (!armed || armed.id !== last.id || !(turn > armed.turn)) {
      await drafts.armUndo(draft, last.id, turn);
      return { wouldUndo: last.lines, publishedAt: new Date(last.at).toISOString(), publishedBy: last.by, live: true,
        instruction: 'Nothing was undone yet. Tell the writer exactly what would be undone and ask for a yes with buttons. Only after their yes in a NEW message call website_publish with action=undo again.' };
    }
    const p = await drafts.getPublish(db, last.id);
    if (!p) throw new Error('the record of that publish is missing, so it cannot be undone from here; Lou can restore the site in his panel');
    let done;
    try { done = await site().restore(p.before, { expect: p.after }); }
    catch (e) {
      if (e.code === 'moved') throw new Error("the site was published again since then from Lou's panel, so undoing would throw his change away. Prepare the opposite change as a new draft instead.");
      throw e;
    }
    const lines = last.lines.map((l) => `undone: ${l}`);
    await quietly('marking the publish undone', () => drafts.markUndone(db, last.id));
    const entry = await quietly('recording the undo', () => drafts.recordPublish(db, { by, deployId: done.deployId, lines, before: done.before, after: done.after, undoOf: last.id }));
    await quietly('disarming the undo', () => drafts.armUndo(draft, null, turn));
    if (entry) await quietly('the audit line', () => auditLine(entry, lines, 'website undo'));
    return { undone: true, site: SITE_URL, restored: last.lines, note: 'The site is back to how it was before that publish.' };
  }

  async function status() {
    mayEdit();
    const [check, meta, draft] = await Promise.all([site().check(), drafts.getMeta(db), drafts.getDraft(db, by.email)]);
    await quietly('saving the connection check', () => drafts.saveMeta(db, { connection: { ok: !!check.ok, at: Date.now(), why: check.why || '', waitingForPanel: !!check.waitingForPanel, serviceEmail: check.serviceEmail || '' } }));
    return {
      site: SITE_URL, canPublish: !!check.ok, ...(check.ok ? {} : { problem: check.why }),
      lastPublish: meta.last ? { at: new Date(meta.last.at).toISOString(), by: meta.last.by, changes: meta.last.lines, undone: !!meta.last.undone } : null,
      draftLines: draft.changes.length,
    };
  }

  const actions = { publish, undo, status };
  return {
    website_read: read,
    website_edit: edit,
    website_publish: async (input = {}) => {
      const fn = actions[input.action];
      if (!fn) throw new Error(`unknown action ${input.action}`);
      return fn();
    },
  };
}

module.exports = { websiteTools, WEBSITE_TOOL_DEFS, line };
