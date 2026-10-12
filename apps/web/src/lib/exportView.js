// View export — exports the currently visible (filtered + sorted) rows
// of any screen to a styled Excel workbook or a branded PDF document.
//
// Both libraries are loaded LAZILY via dynamic import so they don't bloat
// the main bundle — the first export click downloads ~200 KB of code, every
// click after that hits the cache.
//
// API:
//   exportToExcel({ filename, title, subtitle?, columns, rows })
//   exportToPdf  ({ filename, title, subtitle?, columns, rows })
//
// `columns` is an array of { key, label, width?, format? } where:
//   - key:    the property name in each row object
//   - label:  the column header displayed in the export
//   - width:  optional column width (Excel chars; defaults to auto)
//   - format: optional function (value, row) => string to massage cells
//             (e.g. join arrays, format dates, follow nested paths).

const GOLD       = 'C9A84C';    // brand gold
const GOLD_DARK  = '8E6A24';    // antique gold for borders
const BG_DARK    = '0A140D';    // club green
const TEXT_LIGHT = 'F6FBF6';    // off-white
const ROW_EVEN   = 'F7F3EC';    // warm cream — alternating row tint
const ROW_ODD    = 'FFFFFF';    // pure white

// ─────────────────────────── Helpers ────────────────────────────
function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Returns either a plain string OR a { text, url } object for hyperlink
// cells. The two exporters know how to render both shapes.
function cellValue(row, col) {
  if (col.format) {
    const out = col.format(row[col.key], row);
    return out ?? '';
  }
  const v = row[col.key];
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object' && (v.text != null || v.url)) return v;   // hyperlink-shaped
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
function isHyperlink(v) {
  return v && typeof v === 'object' && typeof v.url === 'string' && v.url;
}
function cellText(v) {
  if (isHyperlink(v)) return v.text ?? 'Open';
  return v == null ? '' : String(v);
}
// Drop everything that's not Latin-1 (i.e. anything jsPDF's Helvetica
// can't render). Used as a last-resort fallback when a column doesn't
// supply a pdfLabel.
function stripEmoji(s) {
  if (s == null) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = String(s).replace(/[^\x00-\xFF]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || '—';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─────────────────────────── Excel ──────────────────────────────
export async function exportToExcel({ filename, title, subtitle, columns, rows }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator   = 'Gold A&S';
  wb.created   = new Date();
  wb.modified  = new Date();
  wb.company   = 'Gold A&S Football Agency';

  const ws = wb.addWorksheet(title || 'Sheet', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'landscape' },
  });

  // Typography palette for Excel — chosen to be ELEGANT yet UNIVERSALLY
  // installed (so the file looks the same on Lou's Mac, his colleague's
  // Windows PC, and the recipient club's iPad):
  //
  //   • SERIF_DISPLAY = Garamond — the classic French luxury serif
  //     (16th-century roots, used by Apple's marketing typography for
  //     decades). Ships with every Office install since 2007 on both
  //     Windows and Mac. Far more refined than Cambria's ClearType look.
  //
  //   • SANS_BODY = Corbel — a humanist sans bundled with every Office
  //     install since 2007. Designed by Jeremy Tankard with subtle
  //     contrast and softer terminals than Calibri, which makes long
  //     data rows feel tailored rather than utilitarian. Maintains
  //     Calibri-class readability.
  const SERIF_DISPLAY = 'Garamond';
  const SANS_BODY     = 'Corbel';

  // ── Title strip (rows 1–3) ────────────────────────────────────
  const colCount = columns.length;
  ws.mergeCells(1, 1, 1, colCount);
  ws.getCell(1, 1).value = 'GOLD A&S — FOOTBALL AGENCY';
  ws.getCell(1, 1).font = { name: SANS_BODY, size: 10, bold: true, color: { argb: GOLD } };
  ws.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_DARK } };
  ws.getRow(1).height = 22;

  ws.mergeCells(2, 1, 2, colCount);
  ws.getCell(2, 1).value = title || 'Export';
  ws.getCell(2, 1).font = { name: SERIF_DISPLAY, size: 20, bold: true, color: { argb: 'FFFFFF' } };
  ws.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_DARK } };
  ws.getRow(2).height = 34;

  ws.mergeCells(3, 1, 3, colCount);
  const sub = `${subtitle || ''}${subtitle ? '  ·  ' : ''}${rows.length} row${rows.length !== 1 ? 's' : ''}  ·  ${todayStamp()}`;
  ws.getCell(3, 1).value = sub;
  ws.getCell(3, 1).font = { name: SERIF_DISPLAY, size: 11, italic: true, color: { argb: GOLD } };
  ws.getCell(3, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_DARK } };
  ws.getRow(3).height = 22;

  // ── Header row (row 4) ────────────────────────────────────────
  const headerRow = ws.getRow(4);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name: SANS_BODY, size: 11, bold: true, color: { argb: BG_DARK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top:    { style: 'medium', color: { argb: GOLD_DARK } },
      bottom: { style: 'medium', color: { argb: GOLD_DARK } },
      left:   { style: 'thin',   color: { argb: GOLD_DARK } },
      right:  { style: 'thin',   color: { argb: GOLD_DARK } },
    };
  });
  headerRow.height = 28;

  // ── Data rows ────────────────────────────────────────────────
  rows.forEach((row, ri) => {
    const rowIdx = 5 + ri;
    const xlRow = ws.getRow(rowIdx);
    const tint = ri % 2 === 0 ? ROW_ODD : ROW_EVEN;
    columns.forEach((c, ci) => {
      const cell = xlRow.getCell(ci + 1);
      const v = cellValue(row, c);
      if (isHyperlink(v)) {
        // Native Excel hyperlink — Ctrl+click in Excel, or just click in the
        // web/mobile viewers. Rendered as gold underlined text.
        cell.value = { text: v.text || 'Open', hyperlink: v.url };
        cell.font = { name: SANS_BODY, size: 11, bold: true, underline: true, color: { argb: GOLD_DARK } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else {
        cell.value = v;
        cell.font = { name: SANS_BODY, size: 11, color: { argb: '2A2A2A' } };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tint } };
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'D9C68A' } },
        left:   { style: 'hair', color: { argb: 'EFE4C8' } },
        right:  { style: 'hair', color: { argb: 'EFE4C8' } },
      };
    });
    xlRow.height = 22;
  });

  // ── Column widths ────────────────────────────────────────────
  columns.forEach((c, i) => {
    if (c.width) { ws.getColumn(i + 1).width = c.width; return; }
    // Auto-size: max(label length, longest value length) capped at 60.
    let max = String(c.label || '').length;
    for (const r of rows) {
      const t = cellText(cellValue(r, c));
      if (t.length > max) max = t.length;
    }
    ws.getColumn(i + 1).width = Math.min(Math.max(max + 3, 8), 60);
  });

  // ── Convert as an official Excel Table so users get filter/sort UI ───
  // Range: A4..lastCol(lastRow). Names must be unique per sheet & start
  // with a letter; sanitise the title.
  // Attach an auto-filter to the header row so the user gets the
  // dropdown-arrow filter UI in Excel without losing our custom cell
  // styling (ws.addTable would override the gold-on-dark header look).
  if (rows.length > 0) {
    const lastCol = colCount;
    ws.autoFilter = {
      from: { row: 4, column: 1 },
      to:   { row: 4 + rows.length, column: lastCol },
    };
  }

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${filename || 'export'} ${todayStamp()}.xlsx`
  );
}

// ─────────────────────────── PDF ────────────────────────────────
export async function exportToPdf({ filename, title, subtitle, columns, rows }) {
  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth  = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // Dark green header band
  doc.setFillColor(10, 20, 13);
  doc.rect(0, 0, pageWidth, 70, 'F');

  // Gold accent line under the band
  doc.setFillColor(0xC9, 0xA8, 0x4C);
  doc.rect(0, 70, pageWidth, 2, 'F');

  // PDF typography palette:
  //   • Times — Adobe-standard serif baked into every PDF reader. Used
  //     for the big display title + italic subtitle (matches the app's
  //     Playfair Display tone).
  //   • Helvetica — the industry-standard sans for tabular data. 9pt body
  //     is the size newspaper financial tables and Bloomberg terminals use
  //     for maximum density without losing readability.
  //   These two are PDF base-14 fonts so they render identically on every
  //   reader (Acrobat, Preview, Chrome, mobile) with zero embedding cost.

  // Brand line — small sans caps, gold on dark
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(0xC9, 0xA8, 0x4C);
  doc.text('GOLD A&S — FOOTBALL AGENCY', 40, 28);

  // Title — large serif for an elegant "frontispiece" feel
  doc.setFont('times', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text(title || 'Export', 40, 56);

  // Subtitle — serif italic, gold tone
  doc.setFont('times', 'italic');
  doc.setFontSize(10.5);
  doc.setTextColor(0x8E, 0x6A, 0x24);
  const sub = `${subtitle || ''}${subtitle ? '  ·  ' : ''}${rows.length} row${rows.length !== 1 ? 's' : ''}  ·  ${todayStamp()}`;
  doc.text(sub, 40, 92);

  // Build table data — convert hyperlink cells into display text, but keep
  // the URL in a parallel map so didDrawCell can attach a clickable region.
  // jsPDF's bundled Helvetica is Latin-1 only and prints emoji as garbage,
  // so per-column `pdfLabel` overrides the emoji header for PDF output.
  // Excel keeps the emoji label because Excel renders emoji natively.
  const headers = columns.map(c => c.pdfLabel || stripEmoji(c.label));
  const linkMap = new Map();  // key: "rowIdx,colIdx" → url
  const data = rows.map((r, ri) => columns.map((c, ci) => {
    const v = cellValue(r, c);
    if (isHyperlink(v)) {
      linkMap.set(`${ri},${ci}`, v.url);
      return stripEmoji(v.text || 'Open');
    }
    // Body text — also stripped so cell content with emoji (e.g. club
    // names with country flags) renders cleanly in the PDF.
    return stripEmoji(String(v ?? ''));
  }));

  doc.autoTable({
    head: [headers],
    body: data,
    startY: 110,
    margin: { left: 40, right: 40 },
    styles: {
      font: 'helvetica',           // industry standard for tabular data
      fontSize: 9,                 // dense but legible — financial-press norm
      cellPadding: { top: 7, right: 6, bottom: 7, left: 6 },
      textColor: [42, 42, 42],
      lineColor: [217, 198, 138],
      lineWidth: 0.25,
      valign: 'middle',
    },
    headStyles: {
      font: 'helvetica',
      fontStyle: 'bold',
      fontSize: 9.5,
      fillColor: [10, 20, 13],
      textColor: [0xC9, 0xA8, 0x4C],
      halign: 'center',
      cellPadding: 9,
      lineColor: [0x8E, 0x6A, 0x24],
      lineWidth: 0.5,
    },
    alternateRowStyles: {
      fillColor: [247, 243, 236],
    },
    bodyStyles: { fillColor: [255, 255, 255] },
    didParseCell: (d) => {
      // Style hyperlink cells in gold + bold so they LOOK clickable.
      if (d.section !== 'body') return;
      const key = `${d.row.index},${d.column.index}`;
      if (linkMap.has(key)) {
        d.cell.styles.textColor = [0x8E, 0x6A, 0x24];
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.halign = 'center';
      }
    },
    didDrawCell: (d) => {
      // Make the cell a clickable region pointing at the URL.
      if (d.section !== 'body') return;
      const key = `${d.row.index},${d.column.index}`;
      const url = linkMap.get(key);
      if (url) {
        doc.link(d.cell.x, d.cell.y, d.cell.width, d.cell.height, { url });
      }
    },
    didDrawPage: (data) => {
      // Footer — small italic serif, brand antique-gold
      doc.setFont('times', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(0x8E, 0x6A, 0x24);
      doc.text(
        `Gold A&S Football Agency  ·  Page ${doc.internal.getNumberOfPages()}`,
        pageWidth / 2,
        pageHeight - 18,
        { align: 'center' }
      );
    },
  });

  doc.save(`${filename || 'export'} ${todayStamp()}.pdf`);
}
