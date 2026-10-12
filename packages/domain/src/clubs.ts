// Club identity: the same club is written many ways across the records
// ("Hapoel Tel Aviv", "הפועל ת"א", "Hapoel Tel Aviv F.C.", "Hapoel Tel Aviv U19").
// clubKey() folds those into one key so the migration and the UI can group
// them; the report shows the variants under each key for Lou to confirm.

const SUFFIXES = [
  /\b(f\.?c\.?|a\.?f\.?c\.?|s\.?c\.?|m\.?s\.?|b\.?c\.?)\b/gi,
  /\b(u-?\d{2}|under\s?\d{2}|youth|academy|women|ladies|reserves?|b team|ii)\b/gi,
  /\((?:youth|women|u-?\d{2}|נוער|נשים)\)/gi,
  /(?:^|\s)(נוער|נערים|ילדים|נשים|מילואים)(?=\s|$)/g,
  /(?:^|\s)(מ\.?ס\.?|מועדון ספורט|מועדון כדורגל|מ\.?כ\.?|ע\.?ש\.?)(?=\s|$)/g,
];

// JS \b is ASCII-only, so Hebrew tokens are bounded by whitespace instead.
const heb = (inner: string) => new RegExp(`(^|\\s)${inner}(?=\\s|$)`, 'g');
const HEBREW_ABBR: Array<[RegExp, string]> = [
  [heb(`ת["״׳']?א`), 'תל אביב'],
  [heb(`ב["״׳']?ש`), 'באר שבע'],
  [heb(`פ["״׳']?ת`), 'פתח תקווה'],
  [heb(`כ["״׳']?ס`), 'כפר סבא'],
  [heb(`ר["״׳']?ג`), 'רמת גן'],
  [heb(`ק["״׳']?ש`), 'קרית שמונה'],
  [heb(`י[-־]?ם`), 'ירושלים'],
  [heb(`ראשל["״׳']?צ`), 'ראשון לציון'],
];

export const isYouthName = (name: string): boolean =>
  /\b(u-?\d{2}|under\s?\d{2}|youth|academy)\b/i.test(name) || /(^|\s)(נוער|נערים|ילדים)(\s|$)/.test(name);

export const isWomenName = (name: string): boolean =>
  /\b(women|ladies)\b/i.test(name) || /(^|\s)נשים(\s|$)/.test(name);

/** Fold a club name into a comparison key. Empty for blanks and "free agent". */
export const clubKey = (raw: unknown): string => {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(free( agent)?|ללא|חופשי|-|—|none|n\/a)$/i.test(s)) return '';
  s = s.replace(/[’'`´]/g, "'").replace(/["״]/g, '"');
  for (const [re, full] of HEBREW_ABBR) s = s.replace(re, `$1${full}`);
  s = s.replace(/["'"]/g, '');
  for (const re of SUFFIXES) s = s.replace(re, ' ');
  s = s.replace(/[.,/()\-–—_]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
};

/** The nicer of two spellings to keep as the club's display name. */
export const preferName = (a: string, b: string): string => {
  const score = (n: string) => (/[a-z]/i.test(n) ? 2 : 0) + (/f\.?c\.?/i.test(n) ? 1 : 0) + Math.min(n.length, 40) / 100;
  return score(b) > score(a) ? b : a;
};
