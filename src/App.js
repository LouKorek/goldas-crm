import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from 'lib/firebase';
import { fetchUserAccess, ensureSeedUsers, setSessionAccess, clearSessionAccess } from 'lib/db';
import { RoleContext } from 'lib/roleContext';
import './index.css';

import Layout        from 'components/layout/Layout';
import Login         from 'pages/Login';
import Dashboard     from 'pages/Dashboard';
import Players       from 'pages/Players';
import Pipeline      from 'pages/Pipeline';
import Requirements  from 'pages/Requirements';
import Matches       from 'pages/Matches';
import Contacts      from 'pages/Contacts';
import Notifications from 'pages/Notifications';
import Team          from 'pages/Team';
import { ToastProvider } from 'components/ui/UI';

// Animated splash screen shown on app open
function Splash({ fading }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at center, #1A2820 0%, #0E1B11 70%)',
      zIndex: 9999,
      opacity: fading ? 0 : 1,
      transition: 'opacity 0.5s ease',
      pointerEvents: fading ? 'none' : 'auto',
    }}>
      <style>{`
        @keyframes splash-logo-in {
          0%   { opacity: 0; transform: scale(0.6) rotate(-8deg); }
          60%  { opacity: 1; transform: scale(1.08) rotate(2deg); }
          100% { opacity: 1; transform: scale(1) rotate(0); }
        }
        @keyframes splash-glow {
          0%, 100% { box-shadow: 0 0 40px rgba(201,168,76,0.25), 0 0 80px rgba(201,168,76,0.12); }
          50%      { box-shadow: 0 0 60px rgba(201,168,76,0.55), 0 0 120px rgba(201,168,76,0.25); }
        }
        @keyframes splash-shimmer {
          0%   { transform: translateX(-150%) skewX(-20deg); }
          100% { transform: translateX(250%) skewX(-20deg); }
        }
        @keyframes splash-text-in {
          0%   { opacity: 0; transform: translateY(14px); letter-spacing: 0.5em; }
          100% { opacity: 1; transform: translateY(0); letter-spacing: 0.04em; }
        }
        @keyframes splash-tagline-in {
          0%, 50% { opacity: 0; transform: translateY(8px); }
          100%    { opacity: 0.7; transform: translateY(0); }
        }
        @keyframes splash-ring {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div style={{ textAlign: 'center', position: 'relative' }}>
        {/* Orbiting ring around the logo */}
        <div style={{
          position: 'absolute', top: 55, left: '50%',
          width: 150, height: 150,
          marginLeft: -75,
          borderRadius: '50%',
          border: '1px solid transparent',
          borderTopColor: 'rgba(201,168,76,0.55)',
          borderRightColor: 'rgba(201,168,76,0.15)',
          animation: 'splash-ring 2.6s linear infinite',
          pointerEvents: 'none',
        }} />

        {/* Logo with glow + shimmer */}
        <div style={{
          position: 'relative',
          width: 110, height: 110,
          margin: '0 auto 26px',
          borderRadius: 26,
          overflow: 'hidden',
          border: '1.5px solid rgba(201,168,76,0.4)',
          animation: 'splash-logo-in 0.9s cubic-bezier(0.34,1.56,0.64,1) both, splash-glow 2.4s ease-in-out 0.9s infinite',
        }}>
          <img src="/logo.png" alt="Gold A&S"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          {/* Shimmer sweep */}
          <div style={{
            position: 'absolute', top: 0, left: 0,
            width: '40%', height: '100%',
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)',
            animation: 'splash-shimmer 2.2s ease-in-out 1s infinite',
            pointerEvents: 'none',
          }} />
        </div>

        {/* Wordmark */}
        <div style={{
          fontFamily: 'Cormorant Garamond, serif',
          fontSize: 34, fontWeight: 700,
          background: 'linear-gradient(135deg, #E8C96A 0%, #C9A84C 50%, #A07830 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          animation: 'splash-text-in 0.9s cubic-bezier(0.16,1,0.3,1) 0.25s both',
          lineHeight: 1,
        }}>
          Gold A&amp;S
        </div>

        {/* Tagline */}
        <div style={{
          marginTop: 10,
          fontSize: 11, color: 'var(--text-3)',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          animation: 'splash-tagline-in 1.4s ease 0.4s both',
        }}>
          Football Agency
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser]     = useState(undefined);
  const [access, setAccess] = useState(null);
  const [denied, setDenied] = useState(false);
  const [splash, setSplash] = useState({ show: true, fading: false });
  const [mountedAt] = useState(() => performance.now());

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      if (!u) { clearSessionAccess(); setAccess(null); setUser(null); return; }
      const acc = await fetchUserAccess(u.email);
      if (!acc.allowed) {
        await signOut(auth);
        clearSessionAccess(); setAccess(null); setUser(null); setDenied(true);
        return;
      }
      // Owner: make sure the user collection is seeded so the Team screen works.
      if (acc.role === 'admin') { try { await ensureSeedUsers(); } catch (e) {} }
      setSessionAccess({ email: acc.email, name: acc.name, role: acc.role });
      setAccess(acc);
      setUser(u);
      setDenied(false);
    });
  }, []);

  // Splash lifecycle: keep visible while auth resolves, with a minimum show time
  useEffect(() => {
    if (user === undefined) return; // auth still resolving - keep splash up
    const minShownMs = 1500;
    const elapsed    = performance.now() - mountedAt;
    const wait       = Math.max(0, minShownMs - elapsed);
    const t1 = setTimeout(() => setSplash(s => ({ ...s, fading: true })), wait);
    const t2 = setTimeout(() => setSplash({ show: false, fading: true }), wait + 550);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [user, mountedAt]);

  return (
    <>
      {splash.show && <Splash fading={splash.fading} />}
      {user === null && <Login denied={denied} />}
      {user && access && (
        <RoleContext.Provider value={{
          email: access.email, name: access.name, role: access.role,
          canEdit: access.role === 'admin' || access.role === 'manager',
          isAdmin: access.role === 'admin',
        }}>
          <BrowserRouter>
            <ToastProvider />
            <Routes>
              <Route path="/" element={<Layout user={user} />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard"      element={<Dashboard />} />
                <Route path="players"        element={<Players />} />
                <Route path="matches"        element={<Matches />} />
                <Route path="requirements"   element={<Requirements />} />
                <Route path="contacts"       element={<Contacts />} />
                <Route path="pipeline/men"   element={<Pipeline category="men" />} />
                <Route path="pipeline/women" element={<Pipeline category="women" />} />
                <Route path="pipeline/youth" element={<Pipeline category="youth" />} />
                <Route path="pipeline/jewish"element={<Pipeline category="jewish" />} />
                <Route path="notifications"  element={<Notifications />} />
                <Route path="team" element={
                  access.role === 'admin' ? <Team /> : <Navigate to="/dashboard" replace />
                } />
              </Route>
            </Routes>
          </BrowserRouter>
        </RoleContext.Provider>
      )}
    </>
  );
}
