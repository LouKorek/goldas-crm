// The cover (thumbnail) Golda puts on a video she uploads, drawn in the style
// she learned from Lou's channel (lib/youtube-style.js → style.thumbnail).
//
// Lou's covers share one idea: a picture of the player, the name very large
// and a short list of facts (date of birth, nationality, position, height,
// club). Three layouts cover what the channel has used:
//
//   bars    the picture fills the cover; the name and the facts sit on one
//           side, each fact on its own coloured bar
//   panel   the picture on one half and a light paper panel on the other,
//           with the season, the name in two colours and the facts
//   band    the picture with a dark band at the bottom: the name and one line
//
// The picture is a frame of the video (the one YouTube picked) or an image
// the writer sent. Drawn as SVG and rendered with resvg (WebAssembly) with
// the fonts the site serves: Heebo (Hebrew and Latin) and Bebas Neue (the
// tall capitals of the covers). Neither has emoji, so emoji are left out of
// the cover's text. Saved as a 1280x720 JPG under YouTube's 2 MB.
const fs = require('fs');
const path = require('path');

const W = 1280, H = 720;
const LAYOUTS = ['bars', 'panel', 'band'];
const DEFAULT_SPEC = {
  custom: true, layout: 'bars', side: 'left',
  topLine: '',
  nameLines: ['{firstName}', '{lastName}'],
  rows: ['Date Of Birth : {birthDateDots}', 'Nationality : {nationality}', 'Position : {positions}', 'Height : {heightM} CM'],
  uppercase: true, font: 'display',
  nameColor: '#FFFFFF', nameAccentColor: '#1E5BB8',
  rowColor: '#FFFFFF', barColor: '#1E88E5', barOpacity: 0.86,
  panelColor: '#F4F4F1', panelTextColor: '#141414',
  logo: 'none',
};

const HEBREW = /[֐-׿]/;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const color = (c, d) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : d);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
// Emoji, flags and their joiners: the cover fonts cannot draw them.
const noEmoji = (s) => String(s).replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/gu, '').replace(/[ \t]{2,}/g, ' ').trim();

/** Fill {placeholders} from values; drop the separators around empty ones. */
function fill(template, values) {
  const GONE = '\u0000';
  const SEP = '[|·•–—\\-/,&]';
  let s = String(template || '').replace(/\{(\w+)\}/g, (_, k) => (values[k] == null || values[k] === '' ? GONE : String(values[k])));
  s = s.replace(new RegExp(`[ \\t]*${SEP}[ \\t]*${GONE}`, 'g'), '')       // "A | (nothing)" → "A"
    .replace(new RegExp(`${GONE}[ \\t]*${SEP}[ \\t]*`, 'g'), '')          // "(nothing) | B" → "B"
    .replace(new RegExp(GONE, 'g'), '')
    .replace(/\(\s*\)|\[\s*\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  return s;
}

/** A line of a pattern, or null when it names values and none of them is known ("Height : " says nothing). */
function fillOrDrop(template, values) {
  const used = [...String(template || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (used.length && used.every((k) => values[k] == null || values[k] === '')) return null;
  const s = fill(template, values);
  return s || null;
}

/** A rough text width, for when the real fonts are not at hand (tests). */
function roughMeasure(text, { family, size, spacing = 0 }) {
  const n = [...String(text)].length;
  return n * size * (family === 'Bebas Neue' ? 0.4 : 0.56) + Math.max(0, n - 1) * spacing;
}

/** Largest size ≤ wanted at which the text is no wider than maxWidth. */
function fitSize(text, wanted, maxWidth, measure, font) {
  const w = measure(text, { ...font, size: wanted });
  return w <= maxWidth ? wanted : Math.max(22, Math.floor(wanted * (maxWidth / w)));
}

function specOf(spec) {
  const s = { ...DEFAULT_SPEC, ...(spec || {}) };
  // The first covers Golda drew had `textLines`; read them as a band.
  if (!spec?.layout && Array.isArray(spec?.textLines) && spec.textLines.length) {
    s.layout = 'band'; s.nameLines = [spec.textLines[0]]; s.rows = spec.textLines.slice(1);
  }
  s.layout = LAYOUTS.includes(s.layout) ? s.layout : 'bars';
  s.side = ['left', 'right', 'center'].includes(s.side) ? s.side : 'left';
  s.nameLines = (Array.isArray(s.nameLines) ? s.nameLines : DEFAULT_SPEC.nameLines).slice(0, 2);
  s.rows = (Array.isArray(s.rows) ? s.rows : DEFAULT_SPEC.rows).slice(0, 6);
  return s;
}

/**
 * The drawing, as a list of SVG pieces above the picture. `measure` gives a
 * text's width; `hasDisplay` says whether the tall-capitals font is loaded.
 */
function layoutCover({ spec, values = {}, measure = roughMeasure, hasDisplay = true, hasLogo = false }) {
  const s = specOf(spec);
  const out = { defs: [], under: [], over: [], photo: { x: 0, width: W }, logo: null };
  if (spec?.plain) return out;                       // the picture alone
  const upper = (t) => (s.uppercase !== false && !HEBREW.test(t) ? t.toUpperCase() : t);
  const display = s.font !== 'sans' && hasDisplay;
  const fam = (t) => (HEBREW.test(t) || !display ? 'Heebo' : 'Bebas Neue');
  const line = (t) => { const v = fillOrDrop(t, values); return v ? noEmoji(v) : null; };
  const names = s.nameLines.map(line).filter(Boolean).map(upper);
  if (!names.length && values.name) names.push(upper(noEmoji(values.name)));
  const top = s.topLine ? line(s.topLine) : null;
  const rows = s.rows.map(line).filter(Boolean).map(upper);

  const text = ({ x, y, t, size, family, weight = 400, fillColor, anchor = 'start', spacing = 0, shadow = false }) => {
    const attrs = `font-family="${family}" font-weight="${weight}" font-size="${size}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}${HEBREW.test(t) ? ' direction="rtl"' : ''}`;
    if (shadow) out.over.push(`<text x="${x + 3}" y="${y + 4}" ${attrs} fill="#000000" fill-opacity="0.45">${esc(t)}</text>`);
    out.over.push(`<text x="${x}" y="${y}" ${attrs} fill="${fillColor}">${esc(t)}</text>`);
  };
  const placeLogo = (corner, size = 104) => {
    if (!hasLogo || !corner || corner === 'none') return;
    out.logo = { x: /left/.test(corner) ? 36 : W - 36 - size, y: /top/.test(corner) ? 30 : H - 30 - size, size };
  };

  if (s.layout === 'panel') {
    const right = s.side !== 'left';
    const PW = 650;
    const x0 = right ? W - PW : 0;
    const edge = right ? x0 : PW;
    const dark = color(s.panelTextColor, '#141414');
    const accent = color(s.nameAccentColor, '#1E5BB8');
    // A torn-paper edge between the picture and the panel.
    const pts = [];
    for (let i = 0; i <= 20; i++) pts.push([Math.round(edge + 13 * Math.sin(i * 1.7) + 8 * Math.sin(i * 0.6 + 1)), i * 36]);
    const shape = `M${pts.map((p) => p.join(',')).join(' L')} L${right ? W : 0},${H} L${right ? W : 0},0 Z`;
    out.photo = right ? { x: 0, width: edge + 40 } : { x: edge - 40, width: W - edge + 40 };
    out.defs.push('<filter id="soft" x="-20%" y="-5%" width="140%" height="110%"><feGaussianBlur stdDeviation="16"/></filter>');
    out.defs.push(`<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${color(s.panelColor, '#F4F4F1')}"/></linearGradient>`);
    out.under.push(`<path d="${shape}" transform="translate(${right ? -16 : 16},0)" fill="#000000" fill-opacity="0.5" filter="url(#soft)"/>`);
    out.under.push(`<path d="${shape}" fill="url(#paper)"/>`);

    const cx = x0 + PW / 2 + (right ? 12 : -12);
    const maxW = PW - 130;
    const items = [];
    if (top) items.push({ t: upper(top), family: 'Heebo', weight: 400, wanted: 46, spacing: 8, fillColor: dark, after: 14 });
    names.forEach((t, i) => {
      const first = i === 0 && names.length > 1;
      items.push(first
        ? { t, family: 'Heebo', weight: 700, wanted: 104, fillColor: accent, after: 2 }
        : { t, family: fam(t), weight: fam(t) === 'Heebo' ? 700 : 400, wanted: display ? 150 : 108, fillColor: names.length > 1 ? dark : accent, after: 30 });
    });
    const rowSize = rows.length
      ? Math.min(...rows.map((t) => fitSize(t, display ? 52 : 40, maxW, measure, { family: fam(t), weight: fam(t) === 'Heebo' ? 700 : 400 })))
      : 0;
    rows.forEach((t) => items.push({ t, family: fam(t), weight: fam(t) === 'Heebo' ? 700 : 400, size: rowSize, fillColor: dark, after: 12 }));
    for (const it of items) if (!it.size) it.size = fitSize(it.t, it.wanted, maxW - (it.spacing ? [...it.t].length * it.spacing : 0), measure, it);
    const cap = (it) => Math.round(it.size * (it.family === 'Heebo' ? 0.76 : 0.72));       // the height of the capitals
    let total = items.reduce((a, it) => a + cap(it) + it.after, 0) - (items.length ? items[items.length - 1].after : 0);
    const room = H - 110;
    if (total > room) { const k = room / total; for (const it of items) { it.size = Math.max(22, Math.floor(it.size * k)); it.after = Math.round(it.after * k); } total = room; }
    let y = Math.max(46, (H - total) / 2);
    for (const it of items) { y += cap(it); text({ x: cx, y: Math.round(y), t: it.t, size: it.size, family: it.family, weight: it.weight, fillColor: it.fillColor, anchor: 'middle', spacing: it.spacing || 0 }); y += it.after; }
    placeLogo(right ? 'bottom-right' : 'bottom-left', 92);
    return out;
  }

  if (s.layout === 'band') {
    const line1 = names.join(' ');
    const line2 = rows.slice(0, 2).join('  ·  ');
    const maxW = W - 140;
    const s1 = line1 ? fitSize(line1, display ? 132 : 100, maxW, measure, { family: fam(line1), weight: 700 }) : 0;
    const s2 = line2 ? fitSize(line2, display ? 58 : 48, maxW, measure, { family: fam(line2), weight: 400 }) : 0;
    const blockH = Math.round(s1 * 0.78) + (s2 ? Math.round(s2 * 0.78) + 22 : 0);
    out.defs.push('<linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000000" stop-opacity="0.82"/><stop offset="0.6" stop-color="#000000" stop-opacity="0.38"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>');
    const h = Math.min(H, blockH + 240);
    out.under.push(`<rect x="0" y="${H - h}" width="${W}" height="${h}" fill="url(#g)"/>`);
    let y = H - 62 - blockH;
    if (line1) { y += Math.round(s1 * 0.78); text({ x: W / 2, y, t: line1, size: s1, family: fam(line1), weight: fam(line1) === 'Heebo' ? 700 : 400, fillColor: color(s.nameColor, '#FFFFFF'), anchor: 'middle', shadow: true }); y += 22; }
    if (line2) { y += Math.round(s2 * 0.78); text({ x: W / 2, y, t: line2, size: s2, family: fam(line2), weight: 400, fillColor: color(s.rowColor, '#FFFFFF'), anchor: 'middle' }); }
    placeLogo(/bottom/.test(s.logo || '') ? s.logo.replace('bottom', 'top') : s.logo, 110);
    return out;
  }

  // bars
  const side = s.side;
  const margin = 70;
  const maxW = side === 'center' ? 900 : 650;
  const x = side === 'left' ? margin : side === 'right' ? W - margin : W / 2;
  const anchor = side === 'left' ? 'start' : side === 'right' ? 'end' : 'middle';
  const nameFont = (t) => ({ family: fam(t), weight: fam(t) === 'Heebo' ? 700 : 400 });
  const nameSize = names.length ? Math.min(...names.map((t) => fitSize(t, display ? 168 : 116, maxW, measure, nameFont(t)))) : 0;
  const nameStep = Math.round(nameSize * (display ? 0.86 : 1.0));
  const nameCap = Math.round(nameSize * (display ? 0.72 : 0.76));
  const rowFont = (t) => ({ family: fam(t), weight: fam(t) === 'Heebo' ? 700 : 400 });
  const pad = 18;
  const rowSize = rows.length ? Math.min(...rows.map((t) => fitSize(t, display ? 50 : 40, maxW - 2 * pad, measure, rowFont(t)))) : 0;
  const barH = Math.round(rowSize * 1.42), gap = 12;
  const topSize = top ? fitSize(upper(top), 44, maxW, measure, { family: 'Heebo', weight: 400, spacing: 6 }) : 0;
  const total = (top ? Math.round(topSize * 0.76) + 20 : 0)
    + (names.length ? nameCap + (names.length - 1) * nameStep : 0)
    + (rows.length ? 34 + rows.length * barH + (rows.length - 1) * gap : 0);
  let y = Math.max(40, Math.round((H - total) / 2));

  if (side === 'center') out.under.push(`<rect width="${W}" height="${H}" fill="#000000" fill-opacity="0.38"/>`);
  else {
    const [a, b] = side === 'left' ? ['0', '1'] : ['1', '0'];
    out.defs.push(`<linearGradient id="g" x1="${a}" y1="0" x2="${b}" y2="0"><stop offset="0" stop-color="#000000" stop-opacity="0.66"/><stop offset="0.5" stop-color="#000000" stop-opacity="0.34"/><stop offset="0.78" stop-color="#000000" stop-opacity="0"/></linearGradient>`);
    out.under.push(`<rect width="${W}" height="${H}" fill="url(#g)"/>`);
  }
  if (top) { y += Math.round(topSize * 0.76); text({ x, y, t: upper(top), size: topSize, family: 'Heebo', weight: 400, fillColor: color(s.nameColor, '#FFFFFF'), anchor, spacing: 6, shadow: true }); y += 20; }
  names.forEach((t, i) => {
    y += i === 0 ? nameCap : nameStep;
    text({ x, y, t, size: nameSize, ...nameFont(t), fillColor: color(s.nameColor, '#FFFFFF'), anchor, shadow: true });
  });
  if (rows.length) y += 34;
  rows.forEach((t, i) => {
    const w = Math.ceil(measure(t, { ...rowFont(t), size: rowSize })) + 2 * pad;
    const bx = side === 'left' ? x - 6 : side === 'right' ? x + 6 - w : x - w / 2;
    const top0 = y + i * (barH + gap);
    out.over.push(`<rect x="${Math.round(bx)}" y="${top0}" width="${w}" height="${barH}" rx="5" fill="${color(s.barColor, '#1E88E5')}" fill-opacity="${clamp(Number(s.barOpacity ?? 0.86), 0, 1)}"/>`);
    const tx = side === 'left' ? bx + pad : side === 'right' ? bx + w - pad : x;
    text({ x: Math.round(tx), y: Math.round(top0 + barH / 2 + rowSize * 0.36), t, size: rowSize, ...rowFont(t), fillColor: color(s.rowColor, '#FFFFFF'), anchor });
  });
  // The logo keeps to the side the text is not on.
  let corner = s.logo || 'bottom-right';
  if (side === 'left') corner = corner.replace('left', 'right');
  if (side === 'right') corner = corner.replace('right', 'left');
  placeLogo(corner, 110);
  return out;
}

/** PNG or JPG, by the file's first bytes (a name's ending can lie). */
const imageType = (b) => (b && b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b && b[0] === 0x52 && b[1] === 0x49 ? 'image/webp' : 'image/jpeg');

function buildSvg({ background, logo = null, spec = {}, values = {}, measure = roughMeasure, hasDisplay = true }) {
  const lay = layoutCover({ spec, values, measure, hasDisplay, hasLogo: !!logo });
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<defs>${lay.defs.join('')}</defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="#111111"/>`);
  if (background) parts.push(`<image x="${lay.photo.x}" y="0" width="${lay.photo.width}" height="${H}" preserveAspectRatio="xMidYMid slice" xlink:href="data:${imageType(background)};base64,${Buffer.from(background).toString('base64')}"/>`);
  parts.push(...lay.under, ...lay.over);
  if (logo && lay.logo) parts.push(`<image x="${lay.logo.x}" y="${lay.logo.y}" width="${lay.logo.size}" height="${lay.logo.size}" preserveAspectRatio="xMidYMid meet" xlink:href="data:${imageType(logo)};base64,${Buffer.from(logo).toString('base64')}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

let _wasm = null;
async function resvgModule() {
  const mod = require('@resvg/resvg-wasm');
  if (!_wasm) {
    const file = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
    _wasm = mod.initWasm(fs.readFileSync(file)).catch((e) => { if (!/Already initialized/i.test(e.message)) throw e; });
  }
  await _wasm;
  return mod;
}

const _assets = {};
/** A file the site serves (fonts, logo): from the function's own files when they came along, else from the site. */
async function siteAsset(rel, { fetchImpl = fetch, env = process.env } = {}) {
  if (_assets[rel]) return _assets[rel];
  // In the repository this file sits three folders deep; bundled, the function sits two deep.
  for (const local of [path.join(__dirname, '../../../apps/web/public', rel), path.join(__dirname, '../../apps/web/public', rel), path.join(process.cwd(), 'apps/web/public', rel)]) {
    try { if (fs.existsSync(local)) return (_assets[rel] = fs.readFileSync(local)); } catch { /* not packed with the function */ }
  }
  const site = (env.URL || 'https://goldas-crm.netlify.app').replace(/\/$/, '');
  const res = await fetchImpl(`${site}/${rel}`);
  if (!res.ok) throw new Error(`${rel}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000 || bytes.subarray(0, 15).toString('latin1').toLowerCase().includes('<!doctype')) throw new Error(`${rel}: not a file`);
  return (_assets[rel] = bytes);
}

/** A width function that asks the real fonts (through resvg), cached per text. */
function measurer(Resvg, font) {
  const cache = new Map();
  return (t, { family, weight = 400, size, spacing = 0 }) => {
    const key = `${family}|${weight}|${t}`;
    let w100 = cache.get(key);
    if (w100 == null) {
      const r = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="300"><text x="40" y="200" font-family="${family}" font-weight="${weight}" font-size="100">${esc(t)}</text></svg>`, { font });
      const box = r.getBBox();
      w100 = box ? box.width : roughMeasure(t, { family, size: 100 });
      try { box?.free?.(); r.free?.(); } catch { /* nothing to free */ }
      cache.set(key, w100);
    }
    return (w100 * size) / 100 + Math.max(0, [...String(t)].length - 1) * spacing;
  };
}

/** Draw the cover → { bytes (JPG), type, width, height }. */
async function renderCover({ background, spec, values, withLogo = true, quality = 86, fetchImpl = fetch, env = process.env }) {
  const { Resvg } = await resvgModule();
  const [bold, regular, tall] = await Promise.all([
    siteAsset('fonts/Heebo-700.ttf', { fetchImpl, env }), siteAsset('fonts/Heebo-400.ttf', { fetchImpl, env }),
    siteAsset('fonts/BebasNeue-400.ttf', { fetchImpl, env }).catch(() => null),
  ]);
  let logo = null;
  if (withLogo && !spec?.plain && (spec?.logo ?? DEFAULT_SPEC.logo) !== 'none') logo = await siteAsset('brand-mark.png', { fetchImpl, env }).catch(() => null);
  const font = { fontBuffers: [bold, regular, tall].filter(Boolean).map((b) => new Uint8Array(b)), defaultFontFamily: 'Heebo', loadSystemFonts: false };
  const svg = buildSvg({ background, logo, spec, values, measure: measurer(Resvg, font), hasDisplay: !!tall });
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font });
  const img = r.render();
  const jpeg = require('jpeg-js');
  let q = quality, out;
  do {
    out = jpeg.encode({ data: Buffer.from(img.pixels), width: img.width, height: img.height }, q).data;
    q -= 10;
  } while (out.length > 1900 * 1024 && q > 40);
  return { bytes: Buffer.from(out), type: 'image/jpeg', width: img.width, height: img.height };
}

/** Only resize / re-encode a picture to a valid cover (no text, no logo). */
const plainSpec = () => ({ plain: true, logo: 'none' });

module.exports = { renderCover, resvgModule, buildSvg, layoutCover, fill, fillOrDrop, fitSize, roughMeasure, plainSpec, noEmoji, imageType, DEFAULT_SPEC, LAYOUTS, W, H };
