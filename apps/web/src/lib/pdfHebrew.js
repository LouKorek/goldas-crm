// Hebrew in PDFs. jsPDF ships Latin-1 fonts only and has no bidi engine, so
// two things are needed for a Hebrew name or note to come out readable:
//   1. an embedded font with Hebrew glyphs (Heebo, self-hosted, ~44 KB each)
//   2. visual reordering: PDF text is laid out left to right, so Hebrew runs
//      are reversed character by character and the runs of a Hebrew-first
//      line are placed right to left.
// `installHebrew(doc)` registers the font and wraps doc.text so every call
// site gets both for free; non-Hebrew text is untouched.

const HE = /[֐-׿]/;
export const hasHebrew = (s) => HE.test(String(s ?? ''));

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
const reverseRun = (run) => Array.from(run).reverse().map((c) => MIRROR[c] || c).join('');

// Turn a logical-order string into the visual order a left-to-right layout
// engine must draw. Runs are: Hebrew letters (with the spaces and
// punctuation between them), or anything else (Latin, digits).
export function bidiVisual(s) {
  const str = String(s ?? '');
  if (!hasHebrew(str)) return str;
  const runs = [];
  let cur = '', curHe = null;
  for (const ch of str) {
    const isHe = HE.test(ch);
    const neutral = /[\s.,:;·\-–—()[\]{}'"/|!?]/.test(ch);
    if (cur === '') { cur = ch; curHe = isHe ? true : neutral ? null : false; continue; }
    if (neutral) { cur += ch; continue; }
    if (curHe === null) { curHe = isHe; cur += ch; continue; }
    if (isHe === curHe) { cur += ch; continue; }
    runs.push({ he: curHe, text: cur }); cur = ch; curHe = isHe;
  }
  if (cur) runs.push({ he: curHe === null ? false : curHe, text: cur });
  // Neutral tails (spaces/punctuation) at the end of a Hebrew run belong to
  // the line, not the run: trim and re-attach so they don't jump sides.
  const firstStrong = runs.find((r) => /[^\s.,:;·\-–—()[\]{}'"/|!?]/.test(r.text));
  const rtlLine = !!firstStrong?.he;
  const out = runs.map((r) => (r.he ? reverseRun(r.text) : r.text));
  return rtlLine ? out.reverse().join('') : out.join('');
}

// Register Heebo on the document and wrap `text` / `splitTextToSize` so
// Hebrew is measured and drawn with it. Returns true when the font loaded.
export async function installHebrew(doc) {
  let ok = false;
  try {
    const { HEEBO_REGULAR, HEEBO_BOLD } = await import('./heeboFont');
    doc.addFileToVFS('Heebo-400.ttf', HEEBO_REGULAR);
    doc.addFileToVFS('Heebo-700.ttf', HEEBO_BOLD);
    doc.addFont('Heebo-400.ttf', 'Heebo', 'normal');
    doc.addFont('Heebo-700.ttf', 'Heebo', 'bold');
    ok = true;
  } catch { ok = false; }

  const withHebrewFont = (fn) => (text, ...rest) => {
    const list = Array.isArray(text) ? text : [text];
    if (!list.some(hasHebrew)) return fn(text, ...rest);
    const visual = list.map(bidiVisual);
    const arg = Array.isArray(text) ? visual : visual[0];
    if (!ok) return fn(arg, ...rest);
    const { fontName, fontStyle } = doc.getFont();
    doc.setFont('Heebo', /bold|medium/.test(fontStyle) ? 'bold' : 'normal');
    try { return fn(arg, ...rest); } finally { doc.setFont(fontName, fontStyle); }
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
