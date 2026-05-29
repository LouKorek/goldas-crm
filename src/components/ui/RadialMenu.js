import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useRole } from 'lib/roleContext';

// All navigable items, grouped by their sidebar section. Each section has
// a colour tint so users can spot where they are on the dial.
const ITEMS = [
  { section: 'Overview',        path: '/dashboard',       emoji: '◈',  label: 'Dashboard' },
  { section: 'Players',         path: '/players',         emoji: '🤝', label: 'Represented' },
  { section: 'Players',         path: '/matches',         emoji: '🏟', label: 'Matches' },
  { section: 'Players',         path: '/contacts',        emoji: '📇', label: 'Contacts' },
  { section: 'Transfer Window', path: '/requirements',    emoji: '📋', label: 'Requirements' },
  { section: 'Transfer Window', path: '/pipeline/men',    emoji: '🏃', label: 'Men' },
  { section: 'Transfer Window', path: '/pipeline/women',  emoji: '🏃‍♀️', label: 'Women' },
  { section: 'Transfer Window', path: '/pipeline/youth',  emoji: '🌱', label: 'Youth' },
  { section: 'Transfer Window', path: '/pipeline/jewish', emoji: '✡️', label: 'Jewish' },
  { section: 'System',          path: '/notifications',   emoji: '🔔', label: 'Notifications' },
  { section: 'System',          path: '/team',            emoji: '👥', label: 'Team', adminOnly: true },
];

const SECTION_TINT = {
  'Overview':        { bg: 'rgba(201,168,76,0.18)',  edge: 'rgba(201,168,76,0.45)' },
  'Players':         { bg: 'rgba(232,201,106,0.18)', edge: 'rgba(232,201,106,0.45)' },
  'Transfer Window': { bg: 'rgba(96,165,250,0.18)',  edge: 'rgba(96,165,250,0.45)' },
  'System':          { bg: 'rgba(167,139,250,0.18)', edge: 'rgba(167,139,250,0.45)' },
};

const SIZE      = 320;   // wheel diameter, px
const R_ITEM    = 112;   // distance from centre to item ring
const ITEM_SIZE = 52;    // item button diameter
const ACTIVE_SCALE = 1.18;

const norm = (a) => ((a % 360) + 360) % 360;

export default function RadialMenu({ open, onClose }) {
  const { isAdmin }  = useRole();
  const navigate     = useNavigate();
  const { pathname } = useLocation();

  const items = useMemo(() => ITEMS.filter(it => !it.adminOnly || isAdmin), [isAdmin]);
  const N     = items.length;
  const step  = 360 / N;

  // On open, spin so the current screen is at 12 o'clock.
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    if (!open) return;
    const i = items.findIndex(it => pathname === it.path || pathname.startsWith(it.path + '/'));
    setRotation(i >= 0 ? -(i * step + step / 2) : 0);
  }, [open, pathname, items, step]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const wheelRef = useRef(null);
  const dragRef  = useRef(null);

  if (!open) return null;

  const angleOf = (cx, cy) => {
    const rect = wheelRef.current.getBoundingClientRect();
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top  + rect.height / 2);
    return Math.atan2(dy, dx) * 180 / Math.PI;
  };
  const startDrag = (cx, cy) => { dragRef.current = { last: angleOf(cx, cy), moved: 0 }; };
  const moveDrag  = (cx, cy) => {
    if (!dragRef.current) return;
    const a = angleOf(cx, cy);
    let d = a - dragRef.current.last;
    if (d >  180) d -= 360;
    if (d < -180) d += 360;
    dragRef.current.last   = a;
    dragRef.current.moved += Math.abs(d);
    setRotation(r => r + d);
  };
  const endDrag = () => { const m = dragRef.current; dragRef.current = null; return m; };

  // Item closest to top (angle 0° after our -90° rotation).
  let activeIdx = 0, minDist = 999;
  items.forEach((it, i) => {
    const a = norm(i * step + step / 2 + rotation);
    const dist = Math.min(a, 360 - a);
    if (dist < minDist) { minDist = dist; activeIdx = i; }
  });
  const activeItem = items[activeIdx];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'rm-fade 0.22s ease',
      }}
    >
      <style>{`
        @keyframes rm-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes rm-pop  { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>

      {/* Close X */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 14px)',
          right: 14,
          width: 38, height: 38, borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: 'var(--text-1)', fontSize: 18, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        aria-label="Close menu"
      >×</button>

      {/* The wheel */}
      <div
        ref={wheelRef}
        onClick={(e) => e.stopPropagation()}
        onMouseDown ={(e) => startDrag(e.clientX, e.clientY)}
        onMouseMove ={(e) => moveDrag(e.clientX, e.clientY)}
        onMouseUp   ={endDrag}
        onMouseLeave={endDrag}
        onTouchStart={(e) => startDrag(e.touches[0].clientX, e.touches[0].clientY)}
        onTouchMove ={(e) => { e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }}
        onTouchEnd  ={endDrag}
        style={{
          position: 'relative',
          width: SIZE, height: SIZE,
          borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 40%, rgba(36,52,40,1) 0%, rgba(16,28,20,1) 70%, rgba(10,21,12,1) 100%)',
          border: '1.5px solid rgba(201,168,76,0.35)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.55), inset 0 0 50px rgba(201,168,76,0.08)',
          touchAction: 'none',
          userSelect: 'none',
          animation: 'rm-pop 0.32s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Selector marker at 12 o'clock */}
        <div style={{
          position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '9px solid transparent', borderRight: '9px solid transparent',
          borderTop: '14px solid var(--gold)',
          filter: 'drop-shadow(0 0 8px rgba(201,168,76,0.7))',
        }} />

        {/* Outer ring guide */}
        <div style={{
          position: 'absolute', inset: 18,
          borderRadius: '50%',
          border: '1px dashed rgba(201,168,76,0.18)',
          pointerEvents: 'none',
        }} />

        {/* Items */}
        {items.map((it, i) => {
          const angDeg = i * step + step / 2 + rotation - 90;  // 0° = top
          const angRad = angDeg * Math.PI / 180;
          const cx = SIZE / 2 + R_ITEM * Math.cos(angRad);
          const cy = SIZE / 2 + R_ITEM * Math.sin(angRad);
          const isActive = i === activeIdx;
          const tint = SECTION_TINT[it.section];
          return (
            <button
              key={it.path}
              onClick={(e) => {
                e.stopPropagation();
                if (dragRef.current && dragRef.current.moved > 8) return;
                navigate(it.path);
                onClose();
              }}
              style={{
                position: 'absolute',
                left: cx - ITEM_SIZE / 2, top: cy - ITEM_SIZE / 2,
                width: ITEM_SIZE, height: ITEM_SIZE,
                borderRadius: '50%',
                background: tint.bg,
                border: `1.5px solid ${isActive ? 'var(--gold)' : tint.edge}`,
                color: 'var(--text-1)',
                fontSize: 22,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
                transform: `scale(${isActive ? ACTIVE_SCALE : 1})`,
                boxShadow: isActive ? '0 0 24px rgba(201,168,76,0.55)' : '0 4px 14px rgba(0,0,0,0.45)',
                transition: 'transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
              }}
              title={it.label}
            >{it.emoji}</button>
          );
        })}

        {/* Centre hub */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          pointerEvents: 'none',
          width: 130,
        }}>
          <div style={{
            fontSize: 9.5, color: 'var(--text-3)',
            letterSpacing: '0.22em', textTransform: 'uppercase',
            fontWeight: 600,
          }}>{activeItem?.section}</div>
          <div style={{
            marginTop: 6,
            fontFamily: 'Cormorant Garamond, serif',
            fontSize: 22, fontWeight: 700, lineHeight: 1.1,
            background: 'linear-gradient(135deg, #E8C96A, #C9A84C)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>{activeItem?.label}</div>
        </div>
      </div>

      {/* Hint */}
      <div style={{
        position: 'absolute',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)',
        left: '50%', transform: 'translateX(-50%)',
        fontSize: 11, color: 'rgba(255,255,255,0.55)',
        letterSpacing: '0.08em',
        whiteSpace: 'nowrap',
      }}>
        Spin the dial or tap an icon to navigate
      </div>
    </div>
  );
}
