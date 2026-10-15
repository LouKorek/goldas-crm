// One report model for every export in the CRM. A screen (a list, the
// Snapshot dashboard, a player page) describes WHAT it shows — title, the
// filters in force, KPI tiles, sections of rows with an optional chart, and
// the raw records — and the Excel and PDF builders decide HOW it looks, so
// all exports share one brand, one RTL handling and one print setup.
//
//   report = {
//     filename, title, subtitle?, lang: 'he' | 'en',
//     meta:     [{ label, value }]                  // period, filters, row count…
//     kpis:     [{ label, value }]                  // already formatted strings
//     sections: [{ title, subtitle?, columns, rows, chart?, totals? }]
//     records?: { title, columns, rows }            // the slice's records
//   }
//   columns = [{ key, label, numeric?, width?, pdfLabel? }]
//   rows    = [{ [key]: string | number | { text, url } }]
//   chart   = { dataUrl, width, height }            // PNG from charts/toPng
//
// Both builders are loaded lazily by the caller (~200 KB each on first use).

export const BRAND = {
  gold: 'C8A24A', goldDark: '8A6B22', goldSoft: 'EFE4C8', green: '0A140D', ink: '16201A', muted: '6F7C70',
  cream: 'F7F3EC', white: 'FFFFFF', rule: 'D9C68A', ruleSoft: 'EFE4C8',
  rgb: { gold: [0xC8, 0xA2, 0x4A], goldDark: [0x8A, 0x6B, 0x22], green: [0x0A, 0x14, 0x0D], ink: [0x16, 0x20, 0x1A], muted: [0x6F, 0x7C, 0x70], cream: [0xF7, 0xF3, 0xEC], rule: [0xD9, 0xC6, 0x8A] },
  name: 'GOLD A&S — FOOTBALL AGENCY',
  nameHe: 'Gold A&S · סוכנות כדורגל',
};

export const todayStamp = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const prettyDate = (d = new Date(), lang = 'he') => d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const isLink = (v) => !!v && typeof v === 'object' && typeof v.url === 'string' && v.url;
export const cellText = (v) => (isLink(v) ? (v.text ?? 'Open') : v == null ? '' : String(v));
export const hasHebrew = (s) => /[֐-׿]/.test(String(s ?? ''));

/** Drop characters neither Excel's fonts nor the PDF fonts draw well (emoji). */
export const plain = (s) => String(s ?? '').replace(/[^\x20-\xFF֐-׿–—•€₪]/g, '').replace(/\s+/g, ' ').trim();

/** A number stays a number (so Excel sums it); everything else becomes text. */
export const cellValue = (v) => (typeof v === 'number' ? v : isLink(v) ? v : plain(cellText(v)));

/** Column widths in Excel characters from the longest value, within sane bounds. */
export const autoWidth = (col, rows) => {
  if (col.width) return col.width;
  let max = String(col.label || '').length;
  for (const r of rows) { const n = cellText(r[col.key]).length; if (n > max) max = n; }
  return Math.min(Math.max(max + 3, 8), 48);
};

/**
 * Convenience for list screens: the columns/rows the old ExportMenu passes
 * ({ key, label, format? }) become a one-section report. `format(value, row)`
 * is applied here so the builders only ever see display values.
 */
export const listReport = ({ filename, title, subtitle, columns, rows, lang = 'he' }) => {
  const cols = columns.map((c) => ({ key: c.key, label: c.label, pdfLabel: c.pdfLabel, width: c.width, numeric: c.numeric }));
  const data = rows.map((r) => Object.fromEntries(columns.map((c) => {
    let v = c.format ? c.format(r[c.key], r) : r[c.key];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v && typeof v === 'object' && !isLink(v)) v = JSON.stringify(v);
    return [c.key, v ?? ''];
  })));
  return {
    filename, title, subtitle, lang,
    meta: [
      ...(subtitle ? [{ label: lang === 'he' ? 'סינון' : 'Filter', value: subtitle }] : []),
      { label: lang === 'he' ? 'רשומות' : 'Rows', value: String(rows.length) },
      { label: lang === 'he' ? 'הופק' : 'Generated', value: prettyDate(new Date(), lang) },
    ],
    kpis: [],
    sections: [{ title, columns: cols, rows: data }],
  };
};

/** Excel sheet names: ≤31 chars, none of []:*?/\ and unique. */
export const sheetName = (title, used) => {
  let base = plain(title).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Sheet';
  let name = base, i = 2;
  while (used.has(name)) name = `${base.slice(0, 25)} ${i++}`;
  used.add(name);
  return name;
};

export const fileStamp = (filename, ext) => `${plain(filename) || 'export'} ${todayStamp()}.${ext}`;

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
