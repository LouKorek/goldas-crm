import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useRole } from 'lib/roleContext';
import { AREAS, visibleItems } from 'lib/nav';
import { t } from 'lib/i18n';
import Icon from './Icons';

// Mobile navigation: a full-screen index rather than a menu. The seven areas
// are numbered like chapters, each with its screens underneath, and one gold
// marker on the current screen. The list itself lives in lib/nav.js.
export default function NavIndex({ open, onClose, onSearch }) {
  const { isAdmin } = useRole();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const go = (path) => { navigate(path); onClose(); };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 220, background: 'var(--bg)',
      display: 'flex', flexDirection: 'column', overflowY: 'auto',
      animation: 'navIndexIn 0.2s cubic-bezier(0.2,0,0,1)',
      paddingTop: 'env(safe-area-inset-top, 0px)',
    }}>
      <style>{`
        @keyframes navIndexIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
        .nav-index-row { transition: background 0.1s linear; }
        .nav-index-row:active { background: var(--surface-2); }
      `}</style>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '16px 16px 14px', borderBottom: '1px solid var(--gold-dk)',
        position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 2,
      }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--text-1)' }}>{t('Index')}</div>
          <div style={{ fontSize: 9, color: 'var(--text-3)', marginTop: 3 }}>{t('Gold A&S — Football Agency')}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onSearch} aria-label={t('Search')} style={{ background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--gold)', width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="search" size={16} /></button>
          <button onClick={onClose} aria-label={t('Close')} style={{ background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--text-2)', width: 44, height: 44, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={15} /></button>
        </div>
      </div>

      <div style={{ flex: 1, paddingBottom: 'calc(28px + env(safe-area-inset-bottom, 0px))' }}>
        {AREAS.map((a, i) => {
          const items = visibleItems(a.items, { isAdmin });
          if (!items.length) return null;
          return (
            <div key={a.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 16px 8px', color: 'var(--text-mute)', fontSize: 10, fontWeight: 700 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--gold-dk)' }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ color: 'var(--text-3)' }}>{a.label}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
              </div>
              {items.map((it) => {
                const active = pathname === it.path || (it.path.length > 1 && pathname.startsWith(it.path) && it.path !== '/players') || (it.path === '/players' && pathname === '/players');
                return (
                  <button key={it.path} onClick={() => go(it.path)} className="nav-index-row"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '0 16px', height: 56,
                      background: active ? 'var(--surface-2)' : 'transparent', border: 'none',
                      borderBottom: '1px solid var(--rule)', borderInlineStart: `2px solid ${active ? 'var(--gold)' : 'transparent'}`,
                      color: active ? 'var(--text-1)' : 'var(--text-2)', cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit',
                    }}>
                    <span style={{ color: active ? 'var(--gold)' : 'var(--text-3)', display: 'flex' }}><Icon name={it.icon || a.icon} size={17} /></span>
                    <span style={{ flex: 1, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>{it.label}</span>
                    <span style={{ color: 'var(--text-mute)', display: 'flex' }}><Icon name="chevron" size={13} style={{ transform: document.documentElement.dir === 'rtl' ? 'rotate(180deg)' : 'none' }} /></span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
