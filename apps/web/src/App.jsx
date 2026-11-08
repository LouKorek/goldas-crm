import React, { useState, useEffect, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from 'lib/firebase';
import { fetchUserAccess, ensureSeedUsers, setSessionAccess, clearSessionAccess } from 'lib/db';
import { RoleContext } from 'lib/roleContext';
import './index.css';
import './theme.css';

import Layout        from 'components/layout/Layout';
import Login         from 'pages/Login';
const Players = lazy(() => import('pages/Players'));
const Pipeline = lazy(() => import('pages/Pipeline'));
const Requirements = lazy(() => import('pages/Requirements'));
const Matches = lazy(() => import('pages/Matches'));
const Contacts = lazy(() => import('pages/Contacts'));
const Notifications = lazy(() => import('pages/Notifications'));
const Team = lazy(() => import('pages/Team'));
const Tasks = lazy(() => import('pages/Tasks'));
const TmWatch = lazy(() => import('pages/TmWatch'));
const Social = lazy(() => import('pages/Social'));
const Clubs = lazy(() => import('pages/Clubs'));
const RecycleBin = lazy(() => import('pages/RecycleBin'));
const Migrations = lazy(() => import('pages/Migrations'));
import Home          from 'pages/Home';
const Player360 = lazy(() => import('pages/Player360'));
const Golda = lazy(() => import('pages/Golda'));
const Deals = lazy(() => import('pages/Deals'));
const Calendar = lazy(() => import('pages/Calendar'));
const Admin = lazy(() => import('pages/Admin'));
const DesignSystem = lazy(() => import('pages/DesignSystem'));
import ErrorBoundary, { install as installErrorReporting } from 'components/ErrorBoundary';

installErrorReporting();
import { ToastProvider } from 'components/ui/UI';
import { t } from 'lib/i18n';

// Splash on app open: the brand tile breathing on the day or night ground,
// the same tile the rail shows once the shell is up.
function Splash({ fading }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)',
      zIndex: 9999,
      opacity: fading ? 0 : 1,
      transition: 'opacity 0.45s ease',
      pointerEvents: fading ? 'none' : 'auto',
    }}>
      <style>{`
        @keyframes splash-tile-in { from { opacity: 0; transform: scale(0.88); } to { opacity: 1; transform: scale(1); } }
        @keyframes splash-text-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes splash-bar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      `}</style>
      <div style={{ textAlign: 'center' }}>
        <div className="brand-tile" style={{ width: 84, height: 84, borderRadius: 20, margin: '0 auto 18px', animation: 'splash-tile-in 0.6s cubic-bezier(0.2,0,0,1) both', boxShadow: 'var(--shadow-md)' }}>
          <img src="/brand-mark.png" alt="Gold A&S" style={{ width: 64, height: 64 }} />
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: 'var(--text-1)', animation: 'splash-text-in 0.6s ease 0.15s both', lineHeight: 1.1 }}>{t('Gold A&S')}</div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-2)', animation: 'splash-text-in 0.6s ease 0.3s both' }}>{t('Football Agency')}</div>
        <div style={{ margin: '22px auto 0', width: 72, height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
          <div style={{ width: '100%', height: '100%', background: 'var(--accent)', transformOrigin: 'inline-start', animation: 'splash-bar 1.4s cubic-bezier(0.2,0,0,1) 0.2s both' }} />
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
      // Not awaited: the owner's record check must not hold the shell back.
      if (acc.role === 'admin') ensureSeedUsers().catch(() => {});
      setSessionAccess({ email: acc.email, name: acc.name, role: acc.role });
      setAccess(acc);
      setUser(u);
      setDenied(false);
    });
  }, []);

  // Splash lifecycle: keep visible while auth resolves, with a minimum show time
  useEffect(() => {
    if (user === undefined) return; // auth still resolving - keep splash up
    // Long enough for the fade to read as intentional, short enough not to
    // add to the wait.
    const minShownMs = 350;
    const elapsed    = performance.now() - mountedAt;
    const wait       = Math.max(0, minShownMs - elapsed);
    const t1 = setTimeout(() => setSplash(s => ({ ...s, fading: true })), wait);
    const t2 = setTimeout(() => setSplash({ show: false, fading: true }), wait + 550);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [user, mountedAt]);

  return (
    <ErrorBoundary>
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
                <Route index element={<Navigate to="/home" replace />} />
                <Route path="home"           element={<Home />} />
                <Route path="home/:tab"      element={<Home />} />
                <Route path="dashboard"      element={<Navigate to="/home/snapshot" replace />} />
                <Route path="golda"          element={<Golda />} />
                <Route path="social"         element={<Social />} />
                <Route path="players"        element={<Players />} />
                <Route path="players/:id"    element={<Player360 />} />
                <Route path="matches"        element={<Matches />} />
                <Route path="calendar"       element={<Calendar />} />
                <Route path="market"         element={<Navigate to="/market/prospects" replace />} />
                <Route path="market/prospects"    element={<Pipeline />} />
                <Route path="market/requirements" element={<Requirements />} />
                <Route path="market/deals"        element={<Deals />} />
                <Route path="requirements"   element={<Navigate to="/market/requirements" replace />} />
                <Route path="clubs"          element={<Clubs />} />
                <Route path="clubs/:id"      element={<Clubs />} />
                <Route path="recycle"        element={<RecycleBin />} />
                <Route path="admin" element={access.role === 'admin' ? <Admin /> : <Navigate to="/home" replace />} />
                <Route path="admin/design" element={access.role === 'admin' ? <DesignSystem /> : <Navigate to="/home" replace />} />
                <Route path="admin/:tab" element={access.role === 'admin' ? <Admin /> : <Navigate to="/home" replace />} />
                <Route path="admin/migrations" element={
                  access.role === 'admin' ? <Migrations /> : <Navigate to="/dashboard" replace />
                } />
                <Route path="contacts"       element={<Contacts />} />
                <Route path="pipeline/men"   element={<Pipeline category="men" />} />
                <Route path="pipeline/women" element={<Pipeline category="women" />} />
                <Route path="pipeline/youth" element={<Pipeline category="youth" />} />
                <Route path="pipeline/jewish"element={<Pipeline category="jewish" />} />
                <Route path="pipeline/jewish/tm-watch" element={<Navigate to="/scouting/tm-watch" replace />} />
                <Route path="scouting" element={<Navigate to="/scouting/tm-watch" replace />} />
                <Route path="scouting/tm-watch" element={<TmWatch />} />
                <Route path="notifications"  element={<Notifications />} />
                {/* Personal to-do board — every signed-in user gets their
                    own, and only ever sees their own. */}
                <Route path="tasks" element={<Tasks />} />
                <Route path="team" element={
                  access.role === 'admin' ? <Team /> : <Navigate to="/dashboard" replace />
                } />
              </Route>
            </Routes>
          </BrowserRouter>
        </RoleContext.Provider>
      )}
    </ErrorBoundary>
  );
}
