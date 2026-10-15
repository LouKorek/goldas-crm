// Excel builder for the report model (see report.js). One workbook:
//   "סיכום"  — brand band, title, the filters in force, KPI tiles
//   one sheet per section — styled table, data bars on the numeric column,
//                           the chart picture beside it
//   "רשומות" — the full record list (when the report carries one)
// Every sheet is right-to-left in Hebrew, has a frozen header, auto-filter
// and a print setup (A4 landscape, fit to width, header row repeated,
// branded header/footer with page numbers) so Ctrl+P is enough.
import { BRAND, cellValue, isLink, autoWidth, sheetName, fileStamp, downloadBlob, hasHebrew, plain } from './report';

const SERIF = 'Garamond';
const SANS = 'Corbel';
const HE_FONT = 'Arial';           // Garamond/Corbel have no Hebrew glyphs; Arial is everywhere.
const font = (lang, extra = {}) => ({ name: lang === 'he' ? HE_FONT : SANS, size: 11, color: { argb: `FF${BRAND.ink}` }, ...extra });
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${argb}` } });
const thin = (argb) => ({ style: 'thin', color: { argb: `FF${argb}` } });
const hair = (argb) => ({ style: 'hair', color: { argb: `FF${argb}` } });

function brandBand(ws, lang, title, subtitle, colCount) {
  const n = Math.max(colCount, 4);
  ws.mergeCells(1, 1, 1, n);
  Object.assign(ws.getCell(1, 1), { value: lang === 'he' ? BRAND.nameHe : BRAND.name, font: font(lang, { size: 10, bold: true, color: { argb: `FF${BRAND.gold}` } }), fill: fill(BRAND.green), alignment: { vertical: 'middle', horizontal: lang === 'he' ? 'right' : 'left' } });
  ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, n);
  Object.assign(ws.getCell(2, 1), { value: plain(title) || 'Report', font: { name: lang === 'he' ? HE_FONT : SERIF, size: 20, bold: true, color: { argb: 'FFFFFFFF' } }, fill: fill(BRAND.green), alignment: { vertical: 'middle', horizontal: lang === 'he' ? 'right' : 'left' } });
  ws.getRow(2).height = 34;
  ws.mergeCells(3, 1, 3, n);
  Object.assign(ws.getCell(3, 1), { value: plain(subtitle || ''), font: { name: lang === 'he' ? HE_FONT : SERIF, size: 11, italic: lang !== 'he', color: { argb: `FF${BRAND.gold}` } }, fill: fill(BRAND.green), alignment: { vertical: 'middle', horizontal: lang === 'he' ? 'right' : 'left' } });
  ws.getRow(3).height = 22;
}

function printSetup(ws, lang, title, headerRow) {
  ws.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    ...(headerRow ? { printTitlesRow: `${headerRow}:${headerRow}` } : {}),
  };
  const t = plain(title).replace(/&/g, '&&');
  ws.headerFooter = {
    differentFirst: false,
    oddHeader: `&L&"${SANS},Bold"&K${BRAND.goldDark}GOLD A&&S&C&"${HE_FONT},Bold"&K${BRAND.ink}${t}&R&D`,
    oddFooter: `&L&"${SANS},Italic"&K${BRAND.muted}Gold A&&S Football Agency&R&"${SANS}"&K${BRAND.muted}&P / &N`,
  };
}

function table(ws, lang, columns, rows, startRow, { dataBars = true } = {}) {
  const head = ws.getRow(startRow);
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = plain(c.label);
    cell.font = font(lang, { bold: true, color: { argb: `FF${BRAND.green}` } });
    cell.fill = fill(BRAND.gold);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'medium', color: { argb: `FF${BRAND.goldDark}` } }, bottom: { style: 'medium', color: { argb: `FF${BRAND.goldDark}` } }, left: thin(BRAND.goldDark), right: thin(BRAND.goldDark) };
  });
  head.height = 26;
  rows.forEach((row, ri) => {
    const r = ws.getRow(startRow + 1 + ri);
    const tint = ri % 2 === 0 ? BRAND.white : BRAND.cream;
    columns.forEach((c, ci) => {
      const cell = r.getCell(ci + 1);
      const v = cellValue(row[c.key]);
      if (isLink(v)) {
        cell.value = { text: plain(v.text || 'Open'), hyperlink: v.url };
        cell.font = font(lang, { bold: true, underline: true, color: { argb: `FF${BRAND.goldDark}` } });
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else {
        cell.value = v;
        cell.font = font(lang);
        const numeric = typeof v === 'number' || c.numeric;
        cell.alignment = { vertical: 'middle', horizontal: numeric ? 'center' : lang === 'he' ? 'right' : 'left', wrapText: !numeric };
        if (typeof v === 'number') cell.numFmt = Number.isInteger(v) ? '#,##0' : '#,##0.0';
      }
      cell.fill = fill(tint);
      cell.border = { bottom: hair(BRAND.rule), left: hair(BRAND.ruleSoft), right: hair(BRAND.ruleSoft) };
    });
    r.height = 20;
  });
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = autoWidth(c, rows); });
  if (rows.length) {
    ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + rows.length, column: columns.length } };
    if (dataBars) {
      columns.forEach((c, i) => {
        if (!c.numeric && !rows.every((r) => typeof r[c.key] === 'number')) return;
        const col = ws.getColumn(i + 1).letter;
        ws.addConditionalFormatting({
          ref: `${col}${startRow + 1}:${col}${startRow + rows.length}`,
          rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: `FF${BRAND.gold}` }, gradient: true, minLength: 0, maxLength: 100 }],
        });
      });
    }
  }
  return startRow + rows.length + 1;
}

function totalsRow(ws, lang, columns, rows, row) {
  const r = ws.getRow(row);
  columns.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    const nums = rows.map((x) => x[c.key]).filter((v) => typeof v === 'number');
    if (i === 0) cell.value = lang === 'he' ? 'סה״כ' : 'Total';
    else if (nums.length === rows.length && rows.length) { cell.value = nums.reduce((a, b) => a + b, 0); cell.numFmt = '#,##0'; }
    cell.font = font(lang, { bold: true });
    cell.fill = fill(BRAND.goldSoft);
    cell.alignment = { horizontal: i === 0 ? (lang === 'he' ? 'right' : 'left') : 'center' };
    cell.border = { top: thin(BRAND.goldDark) };
  });
}

export async function buildWorkbook(report) {
  const ExcelJS = (await import('exceljs')).default;
  const lang = report.lang || 'he';
  const rtl = lang === 'he' || hasHebrew(report.title);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gold A&S'; wb.company = 'Gold A&S Football Agency'; wb.created = new Date(); wb.modified = new Date();
  const used = new Set();
  const view = (ySplit) => ({ state: 'frozen', ySplit, rightToLeft: rtl, showGridLines: false });

  // ── Summary sheet: only when there is more than one thing to summarise.
  const sections = report.sections || [];
  const summary = (report.kpis?.length || report.meta?.length) && (sections.length !== 1 || report.kpis?.length);
  if (summary) {
    const ws = wb.addWorksheet(sheetName(lang === 'he' ? 'סיכום' : 'Summary', used), { views: [view(3)] });
    brandBand(ws, lang, report.title, report.subtitle, 4);
    let row = 5;
    for (const m of report.meta || []) {
      ws.getCell(row, 1).value = plain(m.label); ws.getCell(row, 1).font = font(lang, { bold: true, color: { argb: `FF${BRAND.goldDark}` } });
      ws.mergeCells(row, 2, row, 4);
      ws.getCell(row, 2).value = plain(m.value); ws.getCell(row, 2).font = font(lang);
      ws.getCell(row, 2).alignment = { wrapText: true, horizontal: rtl ? 'right' : 'left' };
      row++;
    }
    if (report.kpis?.length) {
      row++;
      ws.getCell(row, 1).value = lang === 'he' ? 'מדדים' : 'Key figures';
      ws.getCell(row, 1).font = font(lang, { bold: true, size: 12, color: { argb: `FF${BRAND.goldDark}` } });
      row++;
      // Tiles two per row: label over value, like the screen.
      report.kpis.forEach((k, i) => {
        const c = (i % 2) * 2 + 1, r0 = row + Math.floor(i / 2) * 3;
        ws.mergeCells(r0, c, r0, c + 1); ws.mergeCells(r0 + 1, c, r0 + 1, c + 1);
        const lab = ws.getCell(r0, c), val = ws.getCell(r0 + 1, c);
        lab.value = plain(k.label); lab.font = font(lang, { size: 9, bold: true, color: { argb: `FF${BRAND.muted}` } }); lab.fill = fill(BRAND.cream); lab.alignment = { horizontal: 'center', vertical: 'bottom' };
        val.value = typeof k.value === 'number' ? k.value : plain(k.value); val.font = { name: SANS, size: 20, bold: true, color: { argb: `FF${BRAND.ink}` } }; val.fill = fill(BRAND.cream); val.alignment = { horizontal: 'center', vertical: 'top' };
        if (typeof k.value === 'number') val.numFmt = '#,##0';
        for (const cell of [lab, val]) cell.border = { left: thin(BRAND.rule), right: thin(BRAND.rule), top: thin(BRAND.rule), bottom: thin(BRAND.rule) };
        ws.getRow(r0).height = 18; ws.getRow(r0 + 1).height = 30;
      });
      row += Math.ceil(report.kpis.length / 2) * 3;
    }
    [22, 22, 22, 22].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, horizontalCentered: true };
    printSetup(ws, lang, report.title, 0);
    ws.pageSetup.orientation = 'portrait';
  }

  // ── One sheet per section.
  for (const s of sections) {
    const ws = wb.addWorksheet(sheetName(s.title || report.title, used), { views: [view(4)] });
    brandBand(ws, lang, s.title || report.title, s.subtitle || report.subtitle || (report.meta || []).map((m) => `${m.label}: ${m.value}`).join('  ·  '), s.columns.length);
    const end = table(ws, lang, s.columns, s.rows, 4);
    if (s.totals) totalsRow(ws, lang, s.columns, s.rows, end);
    if (s.chart?.dataUrl) {
      const id = wb.addImage({ base64: s.chart.dataUrl, extension: 'png' });
      const w = Math.min(520, s.chart.width || 520), h = Math.round((s.chart.height || 200) * (w / (s.chart.width || 520)));
      // Beside the table (in RTL the sheet mirrors, so "after the last column" is still beside it).
      ws.addImage(id, { tl: { col: s.columns.length + 0.3, row: 3.2 }, ext: { width: w, height: h } });
    }
    printSetup(ws, lang, s.title || report.title, 4);
  }

  // ── Records.
  if (report.records?.rows?.length) {
    const r = report.records;
    const ws = wb.addWorksheet(sheetName(r.title || (lang === 'he' ? 'רשומות' : 'Records'), used), { views: [view(4)] });
    brandBand(ws, lang, r.title || (lang === 'he' ? 'רשומות' : 'Records'), `${r.rows.length} ${lang === 'he' ? 'רשומות' : 'rows'}`, r.columns.length);
    table(ws, lang, r.columns, r.rows, 4, { dataBars: false });
    printSetup(ws, lang, r.title || report.title, 4);
  }

  return wb;
}

export async function exportExcel(report) {
  const wb = await buildWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileStamp(report.filename, 'xlsx'));
}
