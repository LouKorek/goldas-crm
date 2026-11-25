// A player's photo, made ready for his card on the website.
//
// Every card photo on gold-as.com is the same: a 661x1100 picture, the dark
// card green behind, the player cut out and standing 728 px tall with 186 px
// of air under his feet. Lou's panel makes it in the browser from a picture
// with a transparent background; this is the same recipe on the server, so a
// card Golda adds cannot be told from one Lou added:
//
//   transparent background → the player is found by his outline (every pixel
//                            that is more than a tenth opaque), scaled to
//                            728 px tall, centred, feet 186 px above the edge
//   no transparency        → the whole picture is fitted into the same area
//                            (it will show its own background; `cutout` is
//                            false so Golda can say so)
//
// Drawn with resvg (WebAssembly) and saved as a JPG, like the panel does.
const { resvgModule } = require('./youtube-thumb.js');

const CARD_W = 661, CARD_H = 1100, SUBJECT_H = 728, BOTTOM_GAP = 186;
const CARD_BG = [13, 28, 21];
const MAX_BYTES = 12 * 1024 * 1024;
const SCAN_PIXELS = 12e6;       // the outline is looked for on at most this many pixels

/** { type, width, height, orientation } from a picture's own bytes (PNG, JPG or WebP). */
function imageInfo(b) {
  if (!b || b.length < 30) throw new Error('the picture is empty');
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), orientation: 1 };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), orientation: 1 };
    if (kind === 'VP8 ') return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, orientation: 1 };
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { type: 'image/webp', width: 1 + (n & 0x3fff), height: 1 + ((n >> 14) & 0x3fff), orientation: 1 }; }
    throw new Error('this WebP picture could not be read');
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let orientation = 1, i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      const size = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.toString('latin1', i + 4, i + 8) === 'Exif') orientation = exifOrientation(b.subarray(i + 10, i + 2 + size)) || 1;
      // The frame header carries the size (the markers 0xC4, 0xC8 and 0xCC are tables, not frames).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), orientation };
      i += 2 + size;
    }
    throw new Error('this JPG picture could not be read');
  }
  throw new Error('the picture has to be a PNG, JPG or WebP');
}

/** The EXIF "which way is up" number (1-8) of a camera JPG, or null. */
function exifOrientation(tiff) {
  try {
    const le = tiff.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const dir = u32(4);
    const n = u16(dir);
    for (let k = 0; k < n; k++) {
      const e = dir + 2 + k * 12;
      if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : null; }
    }
  } catch { /* no readable EXIF */ }
  return null;
}

const href = (bytes, type) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

/**
 * An SVG <g> that draws the picture upright at 0,0 in its own pixels, and the
 * upright size. A phone photo can be stored on its side with a note saying
 * which way is up; a browser follows the note, so this does too.
 */
function upright(bytes, info) {
  const { width: w, height: h, orientation: o } = info;
  const img = `<image width="${w}" height="${h}" xlink:href="${href(bytes, info.type)}"/>`;
  const turn = { 3: `translate(${w},${h}) rotate(180)`, 6: `translate(${h},0) rotate(90)`, 8: `translate(0,${w}) rotate(-90)`,
    2: `translate(${w},0) scale(-1,1)`, 4: `translate(0,${h}) scale(1,-1)`, 5: 'rotate(90) scale(1,-1)', 7: `translate(${h},${w}) rotate(90) scale(-1,1)` }[o];
  const swap = o >= 5 && o <= 8;
  return { g: turn ? `<g transform="${turn}">${img}</g>` : img, width: swap ? h : w, height: swap ? w : h };
}

const svgOpen = (w, h, box) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="${box || `0 0 ${w} ${h}`}">`;

/** Where the player is in the picture: the box around every pixel that is more than a tenth opaque. */
function outline(pixels, width, height) {
  let minX = width, maxX = -1, minY = height, maxY = -1, hasAlpha = false;
  for (let y = 0; y < height; y++) {
    let p = y * width * 4 + 3;
    for (let x = 0; x < width; x++, p += 4) {
      const a = pixels[p];
      if (a < 250) hasAlpha = true;
      if (a > 25) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  return { hasAlpha, found: maxX > minX && maxY > minY, minX, maxX, minY, maxY };
}

/** Where the picture goes on the card, from the panel's two rules. */
function placement({ width, height, box }) {
  if (box) {
    const sw = box.maxX - box.minX + 1, sh = box.maxY - box.minY + 1;
    const scale = SUBJECT_H / sh;
    const dw = sw * scale;
    return { cutout: true, source: { x: box.minX, y: box.minY, width: sw, height: sh }, x: (CARD_W - dw) / 2, y: CARD_H - BOTTOM_GAP - SUBJECT_H, width: dw, height: SUBJECT_H };
  }
  const scale = Math.min(CARD_W / width, (CARD_H - BOTTOM_GAP * 2) / height);
  const dw = width * scale, dh = height * scale;
  return { cutout: false, source: { x: 0, y: 0, width, height }, x: (CARD_W - dw) / 2, y: CARD_H - BOTTOM_GAP - dh, width: dw, height: dh };
}

/**
 * The card photo from a picture → { bytes (JPG 661x1100), type, cutout, note }.
 */
async function renderPlayerPhoto(input, { quality = 88 } = {}) {
  const bytes = Buffer.from(input || []);
  if (bytes.length > MAX_BYTES) throw new Error('the picture is too heavy (over 12 MB); send a smaller one');
  const info = imageInfo(bytes);
  if (!(info.width > 0 && info.height > 0)) throw new Error('the picture has no size');
  if (info.width < 200 || info.height < 300) throw new Error(`the picture is too small (${info.width}x${info.height}); a card needs a player at least a few hundred pixels tall`);
  const { Resvg } = await resvgModule();
  const up = upright(bytes, info);
  const opts = { font: { loadSystemFonts: false } };

  // 1. Look for transparency and the player's outline.
  const k = Math.min(1, Math.sqrt(SCAN_PIXELS / (up.width * up.height)));
  const sw = Math.max(1, Math.round(up.width * k)), sh = Math.max(1, Math.round(up.height * k));
  const scan = new Resvg(`${svgOpen(sw, sh, `0 0 ${up.width} ${up.height}`)}${up.g}</svg>`, opts).render();
  const o = outline(scan.pixels, scan.width, scan.height);
  const fx = up.width / scan.width, fy = up.height / scan.height;
  const box = o.hasAlpha && o.found ? { minX: o.minX * fx, maxX: (o.maxX + 1) * fx - 1, minY: o.minY * fy, maxY: (o.maxY + 1) * fy - 1 } : null;
  if (o.hasAlpha && !o.found) throw new Error(info.type === 'image/webp' ? 'this WebP picture could not be opened; send it as a PNG or JPG' : 'the picture is completely transparent');

  // 2. Draw the card: the green, then the player (only his box, as the panel does).
  const pl = placement({ width: up.width, height: up.height, box });
  const s = pl.source;
  const svg = `${svgOpen(CARD_W, CARD_H)}<rect width="${CARD_W}" height="${CARD_H}" fill="rgb(${CARD_BG.join(',')})"/>`
    + `<svg x="${pl.x}" y="${pl.y}" width="${pl.width}" height="${pl.height}" viewBox="${s.x} ${s.y} ${s.width} ${s.height}" preserveAspectRatio="none">${up.g}</svg></svg>`;
  const img = new Resvg(svg, { ...opts, fitTo: { mode: 'width', value: CARD_W } }).render();
  const out = require('jpeg-js').encode({ data: Buffer.from(img.pixels), width: img.width, height: img.height }, quality).data;
  const wide = pl.width > CARD_W + 1;
  return {
    bytes: Buffer.from(out), type: 'image/jpeg', width: img.width, height: img.height, cutout: pl.cutout,
    note: !pl.cutout ? 'This picture has no transparent background, so it sits on the card as a rectangle with its own background. The cards on the site are players cut out of their background (a PNG with a transparent background).'
      : wide ? 'The player is wider than the card at this height (arms or a ball stretched out), so the sides are cropped.' : '',
  };
}

module.exports = { renderPlayerPhoto, imageInfo, outline, placement, exifOrientation, CARD_W, CARD_H, SUBJECT_H, BOTTOM_GAP, CARD_BG };
