// The monthly report for a represented player and his family: one A4 page on
// the agency's stationery (the CV's masthead, colours and fonts) with his
// month in numbers, the season so far, the month's matches, what the agency
// did and the next step. Hebrew by default, English on request.
//
// The page is what a parent reads, so it carries only what is given to it:
// the facts from monthlyReportFacts (@goldas/domain), which hold no rating,
// match note or watcher, and the two written parts Lou approved. Nothing else
// of the player record is read here but his name and club.
//
// One builder for both sides: the player page downloads it, and Golda builds
// the same page on the server (netlify/functions/lib/golda-pdf.js).

import { monthName } from '@goldas/domain';
import { BRAND, useFonts, loadLogo, seasonLine } from './playerCv';
import { installHebrew, pdfSafe } from './pdfHebrew';

const { DARK, CREST, GOLD, GOLD_DARK, INK, MUTED, RULE } = BRAND;

const LABELS = {
  he: {
    agency: 'Gold A&S  ·  סוכנות כדורגל', title: 'דוח חודשי', player: 'שחקן',
    numbers: 'החודש במספרים', apps: 'משחקים', minutes: 'דקות', goals: 'שערים', assists: 'בישולים',
    soFar: 'עד סוף החודש', matches: 'המשחקים של החודש', date: 'תאריך', match: 'משחק', competition: 'מסגרת',
    min: "דק'", g: 'שערים', a: 'בישולים', more: (n) => `ועוד ${n} משחקים החודש`,
    noMatches: 'החודש לא נרשמו משחקים שלו אצלנו.',
    did: 'מה עשינו החודש', next: 'הצעד הבא', closing: 'תמיד לצדכם,  צוות Gold A&S',
    footer: 'gold-as.com  ·  לו קורק  ·  סוכן מורשה FIFA',
  },
  en: {
    agency: 'Gold A&S  ·  Football Agency', title: 'Monthly report', player: 'Player',
    numbers: 'The month in numbers', apps: 'Matches', minutes: 'Minutes', goals: 'Goals', assists: 'Assists',
    soFar: 'to the end of the month', matches: "This month's matches", date: 'Date', match: 'Match', competition: 'Competition',
    min: 'Min', g: 'Goals', a: 'Assists', more: (n) => `and ${n} more matches this month`,
    noMatches: 'No matches of his were recorded this month.',
    did: 'What we did this month', next: 'The next step', closing: 'Always in your corner,  the Gold A&S team',
    footer: 'gold-as.com  ·  Lou Korek  ·  FIFA Licensed Agent',
  },
};

// The embedded Latin face is Latin-1 only: the en dash and the ellipsis the
// text may carry become their plain forms before anything else is dropped.
const safe = (s) => pdfSafe(String(s ?? '').replace(/[–—]/g, '-').replace(/…/g, '...'));
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A match date as the page prints it: "4/10" on the Hebrew page, "4 Oct" on the English one.
const day = (d, lang) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(d || ''));
  if (!m) return '';
  return lang === 'en' ? `${Number(m[2])} ${SHORT_MONTHS[Number(m[1]) - 1]}` : `${Number(m[2])}/${Number(m[1])}`;
};

/** The file name: the player, the month, the agency. Hebrew stays; what a file name cannot hold goes. */
export function reportFilename(name, month, lang = 'he') {
  const who = String(name || 'player').replace(/[\\/:*?"<>|]/g, '').trim() || 'player';
  return `${who} - ${monthName(month, lang === 'en' ? 'en' : 'he')} - Gold A&S.pdf`;
}

/**
 * Downloads the report in the browser. `report` is
 * { month, matches, monthTotals, season, did, next } (see buildMonthlyReport).
 */
export async function exportMonthlyReport(player, report, { lang = 'he' } = {}) {
  const [{ default: jsPDF }, fonts] = await Promise.all([import('jspdf'), import('./pdfFonts')]);
  const { doc, filename } = await buildMonthlyReport(jsPDF, fonts, player, report, { lang, logo: await loadLogo() });
  doc.save(filename);
}

/**
 * The page itself, with no browser in it.
 *   player  { playerName, currentClub }
 *   report  { month 'YYYY-MM', matches [{ date, title, competition, minutes, goals, assists, played }],
 *             monthTotals { apps, minutes, goals, assists }, season { label, apps, minutes, goals, assists },
 *             did [string], next string }
 *   logo    a data: URL or null
 * Returns { doc, filename }.
 */
export async function buildMonthlyReport(jsPDF, fonts, player, report, { lang = 'he', logo = null } = {}) {
  const L = LABELS[lang === 'en' ? 'en' : 'he'];
  const rtl = lang !== 'en';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const FAM = useFonts(doc, fonts);
  await installHebrew(doc, { rtl });
  const MED = FAM === 'Poppins' ? 'medium' : 'bold';
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 48;
  const CW = W - M * 2;
  const BOTTOM = H - 92;   // nothing is drawn below this but the closing line and the footer
  const X = (x) => (rtl ? W - x : x);
  const ALIGN = rtl ? 'right' : 'left';
  const spaced = (text, space) => (rtl ? -(Array.from(String(text)).length - 1) * space : 0);
  const write = (text, x, y, opts = {}) => doc.text(text, X(x) + spaced(text, opts.charSpace || 0), y, { align: ALIGN, ...opts });
  const label = (text, x, y, colour = GOLD_DARK, size = 7.6) => {
    doc.setFont(FAM, MED);
    doc.setFontSize(size);
    doc.setTextColor(...colour);
    write(String(text).toUpperCase(), x, y, { charSpace: 1.15 });
  };
  const section = (text, y) => {
    label(text, M, y);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(1.2);
    doc.line(M, y + 6, W - M, y + 6);
    return y + 26;
  };
  const r = report || {};
  const month = String(r.month || '');

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
      const lx = rtl ? W - M - w : M, ly = (BAND - h) / 2 - 2;
      doc.setFillColor(...CREST);
      doc.roundedRect(lx - 5, ly - 5, w + 10, h + 10, 3, 3, 'F');
      doc.setDrawColor(...GOLD_DARK);
      doc.setLineWidth(0.8);
      doc.roundedRect(lx - 5, ly - 5, w + 10, h + 10, 3, 3, 'S');
      doc.addImage(logo, 'PNG', lx, ly, w, h);
      textX = M + w + 28;   // measured from the reading start, so the mirror puts it beside the tile
    } catch { /* the logo is decoration; never block the report */ }
  }
  label(L.agency, textX, 44, GOLD, 8);
  doc.setFont(FAM, 'bold');
  doc.setFontSize(26);
  doc.setTextColor(255, 255, 255);
  write(doc.splitTextToSize(safe(player?.playerName) || L.player, W - M - textX)[0] || L.player, textX, 80);
  doc.setFont(FAM, 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...GOLD);
  const strap = [`${L.title}  ·  ${monthName(month, lang === 'en' ? 'en' : 'he')}`, safe(player?.currentClub)].filter(Boolean).join('  ·  ');
  write(doc.splitTextToSize(strap, W - M - textX)[0] || '', textX, 104, { charSpace: 0.3 });

  // ── The month in numbers ───────────────────────────────────────
  let y = section(L.numbers, BAND + 38);
  const t = r.monthTotals || {};
  const figures = [[L.apps, t.apps], [L.minutes, t.minutes], [L.goals, t.goals], [L.assists, t.assists]];
  const colW = CW / figures.length;
  figures.forEach(([k, v], idx) => {
    const i = rtl ? figures.length - 1 - idx : idx;
    const cx = M + colW * i + colW / 2;
    if (i) {
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.7);
      doc.line(M + colW * i, y - 6, M + colW * i, y + 30);
    }
    doc.setFont(FAM, 'bold');
    doc.setFontSize(24);
    doc.setTextColor(...INK);
    doc.text(String(Math.max(0, Number(v) || 0)), cx, y + 14, { align: 'center' });
    doc.setFont(FAM, MED);
    doc.setFontSize(7.6);
    doc.setTextColor(...GOLD_DARK);
    doc.text(String(k).toUpperCase(), cx, y + 30, { align: 'center', charSpace: 1.15 });
  });
  y += 56;
  const season = seasonLine(r.season, lang === 'en' ? 'en' : 'he');
  if (season) {
    doc.setFont(FAM, 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    write(`${season.label} ${L.soFar}:   ${season.value}`, M, y);
    y += 14;
  }

  // ── The month's matches ────────────────────────────────────────
  y = section(L.matches, y + 18);
  const rows = Array.isArray(r.matches) ? r.matches : [];
  if (!rows.length) {
    doc.setFont(FAM, 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...INK);
    write(L.noMatches, M, y);
    y += 16;
  } else {
    // Columns from the reading start: date, match, competition, minutes, goals, assists.
    const NUM = 42;
    const cols = [
      { key: 'date', w: 48 }, { key: 'match', w: CW - 48 - 112 - NUM * 3 }, { key: 'competition', w: 112 },
      { key: 'min', w: NUM, num: true }, { key: 'g', w: NUM, num: true }, { key: 'a', w: NUM, num: true },
    ];
    let cx = M;
    for (const c of cols) { c.x = cx; cx += c.w; }
    const cell = (c, text, yy) => {
      if (c.num) { doc.text(text, X(c.x + c.w / 2), yy, { align: 'center' }); return; }
      // Too long for its column: cut at a word and say so with "...".
      const room = c.w - 8;
      let fitted = doc.splitTextToSize(text, room)[0] || '';
      if (fitted !== text) fitted = `${doc.splitTextToSize(text, room - doc.getTextWidth('...'))[0] || ''}...`;
      write(fitted, c.x, yy);
    };
    doc.setFont(FAM, MED);
    doc.setFontSize(7.2);
    doc.setTextColor(...MUTED);
    const head = { date: L.date, match: L.match, competition: L.competition, min: L.min, g: L.g, a: L.a };
    for (const c of cols) cell(c, String(head[c.key]).toUpperCase(), y - 4);
    y += 4;
    const ROW = 19;
    const room = Math.max(1, Math.floor((BOTTOM - 200 - y) / ROW));
    const shown = rows.length > room ? rows.slice(0, room - 1) : rows;
    doc.setFontSize(10);
    for (const m of shown) {
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.6);
      doc.line(M, y, W - M, y);
      y += 13.5;
      doc.setFont(FAM, 'normal');
      doc.setTextColor(...INK);
      const played = m.played !== false;
      const vals = {
        date: day(m.date, lang), match: safe(m.title), competition: safe(m.competition),
        min: String(Math.max(0, Number(m.minutes) || 0)), g: played ? String(Math.max(0, Number(m.goals) || 0)) : '-', a: played ? String(Math.max(0, Number(m.assists) || 0)) : '-',
      };
      for (const c of cols) {
        if (c.key === 'g' || c.key === 'a') doc.setFont(FAM, Number(vals[c.key]) > 0 ? 'bold' : 'normal');
        doc.setTextColor(...(c.key === 'competition' || c.key === 'date' ? MUTED : INK));
        cell(c, vals[c.key], y);
      }
      y += 5.5;
    }
    doc.setDrawColor(...RULE);
    doc.line(M, y, W - M, y);
    if (shown.length < rows.length) {
      y += 13;
      doc.setFont(FAM, 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      write(L.more(rows.length - shown.length), M, y);
    }
    y += 4;
  }

  // ── What we did this month ─────────────────────────────────────
  const did = (Array.isArray(r.did) ? r.did : []).map(safe).filter(Boolean);
  if (did.length && y < BOTTOM - 60) {
    y = section(L.did, y + 24);
    doc.setFont(FAM, 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...INK);
    for (const line of did) {
      const wrapped = doc.splitTextToSize(line, CW - 18);
      if (y + wrapped.length * 14 > BOTTOM - 40) break;
      doc.setFillColor(...GOLD);
      doc.rect(rtl ? W - M - 5 : M, y - 6.5, 5, 5, 'F');
      write(wrapped, M + 16, y, { lineHeightFactor: 1.35 });
      y += wrapped.length * 14 + 5;
    }
  }

  // ── The next step ──────────────────────────────────────────────
  const next = safe(r.next);
  if (next && y < BOTTOM - 40) {
    y = section(L.next, y + 20);
    doc.setFont(FAM, 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    const room = Math.max(1, Math.floor((BOTTOM - y) / 15.5));
    const lines = doc.splitTextToSize(next, CW - 16).slice(0, room);
    doc.setFillColor(...GOLD);
    doc.rect(rtl ? W - M - 3 : M, y - 10, 3, lines.length * 15.5 + 2, 'F');
    write(lines, M + 14, y, { lineHeightFactor: 1.4 });
    y += lines.length * 15.5;
  }

  // ── Closing and footer ─────────────────────────────────────────
  doc.setFont(FAM, MED);
  doc.setFontSize(10.5);
  doc.setTextColor(...GOLD_DARK);
  write(L.closing, M, H - 74);
  doc.setFillColor(...DARK);
  doc.rect(0, H - 54, W, 54, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, H - 56, W, 2, 'F');
  label(L.footer, M, H - 30, GOLD, 8);

  return { doc, filename: reportFilename(player?.playerName, month, lang) };
}
