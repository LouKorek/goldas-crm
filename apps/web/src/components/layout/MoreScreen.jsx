import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useRole } from 'lib/roleContext';
import { AREAS, BOTTOM, visibleItems } from 'lib/nav';
import { t } from 'lib/i18n';
import Icon from 'components/ui/Icons';

// The phone's "more" screen: who is signed in, every screen grouped by area,
// then the settings (night mode, language, notifications) and sign out.
export default function MoreScreen({ onClose, onSearch, theme, onToggleTheme, lang, onToggleLang, alertCount, user, onSignOut }) {
  const { isAdmin } = useRole();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = (path) => { navigate(path); onClose(); };
  const initials = (user?.name || '?').trim().slice(0, 2);
  const inBar = new Set(BOTTOM.map((b) => b.key));
  const isOn = (p) => pathname === p || (p.length > 1 && pathname.startsWith(p + '/'));
  const chev = <span className="chev"><Icon name="chevron" size={14} style={{ transform: document.documentElement.dir === 'rtl' ? 'rotate(180deg)' : 'none' }} /></span>;

  // Areas already on the bottom bar show only their secondary screens here.
  const groups = AREAS.map((a) => {
    const items = visibleItems(a.items, { isAdmin }).filter((it) => !(inBar.has(a.key) && it.path === a.path));
    return { ...a, items };
  }).filter((g) => g.items.length);

  return (
    <div className="more-screen" role="dialog" aria-label={t('More')}>
      <div className="more-head">
        <div className="mobile-topbar-brand" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-tile" style={{ width: 36, height: 36, borderRadius: 9 }}><img src="/brand-mark.png" alt="" style={{ width: 28, height: 28 }} /></span>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>{t('More')}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="iconbtn" onClick={onSearch} aria-label={t('Search')}><Icon name="search" size={18} /></button>
          <button type="button" className="iconbtn" onClick={onClose} aria-label={t('Close')}><Icon name="close" size={16} /></button>
        </div>
      </div>

      <div className="more-me">
        <span className="me-btn" aria-hidden="true">{initials}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{t(user?.role || '')}</div>
        </div>
      </div>

      <div className="more-body">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="menu-title">{g.label}</div>
            <div className="menu">
              {g.items.map((it) => (
                <button key={it.path} type="button" className={isOn(it.path) ? 'on' : undefined} onClick={() => go(it.path)}>
                  <span className="ico"><Icon name={it.icon || g.icon} size={16} /></span>
                  <span className="mlabel">{it.label}</span>
                  {it.path === '/notifications' && alertCount > 0 && <span className="mmeta">{alertCount}</span>}
                  {chev}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div>
          <div className="menu-title">{t('Settings')}</div>
          <div className="menu">
            <button type="button" onClick={onToggleTheme} role="switch" aria-checked={theme === 'dark'}>
              <span className="ico"><Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} /></span>
              <span className="mlabel">{t('Dark Mode')}</span>
              <span className={`tog-sw${theme === 'dark' ? ' on' : ''}`} aria-hidden="true" />
            </button>
            <button type="button" onClick={onToggleLang}>
              <span className="ico"><Icon name="external" size={16} /></span>
              <span className="mlabel">{t('Language')}</span>
              <span className="mmeta">{lang === 'he' ? 'עברית' : 'English'}</span>
              {chev}
            </button>
            <button type="button" className="danger" onClick={onSignOut}>
              <span className="ico"><Icon name="logout" size={16} /></span>
              <span className="mlabel">{t('Sign out')}</span>
            </button>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-3)', paddingTop: 4 }}>Gold A&amp;S · {t('Football Agency')}</div>
      </div>
    </div>
  );
}
