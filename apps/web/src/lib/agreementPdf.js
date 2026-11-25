// The signed representation agreement as a PDF: the agreement's own text,
// the signatures, and a closing "signing record" (who signed, when in Israel
// time, from a phone or a computer, the SHA-256 of the text exactly as it was
// shown, the link and agreement ids). On the agency's stationery (the CV's
// colours and fonts), Hebrew right to left, English left to right.
//
// Built on the server only (netlify/functions/lib/agreements.js) right after
// the signature is taken, and stored in the player's file. The text it prints
// is the frozen text of the agreement, word for word: nothing is filled in or
// changed here, so what was hashed is what is printed.

import { agreementBlocks } from '@goldas/domain';
import { BRAND, useFonts } from './playerCv';
import { installHebrew, pdfSafe } from './pdfHebrew';

const { DARK, CREST, GOLD, GOLD_DARK, INK, MUTED, RULE } = BRAND;

const LABELS = {
  he: {
    agency: 'Gold A&S  ·  סוכנות כדורגל', title: 'הסכם ייצוג', signatures: 'חתימות', record: 'רשומת החתימה',
    agencySide: 'הסוכנות', agencyBy: (name) => `נחתם בשם הסוכנות על ידי ${name}`, agencyNoSig: 'ללא חתימה מצוירת של הסוכנות',
    player: 'השחקן', guardian: 'ההורה או האפוטרופוס', relation: { father: 'אב', mother: 'אם', guardian: 'אפוטרופוס' },
    name: 'שם', id: 'מספר זהות / דרכון', at: 'נחתם', from: 'מכשיר', phone: 'טלפון', desktop: 'מחשב',
    agreementId: 'מזהה ההסכם', linkId: 'מזהה הקישור', hash: 'SHA-256 של הטקסט שהוצג', version: 'גרסת התבנית',
    created: 'ההסכם נוצר', signedAt: 'מועד החתימה (שעון ישראל)', signers: 'החותמים',
    hashNote: 'טביעת האצבע (SHA-256) מחושבת על נוסח ההסכם בדיוק כפי שהוצג לחותם בעמוד החתימה, והוא הנוסח המודפס בראש המסמך הזה.',
    page: (n, of) => `עמוד ${n} מתוך ${of}`,
    footer: 'gold-as.com  ·  לו קורק  ·  סוכן מורשה FIFA',
  },
  en: {
    agency: 'Gold A&S  ·  Football Agency', title: 'Representation agreement', signatures: 'Signatures', record: 'Signing record',
    agencySide: 'The agency', agencyBy: (name) => `Signed for the agency by ${name}`, agencyNoSig: 'No drawn signature of the agency',
    player: 'The player', guardian: 'Parent or guardian', relation: { father: 'Father', mother: 'Mother', guardian: 'Guardian' },
    name: 'Name', id: 'ID / passport number', at: 'Signed', from: 'Device', phone: 'Phone', desktop: 'Computer',
    agreementId: 'Agreement id', linkId: 'Link id', hash: 'SHA-256 of the text shown', version: 'Template version',
    created: 'Agreement made', signedAt: 'Signed at (Israel time)', signers: 'Signers',
    hashNote: 'The fingerprint (SHA-256) is of the agreement text exactly as it was shown to the signer on the signing page, which is the text printed at the top of this document.',
    page: (n, of) => `Page ${n} of ${of}`,
    footer: 'gold-as.com  ·  Lou Korek  ·  FIFA Licensed Agent',
  },
};

// The embedded Latin face is Latin-1 only: the dashes and the ellipsis become their plain forms first.
const safe = (s) => pdfSafe(String(s ?? '').replace(/[–—]/g, '-').replace(/…/g, '...'));
// One line of the agreement as printed: the same cleaning, but spaces inside the line are kept as they are.
const safeLine = (s) => String(s ?? '').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\xFF֐-׿]/g, '').trim();

/** 25/11/2026 14:32 in Israel time. */
export function israelTime(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

/** The file name: the agreement, the player, the day it was signed. */
export function agreementFilename(playerName, signedAt, lang = 'he') {
  const who = String(playerName || 'player').replace(/[\\/:*?"<>|]/g, '').trim() || 'player';
  const day = israelTime(signedAt || Date.now()).slice(0, 10).split('/').join('-');
  return `${lang === 'en' ? 'Representation agreement' : 'הסכם ייצוג'} - ${who} - ${day}.pdf`;
}

/**
 * The page, with no browser in it.
 *   a  the agreement: { id, lang, text, playerName, templateVersion, createdAt, createdBy { name },
 *        agencySignature { png, name, at } | null, agencyName, signers [{ role, name, idNumber, relation, png }],
 *        signedAt, signedDevice, shownHash, linkId }
 *   logo  a data: URL or null
 * Returns { doc, filename }.
 */
export async function buildAgreementPdf(jsPDF, fonts, a, { logo = null } = {}) {
  const lang = a.lang === 'en' ? 'en' : 'he';
  const L = LABELS[lang];
  const rtl = lang === 'he';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const FAM = useFonts(doc, fonts);
  await installHebrew(doc, { rtl });
  const MED = FAM === 'Poppins' ? 'medium' : 'bold';
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 52;
  const CW = W - M * 2;
  const BOTTOM = H - 66;
  const X = (x) => (rtl ? W - x : x);
  const ALIGN = rtl ? 'right' : 'left';
  const write = (text, x, y, opts = {}) => doc.text(text, X(x), y, { align: ALIGN, ...opts });
  let y = 0;

  const newPage = () => { doc.addPage(); y = 64; };
  const room = (h) => { if (y + h > BOTTOM) newPage(); };
  const heading = (text, { size = 12.5, before = 18, rule = false } = {}) => {
    room(before + size + 22);
    y += before;
    doc.setFont(FAM, 'bold');
    doc.setFontSize(size);
    doc.setTextColor(...(rule ? GOLD_DARK : INK));
    const lines = doc.splitTextToSize(safe(text), CW);
    write(lines, M, y, { lineHeightFactor: 1.3 });
    y += lines.length * size * 1.3;
    if (rule) {
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1.1);
      doc.line(M, y - size * 0.7, W - M, y - size * 0.7);
      y += 8;
    }
  };
  const paragraph = (text, { size = 10.5, colour = INK, after = 9 } = {}) => {
    doc.setFont(FAM, 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...colour);
    const step = size * 1.45;
    for (const raw of String(text).split('\n')) {
      for (const line of doc.splitTextToSize(safeLine(raw), CW)) {
        room(step);
        write(line, M, y);
        y += step;
      }
    }
    y += after;
  };
  const row = (k, v, { mono = false } = {}) => {
    const key = safe(k);
    // One value may hold several lines (two signers): each is made safe and wrapped on its own.
    const lines = String(v ?? '').split('\n').flatMap((part) => doc.splitTextToSize(mono ? part : safe(part), CW - 150));
    room(lines.length * 13 + 6);
    doc.setFont(FAM, MED);
    doc.setFontSize(8.6);
    doc.setTextColor(...MUTED);
    write(key, M, y);
    doc.setFont(mono ? 'courier' : FAM, 'normal');
    doc.setFontSize(mono ? 8.6 : 9.6);
    doc.setTextColor(...INK);
    write(lines, M + 150, y, { lineHeightFactor: 1.35 });
    y += lines.length * 13 + 5;
  };
  const image = (png, maxW = 190, maxH = 70) => {
    if (!png) return 0;
    try {
      const p = doc.getImageProperties(png);
      const s = Math.min(maxW / p.width, maxH / p.height, 1);
      const w = p.width * s, h = p.height * s;
      room(h + 6);
      doc.addImage(png, 'PNG', rtl ? W - M - w : M, y, w, h);
      y += h + 6;
      return h;
    } catch { return 0; }
  };

  // ── Masthead ───────────────────────────────────────────────────
  const BAND = 104;
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W, BAND, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, BAND, W, 3, 'F');
  let textX = M;
  if (logo) {
    try {
      const p = doc.getImageProperties(logo);
      const h = 46;
      const w = Math.min((p.width / p.height) * h, 96);
      const lx = rtl ? W - M - w : M, ly = (BAND - h) / 2 - 2;
      doc.setFillColor(...CREST);
      doc.roundedRect(lx - 4, ly - 4, w + 8, h + 8, 3, 3, 'F');
      doc.addImage(logo, 'PNG', lx, ly, w, h);
      textX = M + w + 24;
    } catch { /* the logo is decoration */ }
  }
  doc.setFont(FAM, MED);
  doc.setFontSize(8);
  doc.setTextColor(...GOLD);
  write(L.agency, textX, 38);
  doc.setFont(FAM, 'bold');
  doc.setFontSize(21);
  doc.setTextColor(255, 255, 255);
  write(doc.splitTextToSize(`${L.title}${a.playerName ? `  ·  ${safe(a.playerName)}` : ''}`, W - M - textX)[0] || L.title, textX, 70);
  y = BAND + 34;

  // ── The agreement, word for word ───────────────────────────────
  for (const b of agreementBlocks(a.text || '')) {
    if (b.type === 'h') heading(b.text);
    else paragraph(b.text);
  }

  // ── Signatures ─────────────────────────────────────────────────
  heading(L.signatures, { size: 11, before: 22, rule: true });
  const sig = a.agencySignature;
  doc.setFont(FAM, 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
  room(90); write(L.agencySide, M, y); y += 14;
  if (sig && sig.png) image(sig.png);
  paragraph([
    safe(a.agencyName || 'Gold A&S'),
    sig && sig.name ? L.agencyBy(safe(sig.name)) : (a.createdBy?.name ? L.agencyBy(safe(a.createdBy.name)) : ''),
    sig && sig.at ? israelTime(sig.at) : (sig ? '' : L.agencyNoSig),
  ].filter(Boolean).join('\n'), { size: 9.6, colour: MUTED, after: 14 });

  for (const s of a.signers || []) {
    const who = s.role === 'guardian' ? `${L.guardian}${s.relation && L.relation[s.relation] ? ` (${L.relation[s.relation]})` : ''}` : L.player;
    doc.setFont(FAM, 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    room(110); write(who, M, y); y += 14;
    image(s.png);
    paragraph([safe(s.name), `${L.id}: ${safe(s.idNumber)}`, a.signedAt ? `${L.at}: ${israelTime(a.signedAt)}` : ''].filter(Boolean).join('\n'), { size: 9.6, colour: MUTED, after: 14 });
  }

  // ── Signing record ─────────────────────────────────────────────
  // Kept whole on one page: the record reads as one block.
  room(260 + 14 * Math.max(0, (a.signers || []).length - 1));
  heading(L.record, { size: 11, before: 18, rule: true });
  row(L.signers, (a.signers || []).map((s) => `${safe(s.name)} (${s.role === 'guardian' ? L.guardian : L.player}${s.relation && L.relation[s.relation] ? `, ${L.relation[s.relation]}` : ''}) · ${safe(s.idNumber)}`).join('\n'));
  row(L.signedAt, a.signedAt ? israelTime(a.signedAt) : '');
  row(L.from, a.signedDevice === 'phone' ? L.phone : L.desktop);
  const hash = String(a.shownHash || '');
  row(L.hash, `${hash.slice(0, 32)}\n${hash.slice(32)}`, { mono: true });
  row(L.linkId, `${String(a.linkId || '').slice(0, 32)}\n${String(a.linkId || '').slice(32)}`, { mono: true });
  row(L.agreementId, String(a.id || ''), { mono: true });
  row(L.version, String(a.templateVersion || ''));
  row(L.created, [a.createdAt ? israelTime(a.createdAt) : '', a.createdBy?.name ? safe(a.createdBy.name) : ''].filter(Boolean).join('  ·  '));
  y += 4;
  paragraph(L.hashNote, { size: 8.6, colour: MUTED, after: 0 });

  // ── Footer on every page ───────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, H - 44, W - M, H - 44);
    doc.setFont(FAM, 'normal');
    doc.setFontSize(7.8);
    doc.setTextColor(...MUTED);
    write(L.footer, M, H - 28);
    doc.text(L.page(i, pages), X(W - M), H - 28, { align: rtl ? 'left' : 'right' });
  }

  return { doc, filename: agreementFilename(a.playerName, a.signedAt, lang) };
}
