import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

// Brand image + label shown briefly when navigating to a top-level route.
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

export default function RouteTransition() {
  const { pathname } = useLocation();
  const [overlay, setOverlay] = useState(null);
  const firstRender = useRef(true);

  useEffect(() => {
    // Skip the very first render — the splash already covers app launch.
    if (firstRender.current) { firstRender.current = false; return; }
    const entry = ROUTE_IMAGE[pathname];
    if (!entry) return;
    setOverlay({ ...entry, phase: 'in' });
    const t1 = setTimeout(() => setOverlay(o => o && { ...o, phase: 'out' }), 320);
    const t2 = setTimeout(() => setOverlay(null), 680);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [pathname]);

  if (!overlay) return null;
  const showing = overlay.phase === 'in';
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundImage: `linear-gradient(rgba(10,21,12,0.72), rgba(10,21,12,0.92)), url("${overlay.src}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundColor: '#0E1B11',
      opacity: showing ? 1 : 0,
      transition: 'opacity 0.36s ease',
      pointerEvents: 'none',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 64, height: 64, borderRadius: 14, overflow: 'hidden',
          border: '1.5px solid rgba(201,168,76,0.5)',
          boxShadow: '0 6px 30px rgba(201,168,76,0.35)',
          margin: '0 auto 14px',
          transform: showing ? 'scale(1)' : 'scale(0.94)',
          transition: 'transform 0.36s ease',
        }}>
          <img src="/logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        <div style={{
          fontFamily: 'Cormorant Garamond, serif',
          fontSize: 28, fontWeight: 700,
          background: 'linear-gradient(135deg, #E8C96A, #C9A84C, #A07830)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          letterSpacing: '0.04em',
          lineHeight: 1,
        }}>{overlay.label}</div>
        <div style={{
          marginTop: 8,
          fontSize: 10, color: 'rgba(122,155,124,0.85)',
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
        }}>Gold A&amp;S</div>
      </div>
    </div>
  );
}
