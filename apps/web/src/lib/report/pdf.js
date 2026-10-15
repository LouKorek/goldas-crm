// PDF builder for the report model (see report.js). A4 document:
//   cover band + title + the filters in force + KPI tiles
//   each section: chart picture (when given) and its styled table
//   records appendix
// Hebrew is drawn with the embedded Heebo font and visually reordered by
// pdfHebrew; in Hebrew the column order is mirrored so the first column
// sits at the right edge. `print: true` opens the PDF with the print dialog
// already up instead of downloading it.
import { BRAND, cellText, isLink, plain, hasHebrew, fileStamp, prettyDate } from './report';

const A4 = { w: 595.28, h: 841.89 };
const M = 36;

export async function buildPdf(report) {
  const [{ default: jsPDF }, { installHebrew }] = await Promise.all([import('jspdf'), import('../pdfHebrew')]);
  await import('jspdf-autotable');
  const lang = report.lang || 'he';
  const he = lang === 'he' || hasHebrew(report.title);
  const wide = (report.sections || []).some((s) => s.columns.length > 7) || (report.records?.columns?.length || 0) > 7;
  const doc = new jsPDF({ orientation: wide ? 'landscape' : 'portrait', unit: 'pt', format: 'a4', compress: true });
  const heebo = await installHebrew(doc);
  const F = heebo && he ? 'Heebo' : 'helvetica';
  const serif = heebo && he ? 'Heebo' : 'times';
  const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
  const right = pw - M;
  const tx = (s, x, y, o = {}) => doc.text(plain(s), x, y, { align: he ? 'right' : 'left', ...o });
  const X = he ? right : M;

  // ── Cover band
  doc.setFillColor(...BRAND.rgb.green); doc.rect(0, 0, pw, 96, 'F');
  doc.setFillColor(...BRAND.rgb.gold); doc.rect(0, 96, pw, 2, 'F');
  doc.setFont(F, 'bold'); doc.setFontSize(9); doc.setTextColor(...BRAND.rgb.gold);
  tx(he ? BRAND.nameHe : BRAND.name, X, 30);
  doc.setFont(serif, 'bold'); doc.setFontSize(22); doc.setTextColor(255, 255, 255);
  tx(report.title || 'Report', X, 62);
  doc.setFont(serif, 'normal'); doc.setFontSize(10.5); doc.setTextColor(...BRAND.rgb.gold);
  tx(report.subtitle || (he ? `הופק ${prettyDate(new Date(), lang)}` : `Generated ${prettyDate(new Date(), lang)}`), X, 84);

  let y = 120;
  // ── Meta lines (period, filters, counts)
  doc.setFont(F, 'normal'); doc.setFontSize(10); doc.setTextColor(...BRAND.rgb.ink);
  for (const m of report.meta || []) {
    doc.setFont(F, 'bold'); doc.setTextColor(...BRAND.rgb.goldDark);
    const label = `${plain(m.label)}:`;
    tx(label, X, y);
    const lw = doc.getTextWidth(label) + 6;
    doc.setFont(F, 'normal'); doc.setTextColor(...BRAND.rgb.ink);
    const lines = doc.splitTextToSize(plain(m.value), pw - M * 2 - lw);
    doc.text(lines, he ? right - lw : M + lw, y, { align: he ? 'right' : 'left' });
    y += 14 * lines.length;
  }

  // ── KPI tiles, 3 per row
  if (report.kpis?.length) {
    y += 10;
    const cols = wide ? 6 : 3, gap = 10, tw = (pw - M * 2 - gap * (cols - 1)) / cols, th = 44;
    report.kpis.forEach((k, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const x0 = he ? right - tw - c * (tw + gap) : M + c * (tw + gap);
      const y0 = y + r * (th + gap);
      doc.setFillColor(...BRAND.rgb.cream); doc.rect(x0, y0, tw, th, 'F');
      doc.setFillColor(...BRAND.rgb.gold); doc.rect(x0, y0, tw, 2, 'F');
      doc.setFont(F, 'bold'); doc.setFontSize(18); doc.setTextColor(...BRAND.rgb.ink);
      doc.text(plain(String(k.value)), x0 + tw / 2, y0 + 25, { align: 'center' });
      doc.setFont(F, 'normal'); doc.setFontSize(8); doc.setTextColor(...BRAND.rgb.muted);
      doc.text(plain(k.label), x0 + tw / 2, y0 + 40, { align: 'center' });
    });
    y += Math.ceil(report.kpis.length / cols) * (th + gap) + 8;
  }

  const sectionTitle = (title, sub) => {
    if (y > ph - 140) { doc.addPage(); y = M + 10; }
    doc.setFont(F, 'bold'); doc.setFontSize(13); doc.setTextColor(...BRAND.rgb.green);
    tx(title, X, y); y += 6;
    doc.setDrawColor(...BRAND.rgb.gold); doc.setLineWidth(1); doc.line(M, y, right, y); y += 12;
    if (sub) { doc.setFont(F, 'normal'); doc.setFontSize(9); doc.setTextColor(...BRAND.rgb.muted); tx(sub, X, y); y += 12; }
  };

  const drawTable = (columns, rows, { totals } = {}) => {
    const cols = he ? [...columns].reverse() : columns;
    const head = [cols.map((c) => plain(c.pdfLabel || c.label))];
    const links = new Map();
    const body = rows.map((r, ri) => cols.map((c, ci) => {
      const v = r[c.key];
      if (isLink(v)) { links.set(`${ri},${ci}`, v.url); return plain(v.text || 'Open'); }
      return typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : plain(cellText(v));
    }));
    if (totals && rows.length) {
      body.push(cols.map((c, ci) => {
        const nums = rows.map((x) => x[c.key]).filter((v) => typeof v === 'number');
        if ((he ? ci === cols.length - 1 : ci === 0)) return he ? 'סה״כ' : 'Total';
        return nums.length === rows.length ? nums.reduce((a, b) => a + b, 0).toLocaleString('en-US') : '';
      }));
    }
    const numericIdx = new Set(cols.map((c, i) => (c.numeric || rows.every((r) => typeof r[c.key] === 'number')) ? i : -1).filter((i) => i >= 0));
    doc.autoTable({
      head, body, startY: y, margin: { left: M, right: M, top: M + 10, bottom: M },
      styles: { font: F, fontSize: 8.5, cellPadding: { top: 5, right: 5, bottom: 5, left: 5 }, textColor: BRAND.rgb.ink, lineColor: BRAND.rgb.rule, lineWidth: 0.25, valign: 'middle', halign: he ? 'right' : 'left', overflow: 'linebreak' },
      headStyles: { font: F, fontStyle: 'bold', fontSize: 9, fillColor: BRAND.rgb.green, textColor: BRAND.rgb.gold, halign: 'center', cellPadding: 6, lineColor: BRAND.rgb.goldDark, lineWidth: 0.5 },
      alternateRowStyles: { fillColor: BRAND.rgb.cream },
      bodyStyles: { fillColor: [255, 255, 255] },
      showHead: 'everyPage', rowPageBreak: 'avoid',
      didParseCell: (d) => {
        if (d.section === 'body') {
          if (numericIdx.has(d.column.index)) d.cell.styles.halign = 'center';
          if (links.has(`${d.row.index},${d.column.index}`)) { d.cell.styles.textColor = BRAND.rgb.goldDark; d.cell.styles.fontStyle = 'bold'; d.cell.styles.halign = 'center'; }
          if (totals && d.row.index === body.length - 1) { d.cell.styles.fontStyle = 'bold'; d.cell.styles.fillColor = [0xEF, 0xE4, 0xC8]; }
        }
      },
      didDrawCell: (d) => {
        if (d.section !== 'body') return;
        const url = links.get(`${d.row.index},${d.column.index}`);
        if (url) doc.link(d.cell.x, d.cell.y, d.cell.width, d.cell.height, { url });
      },
    });
    y = doc.lastAutoTable.finalY + 18;
  };

  for (const s of report.sections || []) {
    let w = 0, h = 0;
    if (s.chart?.dataUrl) {
      // Chart no taller than 200pt and no wider than the text block, keeping
      // its aspect ratio; the title and the chart stay on one page together.
      const cw = s.chart.width || 520, ch = s.chart.height || 200;
      h = Math.min(wide ? 170 : 200, ch); w = cw * (h / ch);
      if (w > pw - M * 2) { w = pw - M * 2; h = ch * (w / cw); }
      if (y + h + 40 > ph - M) { doc.addPage(); y = M + 10; }
    }
    sectionTitle(s.title || report.title, s.subtitle);
    if (h) {
      doc.addImage(s.chart.dataUrl, 'PNG', he ? right - w : M, y, w, h);
      y += h + 12;
    }
    drawTable(s.columns, s.rows, { totals: s.totals });
  }
  if (report.records?.rows?.length) {
    const r = report.records;
    doc.addPage(); y = M + 10;
    sectionTitle(r.title || (he ? 'רשומות' : 'Records'), `${r.rows.length} ${he ? 'רשומות' : 'rows'}`);
    drawTable(r.columns, r.rows);
  }

  // ── Footer on every page
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont(F, 'normal'); doc.setFontSize(8); doc.setTextColor(...BRAND.rgb.goldDark);
    doc.text(`Gold A&S Football Agency  ·  ${i} / ${n}`, pw / 2, ph - 16, { align: 'center' });
    doc.text(prettyDate(new Date(), lang), he ? M : right, ph - 16, { align: he ? 'left' : 'right' });
  }
  return doc;
}

export async function exportPdf(report, { print = false, win = null } = {}) {
  const doc = await buildPdf(report);
  if (!print) { doc.save(fileStamp(report.filename, 'pdf')); return; }
  // Print: the dialog opens as soon as the PDF loads. The window was opened
  // by the click itself (popup rules), so only its address changes here.
  doc.autoPrint();
  const url = doc.output('bloburl');
  if (win && !win.closed) win.location.href = url;
  else window.open(url, '_blank');
}
