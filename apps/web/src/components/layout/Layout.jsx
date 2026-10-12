import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import Icon from 'components/ui/Icons';
import { signOut } from 'firebase/auth';
import { auth } from 'lib/firebase';
import { useRole, roleLabel } from 'lib/roleContext';
import NavIndex from 'components/ui/NavIndex';
import GlobalSearch from 'components/ui/GlobalSearch';
import { AREAS, BOTTOM, areaOf, visibleItems } from 'lib/nav';
import { t, getLang, setLang } from 'lib/i18n';

// The app shell: a collapsible rail of the seven areas on desktop, a top bar
// plus five-button bottom bar on the phone, one global search (button and
// Ctrl+K) and the language / theme switches. Every destination comes from
// lib/nav.js, so nothing here knows the list of screens.
export default function Layout({ user }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true');
  const { name, role, isAdmin } = useRole();
  const info = { name: name || user?.email, role: roleLabel(role) };
  const area = areaOf(location.pathname);
  const lang = getLang();

  useEffect(() => {
    document.body.classList.toggle('light-mode', theme === 'light');
    localStorage.setItem('theme', theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', theme === 'light' ? '#F7F3EC' : '#0E1B11');
  }, [theme]);

  useEffect(() => { localStorage.setItem('sidebar-collapsed', String(collapsed)); }, [collapsed]);

  // Ctrl+K / Cmd+K opens the search anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close the index when navigating; lock scroll while it is open.
  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const toggleLang = () => setLang(lang === 'he' ? 'en' : 'he');

  const SquareBtn = ({ onClick, title, children, size = 28 }) => (
    <button onClick={onClick} title={title} aria-label={title}
      style={{
        background: 'transparent', border: '1px solid var(--border-2)', borderRadius: 0,
        color: 'var(--gold)', cursor: 'pointer', width: size, height: size,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
        transition: 'border-color 0.12s linear',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--gold)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-2)'; }}
    >{children}</button>
  );

  const Sidebar = () => (
    <>
      <div style={{ padding: '16px 12px', borderBottom: '1px solid var(--border-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, flexShrink: 0, overflow: 'hidden', border: '1px solid var(--gold-dk)' }}>
            <img src="/logo.png" alt="Gold A&S" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div style={{ overflow: 'hidden', opacity: collapsed ? 0 : 1, transition: 'opacity 0.2s ease', pointerEvents: collapsed ? 'none' : 'auto' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700, lineHeight: 1, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-1)', whiteSpace: 'nowrap' }}>Gold A&amp;S</div>
            <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 3, letterSpacing: lang === 'he' ? 0 : '0.18em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{t('Football Agency')}</div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '10px 10px 2px' }}>
        <button onClick={() => setSearchOpen(true)} className="shell-search" title={t('Search')}
          style={{
            width: '100%', height: 34, display: 'flex', alignItems: 'center', gap: 10,
            padding: collapsed ? 0 : '0 10px', justifyContent: collapsed ? 'center' : 'flex-start',
            background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-3)',
            cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
          }}>
          <Icon name="search" size={14} />
          {!collapsed && <span style={{ flex: 1, textAlign: 'start' }}>{t('Search')}</span>}
          {!collapsed && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-mute)' }}>Ctrl K</span>}
        </button>
      </div>

      {/* Areas */}
      <nav style={{ flex: 1, padding: '6px 0 10px', overflowY: 'auto', overflowX: 'hidden' }}>
        {AREAS.map((a, i) => {
          const items = visibleItems(a.items, { isAdmin });
          if (!items.length) return null;
          const active = area === a.key;
          const showChildren = active && !collapsed && items.length > 1;
          return (
            <div key={a.key}>
              <NavLink to={a.path} title={collapsed ? a.label : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', height: 36,
                  textDecoration: 'none', position: 'relative',
                  fontWeight: active ? 600 : 400,
                  color: active ? 'var(--text-1)' : 'var(--text-2)',
                  background: active ? 'var(--surface-2)' : 'transparent',
                  transition: 'background 0.12s linear, color 0.12s linear',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-1)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                {active && <span style={{ position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, width: 2, background: 'var(--gold)' }} />}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: active ? 'var(--gold)' : 'var(--gold-dk)', width: 16, flexShrink: 0, display: collapsed ? 'none' : 'block' }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ flexShrink: 0, width: 18, display: 'flex', justifyContent: 'center', color: active ? 'var(--gold)' : 'inherit' }}><Icon name={a.icon} size={15} /></span>
                <span style={{ fontSize: 12.5, whiteSpace: 'nowrap', opacity: collapsed ? 0 : 1, transition: 'opacity 0.18s ease' }}>{a.label}</span>
              </NavLink>
              {showChildren && (
                <div style={{ padding: '2px 0 6px', background: 'var(--surface-1)' }}>
                  {items.map((it) => {
                    const on = location.pathname === it.path || (it.path !== a.path && location.pathname.startsWith(it.path) && it.path.length > 1);
                    return (
                      <NavLink key={it.path} to={it.path}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, height: 30,
                          padding: '0 12px 0 0', paddingInlineStart: 56, textDecoration: 'none',
                          fontSize: 12, color: on ? 'var(--gold)' : 'var(--text-3)',
                        }}>
                        <span style={{ width: 4, height: 4, background: on ? 'var(--gold)' : 'var(--border-2)', flexShrink: 0 }} />
                        {it.label}
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* User + switches */}
      <div style={{ borderTop: '1px solid var(--border)', padding: collapsed ? '12px 13px' : 10 }}>
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '0 2px' }}>
            <div style={{ width: 30, height: 30, flexShrink: 0, border: '1px solid var(--gold-dk)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', fontWeight: 700, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{info.name?.charAt(0)}</div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-1)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.name}</div>
              <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 1 }}>{t(info.role)}</div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: collapsed ? 'center' : 'space-between', flexWrap: 'wrap' }}>
          {!collapsed && (
            <button className="btn btn-ghost btn-sm" onClick={() => signOut(auth)} style={{ color: 'var(--text-3)', borderColor: 'var(--border)', padding: '5px 10px' }}>{t('Sign out')}</button>
          )}
          <div style={{ display: 'flex', gap: 5, flexDirection: collapsed ? 'column' : 'row' }}>
            <SquareBtn onClick={toggleLang} title={t('Language')}>{lang === 'he' ? 'EN' : 'עב'}</SquareBtn>
            <SquareBtn onClick={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))} title={theme === 'dark' ? t('Light Mode') : t('Dark Mode')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} /></SquareBtn>
            <SquareBtn onClick={() => setCollapsed((v) => !v)} title={collapsed ? t('Expand') : t('Collapse')}>
              <Icon name="chevron" size={13} style={{ transform: (collapsed ? (lang === 'he') : (lang !== 'he')) ? 'rotate(180deg)' : 'none' }} />
            </SquareBtn>
          </div>
        </div>
      </div>
    </>
  );

  const moreActive = !BOTTOM.some((n) => n.key !== 'more' && n.key === area);

  return (
    <div className="layout-root" style={{ display: 'flex', minHeight: '100vh' }}>
      <NavIndex open={open} onClose={() => setOpen(false)} onSearch={() => { setOpen(false); setSearchOpen(true); }} />
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Mobile top bar */}
      <div className="mobile-topbar" style={{
        display: 'none', position: 'fixed', top: 0, insetInlineStart: 0, insetInlineEnd: 0,
        height: 'calc(var(--topbar-h) + env(safe-area-inset-top, 0px))',
        background: 'var(--surface-1)', borderBottom: '1px solid var(--border-2)',
        alignItems: 'center', justifyContent: 'space-between', padding: '0 12px',
        paddingTop: 'env(safe-area-inset-top, 0px)', zIndex: 50, boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 26, height: 26, overflow: 'hidden', border: '1px solid var(--gold-dk)' }}>
            <img src="/logo.png" alt="Gold A&S" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--text-1)' }}>Gold A&amp;S</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <SquareBtn size={36} onClick={() => setSearchOpen(true)} title={t('Search')}><Icon name="search" size={15} /></SquareBtn>
          <SquareBtn size={36} onClick={toggleLang} title={t('Language')}>{lang === 'he' ? 'EN' : 'עב'}</SquareBtn>
          <SquareBtn size={36} onClick={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))} title={t('Toggle theme')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} /></SquareBtn>
        </div>
      </div>

      {/* Desktop rail */}
      <aside className="desktop-sidebar" style={{
        width: collapsed ? 62 : 224, background: 'var(--surface-1)', borderInlineEnd: '1px solid var(--border-2)',
        display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh',
        flexShrink: 0, overflow: 'hidden', transition: 'width 0.3s cubic-bezier(0.2,0,0,1)',
      }}>
        <Sidebar />
      </aside>

      <main className="main-content" style={{ flex: 1, padding: '18px 20px', minHeight: '100vh' }}>
        <Outlet />
      </main>

      {/* Bottom bar (phone) */}
      <nav className="bottom-nav" aria-label={t('Menu')}>
        {BOTTOM.map((item) => {
          if (item.key === 'more') {
            return (
              <button key={item.key} onClick={() => setOpen(true)} className={`bottom-nav-item${moreActive ? ' active' : ''}`} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                <span className="icon"><Icon name={item.icon} size={17} /></span>
                <span>{item.label}</span>
              </button>
            );
          }
          const isActive = area === item.key;
          return (
            <NavLink key={item.key} to={item.path} className={`bottom-nav-item${isActive ? ' active' : ''}`} onClick={(e) => { if (isActive) { e.preventDefault(); navigate(item.path); } }}>
              <span className="icon"><Icon name={item.icon} size={17} /></span>
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
