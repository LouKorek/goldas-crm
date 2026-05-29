import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

// Brand image + label shown when navigating to a top-level route.
// Each screen has its own scene so the transition feels intentional, not
// random. Sub-routes (e.g. team) fall through to the default.
const ROUTE_IMAGE = {
  '/dashboard':       { src: '/photos/About.png',        label: 'Dashboard' },
  '/players':         { src: '/photos/Signed.png',       label: 'Represented' },
  '/matches':         { src: '/photos/Stadium.png',      label: 'Matches' },
  '/contacts':        { src: '/photos/Table.png',        label: 'Contacts' },
  '/requirements':    { src: '/photos/Brand.png',        label: 'Club Requirements' },
  '/pipeline/men':    { src: '/photos/Tunnel1.png',      label: 'Men' },
  '/pipeline/women':  { src: '/photos/Tunnel2.png',      label: 'Women' },
  '/pipeline/youth':  { src: '/photos/Scouting1.png',    label: 'Youth' },
  '/pipeline/jewish': { src: '/photos/Stadium_Road.png', label: 'Jewish' },
  '/notifications':   { src: '/photos/Scouting2.png',    label: 'Notifications' },
  '/team':            { src: '/photos/Services.png',     label: 'Team' },
};

// Timings (ms). Keep these tuned together: HOLD_MS is the time the overlay
// stays fully opaque; FADE_MS is the in/out fade length on each side.
const FADE_MS = 400;
const HOLD_MS = 900;

export default function RouteTransition() {
  const { pathname } = useLocation();
  const [overlay, setOverlay] = useState(null);
  // Skip the FIRST matched route the app lands on — the launch splash already
  // covered that arrival. This also handles the "/" → "/dashboard" redirect
  // so the dashboard overlay doesn't fire immediately after the splash.
  const landed = useRef(false);

  useEffect(() => {
    const entry = ROUTE_IMAGE[pathname];
    if (!entry) return;
    if (!landed.current) { landed.current = true; return; }
    setOverlay({ ...entry, phase: 'in' });
    const t1 = setTimeout(() => setOverlay(o => o && { ...o, phase: 'out' }), FADE_MS + HOLD_MS);
    const t2 = setTimeout(() => setOverlay(null), FADE_MS + HOLD_MS + FADE_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [pathname]);

  if (!overlay) return null;
  const showing = overlay.phase === 'in';
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: '#0E1B11',
      opacity: showing ? 1 : 0,
      transition: `opacity ${FADE_MS}ms ease`,
      pointerEvents: 'none',
      overflow: 'hidden',
    }}>
      {/* Local keyframes for the Ken-Burns zoom + title rise. */}
      <style>{`
        @keyframes rt-zoom { from { transform: scale(1); } to { transform: scale(1.06); } }
        @keyframes rt-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes rt-line { from { width: 0; opacity: 0; } to { width: 84px; opacity: 1; } }
      `}</style>

      {/* Background image (zooms in slowly during the transition). */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `url("${overlay.src}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        animation: `rt-zoom ${FADE_MS + HOLD_MS + FADE_MS}ms ease-out forwards`,
      }} />

      {/* Dark gradient for legibility — lighter than before so the photo reads. */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, rgba(10,21,12,0.55) 0%, rgba(10,21,12,0.78) 100%)',
      }} />

      {/* Foreground: logo + screen name + accent line. */}
      <div style={{
        position: 'relative', zIndex: 1, textAlign: 'center',
        animation: `rt-rise ${FADE_MS}ms cubic-bezier(0.16,1,0.3,1) both`,
      }}>
        <div style={{
          width: 96, height: 96, borderRadius: 20, overflow: 'hidden',
          border: '1.5px solid rgba(201,168,76,0.55)',
          boxShadow: '0 0 0 6px rgba(201,168,76,0.10), 0 12px 50px rgba(201,168,76,0.45)',
          margin: '0 auto 22px',
        }}>
          <img src="/logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        <div style={{
          fontFamily: 'Cormorant Garamond, serif',
          fontSize: 44, fontWeight: 700,
          background: 'linear-gradient(135deg, #F0D27E 0%, #E8C96A 35%, #C9A84C 65%, #A07830 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          letterSpacing: '0.04em',
          lineHeight: 1.05,
          textShadow: '0 4px 24px rgba(0,0,0,0.55)',
        }}>{overlay.label}</div>

        {/* Slim animated gold underline. */}
        <div style={{
          height: 2, background: 'linear-gradient(90deg, transparent, #C9A84C, transparent)',
          margin: '14px auto 12px',
          animation: `rt-line ${FADE_MS + 120}ms ease-out forwards`,
        }} />

        <div style={{
          fontSize: 11, color: 'rgba(168,196,170,0.85)',
          letterSpacing: '0.28em',
          textTransform: 'uppercase',
        }}>Gold A&amp;S — Football Agency</div>
      </div>
    </div>
  );
}
