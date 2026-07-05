import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from 'lib/firebase';
import { useRole, roleLabel } from 'lib/roleContext';
import RouteTransition from 'components/ui/RouteTransition';
import RadialMenu from 'components/ui/RadialMenu';

const NAV = [
  { section: 'Overview' },
  { label: 'Dashboard',         path: '/dashboard',       emoji: '◈' },
  { section: 'Players' },
  { label: 'Represented',       path: '/players',         emoji: '🤝' },
  { label: 'Matches',           path: '/matches',         emoji: '🏟' },
  { label: 'Contacts',          path: '/contacts',        emoji: '📇' },
  { section: 'Transfer Window' },
  { label: 'Club Requirements', path: '/requirements',    emoji: '📋' },
  { label: 'Men',               path: '/pipeline/men',    emoji: '🏃', color: '#4ADE80' },
  { label: 'Women',             path: '/pipeline/women',  emoji: '🏃‍♀️', color: '#F472B6' },
  { label: 'Youth',             path: '/pipeline/youth',  emoji: '🌱', color: '#60A5FA' },
  { label: 'Jewish',            path: '/pipeline/jewish', emoji: '✡️', color: '#A78BFA' },
  { section: 'System' },
  { label: 'Tasks',             path: '/tasks',           emoji: '✅', ownerOnly: true },
  { label: 'Notifications',     path: '/notifications',   emoji: '🔔' },
  { label: 'Team',              path: '/team',            emoji: '👥', adminOnly: true },
];

// Bottom nav for mobile - 5 most important destinations
const BOTTOM_NAV = [
  { label: 'Home',     path: '/dashboard',     icon: '◈' },
  { label: 'Players',  path: '/players',       icon: '🤝' },
  { label: 'Matches',  path: '/matches',       icon: '🏟' },
  { label: 'Clubs',    path: '/requirements',  icon: '📋' },
  { label: 'More',     path: '__more__',       icon: '⋯' },
];

export default function Layout({ user }) {
  const location              = useLocation();
  const [open, setOpen]       = useState(false);
  const [theme, setTheme]     = useState(() => localStorage.getItem('theme') || 'dark');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true');
  const { name, role, isAdmin } = useRole();
  const isOwner = user?.email === 'lou.korek@gmail.com';
  const info = { name: name || user?.email, role: roleLabel(role) };

  useEffect(() => {
    document.body.classList.toggle('light-mode', theme === 'light');
    localStorage.setItem('theme', theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', theme === 'light' ? '#F7F3EC' : '#0E1B11');
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  // Mobile only — strictly axis-lock the scroll inside .table-wrap so a single
  // swipe goes EITHER horizontal OR vertical, never both. We block the browser's
  // native scrolling on the wrap (preventDefault) once we've decided the axis,
  // and drive the chosen axis manually from touchmove deltas. A short momentum
  // tail after release keeps the gesture feeling natural.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    let state  = null;
    let raf    = null;
    const stopMomentum = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };

    const onStart = (e) => {
      stopMomentum();
      const wrap = e.target.closest && e.target.closest('.table-wrap');
      if (!wrap) { state = null; return; }
      const t = e.touches[0];
      state = {
        wrap,
        x0: t.clientX, y0: t.clientY,
        sx: wrap.scrollLeft, sy: wrap.scrollTop,
        axis: null,
        lastX: t.clientX, lastY: t.clientY,
        lastT: performance.now(),
        vx: 0, vy: 0,
      };
    };

    const onMove = (e) => {
      if (!state) return;
      const t  = e.touches[0];
      const dx = t.clientX - state.x0;
      const dy = t.clientY - state.y0;
      if (!state.axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        state.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      // Hard-lock to the chosen axis: cancel the browser's bi-directional
      // scroll, then drive only the locked axis ourselves.
      if (e.cancelable) e.preventDefault();
      if (state.axis === 'x') {
        state.wrap.scrollLeft = state.sx - dx;
      } else {
        state.wrap.scrollTop  = state.sy - dy;
      }
      // Velocity sample for momentum (px / sec on the locked axis).
      const now = performance.now();
      const dt  = Math.max(1, now - state.lastT);
      if (state.axis === 'x') state.vx = ((t.clientX - state.lastX) / dt) * 1000;
      else                    state.vy = ((t.clientY - state.lastY) / dt) * 1000;
      state.lastX = t.clientX; state.lastY = t.clientY; state.lastT = now;
    };

    const onEnd = () => {
      if (!state || !state.axis) { state = null; return; }
      const wrap = state.wrap;
      const axis = state.axis;
      let v = axis === 'x' ? -state.vx : -state.vy; // scroll moves opposite to finger
      state = null;
      if (Math.abs(v) < 120) return;             // tiny flick — skip momentum
      const friction = 0.93;
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (axis === 'x') wrap.scrollLeft += v * dt;
        else              wrap.scrollTop  += v * dt;
        v *= Math.pow(friction, dt * 60);
        if (Math.abs(v) > 30) raf = requestAnimationFrame(tick);
        else                  raf = null;
      };
      raf = requestAnimationFrame(tick);
    };

    document.addEventListener('touchstart',  onStart, { passive: true  });
    document.addEventListener('touchmove',   onMove,  { passive: false });
    document.addEventListener('touchend',    onEnd,   { passive: true  });
    document.addEventListener('touchcancel', onEnd,   { passive: true  });
    return () => {
      stopMomentum();
      document.removeEventListener('touchstart',  onStart);
      document.removeEventListener('touchmove',   onMove);
      document.removeEventListener('touchend',    onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  // Close drawer when navigating
  useEffect(() => { setOpen(false); }, [location.pathname]);

  // Lock scroll while drawer open (mobile)
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [open]);

  const SidebarContent = ({ isMobile = false }) => (
    <>
      {/* Logo — IDENTICAL geometry in both states. The icon never moves;
          the text on its right only fades. */}
      <div style={{
        padding: '14px 12px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9, flexShrink: 0, overflow: 'hidden',
            border: '1px solid rgba(201,168,76,0.3)',
            boxShadow: '0 2px 10px rgba(201,168,76,0.18)',
          }}>
            <img src="/logo.png" alt="Gold A&S" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div style={{
            overflow: 'hidden',
            opacity: (collapsed && !isMobile) ? 0 : 1,
            transition: 'opacity 0.2s ease',
            pointerEvents: (collapsed && !isMobile) ? 'none' : 'auto',
          }}>
            <div style={{
              fontFamily: 'Cormorant Garamond,serif',
              fontSize: 16, fontWeight: 700, lineHeight: 1,
              background: 'linear-gradient(135deg, var(--gold-lt), var(--gold))',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              whiteSpace: 'nowrap',
            }}>Gold A&S</div>
            <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 1, letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>gold-as.com</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '6px 6px', overflowY: 'auto', overflowX: 'hidden' }}>
        {NAV.map((item, i) => {
          if (item.adminOnly && !isAdmin) return null;
          if (item.ownerOnly && !isOwner) return null;
          if (item.section) {
            /* Section header keeps an EXPLICIT fixed height in both states
               so the stack of NavLinks below it cannot shift vertically.
               Only the text fades out. */
            const isCollapsedOnDesktop = collapsed && !isMobile;
            return (
              <div key={i} style={{
                color: 'var(--text-3)', fontSize: 8.5, fontWeight: 700,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                height: 30,
                lineHeight: '30px',
                paddingLeft: 8,
                opacity: isCollapsedOnDesktop ? 0 : 1,
                transition: 'opacity 0.2s ease',
                boxSizing: 'border-box',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}>{item.section}</div>
            );
          }
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          const isCollapsedDesktop = collapsed && !isMobile;
          return (
            <NavLink key={i} to={item.path} onClick={() => isMobile && setOpen(false)}
              style={{
                /* Every NavLink is the SAME physical box in both states:
                   identical padding, identical height. Only the
                   right-hand text label fades — the icon never moves
                   vertically OR horizontally. */
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 12px',
                height: 36,
                borderRadius: 8,
                marginBottom: 2,
                textDecoration: 'none',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--text-1)' : 'var(--text-2)',
                background: isActive ? 'rgba(201,168,76,0.10)' : 'transparent',
                transition: 'background 0.18s ease, color 0.18s ease',
                position: 'relative',
                overflow: 'hidden',
                boxSizing: 'border-box',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'var(--text-1)'; } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-2)'; } }}
            >
              {isActive && !isCollapsedDesktop && (
                <span style={{
                  position: 'absolute', left: 0, top: '22%', bottom: '22%',
                  width: 3, background: 'var(--gold)',
                  borderRadius: '0 3px 3px 0',
                  boxShadow: '0 0 8px rgba(201,168,76,0.5)',
                }} />
              )}
              {/* Icon — fixed-width, never moves */}
              <span style={{
                fontSize: 16,
                flexShrink: 0,
                width: 18,
                textAlign: 'center',
                lineHeight: 1,
              }} title={isCollapsedDesktop ? item.label : ''}>{item.emoji}</span>
              {/* Label — fades + collapses horizontally when the rail
                  shrinks, but the icon to its left does NOT shift. */}
              <span style={{
                color: isActive ? (item.color || 'var(--gold)') : 'inherit',
                fontSize: 11.5,
                whiteSpace: 'nowrap',
                opacity: isCollapsedDesktop ? 0 : 1,
                transition: 'opacity 0.18s ease',
                pointerEvents: isCollapsedDesktop ? 'none' : 'auto',
              }}>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* User + collapse — wider horizontal padding when collapsed so the
          theme & toggle buttons get breathing room from the rail edge. */}
      <div style={{
        borderTop: '1px solid var(--border)',
        padding: (collapsed && !isMobile) ? '12px 13px' : '10px',
        transition: 'padding 0.45s cubic-bezier(0.16,1,0.3,1)',
      }}>
        {(!collapsed || isMobile) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '0 2px' }}>
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, rgba(201,168,76,0.25), rgba(201,168,76,0.1))',
              border: '1px solid rgba(201,168,76,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--gold)', fontWeight: 700, fontSize: 12,
            }}>{info.name?.charAt(0)}</div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{
                fontSize: 11.5, color: 'var(--text-1)', fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>{info.name}</div>
              <div style={{ fontSize: 9.5, color: 'var(--text-3)' }}>{info.role}</div>
            </div>
          </div>
        )}
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center',
          justifyContent: collapsed && !isMobile ? 'center' : 'space-between'
        }}>
          {(!collapsed || isMobile) && (
            <button className="btn btn-ghost btn-sm" onClick={() => signOut(auth)}
              style={{ fontSize: 10, color: 'var(--red)', borderColor: 'rgba(248,113,113,0.2)', padding: '5px 9px' }}>
              Sign out
            </button>
          )}
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              style={{
                background: 'rgba(201,168,76,0.08)',
                border: '1px solid rgba(201,168,76,0.2)',
                borderRadius: 7, color: 'var(--gold)', cursor: 'pointer',
                width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, transition: 'all 0.2s', flexShrink: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(201,168,76,0.16)'; e.currentTarget.style.transform = 'rotate(20deg)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(201,168,76,0.08)'; e.currentTarget.style.transform = 'rotate(0)'; }}
              title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            >{theme === 'dark' ? '☀️' : '🌙'}</button>
            {!isMobile && (
              <button onClick={() => setCollapsed(v => !v)}
                style={{
                  background: 'rgba(201,168,76,0.1)',
                  border: '1px solid rgba(201,168,76,0.2)',
                  borderRadius: 7, color: 'var(--gold)', cursor: 'pointer',
                  width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 700, transition: 'all 0.2s', flexShrink: 0,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(201,168,76,0.18)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(201,168,76,0.1)'}
                title={collapsed ? 'Expand' : 'Collapse'}
              >{collapsed ? '›' : '‹'}</button>
            )}
          </div>
        </div>
      </div>
    </>
  );

  // Is the "More" tab active for bottom nav?
  const moreActive = !BOTTOM_NAV.some(n => n.path !== '__more__' && (
    location.pathname === n.path || location.pathname.startsWith(n.path)
  ));

  return (
    <div className="layout-root" style={{ display: 'flex', minHeight: '100vh' }}>

      {/* Brand image overlay shown briefly on each top-level route change */}
      <RouteTransition />

      {/* Mobile radial menu — replaces the old slide-out drawer */}
      <RadialMenu open={open} onClose={() => setOpen(false)} />

      {/* Mobile top bar */}
      <div
        className="mobile-topbar"
        style={{
          display: 'none',
          position: 'fixed', top: 0, left: 0, right: 0,
          height: 'calc(54px + env(safe-area-inset-top, 0px))',
          background: 'rgba(22,32,25,0.92)',
          WebkitBackdropFilter: 'blur(18px) saturate(140%)',
          backdropFilter: 'blur(18px) saturate(140%)',
          borderBottom: '1px solid var(--border)',
          alignItems: 'center', justifyContent: 'space-between',
          paddingLeft: 14, paddingRight: 14,
          paddingTop: 'env(safe-area-inset-top, 0px)',
          zIndex: 50,
          boxShadow: '0 2px 14px rgba(0,0,0,0.35)',
          boxSizing: 'border-box',
        }}
      >
        <button
          onClick={() => setOpen(true)}
          style={{
            background: 'none', border: 'none',
            color: 'var(--gold)', fontSize: 22, cursor: 'pointer', padding: 4,
            transition: 'transform 0.18s',
          }}
          onTouchStart={e => e.currentTarget.style.transform = 'scale(0.9)'}
          onTouchEnd={e => e.currentTarget.style.transform = ''}
        >&#9776;</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8, overflow: 'hidden',
            border: '1px solid rgba(201,168,76,0.3)',
            boxShadow: '0 2px 8px rgba(201,168,76,0.2)',
          }}>
            <img src="/logo.png" alt="Gold A&S" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <span style={{
            fontFamily: 'Cormorant Garamond,serif',
            fontSize: 18, fontWeight: 700,
            background: 'linear-gradient(135deg, var(--gold-lt), var(--gold))',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>Gold A&S</span>
        </div>
        <button
          onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          style={{
            background: 'rgba(201,168,76,0.10)',
            border: '1px solid rgba(201,168,76,0.22)',
            borderRadius: 8, color: 'var(--gold)', cursor: 'pointer',
            width: 32, height: 32, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 15, transition: 'transform 0.25s',
          }}
          onTouchStart={e => e.currentTarget.style.transform = 'scale(0.92) rotate(15deg)'}
          onTouchEnd={e => e.currentTarget.style.transform = ''}
        >{theme === 'dark' ? '☀️' : '🌙'}</button>
      </div>

      {/* Desktop sidebar */}
      <aside
        className="desktop-sidebar"
        style={{
          /* Slightly wider collapsed rail (62px instead of 54) so the
             theme + toggle buttons sit comfortably away from the edge. */
          width: collapsed ? 62 : 210,
          background: 'var(--surface-1)',
          borderRight: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          position: 'sticky', top: 0, height: '100vh',
          flexShrink: 0, overflow: 'hidden',
          /* Longer + softer easing so the rail glides like a drawer
             rather than snapping. Matches the .45s feel of premium
             SaaS sidebars. */
          transition: 'width 0.45s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <SidebarContent isMobile={false} />
      </aside>

      {/* Mobile drawer removed — replaced by RadialMenu above */}

      {/* Main content. We deliberately do NOT set overflow:auto on <main>
          — that turns <main> into a scroll container that on mobile silently
          eats touch events even when nothing actually overflows it, breaking
          page scroll on the Dashboard etc. Document-level scrolling is what
          we want: the body scrolls naturally when content exceeds the
          viewport, the mobile top-bar (position:fixed) stays pinned, and
          our internal scroll wrappers (e.g. .matches-scroll, .table-wrap)
          still create their own scroll regions where they need to. */}
      <main
        className="main-content"
        key={location.pathname}
        style={{ flex: 1, padding: '18px 20px', minHeight: '100vh' }}
      >
        <Outlet />
      </main>

      {/* Bottom nav (mobile only) */}
      <nav className="bottom-nav" aria-label="Primary">
        {BOTTOM_NAV.map(item => {
          if (item.path === '__more__') {
            return (
              <button
                key={item.label}
                onClick={() => setOpen(true)}
                className={`bottom-nav-item${moreActive ? ' active' : ''}`}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <span className="icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          }
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={`bottom-nav-item${isActive ? ' active' : ''}`}
            >
              <span className="icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <style>{`
        @media (max-width: 768px) {
          .desktop-sidebar { display: none !important; }
          .mobile-topbar   { display: flex !important; }
        }
        @media (min-width: 769px) {
          .mobile-sidebar { display: none !important; }
        }
      `}</style>
    </div>
  );
}
