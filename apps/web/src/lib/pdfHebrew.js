// Hebrew in PDFs. jsPDF ships Latin-1 fonts only, so two things are needed
// for a Hebrew name or note to come out readable:
//   1. an embedded font with Hebrew glyphs (Heebo, self-hosted, ~44 KB each)
//   2. visual reordering: PDF text is laid out left to right, so a logical
//      string has to be turned into display order — Hebrew runs reversed,
//      numbers and Latin kept left-to-right, brackets mirrored.
// jsPDF has a bidi engine of its own, but it only touches mixed lines and
// reverses Hebrew runs in them regardless of what it was given, which is what
// garbled "Gold A&S · סוכנות כדורגל" and "19 באוקטובר 2010": it undid the
// reordering done here. The wrapper below therefore passes every text()
// call through with the engine switched off (isInputVisual + isOutputVisual
// both true make it a no-op) and does the reordering itself.
// `installHebrew(doc, { rtl })` registers the font and wraps doc.text so
// every call site gets both for free; text without Hebrew is untouched.

const HE = /[֐-׿]/;
export const hasHebrew = (s) => HE.test(String(s ?? ''));

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
const LATIN = /[A-Za-zÀ-ɏ]/;
const DIGIT = /[0-9]/;

// A compact Unicode-bidi pass (the parts that matter for a CV: W7, N1/N2,
// L2 and bracket mirroring). `rtl` fixes the paragraph direction; when it is
// undefined the first strong letter decides.
export function bidiVisual(s, { rtl } = {}) {
  const str = String(s ?? '');
  if (!hasHebrew(str)) return str;
  const chars = Array.from(str);
  const types = chars.map((c) => (HE.test(c) ? 'R' : LATIN.test(c) ? 'L' : DIGIT.test(c) ? 'EN' : 'N'));
  const para = rtl === undefined ? (types.find((t) => t === 'R' || t === 'L') === 'L' ? 'L' : 'R') : rtl ? 'R' : 'L';

  // W4: a single separator between two digits is part of the number
  // ("2025/26", "1.85", "19:30") and must not split it.
  for (let i = 1; i < types.length - 1; i++) {
    if (types[i] === 'N' && /[/.,:+\-]/.test(chars[i]) && types[i - 1] === 'EN' && types[i + 1] === 'EN') types[i] = 'EN';
  }
  // W7: a number that follows Latin letters belongs to that Latin run ("1st", "U19").
  let lastStrong = para;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'R' || types[i] === 'L') lastStrong = types[i];
    else if (types[i] === 'EN' && lastStrong === 'L') types[i] = 'L';
  }
  // N1/N2: neutrals take the direction of matching neighbours, otherwise the
  // paragraph's. Numbers count as R for this purpose (UAX #9).
  const strongOf = (t) => (t === 'EN' ? 'R' : t);
  for (let i = 0; i < types.length;) {
    if (types[i] !== 'N') { i++; continue; }
    let j = i; while (j < types.length && types[j] === 'N') j++;
    const before = i > 0 ? strongOf(types[i - 1]) : para;
    const after = j < types.length ? strongOf(types[j]) : para;
    const dir = before === after ? before : para;
    for (let k = i; k < j; k++) types[k] = dir;
    i = j;
  }
  const levels = types.map((t) => (para === 'R' ? (t === 'R' ? 1 : 2) : (t === 'L' ? 0 : t === 'R' ? 1 : 2)));
  // Brackets inside right-to-left runs are mirrored.
  const out = chars.map((c, i) => (levels[i] % 2 === 1 && MIRROR[c] ? MIRROR[c] : c));
  // L2: from the highest level down to 1, reverse every run at or above it.
  const max = Math.max(...levels);
  for (let lv = max; lv >= 1; lv--) {
    for (let i = 0; i < out.length;) {
      if (levels[i] < lv) { i++; continue; }
      let j = i; while (j < out.length && levels[j] >= lv) j++;
      const seg = out.slice(i, j).reverse();
      for (let k = i; k < j; k++) out[k] = seg[k - i];
      i = j;
    }
  }
  return out.join('');
}

// Register Heebo on the document and wrap `text` / `splitTextToSize` so
// Hebrew is measured and drawn with it. `rtl: true` lays every Hebrew line
// out right-to-left (the Hebrew CV); otherwise the first letter decides.
// Returns true when the font loaded.
export async function installHebrew(doc, { rtl } = {}) {
  let ok = false;
  try {
    const { HEEBO_REGULAR, HEEBO_BOLD } = await import('./heeboFont');
    doc.addFileToVFS('Heebo-400.ttf', HEEBO_REGULAR);
    doc.addFileToVFS('Heebo-700.ttf', HEEBO_BOLD);
    doc.addFont('Heebo-400.ttf', 'Heebo', 'normal');
    doc.addFont('Heebo-700.ttf', 'Heebo', 'bold');
    ok = true;
  } catch { ok = false; }

  const withHebrewFont = (fn) => (text, x, y, options, ...rest) => {
    const list = Array.isArray(text) ? text : [text];
    if (!list.some(hasHebrew)) return fn(text, x, y, options, ...rest);
    const visual = list.map((t) => bidiVisual(t, { rtl }));
    const arg = Array.isArray(text) ? visual : visual[0];
    // Already in display order: keep jsPDF's own bidi pass out of it.
    const opts = { ...(options && typeof options === 'object' ? options : {}), isInputVisual: true, isOutputVisual: true };
    if (!ok) return fn(arg, x, y, opts, ...rest);
    const { fontName, fontStyle } = doc.getFont();
    doc.setFont('Heebo', /bold|medium/.test(fontStyle) ? 'bold' : 'normal');
    try { return fn(arg, x, y, opts, ...rest); } finally { doc.setFont(fontName, fontStyle); }
  };
  const origText = doc.text.bind(doc);
  doc.text = withHebrewFont(origText);
  const origSplit = doc.splitTextToSize.bind(doc);
  // Split in logical order (so words stay whole), then let text() reorder.
  doc.splitTextToSize = (text, ...rest) => {
    if (!hasHebrew(text) || !ok) return origSplit(text, ...rest);
    const { fontName, fontStyle } = doc.getFont();
    doc.setFont('Heebo', /bold|medium/.test(fontStyle) ? 'bold' : 'normal');
    try { return origSplit(text, ...rest); } finally { doc.setFont(fontName, fontStyle); }
  };
  return ok;
}

// Keep printable Latin-1 and Hebrew; drop emoji and anything else the fonts
// can't draw.
export const pdfSafe = (s) => String(s ?? '').replace(/[^\x20-\xFF֐-׿]/g, '').replace(/\s+/g, ' ').trim();
