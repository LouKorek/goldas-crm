import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import Icon from 'components/ui/Icons';
import { signOut } from 'firebase/auth';
import { auth } from 'lib/firebase';
import { useRole, roleLabel } from 'lib/roleContext';
import RouteTransition from 'components/ui/RouteTransition';
import NavIndex from 'components/ui/NavIndex';

// Sections are numbered like chapters in a dossier — the rail reads as a
// document index rather than a list of buttons.
const NAV = [
  { section: 'Overview',        num: '01' },
  { label: 'Dashboard',         path: '/dashboard',       icon: 'dashboard' },
  { label: 'Social',            path: '/social',          icon: 'social' },
  { section: 'Players',         num: '02' },
  { label: 'Represented',       path: '/players',         icon: 'players' },
  { label: 'Matches',           path: '/matches',         icon: 'matches' },
  { label: 'Contacts',          path: '/contacts',        icon: 'contacts' },
  { section: 'Transfer Window', num: '03' },
  { label: 'Club Requirements', path: '/requirements',    icon: 'clipboard' },
  { label: 'Men',               path: '/pipeline/men',    icon: 'men' },
  { label: 'Women',             path: '/pipeline/women',  icon: 'women' },
  { label: 'Youth',             path: '/pipeline/youth',  icon: 'youth' },
  { label: 'Jewish',            path: '/pipeline/jewish', icon: 'star' },
  { section: 'System',          num: '04' },
  { label: 'My Tasks',          path: '/tasks',           icon: 'tasks' },
  { label: 'Notifications',     path: '/notifications',   icon: 'bell' },
  { label: 'Team',              path: '/team',            icon: 'team', adminOnly: true },
];

// Bottom nav for mobile - 5 most important destinations
const BOTTOM_NAV = [
  { label: 'Home',     path: '/dashboard',     icon: 'dashboard' },
  { label: 'Players',  path: '/players',       icon: 'players' },
  { label: 'Matches',  path: '/matches',       icon: 'matches' },
  { label: 'Clubs',    path: '/requirements',  icon: 'clipboard' },
  { label: 'More',     path: '__more__',       icon: 'menu' },
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
        padding: '16px 12px',
        borderBottom: '1px solid var(--border-2)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 0, flexShrink: 0, overflow: 'hidden',
            border: '1px solid var(--gold-dk)',
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
              fontFamily: 'var(--font-display)',
              fontSize: 13, fontWeight: 700, lineHeight: 1,
              letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--text-1)',
              whiteSpace: 'nowrap',
            }}>Gold A&amp;S</div>
            <div style={{ fontSize: 8.5, color: 'var(--text-3)', marginTop: 3, letterSpacing: '0.18em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Football Agency</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '4px 0 10px', overflowY: 'auto', overflowX: 'hidden' }}>
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
                display: 'flex', alignItems: 'center', gap: 8,
                color: 'var(--text-mute)', fontSize: 8.5, fontWeight: 700,
                letterSpacing: '0.16em', textTransform: 'uppercase',
                height: 34,
                paddingLeft: 12, paddingRight: 10,
                marginTop: i === 0 ? 6 : 10,
                opacity: isCollapsedOnDesktop ? 0 : 1,
                transition: 'opacity 0.2s ease',
                boxSizing: 'border-box',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--gold-dk)', letterSpacing: 0 }}>{item.num}</span>
                <span>{item.section}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
              </div>
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
                height: 34,
                borderRadius: 0,
                marginBottom: 0,
                textDecoration: 'none',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--text-1)' : 'var(--text-2)',
                background: isActive ? 'var(--surface-2)' : 'transparent',
                transition: 'background 0.12s linear, color 0.12s linear',
                position: 'relative',
                overflow: 'hidden',
                boxSizing: 'border-box',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = 'var(--surface-1)'; e.currentTarget.style.color = 'var(--text-1)'; } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-2)'; } }}
            >
              {isActive && (
                <span style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0,
                  width: 2, background: 'var(--gold)',
                }} />
              )}
              {/* Icon — fixed-width, never moves */}
              <span style={{
                flexShrink: 0, width: 18,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: isActive ? 'var(--gold)' : 'inherit',
              }} title={isCollapsedDesktop ? item.label : ''}>
                <Icon name={item.icon} size={15} />
              </span>
              {/* Label — fades + collapses horizontally when the rail
                  shrinks, but the icon to its left does NOT shift. */}
              <span style={{
                color: 'inherit',
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
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
              width: 30, height: 30, borderRadius: 0, flexShrink: 0,
              background: 'transparent',
              border: '1px solid var(--gold-dk)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--gold)', fontWeight: 700, fontSize: 12,
              fontFamily: 'var(--font-mono)',
            }}>{info.name?.charAt(0)}</div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{
                fontSize: 11.5, color: 'var(--text-1)', fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>{info.name}</div>
              <div style={{ fontSize: 8.5, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 1 }}>{info.role}</div>
            </div>
          </div>
        )}
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center',
          justifyContent: collapsed && !isMobile ? 'center' : 'space-between'
        }}>
          {(!collapsed || isMobile) && (
            <button className="btn btn-ghost btn-sm" onClick={() => signOut(auth)}
              style={{ color: 'var(--text-3)', borderColor: 'var(--border)', padding: '5px 10px' }}>
              Sign out
            </button>
          )}
          <div style={{ display: 'flex', gap: 5 }}>
            <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
              style={{
                background: 'transparent',
                border: '1px solid var(--border-2)',
                borderRadius: 0, color: 'var(--gold)', cursor: 'pointer',
                width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'border-color 0.12s linear', flexShrink: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--gold)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-2)'; }}
              title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            ><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} /></button>
            {!isMobile && (
              <button onClick={() => setCollapsed(v => !v)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-2)',
                  borderRadius: 0, color: 'var(--gold)', cursor: 'pointer',
                  width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'border-color 0.12s linear', flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--gold)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-2)'; }}
                title={collapsed ? 'Expand' : 'Collapse'}
              ><Icon name="chevron" size={13} style={{ transform: collapsed ? 'none' : 'rotate(180deg)' }} /></button>
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

      {/* Mobile navigation — full-screen editorial index */}
      <NavIndex open={open} onClose={() => setOpen(false)} />

      {/* Mobile top bar */}
      <div
        className="mobile-topbar"
        style={{
          display: 'none',
          position: 'fixed', top: 0, left: 0, right: 0,
          height: 'calc(var(--topbar-h) + env(safe-area-inset-top, 0px))',
          background: 'var(--surface-1)',
          borderBottom: '1px solid var(--border-2)',
          alignItems: 'center', justifyContent: 'space-between',
          paddingLeft: 14, paddingRight: 14,
          paddingTop: 'env(safe-area-inset-top, 0px)',
          zIndex: 50,
          boxSizing: 'border-box',
        }}
      >
        <button
          onClick={() => setOpen(true)}
          aria-label="Menu"
          style={{
            background: 'none', border: 'none',
            color: 'var(--gold)', cursor: 'pointer', padding: 6,
            display: 'flex', alignItems: 'center',
          }}
        ><Icon name="menu" size={18} /></button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 0, overflow: 'hidden',
            border: '1px solid var(--gold-dk)',
          }}>
            <img src="/logo.png" alt="Gold A&S" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontSize: 12, fontWeight: 700,
            letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--text-1)',
          }}>Gold A&amp;S</span>
        </div>
        <button
          onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
          style={{
            background: 'transparent',
            border: '1px solid var(--border-2)',
            borderRadius: 0, color: 'var(--gold)', cursor: 'pointer',
            width: 32, height: 32, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        ><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /></button>
      </div>

      {/* Desktop sidebar */}
      <aside
        className="desktop-sidebar"
        style={{
          /* Slightly wider collapsed rail (62px instead of 54) so the
             theme + toggle buttons sit comfortably away from the edge. */
          width: collapsed ? 62 : 214,
          background: 'var(--surface-1)',
          borderRight: '1px solid var(--border-2)',
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

      {/* Mobile drawer removed — replaced by NavIndex above */}

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
                <span className="icon"><Icon name={item.icon} size={17} /></span>
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
              <span className="icon"><Icon name={item.icon} size={17} /></span>
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
