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

function cellValue(row, col) {
  if (col.format) return col.format(row[col.key], row);
  const v = row[col.key];
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
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

  // ── Title strip (rows 1–3) ────────────────────────────────────
  const colCount = columns.length;
  ws.mergeCells(1, 1, 1, colCount);
  ws.getCell(1, 1).value = 'GOLD A&S — FOOTBALL AGENCY';
  ws.getCell(1, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: GOLD } };
  ws.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_DARK } };
  ws.getRow(1).height = 22;

  ws.mergeCells(2, 1, 2, colCount);
  ws.getCell(2, 1).value = title || 'Export';
  ws.getCell(2, 1).font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FFFFFF' } };
  ws.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_DARK } };
  ws.getRow(2).height = 30;

  ws.mergeCells(3, 1, 3, colCount);
  const sub = `${subtitle || ''}${subtitle ? '  ·  ' : ''}${rows.length} row${rows.length !== 1 ? 's' : ''}  ·  ${todayStamp()}`;
  ws.getCell(3, 1).value = sub;
  ws.getCell(3, 1).font = { name: 'Calibri', size: 10, italic: true, color: { argb: GOLD } };
  ws.getCell(3, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BG_DARK } };
  ws.getRow(3).height = 20;

  // ── Header row (row 4) ────────────────────────────────────────
  const headerRow = ws.getRow(4);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: BG_DARK } };
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
      cell.value = cellValue(row, c);
      cell.font = { name: 'Calibri', size: 11, color: { argb: '2A2A2A' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
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
      const v = String(cellValue(r, c) ?? '');
      if (v.length > max) max = v.length;
    }
    ws.getColumn(i + 1).width = Math.min(Math.max(max + 3, 10), 60);
  });

  // ── Convert as an official Excel Table so users get filter/sort UI ───
  // Range: A4..lastCol(lastRow). Names must be unique per sheet & start
  // with a letter; sanitise the title.
  if (rows.length > 0) {
    const lastCol = String.fromCharCode(64 + colCount);     // A..Z fine for ≤26 cols
    const lastRow = 4 + rows.length;
    const tName = ('Tbl_' + (title || 'Export')).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30);
    ws.addTable({
      name: tName,
      ref: `A4:${lastCol}${lastRow}`,
      headerRow: true,
      style: { theme: 'TableStyleLight15', showRowStripes: true },
      columns: columns.map(c => ({ name: c.label, filterButton: true })),
      rows: rows.map(r => columns.map(c => cellValue(r, c))),
    });
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

  // Brand line
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(0xC9, 0xA8, 0x4C);
  doc.text('GOLD A&S — FOOTBALL AGENCY', 40, 28);

  // Title
  doc.setFont('times', 'bold');   // serif-ish for the elegant title
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text(title || 'Export', 40, 54);

  // Subtitle line under the band
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(10);
  doc.setTextColor(0x8E, 0x6A, 0x24);
  const sub = `${subtitle || ''}${subtitle ? '  ·  ' : ''}${rows.length} row${rows.length !== 1 ? 's' : ''}  ·  ${todayStamp()}`;
  doc.text(sub, 40, 90);

  // Build table data
  const headers = columns.map(c => c.label);
  const data = rows.map(r => columns.map(c => String(cellValue(r, c) ?? '')));

  doc.autoTable({
    head: [headers],
    body: data,
    startY: 105,
    margin: { left: 40, right: 40 },
    styles: {
      font: 'helvetica',
      fontSize: 9,
      cellPadding: 6,
      textColor: [42, 42, 42],
      lineColor: [217, 198, 138],
      lineWidth: 0.25,
    },
    headStyles: {
      fillColor: [10, 20, 13],
      textColor: [0xC9, 0xA8, 0x4C],
      fontStyle: 'bold',
      fontSize: 9.5,
      halign: 'center',
      cellPadding: 8,
      lineColor: [0x8E, 0x6A, 0x24],
      lineWidth: 0.5,
    },
    alternateRowStyles: {
      fillColor: [247, 243, 236],
    },
    bodyStyles: { fillColor: [255, 255, 255] },
    didDrawPage: (data) => {
      // Footer
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
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
