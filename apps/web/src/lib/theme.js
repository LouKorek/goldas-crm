// Day / night theme. The choice is per device (localStorage) and applied as
// data-theme on <html>, so theme.css tokens switch before React renders.
// index.html runs applyTheme() inline at startup to avoid a flash.
import { useEffect, useState } from 'react';

const KEY = 'theme';
const LIGHT_BAR = '#F6F3EC';
const DARK_BAR = '#121410';

export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {}
  return 'light';
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? DARK_BAR : LIGHT_BAR);
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch {}
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

/** React hook: [theme, toggle]. Every subscriber follows one switch. */
export function useTheme() {
  const [theme, set] = useState(readTheme);
  useEffect(() => {
    const on = (e) => set(e.detail);
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);
  const toggle = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  return [theme, toggle];
}
