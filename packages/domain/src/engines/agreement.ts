// Representation agreements signed inside the system: the pure parts.
//
// The agreement's words are the agency's own. An admin keeps one template per
// language (System › Agreements); a template is plain text with headings
// ("# Heading"), paragraphs (separated by an empty line) and a small, fixed
// list of named placeholders ({{player_name}}). When an agreement is made for
// a player the placeholders are filled once and the text is frozen on the
// agreement: what the signer reads, what is hashed and what the PDF prints
// are that one text.
//
// Two of the placeholders are not known when the agreement is made: the ID
// numbers the signers type on the signing page. In the text they stay a
// fixed phrase that points to the signing record, where the PDF prints the
// numbers. So the text that was shown, hashed and printed is the same text.
//
// Sections that apply only to a minor (a parent or guardian signs) or only to
// an adult are wrapped in {{#minor}} … {{/minor}} and {{#adult}} … {{/adult}}.
//
// Pure functions (no Firestore, no clock unless one is passed), shared by the
// System tab's preview, the server that makes and signs agreements, the
// signing page and the PDF, so they cannot disagree.

import { toDateStr, israelDate } from './dates.js';

export type AgreementLang = 'he' | 'en';

export interface AgreementPlaceholder {
  key: string;
  /** What it is, in Hebrew and English, for the template screen. */
  he: string;
  en: string;
  /** Filled by the signer on the signing page, not when the agreement is made. */
  bySigner?: boolean;
}

/** The fixed list. A template may use only these. */
export const AGREEMENT_PLACEHOLDERS: AgreementPlaceholder[] = [
  { key: 'player_name', he: 'השם המלא של השחקן (מה-CRM)', en: "The player's full name (from the CRM)" },
  { key: 'player_dob', he: 'תאריך הלידה של השחקן, DD/MM/YYYY', en: "The player's date of birth, DD/MM/YYYY" },
  { key: 'player_id_number', he: 'מספר הזהות או הדרכון של השחקן: ממלא החותם, מופיע ברשומת החתימה', en: "The player's ID or passport number: typed by the signer, printed in the signing record", bySigner: true },
  { key: 'guardian_name', he: 'השם המלא של ההורה או האפוטרופוס (לקטין)', en: "The parent's or guardian's full name (a minor)" },
  { key: 'guardian_id_number', he: 'מספר הזהות של ההורה או האפוטרופוס: ממלא החותם, מופיע ברשומת החתימה', en: "The parent's or guardian's ID number: typed by the signer, printed in the signing record", bySigner: true },
  { key: 'start_date', he: 'תחילת הייצוג, DD/MM/YYYY', en: 'Start of the representation, DD/MM/YYYY' },
  { key: 'end_date', he: 'סוף הייצוג, DD/MM/YYYY', en: 'End of the representation, DD/MM/YYYY' },
  { key: 'period_months', he: 'משך הייצוג בחודשים', en: 'Length of the representation in months' },
  { key: 'agency_name', he: 'שם הסוכנות (מהגדרות התבנית)', en: "The agency's name (from the template's settings)" },
  { key: 'today', he: 'התאריך שבו ההסכם נוצר, DD/MM/YYYY', en: 'The day the agreement was made, DD/MM/YYYY' },
];
const KEYS = new Set(AGREEMENT_PLACEHOLDERS.map((p) => p.key));
const SECTIONS = ['minor', 'adult'];

/** The phrase a signer-filled placeholder stays as in the text. */
export const SIGNER_FIELD_TEXT: Record<AgreementLang, Record<string, string>> = {
  he: { player_id_number: '(מספר הזהות של השחקן, כפי שנמסר ברשומת החתימה)', guardian_id_number: '(מספר הזהות של ההורה או האפוטרופוס, כפי שנמסר ברשומת החתימה)' },
  en: { player_id_number: "(the player's ID number, as given in the signing record)", guardian_id_number: "(the parent's or guardian's ID number, as given in the signing record)" },
};

/** Two years: the longest a representation contract may run under FIFA's agent rules. */
export const AGREEMENT_DEFAULT_MONTHS = 24;
export const AGREEMENT_MAX_MONTHS = 24;
export const AGREEMENT_TEXT_MAX = 60000;
export const ADULT_AGE = 18;

const DAY_MS = 86400000;
const MONTHS_IN_YEAR = 12;
const OLDEST_AGE = 120;
const LINE_MAX = 120;
const LONGEST_PERIOD_MONTHS = 240;
const NESTING_MAX = 20;
const ISO_DAY_LENGTH = 10;
const PAD = 2;

// A placeholder or a section mark, with its mark and name captured.
// Matches "{{player_name}}", "{{ #minor }}", "{{/adult}}"; rejects "{player_name}" and "{{Player}}".
// https://regex101.com/?regex=%5C%7B%5C%7B%5Cs*(%5B%23%2F%5D%3F)%5Cs*(%5Ba-z_%5D%2B)%5Cs*%5C%7D%5C%7D&testString=%7B%7Bplayer_name%7D%7D%20%7B%7B%20%23minor%20%7D%7D%20%7B%7BPlayer%7D%7D
const TAG = /\{\{\s*([#/]?)\s*([a-z_]+)\s*\}\}/g;
// Any double-brace pair at all, to catch a mistyped placeholder.
// Matches "{{ Player }}" and "{{}}"; rejects "{player}".
// https://regex101.com/?regex=%5C%7B%5C%7B(%5B%5E%7D%5D*)%5C%7D%5C%7D&testString=%7B%7B%20Player%20%7D%7D%20%7Bplayer%7D
const ANY_BRACES = /\{\{([^}]*)\}\}/g;
// The inside of a well-formed placeholder or section mark.
// Matches " #minor ", "player_name"; rejects " Player ", "player name".
// https://regex101.com/?regex=%5E%5Cs*%5B%23%2F%5D%3F%5Cs*%5Ba-z_%5D%2B%5Cs*%24&testString=%20%23minor%20
const WELL_FORMED = /^\s*[#/]?\s*[a-z_]+\s*$/;
// A calendar day as stored.
// Matches "2026-12-01"; rejects "1/12/2026" and "2026-12-1".
// https://regex101.com/?regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7D%24&testString=2026-12-01
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// A control character, which never belongs in a one-line value.
// Matches "\t" and "\n"; rejects "a" and " ".
// https://regex101.com/?regex=%5B%5Cu0000-%5Cu001f%5Cu007f%5D&testString=a%09b
const CONTROL = /[\u0000-\u001f\u007f]/g;
// A run of whitespace, collapsed to one space.
// Matches "  " and "\t "; rejects "a".
// https://regex101.com/?regex=%5Cs%2B&testString=a%20%20b
const SPACES = /\s+/g;
// One innermost {{#minor}}…{{/minor}} or {{#adult}}…{{/adult}} section (no other section opens inside it).
// Matches "{{#minor}}a parent signs{{/minor}}"; rejects "{{#minor}}a{{/adult}}".
// https://regex101.com/?regex=%5C%7B%5C%7B%5Cs*%23%5Cs*(minor%7Cadult)%5Cs*%5C%7D%5C%7D((%3F%3A(%3F!%5C%7B%5C%7B%5Cs*%23%5Cs*(%3F%3Aminor%7Cadult)%5Cs*%5C%7D%5C%7D)%5B%5Cs%5CS%5D)*%3F)%5C%7B%5C%7B%5Cs*%5C%2F%5Cs*%5C1%5Cs*%5C%7D%5C%7D&testString=%7B%7B%23minor%7D%7Da%20parent%20signs%7B%7B%2Fminor%7D%7D
const SECTION = /\{\{\s*#\s*(minor|adult)\s*\}\}((?:(?!\{\{\s*#\s*(?:minor|adult)\s*\}\})[\s\S])*?)\{\{\s*\/\s*\1\s*\}\}/g;
// A Windows or old Mac line end.
// Matches "\r\n" and "\r"; rejects "\n".
// https://regex101.com/?regex=%5Cr%5Cn%3F&testString=a%0D%0Ab
const CR = /\r\n?/g;
// Spaces or tabs at the end of a line.
// Matches "text  " (the two spaces); rejects "text".
// https://regex101.com/?regex=%5B%20%5Ct%5D%2B%24&testString=text%20%20
const TRAILING = /[ \t]+$/g;
// Three or more line ends in a row: more than one blank line.
// Matches "\n\n\n"; rejects "\n\n".
// https://regex101.com/?regex=%5Cn%7B3%2C%7D&testString=a%0A%0A%0Ab
const BLANKS = /\n{3,}/g;
// A heading line: one to three "#" and a space, the heading captured.
// Matches "# Term" and "## Fees"; rejects "#Term" and "Term #".
// https://regex101.com/?regex=%5E%23%7B1%2C3%7D%5Cs%2B(.*)%24&testString=%23%20Term
const HEADING = /^#{1,3}\s+(.*)$/;
// A Hebrew letter.
// Matches "הסכם"; rejects "Agreement".
// https://regex101.com/?regex=%5B%5Cu0590-%5Cu05ff%5D&testString=%D7%94%D7%A1%D7%9B%D7%9D
const HEBREW = /[֐-׿]/;

const pad = (n: number): string => String(n).padStart(PAD, '0');
const utcDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, ISO_DAY_LENGTH);

export interface TemplateCheck { ok: boolean; unknown: string[]; sections: string[]; used: string[]; empty: boolean; tooLong: boolean }

/**
 * What is wrong with a template, if anything:
 *   unknown   placeholders not in the fixed list
 *   sections  {{#minor}} / {{#adult}} that are not closed, or closed twice
 *   empty     no text at all; tooLong over AGREEMENT_TEXT_MAX
 * ok is true when nothing is.
 */
export function checkTemplate(text: unknown): TemplateCheck {
  const s = String(text ?? '');
  const tags = [...s.matchAll(TAG)].map((m) => ({ mark: m[1], key: m[2] }));
  const plain = tags.filter((x) => !x.mark);
  const marks = tags.filter((x) => x.mark);
  const unknownMarks = marks.filter((x) => !SECTIONS.includes(x.key)).map((x) => `${x.mark}${x.key}`);
  // Walk the section marks with a stack: a close that does not match the last open, or an open left over, is bad.
  const walked = marks.filter((x) => SECTIONS.includes(x.key)).reduce((acc, x) => {
    if (x.mark === '#') return { open: [...acc.open, x.key], bad: acc.open.includes(x.key) ? [...acc.bad, x.key] : acc.bad };
    return acc.open[acc.open.length - 1] === x.key ? { open: acc.open.slice(0, -1), bad: acc.bad } : { open: acc.open, bad: [...acc.bad, x.key] };
  }, { open: [] as string[], bad: [] as string[] });
  const typos = [...s.matchAll(ANY_BRACES)].map((m) => m[1]).filter((inside) => !WELL_FORMED.test(inside)).map((inside) => inside.trim() || '(empty)');
  const unknown = [...new Set([...plain.filter((x) => !KEYS.has(x.key)).map((x) => x.key), ...unknownMarks, ...typos])];
  const sections = [...new Set([...walked.bad, ...walked.open])];
  const used = [...new Set(plain.filter((x) => KEYS.has(x.key)).map((x) => x.key))];
  const empty = !s.trim();
  const tooLong = s.length > AGREEMENT_TEXT_MAX;
  return { ok: !unknown.length && !sections.length && !empty && !tooLong, unknown, sections, used, empty, tooLong };
}

/** 2026-12-01 → 01/12/2026 ('' for anything that is not a date). */
export function dayText(v: unknown): string {
  const s = toDateStr(v);
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** Whole years between a birthday and a day (both YYYY-MM-DD), or null. */
export function ageOn(dob: unknown, day: string): number | null {
  const b = toDateStr(dob);
  if (!b || !ISO_DAY.test(day)) return null;
  const [by, bm, bd] = b.split('-').map(Number);
  const [ty, tm, td] = day.split('-').map(Number);
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 0 && age < OLDEST_AGE ? age : null;
}

/** True when the player is under 18 on that day; null when his date of birth is not known. */
export function isMinorOn(dob: unknown, day: string): boolean | null {
  const age = ageOn(dob, day);
  return age === null ? null : age < ADULT_AGE;
}

/** A real calendar day as 'YYYY-MM-DD' (not 2026-02-30). */
const isDay = (s: unknown): s is string => typeof s === 'string' && ISO_DAY.test(s) && !isNaN(utcDay(s)) && dayOf(utcDay(s)) === s;

/** 'YYYY-MM-DD' plus n months; the 31st of a short month falls back to its last day. */
export function addMonthsToDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const total = y * MONTHS_IN_YEAR + (m - 1) + n;
  const ny = Math.floor(total / MONTHS_IN_YEAR), nm = total % MONTHS_IN_YEAR;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}

/** The last day of a period of n months from start: 2026-12-01 + 24 → 2028-11-30. */
export function periodEnd(start: string, months: number): string {
  return dayOf(utcDay(addMonthsToDay(start, months)) - DAY_MS);
}

/** Whole months a period covers, rounded up (a period that ends a few days early still counts its months). */
export function monthsBetween(start: string, end: string): number {
  const found = Array.from({ length: LONGEST_PERIOD_MONTHS }, (_, i) => i + 1).find((n) => periodEnd(start, n) >= end);
  return found ?? LONGEST_PERIOD_MONTHS + 1;
}

export type PeriodError = 'start' | 'end' | 'order' | 'months' | 'tooLong';
export type PeriodResult = { ok: true; start: string; end: string; months: number } | { ok: false; error: PeriodError; maxMonths: number };

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * The representation's dates, checked.
 *   start          'YYYY-MM-DD', required
 *   end | months   one of them; neither → defaultMonths
 *   maxMonths      the template's longest period
 * Returns { ok: true, start, end, months } or { ok: false, error, maxMonths }.
 */
export function agreementPeriod({ start, end, months, defaultMonths = AGREEMENT_DEFAULT_MONTHS, maxMonths = AGREEMENT_MAX_MONTHS }:
  { start?: unknown; end?: unknown; months?: unknown; defaultMonths?: number; maxMonths?: number }): PeriodResult {
  const max = Math.max(1, Math.floor(Number(maxMonths) || AGREEMENT_MAX_MONTHS));
  const fail = (error: PeriodError): PeriodResult => ({ ok: false, error, maxMonths: max });
  if (!isDay(start)) return fail('start');
  if (present(end)) {
    if (!isDay(end)) return fail('end');
    if (end <= start) return fail('order');
    if (end > periodEnd(start, max)) return fail('tooLong');
    return { ok: true, start, end, months: monthsBetween(start, end) };
  }
  const n = present(months) ? Math.floor(Number(months)) : Math.floor(Number(defaultMonths) || AGREEMENT_DEFAULT_MONTHS);
  if (!Number.isFinite(n) || n < 1) return fail('months');
  if (n > max) return fail('tooLong');
  return { ok: true, start, end: periodEnd(start, n), months: n };
}

export interface AgreementValues {
  player_name?: string;
  player_dob?: string;
  guardian_name?: string;
  start_date?: string;
  end_date?: string;
  period_months?: string;
  agency_name?: string;
  today?: string;
}

const oneLine = (v: unknown, max = LINE_MAX): string => String(v ?? '').replace(CONTROL, ' ').replace(SPACES, ' ').trim().slice(0, max);

/** The values an agreement is filled with, from what the server knows when it is made. */
export function agreementValues({ playerName, dob, guardianName, start, end, months, agencyName, today }:
  { playerName?: string; dob?: unknown; guardianName?: string; start: string; end: string; months: number; agencyName?: string; today?: string }): AgreementValues {
  return {
    player_name: oneLine(playerName),
    player_dob: dayText(dob),
    guardian_name: oneLine(guardianName),
    start_date: dayText(start),
    end_date: dayText(end),
    period_months: String(months),
    agency_name: oneLine(agencyName) || 'Gold A&S',
    today: dayText(today || israelDate()),
  };
}

/** Drops or keeps the innermost sections until none is left (bounded, for a template nested too deep). */
function resolveSections(text: string, minor: boolean, depth = 0): string {
  const next = text.replace(SECTION, (_m, name: string, body: string) => ((name === 'minor') === minor ? body : ''));
  return next === text || depth >= NESTING_MAX ? next : resolveSections(next, minor, depth + 1);
}

/**
 * The template with its sections kept or dropped and its placeholders filled.
 * Signer fields become their fixed phrase. Returns the text and the
 * placeholders the template used that had no value (so the caller can refuse).
 */
export function fillTemplate(text: string, values: AgreementValues, { minor = false, lang = 'he' }: { minor?: boolean; lang?: AgreementLang } = {}): { text: string; missing: string[] } {
  const phrases = SIGNER_FIELD_TEXT[lang === 'en' ? 'en' : 'he'];
  const missing = new Set<string>();
  const filled = resolveSections(String(text ?? '').replace(CR, '\n'), minor).replace(TAG, (whole, mark: string, key: string) => {
    if (mark) return '';
    if (phrases[key]) return phrases[key];
    if (!KEYS.has(key)) return whole;
    const v = (values as Record<string, string | undefined>)[key];
    if (!v) { missing.add(key); return '—'; }
    return v;
  });
  // A dropped section leaves empty lines behind: never more than one blank line in a row.
  const tidy = filled.split('\n').map((l) => l.replace(TRAILING, '')).join('\n').replace(BLANKS, '\n\n').trim();
  return { text: tidy, missing: [...missing] };
}

export interface AgreementBlock { type: 'h' | 'p'; text: string }

/**
 * The text as blocks to show or print: a line that starts with "#" is a
 * heading; lines separated by an empty line are paragraphs, and a single
 * line break inside a paragraph stays a line break ("\n" in its text).
 */
export function agreementBlocks(text: string): AgreementBlock[] {
  const lines = String(text ?? '').replace(CR, '\n').split('\n').map((l) => l.trim());
  const done = lines.reduce((acc, line) => {
    const flushed = acc.para.length ? [...acc.out, { type: 'p' as const, text: acc.para.join('\n') }] : acc.out;
    if (!line) return { out: flushed, para: [] as string[] };
    const h = HEADING.exec(line);
    if (h) return { out: [...flushed, { type: 'h' as const, text: h[1].trim() }], para: [] as string[] };
    return { out: acc.out, para: [...acc.para, line] };
  }, { out: [] as AgreementBlock[], para: [] as string[] });
  return done.para.length ? [...done.out, { type: 'p', text: done.para.join('\n') }] : done.out;
}

/** True when the text reads right to left (it holds Hebrew). */
export const isRtlText = (s: unknown): boolean => HEBREW.test(String(s ?? ''));
