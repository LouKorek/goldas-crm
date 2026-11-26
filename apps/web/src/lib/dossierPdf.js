// The research dossier Golda prepares ("תחקיר על…"): a few A4 pages on the
// agency's stationery (the CV's masthead, colours and fonts), in Hebrew, right
// to left. Summary, profile, numbers, contract, a value estimate with the
// comparables it rests on, the decision makers, the risks, the numbered
// sources and what could not be verified.
//
// The page prints only what it is given: the dossier as cleanDossier
// (netlify/functions/lib/golda-research.js) leaves it. Every claim from the
// web there already carries the numbers of its sources, and they are printed
// after it as [n]; what the CRM holds is printed under its own tag; a claim
// with no source is in the "not verified" list and nowhere else. When the
// contract part is restricted, one line says so and nothing of it is drawn.
//
// Built on the server (netlify/functions/lib/golda-pdf.js); there is no
// browser in it.

import { BRAND, useFonts } from './playerCv';
import { installHebrew, pdfSafe, hasHebrew } from './pdfHebrew';

const { DARK, CREST, GOLD, GOLD_DARK, INK, MUTED, RULE } = BRAND;

const L = {
  agency: 'Gold A&S  ·  סוכנות כדורגל', title: 'תחקיר עומק', running: 'Gold A&S  ·  תחקיר עומק',
  kind: { player: 'שחקן', club: 'מועדון', person: 'איש מקצוע' },
  summary: 'תקציר', profile: 'פרופיל', stats: 'נתונים', contract: 'חוזה וכספים', value: 'הערכת שווי',
  people: 'מקבלי החלטות', risks: 'סיכונים', sources: 'מקורות', notVerified: 'לא מאומת',
  own: 'מהנתונים שלנו (CRM)', web: 'מהרשת, עם מקור',
  none: 'לא נמצאו ממצאים עם מקור.',
  restricted: 'החלק הזה מוגבל: פרטי חוזה וכספים פתוחים למנהלי המערכת בלבד.',
  estimate: 'הערכה', estimateOnly: 'הערכה בלבד, לא מחיר. היא נשענת על ההשוואות שלמטה.',
  noEstimate: 'אין הערכת שווי: לא נמצאו מספיק השוואות עם מקור כדי לתת טווח.',
  comparables: 'ההשוואות', basis: 'על מה היא נשענת',
  notVerifiedIntro: 'מה שעלה בתחקיר בלי מקור שאפשר להצביע עליו. לא לקחת כעובדה לפני בדיקה.',
  noSources: 'אין מקורות: שום ממצא מהרשת לא נכנס לתחקיר.',
  partial: { cost: 'התחקיר חלקי: הוא נעצר בתקרת העלות של תחקיר אחד.', time: 'התחקיר חלקי: הוא נעצר אחרי עשר דקות.', cap: 'התחקיר חלקי: הוא נעצר בתקרת העלות היומית.' },
  made: (date) => `הופק ב-${date}`, cost: (usd) => `עלות ההפקה: ${usd} דולר`, internal: 'לשימוש פנימי',
  page: (n, of) => `עמוד ${n} מתוך ${of}`,
};

// Letters outside Latin-1 that a name may carry and the fonts cannot draw.
const LETTERS = { ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i', İ: 'I', œ: 'oe', Œ: 'OE', ș: 's', Ș: 'S', ț: 't', Ț: 'T', ħ: 'h', Ħ: 'H' };
/**
 * Text as the embedded fonts can draw it: Latin-1 and Hebrew. Currency signs
 * become words, typographic quotes and dashes their plain forms, and a Latin
 * letter with a mark the font lacks ("Š", "ć") keeps its base letter instead
 * of disappearing.
 */
export function dossierSafe(s) {
  const plain = String(s ?? '')
    .replace(/€\s?(\d[\d.,]*)/g, '$1 EUR').replace(/€/g, ' EUR ').replace(/₪/g, ' ש"ח ').replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/[•‣◦]/g, '-');
  let out = '';
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    if (code <= 0xFF || (code >= 0x0590 && code <= 0x05FF)) { out += ch; continue; }
    out += LETTERS[ch] !== undefined ? LETTERS[ch] : ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  }
  return pdfSafe(out);
}

const dateHe = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : ''; };
const refText = (refs) => (Array.isArray(refs) && refs.length ? refs.map((n) => `[${n}]`).join(' ') : '');
/** An address as it is printed and linked: plain ASCII, whatever letters its path had. */
const href = (u) => { try { return new URL(String(u)).href; } catch { return ''; } };

/** The file name: what it is, the subject, the agency. Hebrew stays; what a file name cannot hold goes. */
export function dossierFilename(subject) {
  const who = String(subject || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Gold A&S';
  return `תחקיר - ${who} - Gold A&S.pdf`;
}

/**
 * The dossier itself.
 *   dossier  { subject, kind, summary [{ text, refs }], profile, stats [{ label, value, refs }],
 *              contract { restricted, items }, value null | { text, basis, comparables [{ name, detail, refs }] },
 *              decisionMakers [{ name, role, note, refs }], risks, sources [{ n, url }], notVerified [{ text, why }],
 *              own { profile, stats, contract, decisionMakers } rows of { label, value },
 *              meta { madeOn 'YYYY-MM-DD', costUsd, stoppedBy } }
 *   logo     a data: URL or null
 * Returns { doc, filename, pages }.
 */
export async function buildDossier(jsPDF, fonts, dossier, { logo = null } = {}) {
  const d = dossier || {};
  const own = d.own || {};
  const meta = d.meta || {};
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const FAM = useFonts(doc, fonts);
  const hebrew = await installHebrew(doc, { rtl: true });
  const MED = FAM === 'Poppins' ? 'medium' : 'bold';
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const CW = W - M * 2;
  const FOOT = 38;                 // the footer band on every page
  const BOTTOM = H - FOOT - 26;    // nothing of the body is drawn below this
  const TOP = 46 + 38;             // where the body starts on a page after the first
  // Everything is laid out from the reading start (the right edge) and mirrored here.
  const X = (x) => W - x;
  // Right-aligned text is measured with the letter spacing after its last
  // letter too, so a spaced line would sit that much inside the margin.
  const write = (text, x, y, opts = {}) => doc.text(text, X(x) + (opts.charSpace || 0), y, { align: 'right', ...opts });
  /** The width of a line as it will be drawn: Hebrew is drawn in the Hebrew face, so it is measured in it. */
  const widthOf = (text) => {
    if (!hebrew || !hasHebrew(text)) return doc.getTextWidth(text);
    const { fontName, fontStyle } = doc.getFont();
    doc.setFont('Heebo', /bold|medium/.test(fontStyle) ? 'bold' : 'normal');
    try { return doc.getTextWidth(text); } finally { doc.setFont(fontName, fontStyle); }
  };
  const label = (text, x, y, colour = GOLD_DARK, size = 7.6) => {
    doc.setFont(FAM, MED);
    doc.setFontSize(size);
    doc.setTextColor(...colour);
    write(String(text).toUpperCase(), x, y, { charSpace: 1.15 });
  };
  const subject = dossierSafe(d.subject) || L.title;

  let y = 0;
  const runningHead = () => {
    doc.setFillColor(...DARK);
    doc.rect(0, 0, W, 44, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, 44, W, 2, 'F');
    label(L.running, M, 27, GOLD, 7.6);
    doc.setFont(FAM, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(doc.splitTextToSize(subject, CW / 2)[0] || '', M, 27, { align: 'left' });
  };
  const newPage = () => { doc.addPage(); runningHead(); y = TOP; };
  /** Room for `h` more points on this page, or a new page. */
  const ensure = (h) => { if (y + h > BOTTOM) newPage(); };

  const section = (text, need = 64) => {
    y += 22;
    ensure(need);                  // a heading never stays alone at the foot of a page
    label(text, M, y);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(1.2);
    doc.line(M, y + 6, W - M, y + 6);
    y += 26;
  };
  /**
   * Wrapped text from the reading start + `x`, a line at a time so a page can
   * end between two lines. `refs` (the numbers of a claim's sources) are drawn
   * after the last word as a piece of their own: put into the sentence, a
   * number that follows a Latin name would be laid out as part of that name.
   */
  const lines = (text, { x = M, width = CW, size = 10.5, lh = 15, style = 'normal', colour = INK, mark = null, refs = '' } = {}) => {
    doc.setFont(FAM, style);
    doc.setFontSize(size);
    const rows = doc.splitTextToSize(text, width);
    const GAP = 5;
    let after = null;                       // where the source numbers go: on the last line, or on one of their own
    if (refs) {
      const last = widthOf(rows[rows.length - 1] || '');
      doc.setFont(FAM, MED);
      doc.setFontSize(size - 1.5);
      const w = doc.getTextWidth(refs);
      if (last + GAP + w <= width) after = last + GAP; else { rows.push(''); after = 0; }
    }
    rows.forEach((row, i) => {
      ensure(lh);
      if (i === 0 && mark) mark(y);
      doc.setFont(FAM, style);
      doc.setFontSize(size);
      doc.setTextColor(...colour);
      if (row) write(row, x, y);
      if (after !== null && i === rows.length - 1) {
        doc.setFont(FAM, MED);
        doc.setFontSize(size - 1.5);
        doc.setTextColor(...GOLD_DARK);
        write(refs, x + after, y);
      }
      y += lh;
    });
    return rows.length;
  };
  const note = (text, colour = MUTED) => { lines(text, { size: 10, lh: 14.5, colour }); y += 3; };
  const square = (colour, filled = true) => (yy) => {
    doc.setFillColor(...colour);
    doc.setDrawColor(...colour);
    doc.setLineWidth(0.8);
    doc.rect(W - M - 5, yy - 6.5, 5, 5, filled ? 'F' : 'S');
  };
  /** One claim: a gold square, the sentence, the numbers of its sources. */
  const bullet = (text, refs) => { lines(dossierSafe(text), { x: M + 16, width: CW - 18, mark: square(GOLD), refs: refText(refs) }); y += 4; };
  /** A row of two columns: what it is, and its value (with the numbers of its sources). */
  const LABEL_W = 132;
  const pair = (name, value, refs, { strong = false } = {}) => {
    const k = dossierSafe(name), v = dossierSafe(value);
    if (!k || !v) return;
    doc.setFont(FAM, MED);
    doc.setFontSize(9);
    const keys = doc.splitTextToSize(k, LABEL_W - 12).slice(0, 3);
    doc.setFont(FAM, 'normal');
    doc.setFontSize(10.5);
    const vals = doc.splitTextToSize(v, CW - LABEL_W);
    const rows = Math.max(keys.length, vals.length);
    ensure(Math.min(rows + 1, 4) * 14.5 + 8);
    const top = y, page = doc.getNumberOfPages();
    doc.setFont(FAM, MED);
    doc.setFontSize(9);
    doc.setTextColor(...(strong ? INK : MUTED));
    keys.forEach((row, i) => write(row, M, top + i * 13));
    lines(v, { x: M + LABEL_W, width: CW - LABEL_W, lh: 14.5, refs: refText(refs) });
    if (doc.getNumberOfPages() === page) y = Math.max(y, top + keys.length * 13);   // a long value may have gone on to the next page
    y += 2;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, y - 7, W - M, y - 7);
    y += 7;
  };
  /** The tag over a group of rows: where they come from. */
  const tag = (text, colour) => {
    ensure(40);
    doc.setFont(FAM, MED);
    doc.setFontSize(8);
    const w = widthOf(text) + 16;
    doc.setFillColor(...colour);
    doc.roundedRect(W - M - w, y - 10, w, 15, 2, 2, 'F');
    doc.setTextColor(255, 255, 255);
    write(text, M + 8, y + 0.5);
    y += 20;
  };
  /** What the CRM holds, under its own tag; returns true when it drew anything. */
  const ownRows = (rows) => {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && dossierSafe(r.label) && dossierSafe(r.value));
    if (!list.length) return false;
    tag(L.own, DARK);
    for (const r of list) pair(r.label, r.value);
    y += 4;
    return true;
  };
  const arr = (v) => (Array.isArray(v) ? v : []);

  // ── Masthead ───────────────────────────────────────────────────
  const BAND = 132;
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, BAND, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, BAND, W, 3, 'F');
  let textX = M;
  if (logo) {
    try {
      const p = doc.getImageProperties(logo);
      const h = 56;
      const w = Math.min((p.width / p.height) * h, 112);
      const lx = W - M - w, ly = (BAND - h) / 2 - 2;
      doc.setFillColor(...CREST);
      doc.roundedRect(lx - 5, ly - 5, w + 10, h + 10, 3, 3, 'F');
      doc.setDrawColor(...GOLD_DARK);
      doc.setLineWidth(0.8);
      doc.roundedRect(lx - 5, ly - 5, w + 10, h + 10, 3, 3, 'S');
      doc.addImage(logo, 'PNG', lx, ly, w, h);
      textX = M + w + 28;
    } catch { /* the logo is decoration; never block the dossier */ }
  }
  label(L.agency, textX, 44, GOLD, 8);
  doc.setFont(FAM, 'bold');
  doc.setFontSize(26);
  doc.setTextColor(255, 255, 255);
  write(doc.splitTextToSize(subject, W - M - textX)[0] || L.title, textX, 80);
  doc.setFont(FAM, 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...GOLD);
  const strap = [L.title, L.kind[d.kind] || '', dateHe(meta.madeOn)].filter(Boolean).join('  ·  ');
  write(strap, textX, 104, { charSpace: 0.3 });
  y = BAND + 16;

  // ── Summary ────────────────────────────────────────────────────
  section(L.summary);
  if (arr(d.summary).length) for (const s of d.summary) bullet(s.text, s.refs);
  else note(L.none);
  if (meta.stoppedBy && L.partial[meta.stoppedBy]) note(L.partial[meta.stoppedBy], GOLD_DARK);

  // ── Profile ────────────────────────────────────────────────────
  section(L.profile);
  {
    const had = ownRows(own.profile);
    if (arr(d.profile).length) {
      if (had) tag(L.web, GOLD_DARK);
      for (const c of d.profile) bullet(c.text, c.refs);
    } else if (!had) note(L.none);
  }

  // ── Numbers ────────────────────────────────────────────────────
  section(L.stats);
  {
    const had = ownRows(own.stats);
    if (arr(d.stats).length) {
      if (had) tag(L.web, GOLD_DARK);
      for (const s of d.stats) pair(s.label, s.value, s.refs);
    } else if (!had) note(L.none);
  }

  // ── Contract and money ─────────────────────────────────────────
  section(L.contract);
  const contract = d.contract || { restricted: true, items: [] };
  if (contract.restricted) note(L.restricted, INK);
  else {
    const had = ownRows(own.contract);
    if (arr(contract.items).length) {
      if (had) tag(L.web, GOLD_DARK);
      for (const c of contract.items) bullet(c.text, c.refs);
    } else if (!had) note(L.none);
  }

  // ── The value estimate ─────────────────────────────────────────
  const valued = Boolean(d.value && arr(d.value.comparables).length);
  section(L.value, valued ? 170 : 64);       // the range, its "estimate only" line and what it rests on stay on one page
  if (valued) {
    const top = y - 12;
    lines(`${L.estimate}: ${dossierSafe(d.value.text)}`, { x: M + 14, width: CW - 16, size: 15, lh: 21, style: 'bold' });
    lines(L.estimateOnly, { x: M + 14, width: CW - 16, size: 9.5, lh: 14, colour: GOLD_DARK });
    doc.setFillColor(...GOLD);
    doc.rect(W - M - 3, top, 3, y - top - 8, 'F');
    y += 6;
    if (dossierSafe(d.value.basis)) pair(L.basis, d.value.basis);
    ensure(50);
    label(L.comparables, M, y + 4, MUTED, 7.2);
    y += 20;
    for (const c of d.value.comparables) bullet([c.name, c.detail].filter(Boolean).join(': '), c.refs);
  } else note(L.noEstimate);

  // ── Decision makers ────────────────────────────────────────────
  section(L.people);
  {
    const had = ownRows(own.decisionMakers);
    if (arr(d.decisionMakers).length) {
      if (had) tag(L.web, GOLD_DARK);
      for (const p of d.decisionMakers) pair(p.name, [p.role, p.note].filter(Boolean).join('. '), p.refs, { strong: true });
    } else if (!had) note(L.none);
  }

  // ── Risks ──────────────────────────────────────────────────────
  section(L.risks);
  if (arr(d.risks).length) for (const c of d.risks) bullet(c.text, c.refs);
  else note(L.none);

  // ── Sources ────────────────────────────────────────────────────
  section(L.sources);
  if (!arr(d.sources).length) note(L.noSources);
  for (const s of arr(d.sources)) {
    const url = href(s.url);
    if (!url) continue;
    doc.setFont(FAM, 'normal');
    doc.setFontSize(8.5);
    // An address is one long word: it is cut to the width, two lines at most.
    let rows = doc.splitTextToSize(url, CW - 34);
    if (rows.length > 2) rows = [rows[0], `${String(rows[1]).slice(0, -3)}...`];
    ensure(rows.length * 12 + 4);
    doc.setFont(FAM, MED);
    doc.setFontSize(8.5);
    doc.setTextColor(...GOLD_DARK);
    write(`[${s.n}]`, M, y);
    doc.setFont(FAM, 'normal');
    doc.setTextColor(...INK);
    rows.forEach((row, i) => {
      write(row, M + 30, y + i * 12);
      const w = doc.getTextWidth(row);
      doc.link(W - M - 30 - w, y + i * 12 - 9, w, 12, { url });
    });
    y += rows.length * 12 + 4;
  }

  // ── Not verified ───────────────────────────────────────────────
  if (arr(d.notVerified).length) {
    section(L.notVerified);
    note(L.notVerifiedIntro, GOLD_DARK);
    for (const u of d.notVerified) {
      const why = dossierSafe(u.why);
      lines(`${dossierSafe(u.text)}${why ? ` (${why})` : ''}`, { x: M + 16, width: CW - 18, size: 10, lh: 14.5, colour: MUTED, mark: square(MUTED, false) });
      y += 4;
    }
  }

  // ── The footer of every page: when it was made, what it cost, the page ──
  const pages = doc.getNumberOfPages();
  const cost = Number(meta.costUsd);
  const foot = [dateHe(meta.madeOn) ? L.made(dateHe(meta.madeOn)) : '', Number.isFinite(cost) && cost >= 0 ? L.cost(cost.toFixed(2)) : '', L.internal].filter(Boolean).join('  ·  ');
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFillColor(...DARK);
    doc.rect(0, H - FOOT, W, FOOT, 'F');
    doc.setFillColor(...GOLD);
    doc.rect(0, H - FOOT - 2, W, 2, 'F');
    doc.setFont(FAM, 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...GOLD);
    write(foot, M, H - 15);
    doc.setTextColor(255, 255, 255);
    doc.text(L.page(i, pages), M, H - 15, { align: 'left' });
  }

  return { doc, filename: dossierFilename(d.subject), pages };
}
