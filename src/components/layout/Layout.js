import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth, USERS } from 'lib/firebase';

const NAV = [
  { section: 'Overview' },
  { label: 'Dashboard',         path: '/dashboard',       emoji: '◈' },
  { section: 'Players' },
  { label: 'Represented',       path: '/players',         emoji: '🤝' },
  { label: 'Matches',           path: '/matches',         emoji: '🏟' },
  { section: 'Transfer Window' },
  { label: 'Club Requirements', path: '/requirements',    emoji: '📋' },
  { label: 'Men',               path: '/pipeline/men',    emoji: '🏃', color: '#4ADE80' },
  { label: 'Women',             path: '/pipeline/women',  emoji: '🏃‍♀️', color: '#F472B6' },
  { label: 'Youth',             path: '/pipeline/youth',  emoji: '🌱', color: '#60A5FA' },
  { label: 'Jewish',            path: '/pipeline/jewish', emoji: '✡️', color: '#A78BFA' },
  { section: 'System' },
  { label: 'Notifications',     path: '/notifications',   emoji: '🔔' },
];

export default function Layout({ user }) {
  const location             = useLocation();
  const [open, setOpen]      = useState(false);
  const [theme, setTheme]    = useState(() => localStorage.getItem('theme')||'dark');
  
  // Apply theme to body
  useEffect(() => {
    document.body.classList.toggle('light-mode', theme==='light');
    localStorage.setItem('theme', theme);
  }, [theme]);
  const [collapsed, setCollapsed] = useState(false);
  const info                 = USERS[user?.email] || { name: user?.email, role: 'User' };

  const SidebarContent = ({ isMobile = false }) => (
    <>
      {/* Logo */}
      <div style={{ padding: collapsed && !isMobile ? '14px 8px' : '16px 14px 12px', borderBottom:'1px solid var(--border)', transition:'padding 0.2s' }}>
        <div style={{ display:'flex', alignItems:'center', gap: collapsed && !isMobile ? 0 : 10, justifyContent: collapsed && !isMobile ? 'center' : 'flex-start' }}>
          <div style={{ width:30, height:30, borderRadius:9, flexShrink:0, overflow:'hidden', border:'1px solid rgba(201,168,76,0.25)' }}>
            <img src="/logo.png" alt="Gold A&S" style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>
          {(!collapsed || isMobile) && (
            <div>
              <div style={{ fontFamily:'Cormorant Garamond,serif', fontSize:15, fontWeight:700, color:'var(--gold)', lineHeight:1 }}>Gold A&S</div>
              <div style={{ fontSize:9, color:'var(--text-3)', marginTop:1 }}>gold-as.com</div>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex:1, padding:'6px 6px', overflowY:'auto', overflowX:'hidden' }}>
        {NAV.map((item, i) => {
          if (item.section) {
            if (collapsed && !isMobile) return <div key={i} style={{height:6}} />;
            return (
              <div key={i} style={{ color:'var(--text-3)', fontSize:8.5, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', padding:'11px 8px 4px' }}>
                {item.section}
              </div>
            );
          }
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          return (
            <NavLink key={i} to={item.path} onClick={() => isMobile && setOpen(false)}
              style={{
                display:'flex', alignItems:'center',
                gap: collapsed && !isMobile ? 0 : 8,
                padding: collapsed && !isMobile ? '9px 0' : '8px 8px',
                justifyContent: collapsed && !isMobile ? 'center' : 'flex-start',
                borderRadius:8, marginBottom:1,
                textDecoration:'none',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--text-1)' : 'var(--text-2)',
                background: isActive ? 'rgba(201,168,76,0.1)' : 'transparent',
                transition:'all 0.15s', position:'relative',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background='rgba(255,255,255,0.04)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background='transparent'; }}
            >
              {isActive && !collapsed && (
                <span style={{ position:'absolute', left:0, top:'20%', bottom:'20%', width:2.5, background:'var(--gold)', borderRadius:'0 2px 2px 0' }} />
              )}
              <span style={{ fontSize:15, flexShrink:0 }} title={collapsed && !isMobile ? item.label : ''}>{item.emoji}</span>
              {(!collapsed || isMobile) && (
                <span style={{ color: isActive ? (item.color||'var(--gold)') : 'inherit', fontSize:10.5, whiteSpace:'nowrap' }}>
                  {item.label}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* User + collapse */}
      <div style={{ borderTop:'1px solid var(--border)', padding:'8px' }}>
        {(!collapsed || isMobile) && (
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, padding:'0 2px' }}>
            <div style={{
              width:26, height:26, borderRadius:'50%', flexShrink:0,
              background:'rgba(201,168,76,0.15)', border:'1px solid rgba(201,168,76,0.2)',
              display:'flex', alignItems:'center', justifyContent:'center',
              color:'var(--gold)', fontWeight:700, fontSize:11,
            }}>{info.name?.charAt(0)}</div>
            <div style={{ overflow:'hidden' }}>
              <div style={{ fontSize:10.5, color:'var(--text-1)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.name}</div>
              <div style={{ fontSize:9, color:'var(--text-3)' }}>{info.role}</div>
            </div>
          </div>
        )}
        <div style={{ display:'flex', gap:5, alignItems:'center', justifyContent: collapsed && !isMobile ? 'center' : 'space-between' }}>
          {(!collapsed || isMobile) && (
            <button className="btn btn-ghost btn-sm" onClick={() => signOut(auth)}
              style={{ fontSize:10, color:'var(--red)', borderColor:'rgba(248,113,113,0.2)', padding:'4px 8px' }}>
              Sign out
            </button>
          )}
          {!isMobile && (
            <button onClick={() => setCollapsed(v => !v)}
              style={{
                background:'rgba(201,168,76,0.1)', border:'1px solid rgba(201,168,76,0.2)',
                borderRadius:6, color:'var(--gold)', cursor:'pointer',
                width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:14, fontWeight:700, transition:'all 0.2s', flexShrink:0,
              }}
              title={collapsed ? 'Expand' : 'Collapse'}
            >{collapsed ? '›' : '‹'}</button>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div style={{ display:'flex', minHeight:'100vh' }}>

      {/* Mobile overlay */}
      {open && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:99,backdropFilter:'blur(4px)' }}
          onClick={() => setOpen(false)} />
      )}

      {/* Mobile top bar */}
      <div style={{
        display:'none', position:'fixed', top:0, left:0, right:0, height:52,
        background:'var(--surface-1)', borderBottom:'1px solid var(--border)',
        alignItems:'center', justifyContent:'space-between', padding:'0 14px',
        zIndex:50, boxShadow:'0 2px 10px rgba(0,0,0,0.3)',
      }} className="mobile-topbar">
        <button onClick={() => setOpen(true)} style={{ background:'none', border:'none', color:'var(--gold)', fontSize:22, cursor:'pointer', padding:4 }}>☰</button>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:26,height:26,borderRadius:8,overflow:'hidden',border:'1px solid rgba(201,168,76,0.3)'}}>
            <img src="/logo.png" alt="Gold A&S" style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>
          <span style={{ fontFamily:'Cormorant Garamond,serif', fontSize:17, color:'var(--gold)', fontWeight:700 }}>Gold A&S</span>
        </div>
        <div style={{ width:32 }} />
      </div>

      {/* Desktop sidebar */}
      <aside style={{
        width: collapsed ? 50 : 200,
        background: 'var(--surface-1)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh',
        flexShrink: 0, overflow: 'hidden',
        transition: 'width 0.22s ease',
      }} className="desktop-sidebar">
        <SidebarContent isMobile={false} />
      </aside>

      {/* Mobile drawer */}
      <aside style={{
        position:'fixed', top:0, left: open ? 0 : -260, width:240,
        height:'100vh', background:'var(--surface-1)',
        borderRight:'1px solid var(--border)',
        display:'flex', flexDirection:'column',
        zIndex:100, transition:'left 0.25s ease', overflow:'hidden',
      }} className="mobile-sidebar">
        <SidebarContent isMobile={true} />
      </aside>

      {/* Main content */}
      <main style={{ flex:1, overflow:'auto', padding:'22px 22px', minHeight:'100vh' }} className="main-content">
        <Outlet />
      </main>

      <style>{`
        @media (max-width: 768px) {
          .desktop-sidebar { display: none !important; }
          .mobile-topbar { display: flex !important; }
          .main-content { padding: 64px 14px 24px !important; }
        }
        @media (min-width: 769px) {
          .mobile-sidebar { display: none !important; }
        }
      `}</style>
    </div>
  );
}
