import React, { useState, useEffect, useRef } from 'react';
import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import Icon from 'components/ui/Icons';
import { signOut } from 'firebase/auth';
import { auth } from 'lib/firebase';
import { useRole, roleLabel } from 'lib/roleContext';
import GlobalSearch from 'components/ui/GlobalSearch';
import MoreScreen from 'components/layout/MoreScreen';
import { AREAS, BOTTOM, DESTINATIONS, areaOf, visibleItems } from 'lib/nav';
import { t, getLang, setLang } from 'lib/i18n';
import { useTheme } from 'lib/theme';
import { useAlertCount } from 'lib/useAlertCount';
import { ShellContext } from 'lib/shellContext';

// The app shell ("חדר הבקרה"): on the desktop a 76px rail of the eight areas
// with the brand tile on top and the night switch and user menu at the
// bottom, plus a top bar with the breadcrumb, the global search and the
// bell. On the phone a five-button bottom bar (home, players, market,
// Golda, more); the search and bell live in each page's own top row.
// Every destination comes from lib/nav.js.
export default function Layout({ user }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const { name, role, isAdmin, email } = useRole();
  const alertCount = useAlertCount(email || user?.email);
  const info = { name: name || user?.email || '', role: roleLabel(role) };
  const area = areaOf(location.pathname);
  const lang = getLang();
  const menuRef = useRef(null);

  // Ctrl+K / Cmd+K opens the search anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Close overlays when navigating; lock scroll while "more" is open.
  useEffect(() => { setMoreOpen(false); setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [moreOpen]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const toggleLang = () => setLang(lang === 'he' ? 'en' : 'he');
  const initials = (info.name || '?').trim().slice(0, 2);
  const areaDef = AREAS.find((a) => a.key === area);
  const here = DESTINATIONS.find((d) => d.path === location.pathname)
    || DESTINATIONS.filter((d) => d.path.length > 1 && location.pathname.startsWith(d.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const moreActive = !BOTTOM.some((n) => n.key !== 'more' && n.key === area);
  const themeLabel = theme === 'dark' ? t('Light Mode') : t('Dark Mode');

  const bell = (size = 40) => (
    <Link to="/notifications" className="iconbtn" aria-label={alertCount ? t('{n} active alerts', { n: alertCount }) : t('Notifications')} title={t('Notifications')} style={{ width: size, height: size }}>
      <Icon name="bell" size={18} />
      {alertCount > 0 && <span className="dot">{alertCount > 99 ? '99+' : alertCount}</span>}
    </Link>
  );

  return (
    <ShellContext.Provider value={{ openSearch: () => setSearchOpen(true), alertCount }}>
      <div className="layout-root" style={{ display: 'flex', minHeight: '100vh' }}>
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
        {moreOpen && (
          <MoreScreen
            onClose={() => setMoreOpen(false)}
            onSearch={() => { setMoreOpen(false); setSearchOpen(true); }}
            theme={theme} onToggleTheme={toggleTheme}
            lang={lang} onToggleLang={toggleLang}
            alertCount={alertCount}
            user={info}
            onSignOut={() => signOut(auth)}
          />
        )}

        {/* Desktop rail */}
        <aside className="rail desktop-sidebar" aria-label={t('Menu')}>
          <Link to="/home" className="brand-tile" aria-label="Gold A&S"><img src="/brand-mark.png" alt="" /></Link>
          <nav>
            {AREAS.map((a) => {
              const items = visibleItems(a.items, { isAdmin });
              if (!items.length) return null;
              const on = area === a.key;
              return (
                <NavLink key={a.key} to={a.path} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}
                  onClick={(e) => { if (on && location.pathname !== a.path) { e.preventDefault(); navigate(a.path); } }}>
                  <Icon name={a.icon} size={20} />
                  <span>{a.label}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="rail-foot" ref={menuRef} style={{ position: 'relative' }}>
            <button type="button" className="iconbtn" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
            <button type="button" className="me-btn" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('Account')} title={info.name}>
              {initials}
            </button>
            {menuOpen && (
              <div className="pop" role="menu" style={{ bottom: 0, insetInlineStart: 'calc(100% + 10px)' }}>
                <div className="pop-head"><b>{info.name}</b><span>{t(info.role)}</span></div>
                <div className="sep" />
                <button type="button" role="menuitem" onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />{themeLabel}</button>
                <button type="button" role="menuitem" onClick={toggleLang}><Icon name="external" size={16} />{t('Language')}<span className="meta">{lang === 'he' ? 'English' : 'עברית'}</span></button>
                <Link role="menuitem" to="/notifications" onClick={() => setMenuOpen(false)}><Icon name="bell" size={16} />{t('Notifications')}{alertCount > 0 && <span className="meta">{alertCount}</span>}</Link>
                <div className="sep" />
                <button type="button" role="menuitem" className="danger" onClick={() => signOut(auth)}><Icon name="logout" size={16} />{t('Sign out')}</button>
              </div>
            )}
          </div>
        </aside>

        <div className="app-col">
          {/* Desktop top bar */}
          <header className="topbar desktop-only">
            <div className="crumb" aria-label={t('You are here')}>
              {areaDef && <Link to={areaDef.path}>{areaDef.label}</Link>}
              {areaDef && here && here.label !== areaDef.label && <><span aria-hidden="true">›</span><b>{here.label}</b></>}
              {areaDef && here && here.label === areaDef.label && <b style={{ display: 'none' }} />}
            </div>
            <button type="button" className="topsearch" onClick={() => setSearchOpen(true)} aria-label={t('Search')}>
              <Icon name="search" size={16} />
              <span>{t('Search players, clubs, contacts, deals…')}</span>
              <kbd>Ctrl K</kbd>
            </button>
            {bell()}
          </header>

          <main className="main-content" style={{ flex: 1, padding: '18px 20px', minHeight: '100vh' }}>
            <Outlet />
          </main>
        </div>

        {/* Bottom bar (phone) */}
        <nav className="bottom-nav" aria-label={t('Menu')}>
          {BOTTOM.map((item) => {
            if (item.key === 'more') {
              return (
                <button key={item.key} type="button" onClick={() => setMoreOpen(true)} className={`bottom-nav-item${moreActive ? ' active' : ''}`} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <span className="icon"><Icon name={item.icon} size={20} /></span>
                  <span>{item.label}</span>
                </button>
              );
            }
            const isActive = area === item.key;
            return (
              <NavLink key={item.key} to={item.path} className={`bottom-nav-item${isActive ? ' active' : ''}`} aria-current={isActive ? 'page' : undefined} onClick={(e) => { if (isActive) { e.preventDefault(); navigate(item.path); } }}>
                <span className="icon"><Icon name={item.icon} size={20} /></span>
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    </ShellContext.Provider>
  );
}
