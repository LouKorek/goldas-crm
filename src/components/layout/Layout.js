import React, { useState } from 'react';
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
  { label: 'Women',             path: '/pipeline/women',  emoji: '🏃\u200d♀️', color: '#F472B6' },
  { label: 'Youth',             path: '/pipeline/youth',  emoji: '🌱', color: '#60A5FA' },
  { label: 'Jewish',            path: '/pipeline/jewish', emoji: '✡️', color: '#A78BFA' },
  { section: 'System' },
  { label: 'Notifications',     path: '/notifications',   emoji: '🔔' },
];

export default function Layout({ user }) {
  const location       = useLocation();
  const [open, setOpen] = useState(false); // mobile sidebar
  const info           = USERS[user?.email] || { name: user?.email, role: 'User' };

  const NavContent = () => (
    <>
      {/* Logo */}
      <div style={{ padding:'20px 18px 16px', borderBottom:'1px solid var(--border)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{
            width:36, height:36, borderRadius:10, flexShrink:0, overflow:'hidden',
            border:'1px solid rgba(201,168,76,0.25)',
          }}>
            <img src="/logo.png" alt="Gold A&S" style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>
          <div>
            <div style={{ fontFamily:'Cormorant Garamond,serif', fontSize:18, fontWeight:700, color:'var(--gold)', lineHeight:1 }}>Gold A&S</div>
            <div style={{ fontSize:10, color:'var(--text-3)', marginTop:1, letterSpacing:'0.04em' }}>gold-as.com</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex:1, padding:'8px', overflowY:'auto' }}>
        {NAV.map((item, i) => {
          if (item.section) return (
            <div key={i} style={{ color:'var(--text-3)', fontSize:10, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', padding:'14px 10px 5px' }}>
              {item.section}
            </div>
          );
          const isActive = location.pathname === item.path ||
            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
          return (
            <NavLink key={i} to={item.path} onClick={() => setOpen(false)}
              style={{
                display:'flex', alignItems:'center', gap:10,
                padding:'9px 10px', borderRadius:9, marginBottom:1,
                textDecoration:'none', fontSize:13.5, fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--text-1)' : 'var(--text-2)',
                background: isActive ? 'rgba(201,168,76,0.1)' : 'transparent',
                transition:'all 0.15s', position:'relative',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.color='var(--text-1)'; } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background='transparent'; e.currentTarget.style.color='var(--text-2)'; } }}
            >
              {isActive && <span style={{ position:'absolute', left:0, top:'20%', bottom:'20%', width:2.5, background:'var(--gold)', borderRadius:'0 2px 2px 0' }} />}
              <span style={{ fontSize:16, flexShrink:0 }}>{item.emoji}</span>
              <span style={{ color: isActive ? (item.color||'var(--gold)') : 'inherit' }}>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* User */}
      <div style={{ borderTop:'1px solid var(--border)', padding:'14px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
          <div style={{
            width:32, height:32, borderRadius:'50%', flexShrink:0,
            background:'linear-gradient(135deg, rgba(201,168,76,0.2), rgba(201,168,76,0.1))',
            border:'1px solid rgba(201,168,76,0.2)',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'var(--gold)', fontWeight:700, fontSize:13,
          }}>{info.name?.charAt(0)}</div>
          <div style={{ overflow:'hidden' }}>
            <div style={{ fontSize:13, color:'var(--text-1)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.name}</div>
            <div style={{ fontSize:11, color:'var(--text-3)' }}>{info.role}</div>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => signOut(auth)}
          style={{ width:'100%', justifyContent:'center', color:'var(--red)', borderColor:'rgba(248,113,113,0.2)' }}>
          Sign out
        </button>
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
        display:'none',
        position:'fixed', top:0, left:0, right:0, height:56,
        background:'var(--surface-1)', borderBottom:'1px solid var(--border)',
        alignItems:'center', justifyContent:'space-between', padding:'0 16px',
        zIndex:50, boxShadow:'0 2px 12px rgba(0,0,0,0.3)',
      }} className="mobile-topbar">
        <button onClick={() => setOpen(true)} style={{ background:'none', border:'none', color:'var(--gold)', fontSize:24, cursor:'pointer', lineHeight:1, padding:4 }}>☰</button>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:28,height:28,borderRadius:8,overflow:'hidden',border:'1px solid rgba(201,168,76,0.3)'}}>
            <img src="/logo.png" alt="Gold A&S" style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>
          <span style={{ fontFamily:'Cormorant Garamond,serif', fontSize:18, color:'var(--gold)', fontWeight:700, letterSpacing:'0.5px' }}>Gold A&S</span>
        </div>
        <div style={{ width:32 }} />
      </div>

      {/* Sidebar — desktop */}
      <aside style={{
        width: 210,
        background: 'var(--surface-1)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        flexShrink: 0,
        overflow: 'hidden',
      }} className="desktop-sidebar">
        <NavContent />
      </aside>

      {/* Sidebar — mobile drawer */}
      <aside style={{
        position: 'fixed', top:0, left: open ? 0 : -280, width:260,
        height:'100vh', background:'var(--surface-1)',
        borderRight:'1px solid var(--border)',
        display:'flex', flexDirection:'column',
        zIndex:100, transition:'left 0.25s ease',
        overflow:'hidden',
      }} className="mobile-sidebar">
        <NavContent />
      </aside>

      {/* Main */}
      <main style={{ flex:1, overflow:'auto', padding:'28px 28px', minHeight:'100vh' }} className="main-content">
        <Outlet />
      </main>

      <style>{`
        @media (max-width: 768px) {
          .desktop-sidebar { display: none !important; }
          .mobile-topbar { display: flex !important; }
          .main-content { padding: 72px 16px 24px !important; }
        }
        @media (min-width: 769px) {
          .mobile-sidebar { display: none !important; }
        }
      `}</style>
    </div>
  );
}
