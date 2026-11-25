// Reading and changing the agency's public website (gold-as.com) as text.
//
// The site is one static index.html that Lou also edits through his own
// panel (manage-g7k2x.html). The panel parses the page, changes the DOM and
// writes the whole page back. Here the page is never rewritten: it is parsed
// only to find where things are, and each change replaces exactly the
// characters of one element or one attribute, so everything else (the styles,
// the scripts, the inline photos) stays byte for byte what was live.
//
//   readSite(html)             → { players, texts, links, seo }
//   applyChanges(html, list)   → { html, summary, newPhotoPaths, removedPhotoPaths }
//
// What can change is what the panel can change: the player cards, the texts
// of its registry, the contact links and the three SEO lines.
const cheerio = require('cheerio');

const GRID = '.players-grid';
const CARD = `${GRID} .player-card`;
const FLAG_STYLE = 'width:20px;height:20px;border-radius:50%;object-fit:cover;display:inline-block;';
const COUNTRY_NAMES = { cd: 'DR Congo', cg: 'Congo', us: 'United States', gb: 'United Kingdom', ci: 'Ivory Coast', kr: 'South Korea', cz: 'Czech Republic' };

// The texts of the page, after the panel's list. `each` = every match is a
// text of its own; `title` = a two-part heading: plain words, a line break and
// a part in gold. (The panel takes the whole About block and each credential
// with its bullet as one text, which would flatten them; here the About
// paragraphs are separate texts and a bullet stays in front of its words.)
const TEXTS = [
  { id: 'hero.eyebrow', sel: '.hero-eyebrow', label: 'Hero: small opening line' },
  { id: 'hero.title', sel: '.hero h1', label: 'Hero: main heading', title: true },
  { id: 'hero.sub', sel: '.hero-sub', label: 'Hero: sub heading' },
  { id: 'about.label', sel: '#about .section-label', label: 'About: section label' },
  { id: 'about.title', sel: '#about .section-title', label: 'About: heading', title: true },
  { id: 'about.paragraph', sel: '.about-text > p:not(.section-label)', label: 'About: paragraph', each: true },
  { id: 'about.stat_number', sel: '.stat-num', label: 'About: statistic number', each: true },
  { id: 'about.stat_label', sel: '.stat-label', label: 'About: statistic description', each: true },
  { id: 'services.label', sel: '#services .section-label', label: 'Services: section label' },
  { id: 'services.title', sel: '#services .section-title', label: 'Services: heading', title: true },
  { id: 'services.name', sel: '.service-name', label: 'Services: service name', each: true },
  { id: 'services.description', sel: '.service-desc', label: 'Services: service description', each: true },
  { id: 'presence.label', sel: '#presence .section-label', label: 'Global Footprint: section label' },
  { id: 'presence.title', sel: '#presence .section-title', label: 'Global Footprint: heading', title: true },
  { id: 'presence.intro', sel: '.presence-intro', label: 'Global Footprint: opening text' },
  { id: 'presence.country', sel: '.presence-country', label: 'Global Footprint: country', each: true },
  { id: 'presence.detail', sel: '.presence-detail', label: 'Global Footprint: country detail', each: true },
  { id: 'presence.map_title', sel: '.presence-map-title', label: 'Global Footprint: map heading' },
  { id: 'players.label', sel: '#players .section-label', label: 'Players: section label' },
  { id: 'players.title', sel: '#players .section-title', label: 'Players: heading', title: true },
  { id: 'agent.label', sel: '#agent .section-label', label: 'The Agent: section label' },
  { id: 'agent.title', sel: '#agent .section-title', label: 'The Agent: heading', title: true },
  { id: 'agent.name', sel: '.agent-name', label: 'The Agent: name' },
  { id: 'agent.role', sel: '.agent-title', label: 'The Agent: role' },
  { id: 'agent.credential', sel: '.credential-item', label: 'The Agent: credential', each: true },
  { id: 'agent.quote', sel: '.agent-value', label: 'The Agent: quote' },
  { id: 'agent.language', sel: '.lang-badge', label: 'The Agent: language', each: true },
  { id: 'contact.label', sel: '#contact .section-label', label: 'Contact: section label' },
  { id: 'contact.title', sel: '#contact .section-title', label: 'Contact: heading', title: true },
  { id: 'contact.subheading', sel: '.contact-center h3', label: 'Contact: small heading' },
  { id: 'contact.intro', sel: '.contact-intro', label: 'Contact: opening text' },
  { id: 'contact.link_label', sel: '.contact-link-label', label: 'Contact: link label', each: true },
  { id: 'contact.link_value', sel: '.contact-link-value', label: 'Contact: link value as shown', each: true },
  { id: 'footer.tagline', sel: '.footer-tagline', label: 'Footer: tagline' },
  { id: 'footer.copyright', sel: '.footer-copy', label: 'Footer: copyright line' },
];
const SEO = [
  { id: 'seo.title', sel: 'title', label: 'Site title (browser tab and Google)' },
  { id: 'seo.description', sel: 'meta[name="description"]', attr: 'content', label: 'Description for Google' },
  { id: 'seo.share_description', sel: 'meta[property="og:description"]', attr: 'content', label: 'Description when the site is shared' },
];
const LINK_SEL = 'a[href^="https://wa.me"], a[href^="tel:"], a[href^="mailto:"]';
const LINK_KINDS = [['https://wa.me', 'whatsapp'], ['tel:', 'phone'], ['mailto:', 'email']];

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const norm = (s) => squash(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, '');
const slugOf = (name) => String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
const photoPathFor = (name) => `/player-${slugOf(name)}.jpg`;

function countryName(code, given) {
  if (given) return squash(given);
  const c = String(code).toLowerCase();
  if (COUNTRY_NAMES[c]) return COUNTRY_NAMES[c];
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c.toUpperCase()) || c.toUpperCase(); } catch { return c.toUpperCase(); }
}

/** [{ code, name }] from codes ("il"), names are filled in. */
function cleanFlags(flags) {
  const out = [];
  for (const f of flags || []) {
    const code = String(typeof f === 'string' ? f : f?.code || '').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(code)) throw new Error(`"${typeof f === 'string' ? f : f?.code}" is not a country code: use the two letters of the flag (il, de, us, gb, cd…)`);
    if (!out.some((x) => x.code === code)) out.push({ code, name: countryName(code, typeof f === 'string' ? '' : f?.name) });
  }
  if (out.length > 4) throw new Error('at most four flags fit on a card');
  return out;
}
const flagHtml = (f) => `<img src="https://flagcdn.com/h40/${f.code}.png" alt="${escAttr(f.name)}" title="${escAttr(f.name)}" style="${FLAG_STYLE}" loading="lazy" decoding="async">`;

function load(html) {
  if (typeof html !== 'string' || html.length < 500) throw new Error('the website page is empty');
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true });
  if (!$(GRID).length) throw new Error('the players section was not found in the page');
  return $;
}
const loc = (el) => {
  const l = el.sourceCodeLocation;
  if (!l || !l.startTag) throw new Error('the page could not be located precisely');
  return l;
};
/** The characters between an element's tags. */
const inner = (el) => { const l = loc(el); if (!l.endTag) throw new Error('an element of the page is not closed'); return [l.startTag.endOffset, l.endTag.startOffset]; };

function cardData($, el, html) {
  const c = $(el);
  const meta = {};
  c.find('.player-meta-item').each((_, m) => {
    const key = squash($(m).find('strong').first().text());
    const rest = $(m).clone(); rest.find('strong').remove();
    if (key) meta[key.toLowerCase()] = squash(rest.text());
  });
  const src = c.find('.player-photo').attr('src') || '';
  const l = loc(el);
  return {
    name: squash(c.find('.player-name').text()), club: squash(c.find('.player-club').text()), position: squash(c.find('.player-pos-badge').text()),
    born: meta.born || '', foot: meta.foot || '',
    flags: c.find('.player-nat-overlay img').map((_, f) => ({ code: (String($(f).attr('src') || '').match(/flagcdn\.com\/h40\/([a-z]{2})\.png/) || [])[1] || '', name: $(f).attr('title') || $(f).attr('alt') || '' })).get(),
    photo: src.startsWith('data:') ? '(inside the page)' : src, photoPath: src.startsWith('/') ? src : null,
    start: l.startOffset, end: l.endOffset, source: html.slice(l.startOffset, l.endOffset),
  };
}

function textItems($, list = TEXTS) {
  const out = [];
  for (const item of list) {
    const els = $(item.sel).toArray();
    if (!els.length) continue;
    (item.each ? els : [els[0]]).forEach((el, i) => {
      const id = item.each ? `${item.id}.${i + 1}` : item.id;
      const e = $(el);
      if (item.attr) { out.push({ id, label: item.label, value: e.attr(item.attr) || '', el, item }); return; }
      if (item.title) {
        const em = e.find('em').first();
        const plain = e.clone(); plain.find('em').remove();
        out.push({ id, label: item.label, value: squash(plain.text()), gold: em.length ? squash(em.text()) : null, el, item });
        return;
      }
      out.push({ id, label: item.each && els.length > 1 ? `${item.label} #${i + 1}` : item.label, ...plainText($, el), el, item });
    });
  }
  return out;
}

/**
 * The words of a text element and where they sit. Line breaks read as "\n".
 * An empty decoration in front (a bullet) is kept: the words start after it.
 * Anything else inside (bold, a link) cannot be rewritten as plain words, so
 * the text is locked rather than flattened.
 */
function plainText($, el) {
  const [s, e] = inner(el);
  const nodes = $(el).contents().toArray();
  const words = (list) => list.map((n) => (n.type === 'text' ? n.data.replace(/\s+/g, ' ') : n.tagName === 'br' ? '\n' : '')).join('').replace(/ *\n */g, '\n').trim();
  const marks = nodes.filter((n) => n.type === 'tag' && n.tagName !== 'br');
  if (!marks.length) return { value: words(nodes), range: [s, e] };
  const last = nodes.lastIndexOf(marks[marks.length - 1]);
  const lead = nodes.slice(0, last + 1);
  const decorative = lead.every((n) => (n.type === 'tag' ? n.tagName !== 'br' && !$(n).text().trim() : n.type !== 'text' || !n.data.trim()));
  if (decorative) return { value: words(nodes.slice(last + 1)), range: [loc(marks[marks.length - 1]).endOffset, e] };
  return { value: squash($(el).text()), locked: true };
}

function linkItems($) {
  return $(LINK_SEL).toArray().map((el, i) => {
    const href = $(el).attr('href') || '';
    const kind = (LINK_KINDS.find(([p]) => href.startsWith(p)) || [])[1];
    return { id: `link.${i + 1}`, kind, href, shown: squash($(el).text()).slice(0, 80), el };
  });
}

const pub = ({ el, item, start, end, source, photoPath, range, ...rest }) => rest;

/** What the page says now. */
function readSite(html) {
  const $ = load(html);
  return {
    players: $(CARD).toArray().map((el) => pub(cardData($, el, html))),
    texts: textItems($).map(pub),
    links: linkItems($).map(pub),
    seo: textItems($, SEO).map(pub),
  };
}

function findCard(cards, name) {
  const want = norm(name);
  if (!want) throw new Error('which player? give the name as it is written on the site');
  let hits = cards.filter((c) => norm(c.name) === want);
  if (!hits.length) hits = cards.filter((c) => norm(c.name).includes(want) || want.split(' ').every((w) => norm(c.name).split(' ').includes(w)));
  if (!hits.length) throw new Error(`no card for "${name}" on the site. The cards: ${cards.map((c) => c.name).join(', ')}`);
  if (hits.length > 1) throw new Error(`"${name}" fits several cards: ${hits.map((c) => c.name).join(', ')}`);
  return hits[0];
}

const FALLBACK_CARD = `<div class="player-card">
        <div class="player-img-wrap">
          <img alt="" class="player-photo" src="" loading="lazy" decoding="async">
          <span class="player-pos-badge"></span>
          <div class="player-nat-overlay"></div>
          <div class="player-view-hint">View Profile</div>
        </div>
        <div class="player-info">
          <div class="player-name"></div>
          <div class="player-club"></div>
          <div class="player-meta">
            <div class="player-meta-item"><strong>Born</strong></div>
            <div class="player-meta-item"><strong>Foot</strong></div>
          </div>
        </div>
      </div>`;

/** One card's HTML with some of its fields replaced (the rest untouched). */
function editCard(source, fields) {
  const $ = cheerio.load(source, null, false);
  const card = $('.player-card').first();
  if (!card.length) throw new Error('not a player card');
  const photo = card.find('.player-photo').first();
  if (fields.name != null) { card.find('.player-name').first().text(fields.name); photo.attr('alt', fields.name); }
  if (fields.club != null) card.find('.player-club').first().text(fields.club);
  if (fields.position != null) card.find('.player-pos-badge').first().text(fields.position);
  for (const key of ['born', 'foot']) {
    if (fields[key] == null) continue;
    const item = card.find('.player-meta-item').filter((_, m) => squash($(m).find('strong').first().text()).toLowerCase() === key).first();
    if (!item.length) throw new Error(`the cards on the site have no "${key}" line`);
    const strong = item.find('strong').first();
    item.contents().filter((_, n) => n !== strong[0]).remove();
    strong.after(escText(fields[key]));
  }
  if (fields.flags) card.find('.player-nat-overlay').first().html(fields.flags.map(flagHtml).join(''));
  if (fields.photoPath) { photo.attr('src', fields.photoPath); photo.attr('loading', 'lazy'); photo.attr('decoding', 'async'); }
  return $.html();
}

const required = (v, what) => { const s = squash(v); if (!s) throw new Error(`${what} is missing`); return s; };
function cardFields(change, { partial }) {
  const f = {};
  const put = (key, what, check) => {
    if (change[key] == null || change[key] === '') { if (!partial) throw new Error(`${what} is missing`); return; }
    f[key] = required(change[key], what);
    if (check && !check.test(f[key])) throw new Error(`${what} "${f[key]}" does not look right`);
  };
  put('name', 'the name'); put('club', 'the club'); put('position', 'the position');
  put('born', 'the year of birth', /^(19|20)\d\d$/); put('foot', 'the foot', /^(Right|Left|Both)$/);
  if (change.flags != null) { f.flags = cleanFlags(change.flags); if (!f.flags.length) throw new Error('a card needs at least one flag'); }
  else if (!partial) throw new Error('the flag (country code) is missing');
  return f;
}

/**
 * Apply a list of changes to the page. Every change is located in the page as
 * it is now; the result differs from it only where a change says so.
 *
 *   { type: 'add_player', name, club, position, born, foot, flags, photoPath? }
 *   { type: 'update_player', player, name?, club?, position?, born?, foot?, flags?, photoPath? }
 *   { type: 'remove_player', player }
 *   { type: 'set_text', id, value, gold? }      (texts and seo)
 *   { type: 'set_link', id, href }
 */
function applyChanges(html, changes) {
  const $ = load(html);
  const cards = $(CARD).toArray().map((el) => cardData($, el, html));
  const texts = [...textItems($), ...textItems($, SEO)];
  const links = linkItems($);
  const splices = [], summary = [], newPhotoPaths = [], removed = [];
  const touched = new Set();
  const once = (key, what) => { if (touched.has(key)) throw new Error(`${what} is changed twice in the same draft`); touched.add(key); };
  const names = new Set(cards.map((c) => norm(c.name)));
  const insertAt = cards.length ? cards[cards.length - 1].end : inner($(GRID)[0])[1];
  const template = cards.length ? cards[cards.length - 1].source : FALLBACK_CARD;

  for (const ch of changes || []) {
    if (ch.type === 'add_player') {
      const f = cardFields(ch, { partial: false });
      if (names.has(norm(f.name))) throw new Error(`${f.name} already has a card on the site; change it instead of adding another`);
      names.add(norm(f.name));
      const photoPath = ch.photoPath || photoPathFor(f.name);
      splices.push({ start: insertAt, end: insertAt, text: editCard(template, { ...f, photoPath }), order: splices.length });
      newPhotoPaths.push(photoPath);
      summary.push({ type: 'add_player', name: f.name, club: f.club, position: f.position, born: f.born, foot: f.foot, flags: f.flags.map((x) => x.name), photoPath });
    } else if (ch.type === 'update_player') {
      const card = findCard(cards, ch.player);
      once(`card:${card.start}`, card.name);
      const f = cardFields(ch, { partial: true });
      if (f.name && norm(f.name) !== norm(card.name) && names.has(norm(f.name))) throw new Error(`${f.name} already has a card on the site`);
      if (ch.photoPath) { f.photoPath = ch.photoPath; newPhotoPaths.push(ch.photoPath); if (card.photoPath && card.photoPath !== ch.photoPath) removed.push(card.photoPath); }
      if (!Object.keys(f).length) throw new Error(`nothing to change for ${card.name}`);
      splices.push({ start: card.start, end: card.end, text: editCard(card.source, f), order: splices.length });
      const before = {};
      for (const k of Object.keys(f)) before[k] = k === 'flags' ? card.flags.map((x) => x.name) : k === 'photoPath' ? card.photo : card[k];
      summary.push({ type: 'update_player', player: card.name, before, after: { ...f, ...(f.flags ? { flags: f.flags.map((x) => x.name) } : {}) } });
    } else if (ch.type === 'remove_player') {
      const card = findCard(cards, ch.player);
      once(`card:${card.start}`, card.name);
      // The blank run before the card goes with it, so no hole is left in the page.
      let start = card.start;
      while (start > 0 && /\s/.test(html[start - 1])) start--;
      splices.push({ start, end: card.end, text: '', order: splices.length });
      if (card.photoPath) removed.push(card.photoPath);
      summary.push({ type: 'remove_player', player: card.name, club: card.club });
    } else if (ch.type === 'set_text') {
      const t = texts.find((x) => x.id === ch.id);
      if (!t) throw new Error(`no text "${ch.id}" on the site; read the texts first for their ids`);
      once(`text:${t.id}`, t.label);
      if (t.item.attr) {
        const value = required(ch.value, 'the new text');
        const a = loc(t.el).attrs?.[t.item.attr];
        if (!a) throw new Error(`${t.label} could not be located`);
        splices.push({ start: a.startOffset, end: a.endOffset, text: `${t.item.attr}="${escAttr(value)}"`, order: splices.length });
        summary.push({ type: 'set_text', id: t.id, label: t.label, before: t.value, after: value });
      } else if (t.item.title) {
        const plain = ch.value != null ? required(ch.value, 'the heading') : t.value;
        const gold = ch.gold != null ? squash(ch.gold) : t.gold;
        const style = $(t.el).find('em').first().attr('style');
        const [s, e] = inner(t.el);
        splices.push({ start: s, end: e, text: escText(plain) + (gold ? `<br><em${style ? ` style="${escAttr(style)}"` : ''}>${escText(gold)}</em>` : ''), order: splices.length });
        summary.push({ type: 'set_text', id: t.id, label: t.label, before: [t.value, t.gold].filter(Boolean).join(' / '), after: [plain, gold].filter(Boolean).join(' / ') });
      } else {
        if (t.locked) throw new Error(`${t.label} has formatting inside (bold or a link), so it cannot be replaced by plain words here; Lou changes it in his panel`);
        const value = String(ch.value == null ? '' : ch.value).split(/\r?\n/).map(squash).filter(Boolean).join('\n');
        if (!value) throw new Error('the new text is missing');
        splices.push({ start: t.range[0], end: t.range[1], text: escText(value).replace(/\n/g, '<br>'), order: splices.length });
        summary.push({ type: 'set_text', id: t.id, label: t.label, before: t.value, after: value });
      }
    } else if (ch.type === 'set_link') {
      const l = links.find((x) => x.id === ch.id);
      if (!l) throw new Error(`no link "${ch.id}" on the site; read the links first for their ids`);
      once(`link:${l.id}`, l.id);
      const href = String(ch.href || '').trim();
      const prefix = LINK_KINDS.find(([, k]) => k === l.kind)[0];
      const ok = l.kind === 'phone' ? /^tel:\+?\d[\d-]{6,}$/.test(href) : l.kind === 'email' ? /^mailto:[^\s@]+@[^\s@]+\.[^\s@?]+(\?.*)?$/.test(href) : /^https:\/\/wa\.me\/\d{8,15}(\?.*)?$/.test(href);
      if (!ok) throw new Error(`a ${l.kind} link has to look like ${prefix}… (got "${href}")`);
      const a = loc(l.el).attrs?.href;
      if (!a) throw new Error(`${l.id} could not be located`);
      splices.push({ start: a.startOffset, end: a.endOffset, text: `href="${escAttr(href)}"`, order: splices.length });
      summary.push({ type: 'set_link', id: l.id, kind: l.kind, before: l.href, after: href });
    } else throw new Error(`unknown change ${ch.type}`);
  }

  // From the end of the page backwards, so earlier positions stay true.
  // New cards share one position: the later one is placed first, so they end up in the order asked.
  splices.sort((a, b) => b.start - a.start || b.order - a.order);
  for (let i = 1; i < splices.length; i++) {
    if (splices[i].end > splices[i - 1].start) throw new Error('two changes touch the same place in the page');
  }
  let out = html;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);

  // A removed photo file goes only when no card uses it any more.
  const after = load(out);
  const used = new Set(after(`${CARD} .player-photo`).toArray().map((el) => after(el).attr('src') || ''));
  if ([...used].some((s) => !s)) throw new Error('a card would be left without a photo');
  return { html: out, summary, newPhotoPaths: [...new Set(newPhotoPaths)], removedPhotoPaths: [...new Set(removed)].filter((p) => !used.has(p)), playerCount: after(CARD).length };
}

module.exports = { readSite, applyChanges, editCard, findCard, cleanFlags, countryName, photoPathFor, slugOf, norm, TEXTS, SEO };
