// The website follows the CRM. When a represented player who has a card on
// gold-as.com changes in the CRM in a way the card shows (the name, the club,
// the position, the year of birth, the foot, the nationality), Golda prepares
// the website draft with her own website tools (lib/golda-website.js) and asks
// the owner whether to publish. Nothing goes live from here: the draft waits
// for his yes in a later message, and the agent publishes it then with
// website_publish, exactly like a draft he asked for himself.
//
// How a change is noticed: app_meta/goldaSiteFollow.seen keeps, per player,
// the few CRM facts a card shows. A player whose facts differ from what was
// seen has changed. The first run only records everyone; a new player is
// recorded without a word (a new card needs a picture and is asked for by Lou).
// The record moves on once the proposal went out, so one change is proposed once.
//
// What is drafted is only what follows from the record with no guessing:
// positions in the site's short codes, the year, the foot, flags from the
// nationalities, a club written in English (with the age group for a youth
// team). A club or a name written in Hebrew, a player who became a free agent
// or left the agency: she asks what to write instead of drafting.
// A card has no video link and the CRM keeps no card photo, so those two never
// come from here.
const { playerName, resolveAgeGroup, isScored } = require('@goldas/domain');
const { readSite, norm, slugOf, countryName } = require('./website-html.js');
const { chatOf, nudge } = require('./golda-nudge.js');

const META = ['app_meta', 'goldaSiteFollow'];
const BUTTONS = ['כן, לפרסם', 'לא'];
const SITE_POSITION = { CDM: 'DM', CAM: 'AM' };          // the site's codes where they differ from the CRM's
const FEET = ['Right', 'Left', 'Both'];
const LABEL = { name: 'שם', club: 'מועדון', position: 'עמדה', born: 'שנת לידה', foot: 'רגל', flags: 'דגלים' };

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// Written in English letters (accents allowed), so it can go on the site as it is.
const isLatin = (s) => /^[\x20-\x7EÀ-ɏ’]+$/.test(s) && /[A-Za-z]/.test(s);

/** The CRM facts a card shows, as kept in the record of what was seen. */
function viewOf(p) {
  return {
    name: squash(playerName(p)),
    club: squash(p.currentClub),
    youth: Boolean(p.currentClubIsYouth),
    free: p.contractStatus === 'Free',
    pos: [p.primaryPosition, ...(Array.isArray(p.secondaryPositions) ? p.secondaryPositions : [])].map(squash).filter(Boolean).slice(0, 2).join('/'),
    born: (/^(\d{4})/.exec(String(p.dob || '')) || [])[1] || '',
    foot: squash(p.foot),
    nat: (Array.isArray(p.nationalities) ? p.nationalities : []).map(squash).filter(Boolean).join('|'),
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Country names as the CRM writes them → the two letters of the flag.
const countryKey = (s) => squash(String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\b(and|the)\b/g, ' '));
const ALIASES = { 'dr congo': 'cd', congo: 'cg', 'united states': 'us', usa: 'us', 'united kingdom': 'gb', england: 'gb', scotland: 'gb', wales: 'gb', 'northern ireland': 'gb',
  'ivory coast': 'ci', 'south korea': 'kr', 'north korea': 'kp', 'czech republic': 'cz', 'republic of ireland': 'ie', turkey: 'tr', turkiye: 'tr', 'cape verde': 'cv', 'north macedonia': 'mk', macedonia: 'mk', russia: 'ru' };
let byName = null;
function flagCode(country) {
  if (!byName) {
    byName = {};
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) { let n = ''; try { n = names.of(a + b) || ''; } catch { n = ''; } if (n && n !== a + b) byName[countryKey(n)] = (a + b).toLowerCase(); }
    for (const [k, v] of Object.entries(ALIASES)) byName[countryKey(k)] = v;
  }
  return byName[countryKey(country)] || null;
}

/** The card of a player: the same words as one of his names, or the name in his Transfermarkt link. */
function cardFor(cards, names, profileLink = '') {
  const words = (s) => norm(s).split(' ').filter(Boolean).sort().join(' ');
  for (const n of names) {
    const w = words(n);
    if (!w) continue;
    const hits = cards.filter((c) => words(c.name) === w);
    if (hits.length === 1) return hits[0];
  }
  const slug = (/transfermarkt\.[a-z.]+\/([a-z0-9-]+)\/profil/i.exec(String(profileLink || '')) || [])[1];
  const hits = slug ? cards.filter((c) => slugOf(c.name) === slug.toLowerCase()) : [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * What one changed player means for his card.
 *   → { fields: what website_edit gets, lines: the same in Hebrew, asks: what only Lou can decide }
 */
function cardChange(card, before, after, player, now = new Date()) {
  const fields = {}, lines = [], asks = [];
  const put = (k, to, from, shown = to) => { fields[k] = to; lines.push(`${LABEL[k]}: ${shown} (במקום ${from || 'ריק'})`); };

  if (after.name !== before.name) {
    if (!isLatin(after.name)) asks.push(`השם ב-CRM שונה ל"${after.name}". איך לכתוב אותו באנגלית בכרטיס?`);
    else if (norm(after.name) !== norm(card.name)) put('name', after.name, card.name);
  }
  if (after.club !== before.club || after.youth !== before.youth || after.free !== before.free) {
    if (after.free) asks.push(`ב-CRM ${player.gender === 'Women' ? 'היא שחקנית חופשייה' : 'הוא שחקן חופשי'} עכשיו, ובכרטיס כתוב "${card.club}". מה לכתוב שם?`);
    else if (!after.club) asks.push(`ב-CRM אין עכשיו מועדון, ובכרטיס כתוב "${card.club}". מה לכתוב שם?`);
    else if (!isLatin(after.club)) asks.push(`המועדון ב-CRM הוא "${after.club}", ובכרטיס כתוב "${card.club}". איך לכתוב את המועדון החדש באנגלית?`);
    else {
      const group = after.youth ? resolveAgeGroup(player, now) : null;
      const club = `${after.club}${group ? ` (${group.en})` : ''}`;
      if (after.youth && !group) asks.push(`המועדון החדש "${after.club}" מסומן כקבוצת נוער, ולא ידוע לי השנתון לסוגריים (U17, U19…).`);
      if (squash(club) !== squash(card.club)) put('club', club, card.club);
    }
  }
  if (after.pos !== before.pos && after.pos) {
    const position = after.pos.split('/').map((x) => SITE_POSITION[x] || x).join(' / ');
    if (position !== squash(card.position)) put('position', position, card.position);
  }
  if (after.born !== before.born && after.born && after.born !== squash(card.born)) put('born', after.born, card.born);
  if (after.foot !== before.foot && FEET.includes(after.foot) && after.foot !== squash(card.foot)) put('foot', after.foot, card.foot);
  if (after.nat !== before.nat && after.nat) {
    const names = after.nat.split('|');
    const codes = [...new Set(names.map(flagCode))];
    const unknown = names.filter((n) => !flagCode(n));
    if (unknown.length || codes.length > 4) asks.push(`האזרחויות ב-CRM הן ${names.join(', ')}, ולא הצלחתי להתאים להן דגלים. אילו דגלים לשים בכרטיס?`);
    else if (codes.join() !== card.flags.map((f) => f.code).join()) put('flags', codes, card.flags.map((f) => f.name).join(' + '), codes.map((c) => countryName(c)).join(' + '));
  }
  return { fields, lines, asks };
}

/** The message to the owner: the draft's lines per player, then what needs his word. */
function buildSiteMessage(first, { drafted = [], asks = [], hadDraft = false }) {
  const out = [];
  if (drafted.length) {
    out.push(`*${first}, האתר לא מעודכן לפי ה-CRM* 🌐`, 'הפרטים האלה השתנו ב-CRM, והכנתי טיוטה לכרטיסים באתר:');
    for (const d of drafted) { out.push('', `*${d.card}*`); for (const l of d.lines) out.push(`• ${l}`); }
  } else out.push(`*${first}, משהו השתנה ב-CRM שנוגע לאתר* 🌐`);
  if (asks.length) {
    out.push('', drafted.length ? '*ועוד דבר שצריך את המילה שלך לפני שאגע בכרטיס:*' : 'לפני שאגע בכרטיס צריך את המילה שלך:');
    for (const a of asks) out.push(`• *${a.card}*: ${a.text}`);
  }
  if (drafted.length) {
    if (hadDraft) out.push('', 'בטיוטה של האתר מחכים גם שינויים קודמים שלך, ופרסום יעלה את כולם יחד.');
    out.push('', 'שום דבר לא באוויר עדיין. לפרסם?');
  } else out.push('', 'תכתוב לי מה לשים, ואכין טיוטה לאישור.');
  return out.join('\n');
}

/**
 * followSite(db, owner, players, now, { admin, send, job, site })
 * Compares the represented players with what was seen, drafts what follows for
 * the cards on the site and asks the owner. Returns { sent, drafted, asks, … }.
 *   site  the website client (tests pass a stand-in); the real one by default
 */
async function followSite(db, owner, players, now = new Date(), { admin = null, send = null, job = { note: () => {} }, site = null } = {}) {
  const ref = db.collection(META[0]).doc(META[1]);
  const snap = await ref.get();
  const now0 = now.getTime();
  const views = Object.fromEntries((players || []).map((p) => [p.id, viewOf(p)]));
  if (!snap.exists) { await ref.set({ seen: views, updatedAt: now0 }); return { baseline: Object.keys(views).length }; }

  const seen = (snap.data() || {}).seen || {};
  const changed = (players || []).filter((p) => seen[p.id] && !same(seen[p.id], views[p.id]));
  const gone = Object.keys(seen).filter((id) => !views[id]);
  const fresh = Object.keys(views).some((id) => !seen[id]);
  const save = () => ref.set({ seen: views, updatedAt: now0 });
  if (!changed.length && !gone.length) { if (fresh) await save(); return { changed: 0 }; }

  // Only now is the site read: one request for the public page, no pass needed.
  const client = site || require('./website-publish.js').siteClient();
  const cards = readSite(await client.publicPage()).players;
  const drafted = [], asks = [], changes = [];
  for (const p of changed) {
    const card = cardFor(cards, [seen[p.id].name, views[p.id].name], p.profileLink);
    if (!card) continue;                                          // no card on the site: nothing to follow
    const c = cardChange(card, seen[p.id], views[p.id], p, now);
    if (Object.keys(c.fields).length) { changes.push({ type: 'update_player', player: card.name, ...c.fields }); drafted.push({ card: card.name, lines: c.lines }); }
    for (const text of c.asks) asks.push({ card: card.name, text });
  }
  for (const id of gone) {
    const card = cardFor(cards, [seen[id].name]);
    if (card) asks.push({ card: card.name, text: 'כבר לא ברשימת המיוצגים ב-CRM, והכרטיס עדיין באתר. להוריד אותו?' });
  }
  if (!drafted.length && !asks.length) { await save(); return { changed: changed.length + gone.length, onSite: 0 }; }

  let hadDraft = false;
  if (changes.length) {
    const { websiteTools } = require('./golda-website.js');
    try {
      // The draft is his, at the chat's current turn, so only his next message can publish it.
      const { turn } = await chatOf(db, owner);
      const made = await websiteTools({ db, admin, identity: owner, media: null, session: { turn }, role: 'admin', channel: 'whatsapp', state: { outFiles: [] }, site: client })
        .website_edit({ changes });
      hadDraft = (made.changes || []).length > changes.length;   // lines of his own were already waiting
    } catch (e) {
      // A draft that could not be made (his own open draft already touches the card): the change is still told, as a question.
      job.note(`site follow: no draft (${e.message})`);
      for (const d of drafted.splice(0)) asks.push({ card: d.card, text: `${d.lines.join('; ')}. לא הצלחתי להכין טיוטה לבד; להכין?` });
    }
  }
  const body = buildSiteMessage((owner.name || '').split(' ')[0] || 'לו', { drafted, asks, hadDraft });
  await nudge(db, owner, { body, buttons: drafted.length ? BUTTONS : [], kind: 'website', remember: true }, { now: now0, send, job });
  await save();
  job.note(`site follow → ${owner.email}: ${drafted.length} card(s) drafted, ${asks.length} question(s)`);
  return { sent: 1, drafted: drafted.length, asks: asks.length };
}

// ── Which players have a card: the player checklist's "website card" ─────────
// Once a day, in the quiet of the night, the public page is read once and every
// represented player gets siteCard { on, checkedAt } stamped on his record, but
// only when it differs from what is already there, so a quiet day writes nothing.
// The checklist (packages/domain completeness.ts) reads it; a player never
// checked is "not known yet", not missing.
const CARDS_META = ['app_meta', 'goldaSiteCards'];
const CARD_CHECK_HOUR = 5;          // Israel time
const CARD_CHECK_WINDOW = 3;        // hours: 05:30, then 06:30 and 07:30 if the first run was missed

/** Stamps siteCard on the players whose card state changed. Returns how many were written. */
async function stampSiteCards(db, players, cards, today) {
  const changed = (players || []).filter((p) => p && p.id && isScored(p)).map((p) => ({ p, on: Boolean(cardFor(cards, [playerName(p)], p.profileLink)) }))
    .filter(({ p, on }) => !(p.siteCard && p.siteCard.on === on));
  await Promise.all(changed.map(({ p, on }) => db.collection('players').doc(p.id).update({ siteCard: { on, checkedAt: today } })));
  return changed.length;
}

/**
 * checkSiteCards(db, players, now, { hour, today, site, job })
 * Once a day, on the first run in the hours from CARD_CHECK_HOUR (a missed
 * run is made up an hour later): reads the site and stamps the represented players.
 */
async function checkSiteCards(db, players, now = new Date(), { hour, today, site = null, job = { note: () => {} } } = {}) {
  if (!(hour >= CARD_CHECK_HOUR && hour < CARD_CHECK_HOUR + CARD_CHECK_WINDOW)) return { skipped: 'not the hour' };
  const ref = db.collection(CARDS_META[0]).doc(CARDS_META[1]);
  const snap = await ref.get();
  if (snap.exists && (snap.data() || {}).checkedOn === today) return { skipped: 'checked today' };
  const client = site || require('./website-publish.js').siteClient();
  const cards = readSite(await client.publicPage()).players;
  const stamped = await stampSiteCards(db, players, cards, today);
  await ref.set({ checkedOn: today, cards: cards.length, updatedAt: now.getTime() });
  if (stamped) job.note(`site cards: ${stamped} player(s) stamped`);
  return { stamped, cards: cards.length };
}

module.exports = { viewOf, flagCode, cardFor, cardChange, buildSiteMessage, followSite, BUTTONS, stampSiteCards, checkSiteCards, CARD_CHECK_HOUR };
