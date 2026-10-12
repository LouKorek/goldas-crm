import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useRole } from 'lib/roleContext';
import Icon from './Icons';

// Mobile navigation — a full-screen index rather than a menu.
// Destinations are set as a numbered editorial list: large type, hairline
// rules, one gold marker on the current screen. It reads like the contents
// page of a dossier, which is exactly the register the rest of the app
// now speaks in.

const SECTIONS = [
  {
    num: '01', title: 'Overview', items: [
      { label: 'Dashboard',    path: '/dashboard',       icon: 'dashboard' },
      { label: 'Social',       path: '/social',          icon: 'social' },
    ],
  },
  {
    num: '02', title: 'Players', items: [
      { label: 'Represented',  path: '/players',         icon: 'players' },
      { label: 'Matches',      path: '/matches',         icon: 'matches' },
      { label: 'Contacts',     path: '/contacts',        icon: 'contacts' },
    ],
  },
  {
    num: '03', title: 'Transfer Window', items: [
      { label: 'Requirements', path: '/requirements',    icon: 'clipboard' },
      { label: 'Men',          path: '/pipeline/men',    icon: 'men' },
      { label: 'Women',        path: '/pipeline/women',  icon: 'women' },
      { label: 'Youth',        path: '/pipeline/youth',  icon: 'youth' },
      { label: 'Jewish',       path: '/pipeline/jewish', icon: 'star' },
    ],
  },
  {
    num: '04', title: 'System', items: [
      { label: 'Tasks',        path: '/tasks',           icon: 'tasks', ownerOnly: true },
      { label: 'Notifications',path: '/notifications',   icon: 'bell' },
      { label: 'Team',         path: '/team',            icon: 'team', adminOnly: true },
    ],
  },
];

export default function NavIndex({ open, onClose }) {
  const { isAdmin, email } = useRole();
  const isOwner  = (email || '').toLowerCase() === 'lou.korek@gmail.com';
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Lock the page behind the index and close on Escape.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const go = (path) => { navigate(path); onClose(); };
  let n = 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 220,
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      animation: 'navIndexIn 0.2s cubic-bezier(0.2,0,0,1)',
      overflowY: 'auto',
      paddingTop: 'env(safe-area-inset-top, 0px)',
    }}>
      <style>{`
        @keyframes navIndexIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
        .nav-index-row { transition: background 0.1s linear, padding-left 0.12s linear; }
        .nav-index-row:active { background: var(--surface-2); padding-left: 22px; }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 16px 14px', borderBottom: '1px solid var(--gold-dk)',
        position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 2,
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700,
            letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--text-1)',
          }}>Index</div>
          <div style={{
            fontSize: 8.5, color: 'var(--text-3)', letterSpacing: '0.18em',
            textTransform: 'uppercase', marginTop: 3,
          }}>Gold A&amp;S — Football Agency</div>
        </div>
        <button onClick={onClose} aria-label="Close"
          style={{
            background: 'transparent', border: '1px solid var(--border-2)',
            color: 'var(--text-2)', width: 38, height: 38, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon name="close" size={15} /></button>
      </div>

      {/* Sections */}
      <div style={{ flex: 1, paddingBottom: 'calc(28px + env(safe-area-inset-bottom, 0px))' }}>
        {SECTIONS.map(sec => {
          const items = sec.items.filter(it =>
            (!it.adminOnly || isAdmin) && (!it.ownerOnly || isOwner));
          if (!items.length) return null;
          return (
            <div key={sec.num}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '18px 16px 8px',
                color: 'var(--text-mute)', fontSize: 8.5, fontWeight: 700,
                letterSpacing: '0.18em', textTransform: 'uppercase',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--gold-dk)', letterSpacing: 0 }}>{sec.num}</span>
                <span>{sec.title}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
              </div>
              {items.map(it => {
                n += 1;
                const active = pathname === it.path ||
                  (it.path !== '/dashboard' && pathname.startsWith(it.path));
                return (
                  <button key={it.path} onClick={() => go(it.path)} className="nav-index-row"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      width: '100%', padding: '0 16px', height: 60,
                      background: active ? 'var(--surface-2)' : 'transparent',
                      border: 'none', borderBottom: '1px solid var(--rule)',
                      borderLeft: `2px solid ${active ? 'var(--gold)' : 'transparent'}`,
                      color: active ? 'var(--text-1)' : 'var(--text-2)',
                      cursor: 'pointer', textAlign: 'left',
                    }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10,
                      color: active ? 'var(--gold)' : 'var(--text-mute)',
                      width: 20, flexShrink: 0,
                    }}>{String(n).padStart(2, '0')}</span>
                    <span style={{ color: active ? 'var(--gold)' : 'var(--text-3)', display: 'flex' }}>
                      <Icon name={it.icon} size={17} />
                    </span>
                    <span style={{
                      flex: 1,
                      fontFamily: 'var(--font-display)',
                      fontSize: 19, fontWeight: 600,
                      letterSpacing: '0.02em', textTransform: 'uppercase',
                    }}>{it.label}</span>
                    <span style={{ color: 'var(--text-mute)', display: 'flex' }}>
                      <Icon name="chevron" size={13} />
                    </span>
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
