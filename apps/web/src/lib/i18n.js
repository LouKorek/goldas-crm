// Two languages, one dictionary. Every interface string goes through t():
// the key is the English text as written in the code, the Hebrew comes from
// src/i18n/he.js. A key without a Hebrew entry falls back to English, so a
// forgotten string is visible, never a crash.
//
// Hebrew (RTL) is the default; English is a click away. Switching language
// reloads the page: module-level labels (navigation, column lists) are
// resolved once at load, and a reload is simpler and safer than making every
// constant reactive.
import HE from '../i18n/he.js';

export const LANGS = ['he', 'en'];
const KEY = 'lang';

function initialLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {}
  return 'he';
}

let lang = initialLang();

export const getLang = () => lang;
export const isRtl = () => lang === 'he';
export const dir = () => (isRtl() ? 'rtl' : 'ltr');

/** Apply lang/dir to the document (called once at startup, before render). */
export function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = dir();
  document.documentElement.dataset.lang = lang;
}

/** Persist the choice and reload so every label is re-resolved. */
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  try { localStorage.setItem(KEY, next); } catch {}
  lang = next;
  if (typeof window !== 'undefined') window.location.reload();
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Translate an interface string. `vars` fills {name} placeholders in both
 * languages, so a message can be built without string concatenation:
 *   t('{n} players found', { n: 3 })
 */
export function t(key, vars) {
  if (key === undefined || key === null) return '';
  const k = String(key);
  let out = k;
  if (lang === 'he') {
    const hit = HE[k] ?? HE[norm(k)];
    if (hit) {
      // Preserve the leading/trailing whitespace of JSX text fragments so
      // "Upcoming matches (" keeps its spacing against the expression next to it.
      const lead = k.match(/^\s*/)[0], tail = k.match(/\s*$/)[0];
      out = lead + hit + tail;
    }
  }
  if (vars) for (const [name, v] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(v));
  return out;
}

/** Translate a stored value (status, role, position…) for display only. */
export const tv = (value) => (value === undefined || value === null || value === '' ? '' : t(String(value)));

/** Israeli formats: 12/10/26, ₪ / €, Hebrew weekday names. */
export const locale = () => (lang === 'he' ? 'he-IL' : 'en-GB');

export const fmtNumber = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(locale()));

export const fmtLongDate = (d, opts = { weekday: 'long', day: '2-digit', month: 'long' }) => {
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? String(d || '') : dt.toLocaleDateString(locale(), opts);
};

export const fmtDateTime = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dt.toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** Relative label for a day offset: today / tomorrow / in N days / N days ago. */
export const relDays = (days) => {
  if (days === null || days === undefined) return '';
  if (days === 0) return t('Today');
  if (days === 1) return t('Tomorrow');
  if (days === -1) return t('Yesterday');
  if (days > 0) return t('in {n} days', { n: days });
  return t('{n} days ago', { n: -days });
};
