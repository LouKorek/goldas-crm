// The agency's public look, shared by every private link the site gives out:
// the live player page (/p/<token>, pages/PlayerPage.jsx) and the signing
// page of a representation agreement (/sign/<token>, pages/SignPage.jsx).
// It is gold-as.com, not the CRM's theme, so it looks the same whichever
// theme the CRM is in; this file is the one place its colours are written
// out. Each page adds only the rules of its own parts (Shell's css).
import React, { useEffect } from 'react';

export const GREEN = '#0d3d2e';
export const CARD = 'rgb(13,28,21)';
export const GOLD = '#c9a227';
export const INK = '#f4f0e6';
export const MUTED = 'rgba(244,240,230,0.64)';
export const RULE = 'rgba(201,162,39,0.24)';
// Paper: where an agreement's text is read and a signature is drawn, dark ink on a light sheet in either theme.
export const PAPER = '#fbf8f0';
export const PAPER_INK = '#1d1a14';
// What is missing or wrong in a form: the border, and the text of its message.
export const ERROR = '#e48b7a';
export const ERROR_INK = '#f3c2b8';
export const LOGO = '/logo.png';

const BASE_CSS = `
@font-face { font-family: 'Bebas Neue'; font-weight: 400; font-display: swap; src: url('/fonts/BebasNeue-400.ttf') format('truetype'); }
/* The CRM locks html and body to the window's height (its content pane scrolls); this page scrolls itself the same way. */
.pp { height: 100vh; height: 100dvh; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; background: ${GREEN}; color: ${INK}; font-family: 'Heebo', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.5;
  padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(28px + env(safe-area-inset-bottom, 0px)); -webkit-font-smoothing: antialiased; }
.pp *, .pp *::before, .pp *::after { box-sizing: border-box; }
.pp-wrap { width: 100%; max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
.pp-stack { display: grid; gap: 16px; min-width: 0; align-content: start; }
.pp-top { display: flex; align-items: center; gap: 12px; padding: 4px 2px 8px; }
.pp-logo { width: 44px; height: 44px; border-radius: 10px; border: 1px solid ${RULE}; object-fit: cover; flex: none; }
.pp-brand { font-family: 'Bebas Neue', 'Heebo', sans-serif; font-size: 24px; letter-spacing: 0.08em; line-height: 1; color: ${GOLD}; }
.pp-sub { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${MUTED}; margin-top: 4px; }
.pp[dir="rtl"] .pp-sub, .pp[dir="rtl"] .pp-label, .pp[dir="rtl"] .pp-fig-k, .pp[dir="rtl"] .pp-eyebrow { letter-spacing: 0; text-transform: none; }
.pp-note { border: 1px solid ${RULE}; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: ${GOLD}; background: rgba(201,162,39,0.08); }
.pp-card { background: ${CARD}; border: 1px solid ${RULE}; border-radius: 18px; padding: 20px; min-width: 0; }
.pp-eyebrow { font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: ${GOLD}; font-weight: 700; }
.pp-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: auto; }
.pp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 12px 20px; border-radius: 12px; font: inherit; font-weight: 700; font-size: 14.5px; text-decoration: none; cursor: pointer; flex: 1 1 200px; text-align: center; border: 1px solid ${GOLD}; transition: filter 0.15s ease, background 0.15s ease; }
.pp-btn-gold { background: ${GOLD}; color: ${CARD}; }
.pp-btn-line { background: transparent; color: ${GOLD}; }
.pp-btn:hover { filter: brightness(1.08); }
.pp-btn-line:hover { background: rgba(201,162,39,0.1); }
.pp-btn:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }
.pp a:focus-visible, .pp button:focus-visible, .pp input:focus-visible, .pp select:focus-visible, .pp canvas:focus-visible { outline: 2px solid ${INK}; outline-offset: 3px; }
.pp-label { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: ${GOLD}; font-weight: 700; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid ${RULE}; }
.pp-row { display: grid; grid-template-columns: minmax(96px, 34%) minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid rgba(244,240,230,0.08); }
.pp-row:last-child { border-bottom: 0; padding-bottom: 0; }
.pp-row dt { color: ${MUTED}; font-size: 13.5px; }
.pp-row dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.pp-more { display: inline-block; margin-top: 12px; color: ${GOLD}; font-size: 13.5px; }
.pp-foot { text-align: center; color: ${MUTED}; font-size: 13px; padding: 10px 0 0; display: grid; gap: 6px; }
.pp-foot a { color: ${GOLD}; text-decoration: none; font-weight: 700; }
.pp-foot small { font-size: 11.5px; opacity: 0.85; }
.pp-center { min-height: 100%; display: flex; align-items: center; justify-content: center; }
.pp-msg { max-width: 420px; text-align: center; display: grid; gap: 14px; justify-items: center; padding: 32px 24px; }
.pp-msg img { width: 84px; height: 84px; border-radius: 18px; border: 1px solid ${RULE}; }
.pp-msg p { margin: 0; font-size: 16px; line-height: 1.6; }
.pp-pulse { animation: pp-pulse 1.4s ease-in-out infinite; }
@keyframes pp-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pp-pulse { animation: none; } .pp-btn { transition: none; } }
@media (min-width: 760px) {
  .pp { padding: 28px 28px 40px; font-size: 16px; }
  .pp-wrap, .pp-stack { gap: 20px; }
  .pp-card { padding: 24px; }
  .pp-btn { flex: 0 1 auto; }
}
`;

export const hasHebrew = (s) => /[֐-׿]/.test(String(s || ''));

/** Head tags a private page needs, taken back when the page is left. */
export function usePrivatePage(title) {
  useEffect(() => {
    const added = [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']].map(([name, content]) => {
      const m = document.createElement('meta'); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    const theme = document.querySelector('meta[name="theme-color"]');
    const was = { theme: theme?.getAttribute('content'), bg: document.body.style.background };
    theme?.setAttribute('content', GREEN);
    document.body.style.background = GREEN;
    return () => { added.forEach((m) => m.remove()); if (theme && was.theme) theme.setAttribute('content', was.theme); document.body.style.background = was.bg; };
  }, []);
  useEffect(() => { document.title = title; }, [title]);
}

/** The page itself: the public look, plus the rules of the page's own parts. */
export function Shell({ lang = 'en', css = '', children }) {
  return (
    <main className="pp" lang={lang} dir={lang === 'he' ? 'rtl' : 'ltr'}>
      <style>{BASE_CSS + css}</style>
      {children}
    </main>
  );
}

/** The agency's mark while a page loads. */
export function Loading() {
  return <Shell><div className="pp-center"><img className="pp-logo pp-pulse" src={LOGO} alt="Gold A&S" style={{ width: 72, height: 72, borderRadius: 16 }} /></div></Shell>;
}

/** One calm sentence, in both languages: the page cannot know which the reader wants. */
export function Message({ en, he, action, children }) {
  return (
    <Shell>
      <div className="pp-center">
        <div className="pp-card pp-msg">
          <img src={LOGO} alt="Gold A&S" />
          <p lang="en">{en}</p>
          <p lang="he" dir="rtl">{he}</p>
          {children}
          {action}
          <a className="pp-more" href="https://gold-as.com" rel="noreferrer noopener" style={{ marginTop: 0 }}>gold-as.com</a>
        </div>
      </div>
    </Shell>
  );
}

export const BROKEN = { en: 'The page could not be loaded. Please try again in a moment.', he: 'לא הצלחנו לטעון את העמוד. נסו שוב בעוד רגע.' };

// A visitor never meets the CRM's own error screen: whatever breaks, the page
// answers in its own voice.
export class Guard extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  render() { return this.state.broken ? <Message en={BROKEN.en} he={BROKEN.he} /> : this.props.children; }
}
