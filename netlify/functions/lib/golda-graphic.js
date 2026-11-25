// A branded picture for Instagram, drawn on the server: a player's signing, a
// goal, a birthday, or a free one-line headline ("first call-up", "player of
// the month"). Golda hands it, with a ready caption, to the person who asked;
// he posts it himself. No model draws anything here and nothing is fetched
// from outside: the player's own photo from the CRM, the agency's mark and the
// fonts the site serves.
//
// It is the same house as the YouTube cover (lib/youtube-thumb.js): resvg
// (WebAssembly) renders an SVG, jpeg-js saves it, Heebo sets Hebrew and body
// text, Bebas Neue the tall Latin capitals, and the colours are the app's:
// the deep green, the dark card green and the gold. The layout is its own,
// made for a portrait post:
//
//   with a photo   the photo fills the top, melts into the card green, and the
//                  words sit under it, centred: a gold kicker, the name very
//                  large, a gold rule, one or two lines of facts
//   without        a typographic card: the deep green with a soft light from
//                  the top, the mark faint and large behind, a big gold hero
//                  (the age, "GOAL", the club) and the same block of words
//
// Two sizes: the feed post 1080x1350 and the story 1080x1920 (the words keep
// out of the top and bottom bands Instagram covers with its own buttons).
//
// Direction: resvg lays every line out left to right and only reverses the
// Hebrew runs inside it, so "נגד Hapoel 2-1" would come out in the wrong order.
// Each line is therefore cut into runs of one direction (lineRuns) and the
// runs are placed here, right to left for a Hebrew line; resvg only draws
// each run. Long names shrink, then wrap onto a second line; nothing is clipped.
const { resvgModule, siteAsset, measurer, roughMeasure, noEmoji, esc } = require('./youtube-thumb.js');
const { imageInfo, upright, outline } = require('./website-photo.js');

const SIZES = { post: { w: 1080, h: 1350 }, story: { w: 1080, h: 1920 } };
const KINDS = ['signing', 'goal', 'birthday', 'custom'];
const C = { green: '#0d3d2e', card: '#0d1c15', gold: '#c9a227', goldLight: '#e3c463', white: '#ffffff', soft: '#d9e2dc' };
const HANDLE = '@goldas_loukorek';         // the agency's Instagram (apps/web/src/pages/Social.jsx)
const MAX_BYTES = 4.5 * 1024 * 1024;      // WhatsApp takes images up to 5 MB
const PHOTO_MAX = 15 * 1024 * 1024;

const HEB = /[֐-׿יִ-ﭏ]/;
const STRONG_L = /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ]/;
const hasHebrew = (s) => HEB.test(String(s || ''));
const clean = (s) => noEmoji(String(s ?? '')).replace(/\s+/g, ' ').trim();

// ── direction ────────────────────────────────────────────────────────────────

/**
 * A line cut into runs of one direction, in reading order:
 * [{ t, dir: 'R' | 'L' | 'N' | 'S' }]. 'S' is a run of spaces (t = its length).
 * base is the line's own direction ('R' for a Hebrew line).
 */
function lineRuns(text, base = hasHebrew(text) ? 'R' : 'L') {
  const chars = [...String(text || '')];
  const cls = chars.map((ch) => (HEB.test(ch) ? 'R' : STRONG_L.test(ch) ? 'L' : 'N'));
  // A neutral between two runs of the same direction takes it; otherwise the line's.
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== 'N') continue;
    let j = i;
    while (j < cls.length && cls[j] === 'N') j++;
    const prev = i > 0 ? cls[i - 1] : base;
    const next = j < cls.length ? cls[j] : base;
    for (let k = i; k < j; k++) cls[k] = prev === next ? prev : base;
    i = j - 1;
  }
  const runs = [];
  for (let i = 0; i < chars.length;) {
    let j = i;
    while (j < chars.length && cls[j] === cls[i]) j++;
    runs.push({ t: chars.slice(i, j).join(''), dir: cls[i] });
    i = j;
  }
  // resvg draws each run alone, so a run keeps no spaces or marks at its edges:
  // they become runs of their own, placed by the line's direction.
  const out = [];
  const push = (t, dir) => { if (!t) return; if (/^ +$/.test(t)) out.push({ t: t.length, dir: 'S' }); else out.push({ t, dir }); };
  for (const r of runs) {
    const strong = r.dir === 'R' ? HEB : STRONG_L;
    const chars2 = [...r.t];
    const a = chars2.findIndex((ch) => strong.test(ch));
    if (a < 0) { splitSpaces(r.t).forEach((p) => push(p, 'N')); continue; }
    let b = chars2.length - 1;
    while (b > a && !strong.test(chars2[b])) b--;
    splitSpaces(chars2.slice(0, a).join('')).forEach((p) => push(p, 'N'));
    push(chars2.slice(a, b + 1).join(''), r.dir);
    splitSpaces(chars2.slice(b + 1).join('')).forEach((p) => push(p, 'N'));
  }
  // In a right-to-left line a bracket on its own is drawn mirrored.
  const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '<': '>', '>': '<', '«': '»', '»': '«' };
  if (base === 'R') for (const r of out) if (r.dir === 'N') r.t = [...r.t].map((ch) => MIRROR[ch] || ch).join('');
  return out;
}
const splitSpaces = (s) => String(s).split(/( +)/).filter(Boolean);

// ── text measuring and fitting ───────────────────────────────────────────────

/** The family a run is set in: Hebrew always Heebo; Latin capitals in Bebas Neue for display lines. */
const familyOf = (run, role, lineHasHebrew, hasDisplay) => (role === 'display' && hasDisplay && !lineHasHebrew && run.dir !== 'R' ? 'Bebas Neue' : 'Heebo');

/** A line ready to draw: its runs, each with family and width at `size`, and the total width. */
function shapeLine(text, { size, role = 'body', weight = 700, spacing = 0, measure, hasDisplay = true }) {
  const base = hasHebrew(text) ? 'R' : 'L';
  const heb = base === 'R';
  const runs = lineRuns(text, base).map((r) => {
    const family = familyOf(r, role, heb, hasDisplay);
    const w8 = family === 'Bebas Neue' ? 400 : weight;
    if (r.dir === 'S') {
      const sp = Math.max(size * 0.26, measure('a a', { family, weight: w8, size }) - measure('aa', { family, weight: w8, size }));
      return { ...r, family, weight: w8, width: sp * r.t + spacing * r.t };
    }
    return { ...r, family, weight: w8, width: measure(r.t, { family, weight: w8, size, spacing }) + ([...r.t].length > 0 ? spacing : 0) };
  });
  return { text, base, runs, size, spacing, width: runs.reduce((a, r) => a + r.width, 0) };
}

/** Largest size ≤ wanted at which the line fits maxWidth (widths grow with the size). */
function fitLine(text, wanted, maxWidth, opts) {
  const at = shapeLine(text, { ...opts, size: wanted });
  if (at.width <= maxWidth) return at;
  const size = Math.max(10, Math.floor(wanted * (maxWidth / at.width) * 0.995));
  const s = shapeLine(text, { ...opts, size });
  return s.width <= maxWidth || size <= 10 ? s : shapeLine(text, { ...opts, size: Math.max(10, size - 2) });
}

/**
 * One or two lines for a long text (a name): it shrinks first, and goes onto
 * two lines when one would be much smaller than two. Never clipped.
 */
function fitBlock(text, wanted, maxWidth, opts, { maxLines = 2, wrapBelow = 0.66 } = {}) {
  const one = fitLine(text, wanted, maxWidth, opts);
  const s = String(text);
  // Where the line may break: at a space (dropped) or after a hyphen (kept on the first line).
  const cuts = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === ' ') cuts.push([s.slice(0, i).trim(), s.slice(i + 1).trim()]);
    else if (s[i] === '-' && s[i - 1] !== ' ' && s[i + 1] !== ' ') cuts.push([s.slice(0, i + 1), s.slice(i + 1)]);
  }
  if (maxLines < 2 || !cuts.length || one.size >= wanted * wrapBelow) return [one];
  let best = null;
  for (const [a, b] of cuts) {
    if (!a || !b) continue;
    const wa = shapeLine(a, { ...opts, size: 100 }).width, wb = shapeLine(b, { ...opts, size: 100 }).width;
    const worst = Math.max(wa, wb);
    if (!best || worst < best.worst) best = { a, b, worst };
  }
  const size = Math.min(Math.floor(wanted * 0.92), Math.floor((maxWidth / best.worst) * 100 * 0.995));
  if (size <= one.size * 1.12) return [one];
  return [fitLine(best.a, size, maxWidth, opts), fitLine(best.b, size, maxWidth, opts)];
}

/** SVG for a shaped line centred on cx with its baseline at y. */
function drawLine(line, { cx, y, fill, opacity = 1 }) {
  const parts = [];
  const place = (r, x) => {
    if (r.dir === 'S') return;
    const attrs = `font-family="${r.family}" font-weight="${r.weight}" font-size="${line.size}"${line.spacing ? ` letter-spacing="${line.spacing}"` : ''}`;
    parts.push(`<text x="${x.toFixed(1)}" y="${Math.round(y)}" ${attrs} fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}>${esc(r.t)}</text>`);
  };
  if (line.base === 'R') {
    let right = cx + line.width / 2;
    for (const r of line.runs) { place(r, right - r.width); right -= r.width; }
  } else {
    let left = cx - line.width / 2;
    for (const r of line.runs) { place(r, left); left += r.width; }
  }
  return parts.join('');
}

// Height of the capitals over the baseline, and the step to the next line.
const capOf = (line) => Math.round(line.size * (line.runs.some((r) => r.family === 'Bebas Neue') ? 0.72 : 0.74));
const stepOf = (line) => Math.round(line.size * (line.runs.some((r) => r.family === 'Bebas Neue') ? 0.9 : 1.08));

// ── the words ────────────────────────────────────────────────────────────────

const GOAL_WORD = { he: ['גול!', 'צמד!', 'שלושער!'], en: ['GOAL', 'BRACE', 'HAT-TRICK'] };
const goalWord = (lang, goals) => GOAL_WORD[lang][Math.max(1, Math.min(3, Number(goals) || 1)) - 1];

/**
 * What the picture says, from the facts: { kicker, name, hero, details: [] }.
 * facts: { kind, lang, name, club, opponent, score, minute, competition, goals, age, female, headline, today }
 */
function graphicTexts(f) {
  const he = f.lang !== 'en';
  const L = he ? 'he' : 'en';
  const name = clean(f.name);
  const club = clean(f.club);
  // hero: the big gold word of the card without a photo; heroSub: the line under it.
  const out = { kicker: '', name, hero: '', heroSub: '', details: [] };
  if (f.kind === 'signing') {
    out.kicker = he ? 'חתימה חדשה' : 'NEW SIGNING';
    out.hero = he ? (f.female ? 'חתמה!' : 'חתם!') : 'SIGNED';
    if (club) out.details.push({ text: club, strong: true });
  } else if (f.kind === 'goal') {
    out.kicker = goalWord(L, f.goals);
    out.hero = out.kicker;
    if (f.opponent) out.details.push({ text: he ? `נגד ${clean(f.opponent)}` : `vs ${clean(f.opponent)}`, strong: true });
    const bits = [clean(f.score), f.minute ? (he ? `דקה ${clean(f.minute)}` : `${clean(f.minute)}'`) : '', clean(f.competition)].filter(Boolean);
    if (bits.length) out.details.push({ text: bits.join(' · ') });
  } else if (f.kind === 'birthday') {
    out.kicker = he ? 'יום הולדת שמח' : 'HAPPY BIRTHDAY';
    if (f.age) {
      out.hero = String(f.age);
      out.heroSub = out.kicker;
      // On the card the age is the hero already; under a photo it is said in words.
      out.details.push({ text: he ? `${f.female ? 'חוגגת' : 'חוגג'} ${f.age}` : `TURNS ${f.age}`, strong: true, photoOnly: true });
    }
  } else {
    out.kicker = clean(f.headline);
    if (club) out.details.push({ text: club });
  }
  if (f.headline && f.kind !== 'custom') out.kicker = clean(f.headline);
  return out;
}

// ── the layout ───────────────────────────────────────────────────────────────

/** Where the photo goes in a box (w x h): it fills the box, the face kept in it (tall photos keep their top third). */
function photoBox(img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  const x = (w - dw) / 2;
  // The face of a standing or half-length photo is near the top third: that point sits at 36% of the box.
  const focus = img.height > img.width * 1.05 ? 0.3 : 0.42;
  const y = Math.min(0, Math.max(h - dh, h * 0.36 - dh * focus));
  return { x, y, width: dw, height: dh };
}

/**
 * Everything over the background, as SVG pieces. `photo` is { width, height, cutout } or null.
 * Returns { defs, under, over, photoArea, markAt, fits: { nameLines, nameSize } }.
 */
function layoutGraphic({ size = 'post', texts, photo = null, measure = roughMeasure, hasDisplay = true, hasMark = true }) {
  const { w: W, h: H } = SIZES[size] || SIZES.post;
  const story = size === 'story';
  const out = { defs: [], under: [], over: [], photoArea: null, markAt: null, fits: {} };
  const cx = W / 2;
  const maxW = W - 2 * 96;
  const shape = (t, wanted, role, weight = 700, spacing = 0, mw = maxW) => fitLine(t, wanted, mw, { role, weight, spacing, measure, hasDisplay });
  // Instagram covers the top and bottom of a story with its own buttons.
  const safeTop = story ? 250 : 70, safeBottom = story ? 300 : 70;

  const kickerLatin = texts.kicker && !hasHebrew(texts.kicker);
  const nameLines = texts.name ? fitBlock(texts.name, photo ? (story ? 168 : 150) : (story ? 178 : 160), maxW, { role: 'display', weight: 700, measure, hasDisplay }) : [];
  out.fits = { nameLines: nameLines.length, nameSize: nameLines[0]?.size || 0 };

  // The block of words, top to bottom: [line, colour, gap after].
  const block = [];
  const heroOnCard = !photo && texts.hero;
  if (heroOnCard) {
    const big = /^\d+$/.test(texts.hero) ? (story ? 420 : 360) : (story ? 230 : 200);
    block.push({ line: shape(texts.hero, big, 'display', 700), fill: C.gold, gap: story ? 56 : 44 });
    if (texts.heroSub) block.push({ line: shape(texts.heroSub, 46, 'body', 700, hasHebrew(texts.heroSub) ? 0 : 6), fill: C.white, gap: 34 });
  } else if (texts.kicker) {
    block.push({ line: shape(texts.kicker, photo ? 52 : 64, 'body', 700, kickerLatin ? 8 : 0), fill: C.gold, gap: 30 });
  }
  nameLines.forEach((l, i) => block.push({ line: l, fill: C.white, gap: i === nameLines.length - 1 ? 40 : Math.round(l.size * 0.14) }));
  block.push({ rule: true, gap: 40 });
  const details = texts.details.filter((d) => photo || !d.photoOnly);
  details.forEach((d, i) => block.push({
    line: shape(d.text, d.strong ? (photo ? 60 : 72) : 44, d.strong && !photo ? 'display' : 'body', d.strong ? 700 : 400),
    fill: d.strong ? (photo ? C.white : C.goldLight) : C.soft, opacity: d.strong ? 1 : 0.92, gap: i === details.length - 1 ? 0 : 22,
  }));
  if (block[block.length - 1]?.rule) block.pop();

  const heightOf = (b) => b.reduce((a, it, i) => a + (it.rule ? 6 : capOf(it.line)) + (i < b.length - 1 ? it.gap : 0), 0);
  let total = heightOf(block);

  // The footer: the handle, small, in the band above the bottom edge.
  const footY = H - safeBottom - (story ? 0 : 6);
  const footer = shape(HANDLE, 30, 'body', 400, 2);

  let top;
  if (photo) {
    // The photo takes the top; the words start where it has faded into the green.
    const photoH = Math.round(H * (story ? 0.64 : 0.66));
    out.photoArea = { x: 0, y: 0, width: W, height: photoH, cutout: !!photo.cutout };
    const room = footY - 60;                         // the words end above the footer
    top = Math.min(photoH - 70, room - total);
    const highest = Math.round(H * (story ? 0.42 : 0.4));
    if (top < highest) {                             // too many words: shrink them, never cover the face
      const k = Math.max(0.55, (room - highest) / total);
      for (const it of block) if (!it.rule) { it.line = shapeLine(it.line.text, { size: Math.floor(it.line.size * k), role: it.line.runs.some((r) => r.family === 'Bebas Neue') ? 'display' : 'body', weight: it.line.runs[0]?.weight || 700, spacing: it.line.spacing, measure, hasDisplay }); it.gap = Math.round(it.gap * k); }
      total = heightOf(block);
      top = Math.max(highest, room - total);
    }
    out.defs.push(`<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.card}" stop-opacity="0"/><stop offset="0.55" stop-color="${C.card}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.card}" stop-opacity="1"/></linearGradient>`);
    out.defs.push(`<linearGradient id="topshade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.card}" stop-opacity="0.75"/><stop offset="1" stop-color="${C.card}" stop-opacity="0"/></linearGradient>`);
    const fadeFrom = Math.min(Math.round(photoH * 0.5), top - 260);
    out.under.push(`<rect x="0" y="${fadeFrom}" width="${W}" height="${photoH - fadeFrom + 2}" fill="url(#fade)"/>`);
    out.under.push(`<rect x="0" y="0" width="${W}" height="${safeTop + 170}" fill="url(#topshade)"/>`);
  } else {
    // A card of words: the deep green lit from the top, the mark large and faint behind.
    out.defs.push(`<radialGradient id="light" cx="0.5" cy="0" r="1.05"><stop offset="0" stop-color="#1c6b4f"/><stop offset="0.45" stop-color="${C.green}"/><stop offset="1" stop-color="${C.card}"/></radialGradient>`);
    out.under.push(`<rect width="${W}" height="${H}" fill="url(#light)"/>`);
    const markTop = safeTop + 40;
    const room = footY - 70 - (markTop + 150 + 60);
    if (total > room) {
      const k = Math.max(0.5, room / total);
      for (const it of block) if (!it.rule) { it.line = shapeLine(it.line.text, { size: Math.floor(it.line.size * k), role: it.line.runs.some((r) => r.family === 'Bebas Neue') ? 'display' : 'body', weight: it.line.runs[0]?.weight || 700, spacing: it.line.spacing, measure, hasDisplay }); it.gap = Math.round(it.gap * k); }
      total = heightOf(block);
    }
    top = Math.round(markTop + 150 + 60 + Math.max(0, (room - total) / 2));
    if (hasMark) out.markAt = { x: cx - 75, y: markTop, size: 150, watermark: { x: cx - 560, y: H / 2 - 520, size: 1120 } };
  }
  if (photo && hasMark) out.markAt = { x: 64, y: story ? safeTop - 150 : 56, size: 104 };

  // The words.
  let y = top;
  for (const it of block) {
    if (it.rule) { out.over.push(`<rect x="${cx - 60}" y="${Math.round(y)}" width="120" height="6" rx="3" fill="${C.gold}"/>`); y += 6 + it.gap; continue; }
    y += capOf(it.line);
    if (photo) out.over.push(drawLine(it.line, { cx: cx + 3, y: y + 4, fill: '#000000', opacity: 0.35 }));
    out.over.push(drawLine(it.line, { cx, y, fill: it.fill, opacity: it.opacity ?? 1 }));
    y += it.gap;
  }
  out.fits.bottom = Math.round(y);

  // The footer and a thin gold frame.
  out.over.push(drawLine(footer, { cx, y: footY, fill: C.gold, opacity: 0.9 }));
  out.over.push(`<rect x="34" y="34" width="${W - 68}" height="${H - 68}" rx="18" fill="none" stroke="${C.gold}" stroke-opacity="0.55" stroke-width="2.5"/>`);
  return out;
}

const dataHref = (bytes, type) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/** The whole SVG. photo: { bytes, info, cutout, box } or null; mark: PNG bytes or null. */
function buildGraphicSvg({ size = 'post', texts, photo = null, mark = null, measure = roughMeasure, hasDisplay = true }) {
  const { w: W, h: H } = SIZES[size] || SIZES.post;
  const lay = layoutGraphic({ size, texts, photo: photo ? { width: photo.info.width, height: photo.info.height, cutout: photo.cutout } : null, measure, hasDisplay, hasMark: !!mark });
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  p.push(`<defs>${lay.defs.join('')}<clipPath id="pa"><rect x="0" y="0" width="${W}" height="${lay.photoArea ? lay.photoArea.height : H}"/></clipPath></defs>`);
  p.push(`<rect width="${W}" height="${H}" fill="${C.card}"/>`);
  if (photo && lay.photoArea) {
    const A = lay.photoArea;
    const up = upright(photo.bytes, photo.info);
    if (photo.cutout && photo.box) {
      // A player cut out of his background stands on a lit green, his head near the top.
      p.push(`<rect width="${W}" height="${A.height}" fill="${C.green}"/>`);
      const b = photo.box;
      const sh = A.height * 0.9, scale = sh / (b.maxY - b.minY + 1);
      const sw = (b.maxX - b.minX + 1) * scale;
      p.push(`<g clip-path="url(#pa)"><svg x="${((W - sw) / 2).toFixed(1)}" y="${(A.height - sh).toFixed(1)}" width="${sw.toFixed(1)}" height="${sh.toFixed(1)}" viewBox="${b.minX} ${b.minY} ${b.maxX - b.minX + 1} ${b.maxY - b.minY + 1}" preserveAspectRatio="none">${up.g}</svg></g>`);
    } else {
      const bx = photoBox({ width: up.width, height: up.height }, A.width, A.height);
      p.push(`<g clip-path="url(#pa)"><svg x="${bx.x.toFixed(1)}" y="${bx.y.toFixed(1)}" width="${bx.width.toFixed(1)}" height="${bx.height.toFixed(1)}" viewBox="0 0 ${up.width} ${up.height}" preserveAspectRatio="none">${up.g}</svg></g>`);
    }
  }
  p.push(...lay.under);
  if (mark && lay.markAt?.watermark) {
    const wm = lay.markAt.watermark;
    p.push(`<image x="${wm.x}" y="${wm.y}" width="${wm.size}" height="${wm.size}" opacity="0.06" preserveAspectRatio="xMidYMid meet" xlink:href="${dataHref(mark, 'image/png')}"/>`);
  }
  p.push(...lay.over);
  if (mark && lay.markAt) p.push(`<image x="${lay.markAt.x}" y="${lay.markAt.y}" width="${lay.markAt.size}" height="${lay.markAt.size}" preserveAspectRatio="xMidYMid meet" xlink:href="${dataHref(mark, 'image/png')}"/>`);
  p.push('</svg>');
  return { svg: p.join(''), layout: lay };
}

/**
 * A photo from the CRM made ready to draw: its size, which way is up, and,
 * for a PNG with a transparent background, where the player is in it.
 * Returns null for anything that cannot be drawn (it then gets the card of words).
 */
async function preparePhoto(bytes, Resvg) {
  if (!bytes || !bytes.length || bytes.length > PHOTO_MAX) return null;
  let info;
  try { info = imageInfo(Buffer.from(bytes)); } catch { return null; }
  if (!(info.width >= 200 && info.height >= 200)) return null;
  let cutout = false, box = null;
  // Only a PNG with an alpha channel (colour type 4 or 6) can be a cut-out.
  if (info.type === 'image/png' && [4, 6].includes(bytes[25])) {
    const up = upright(bytes, info);
    const k = Math.min(1, Math.sqrt(2e6 / (up.width * up.height)));
    const sw = Math.max(1, Math.round(up.width * k)), sh = Math.max(1, Math.round(up.height * k));
    const scan = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${sw}" height="${sh}" viewBox="0 0 ${up.width} ${up.height}">${up.g}</svg>`, { font: { loadSystemFonts: false } }).render();
    const o = outline(scan.pixels, scan.width, scan.height);
    if (o.hasAlpha && o.found) {
      const fx = up.width / scan.width, fy = up.height / scan.height;
      cutout = true;
      box = { minX: o.minX * fx, maxX: (o.maxX + 1) * fx - 1, minY: o.minY * fy, maxY: (o.maxY + 1) * fy - 1 };
    } else if (o.hasAlpha) return null;
  }
  return { bytes: Buffer.from(bytes), info, cutout, box };
}

/**
 * Draw the picture → { bytes (JPG), type, width, height, size, layout, ms, photoUsed }.
 *   facts   see graphicTexts
 *   photo   the player's photo bytes, or null
 */
async function renderGraphic({ facts, size = 'post', photo = null, quality = 88, fetchImpl = fetch, env = process.env }) {
  const t0 = Date.now();
  if (!SIZES[size]) throw new Error(`size must be ${Object.keys(SIZES).join(' or ')}`);
  const { Resvg } = await resvgModule();
  const [bold, regular, tall] = await Promise.all([
    siteAsset('fonts/Heebo-700.ttf', { fetchImpl, env }), siteAsset('fonts/Heebo-400.ttf', { fetchImpl, env }),
    siteAsset('fonts/BebasNeue-400.ttf', { fetchImpl, env }).catch(() => null),
  ]);
  const mark = await siteAsset('brand-mark.png', { fetchImpl, env }).catch(() => null);
  const font = { fontBuffers: [bold, regular, tall].filter(Boolean).map((b) => new Uint8Array(b)), defaultFontFamily: 'Heebo', loadSystemFonts: false };
  const ready = photo ? await preparePhoto(photo, Resvg).catch(() => null) : null;
  const texts = graphicTexts(facts);
  const { svg, layout } = buildGraphicSvg({ size, texts, photo: ready, mark, measure: measurer(Resvg, font), hasDisplay: !!tall });
  const { w } = SIZES[size];
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: w }, font }).render();
  const jpeg = require('jpeg-js');
  let q = quality, out;
  do {
    out = jpeg.encode({ data: Buffer.from(img.pixels), width: img.width, height: img.height }, q).data;
    q -= 8;
  } while (out.length > MAX_BYTES && q > 40);
  return { bytes: Buffer.from(out), type: 'image/jpeg', width: img.width, height: img.height, size, layout, texts, photoUsed: !!ready, cutout: !!ready?.cutout, ms: Date.now() - t0 };
}

// ── the caption ──────────────────────────────────────────────────────────────

const TAGS = {
  he: { base: ['#GoldAS', '#כדורגל'], signing: '#חתימה', goal: '#גול', birthday: '#יום_הולדת', custom: '' },
  en: { base: ['#GoldAS', '#football'], signing: '#signing', goal: '#goal', birthday: '#birthday', custom: '' },
};

/**
 * The ready caption: two or three short lines from the facts only, a small
 * fixed set of hashtags and the agency's handle. No numbers that are not in the facts.
 */
function buildCaption(f) {
  const he = f.lang !== 'en';
  const L = he ? 'he' : 'en';
  const name = clean(f.name), club = clean(f.club), opp = clean(f.opponent);
  const lines = [];
  if (f.kind === 'signing') {
    lines.push(he ? `ברכות ל${name} על החתימה${club ? ` ב${hasHebrew(club) ? '' : '-'}${club}` : ''}!` : `Congratulations to ${name} on signing${club ? ` with ${club}` : ''}!`);
    lines.push(he ? 'מאחלים הצלחה גדולה בהמשך הדרך.' : 'Wishing you every success in the next chapter.');
  } else if (f.kind === 'goal') {
    const n = Math.max(1, Math.min(3, Number(f.goals) || 1));
    const what = he ? (n === 1 ? (f.female ? 'כבשה' : 'כבש') : `${f.female ? 'כבשה' : 'כבש'} ${n === 2 ? 'צמד' : 'שלושער'}`) : (n === 1 ? 'scored' : n === 2 ? 'scored a brace' : 'scored a hat-trick');
    const bits = [];
    if (opp) bits.push(he ? `נגד ${opp}` : `against ${opp}`);
    if (f.minute) bits.push(he ? `בדקה ה-${clean(f.minute)}` : `in the ${ordinal(f.minute)} minute`);
    lines.push(he ? `${name} ${what}${bits.length ? ` ${bits.join(' ')}` : ''}!` : `${name} ${what}${bits.length ? ` ${bits.join(' ')}` : ''}!`);
    const more = [f.score ? (he ? `תוצאה: ${clean(f.score)}` : `Final score: ${clean(f.score)}`) : '', clean(f.competition)].filter(Boolean);
    if (more.length) lines.push(more.join(' · '));
  } else if (f.kind === 'birthday') {
    lines.push(he ? `מזל טוב ל${name} ליום ${f.female ? 'הולדתה' : 'הולדתו'}${f.age ? ` ה-${f.age}` : ''}!` : `Happy ${f.age ? `${ordinal(f.age)} ` : ''}birthday, ${name}!`);
    lines.push(he ? 'מאחלים שנה של בריאות והצלחה, על המגרש ומחוצה לו.' : 'Wishing you a great year, on and off the pitch.');
  } else {
    lines.push(`${name}${f.headline ? ` · ${clean(f.headline)}` : ''}`);
    if (club) lines.push(club);
  }
  const tags = [...TAGS[L].base, TAGS[L][f.kind]].filter(Boolean);
  // A Latin tag inside a Hebrew line shows as "GoldAS#" (its # takes the line's
  // direction), so in Hebrew the Hebrew tags get a line and #GoldAS goes with the handle.
  if (he) return [...lines, '', tags.filter(hasHebrew).join(' '), [...tags.filter((x) => !hasHebrew(x)), HANDLE].join(' ')].join('\n');
  return [...lines, '', tags.join(' '), HANDLE].join('\n');
}
function ordinal(n) {
  const v = Number(String(n).replace(/\D/g, '')) || 0;
  if (!v) return String(n);
  const s = v % 100 >= 11 && v % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
  return `${v}${s}`;
}

/** The age a person turns on the birthday nearest to `today` (YYYY-MM-DD), from dob YYYY-MM-DD; null when unknown. */
function ageOn(dob, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob || '')), t = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today || ''));
  if (!m || !t) return null;
  const days = (Date.UTC(+t[1], +t[2] - 1, +t[3]) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000;
  const age = Math.round(days / 365.2425);
  return age > 0 && age < 80 ? age : null;
}
/** Is today (YYYY-MM-DD) the person's birthday? (29 Feb counts on 28 Feb in other years.) */
function isBirthday(dob, today) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(dob || '')), t = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today || ''));
  if (!m || !t) return false;
  if (m[1] === '02' && m[2] === '29') {
    const leap = (+t[1] % 4 === 0 && +t[1] % 100 !== 0) || +t[1] % 400 === 0;
    return leap ? t[2] === '02' && t[3] === '29' : t[2] === '02' && t[3] === '28';
  }
  return m[1] === t[2] && m[2] === t[3];
}

module.exports = {
  renderGraphic, buildGraphicSvg, layoutGraphic, graphicTexts, buildCaption, lineRuns, shapeLine, fitLine, fitBlock, photoBox, preparePhoto,
  ageOn, isBirthday, SIZES, KINDS, HANDLE, COLORS: C, MAX_BYTES,
};
