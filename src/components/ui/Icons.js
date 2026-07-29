import React from 'react';

// Geometric icon set — replaces emoji throughout the app chrome.
// Every glyph is drawn on the same 16×16 grid with square caps and a
// single stroke weight, so the navigation reads as one engineered set
// rather than a bag of pictures. Emoji survive only where they are
// content (a player's note), never where they are interface.

const P = {
  stroke: 'currentColor',
  strokeWidth: 1.4,
  fill: 'none',
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
};

const GLYPHS = {
  // Overview
  dashboard: <><rect x="2" y="2" width="5" height="5" {...P} /><rect x="9" y="2" width="5" height="5" {...P} /><rect x="2" y="9" width="5" height="5" {...P} /><rect x="9" y="9" width="5" height="5" {...P} /></>,
  social:    <><rect x="2" y="2" width="12" height="12" {...P} /><circle cx="8" cy="8" r="3" {...P} /><path d="M11.5 4.5h.01" {...P} strokeWidth="2" /></>,
  // Players
  players:   <><circle cx="8" cy="5" r="2.6" {...P} /><path d="M2.5 14v-1.2C2.5 10.7 5 9.4 8 9.4s5.5 1.3 5.5 3.4V14" {...P} /></>,
  matches:   <><rect x="2" y="3" width="12" height="11" {...P} /><path d="M2 6.5h12M5.5 2v2.5M10.5 2v2.5" {...P} /><path d="M7 9.5h2v2H7z" {...P} /></>,
  contacts:  <><rect x="2" y="3" width="12" height="10" {...P} /><path d="M2 6h12" {...P} /><path d="M5 9h3M5 11h5" {...P} /></>,
  // Transfer window
  clipboard: <><rect x="3" y="3" width="10" height="11" {...P} /><path d="M6 2h4v2H6z" {...P} /><path d="M5.5 7.5h5M5.5 10h3" {...P} /></>,
  men:       <><circle cx="8" cy="4" r="2" {...P} /><path d="M8 6.2v4.3M8 10.5l-2.4 3.3M8 10.5l2.4 3.3M4.6 7.6L8 6.8l3.4.8" {...P} /></>,
  women:     <><circle cx="8" cy="4" r="2" {...P} /><path d="M8 6.2v3.6M5.2 13.8L8 9.8l2.8 4M4.6 7.6L8 6.8l3.4.8" {...P} /></>,
  youth:     <><circle cx="8" cy="5" r="1.7" {...P} /><path d="M8 6.9v3.4M8 10.3l-1.8 2.6M8 10.3l1.8 2.6M5.4 8.1L8 7.5l2.6.6" {...P} /><path d="M2.5 14h11" {...P} /></>,
  star:      <><path d="M8 1.8l2.1 3.6h4.1l-2 3.5 2 3.5h-4.1L8 16l-2.1-3.6H1.8l2-3.5-2-3.5h4.1z" {...P} transform="scale(0.86) translate(1.3 0.4)" /></>,
  // System
  tasks:     <><rect x="2.5" y="2.5" width="11" height="11" {...P} /><path d="M5.2 8.2l2 2 3.6-4" {...P} /></>,
  bell:      <><path d="M4 11.5V7.4A4 4 0 0 1 12 7.4v4.1h1V13H3v-1.5z" {...P} /><path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0" {...P} /></>,
  team:      <><circle cx="6" cy="5.4" r="2.2" {...P} /><path d="M1.8 13.6v-.9c0-1.8 1.9-2.9 4.2-2.9s4.2 1.1 4.2 2.9v.9" {...P} /><path d="M11 4.2a2.2 2.2 0 0 1 0 4.3M11.6 10.2c1.6.3 2.6 1.2 2.6 2.5v.9" {...P} /></>,
  // Utility
  refresh:   <><path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.9" {...P} /><path d="M13.6 2.6v3.2h-3.2" {...P} /></>,
  chevron:   <><path d="M6 3.5L10.5 8 6 12.5" {...P} /></>,
  close:     <><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" {...P} /></>,
  menu:      <><path d="M2.5 4h11M2.5 8h11M2.5 12h11" {...P} /></>,
  sun:       <><circle cx="8" cy="8" r="3" {...P} /><path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" {...P} /></>,
  moon:      <><path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.7 5.7 0 1 0 6.6 6.6z" {...P} /></>,
  search:    <><circle cx="7" cy="7" r="4.3" {...P} /><path d="M10.2 10.2L14 14" {...P} /></>,
  plus:      <><path d="M8 3v10M3 8h10" {...P} /></>,
  edit:      <><path d="M11.2 2.6l2.2 2.2-8 8-3 .8.8-3z" {...P} /></>,
  trash:     <><path d="M3 4.5h10M6.4 4.5V3h3.2v1.5M4.4 4.5l.7 9h5.8l.7-9" {...P} /></>,
  copy:      <><rect x="5" y="5" width="9" height="9" {...P} /><path d="M11 5V2H2v9h3" {...P} /></>,
  external:  <><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5" {...P} /><path d="M11.5 9.5v4h-9v-9h4" {...P} /></>,
};

export default function Icon({ name, size = 16, style, title }) {
  const glyph = GLYPHS[name];
  if (!glyph) return null;
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={{ display: 'block', flexShrink: 0, ...style }}>
      {title && <title>{title}</title>}
      {glyph}
    </svg>
  );
}

export { GLYPHS };
