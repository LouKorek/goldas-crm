// View export — exports the currently visible (filtered + sorted) rows of
// any screen to a styled Excel workbook, a branded PDF, or straight to the
// printer. Thin adapter over lib/report (the one report engine every screen
// and the Snapshot dashboard share), kept for the call sites that pass
// { filename, title, subtitle, columns, rows }.
//
// `columns`: [{ key, label, width?, format?, pdfLabel?, numeric? }], where
// format(value, row) returns the display value (string, number, or
// { text, url } for a hyperlink cell).
import { listReport } from './report/report';
import { getLang } from './i18n';

export async function exportToExcel(args) {
  const { exportExcel } = await import('./report/excel');
  await exportExcel(listReport({ lang: getLang(), ...args }));
}

export async function exportToPdf(args) {
  const { exportPdf } = await import('./report/pdf');
  await exportPdf(listReport({ lang: getLang(), ...args }));
}

/** Print-ready PDF opened in a new tab with the print dialog already up. */
export async function exportToPrint(args, win) {
  const { exportPdf } = await import('./report/pdf');
  await exportPdf(listReport({ lang: getLang(), ...args }), { print: true, win });
}
