// Harness: the real shell and the real market/players/contacts screens on
// fixture data (dev/fixtures.js via dev/mock-db.js). vite.harness.config.js.
import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import CalendarSync from 'components/admin/CalendarSync';
import YouTubeConnect from 'components/admin/YouTubeConnect';
import WebsiteStatus from 'components/admin/WebsiteStatus';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import '../src/index.css';
import '../src/theme.css';
import Layout from 'components/layout/Layout';
import { RoleContext } from 'lib/roleContext';
import { setSessionAccess } from 'lib/db';
import { applyTheme } from 'lib/theme';
const Pipeline = lazy(() => import('pages/Pipeline'));
const Prospects = lazy(() => import('pages/Pipeline'));
const Requirements = lazy(() => import('pages/Requirements'));
const Deals = lazy(() => import('pages/Deals'));
const Players = lazy(() => import('pages/Players'));
const Contacts = lazy(() => import('pages/Contacts'));
const Calendar = lazy(() => import('pages/Calendar'));
const Player360 = lazy(() => import('pages/Player360'));
const Admin = lazy(() => import('pages/Admin'));
const Matches = lazy(() => import('pages/Matches'));
const PlayerPage = lazy(() => import('pages/PlayerPage'));
const SignPage = lazy(() => import('pages/SignPage'));
applyTheme(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
const Finance = lazy(() => import('pages/Finance'));
// ?role=viewer shows the screens as someone who may not edit; ?role=manager as an editor who is not an admin.
const asRole = new URLSearchParams(location.search).get('role') || 'admin';
const role = asRole === 'viewer'
  ? { email: 'viewer@example.com', name: 'צופה', role: 'viewer', canEdit: false, isAdmin: false, canDelete: false }
  : { email: 'lou@example.com', name: 'לו קורק', role: asRole, canEdit: true, isAdmin: asRole === 'admin', canDelete: asRole === 'admin' };
setSessionAccess(role);
const App = () => (
  <RoleContext.Provider value={role}>
    <MemoryRouter initialEntries={[new URLSearchParams(location.search).get('path') || '/market/prospects']}>
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Layout user={{ email: role.email }} />}>
          <Route path="players" element={<Players />} />
          <Route path="players/:id" element={<Player360 />} />
          <Route path="market" element={<Navigate to="/market/prospects" replace />} />
          <Route path="market/prospects" element={<Prospects />} />
          <Route path="market/requirements" element={<Requirements />} />
          <Route path="market/deals" element={<Deals />} />
          <Route path="finance" element={<Finance />} />
          <Route path="contacts" element={<Contacts />} />
          {['men', 'women', 'youth', 'jewish'].map((c) => <Route key={c} path={`pipeline/${c}`} element={<Pipeline category={c} />} />)}
          <Route path="calendar" element={<Calendar />} />
          <Route path="matches" element={<Matches />} />
          <Route path="admin/calendar" element={<CalendarSync he />} />
          <Route path="admin/youtube" element={<YouTubeConnect he />} />
          <Route path="admin/website" element={<WebsiteStatus he />} />
          <Route path="system/:tab" element={<Admin />} />
          <Route path="*" element={<div>other</div>} />
        </Route>
      </Routes>
      </Suspense>
    </MemoryRouter>
  </RoleContext.Provider>
);
// ?path=/p/<token> shows the public live player page on its own, as a club sees it (dev/mock-playerPages.js).
const livePage = /^\/p\/([^/]*)$/.exec(new URLSearchParams(location.search).get('path') || '');
// ?path=/sign/<token> shows the signing page of an agreement the same way (dev/mock-agreements.js).
const signPage = /^\/sign\/([^/]*)$/.exec(new URLSearchParams(location.search).get('path') || '');
createRoot(document.getElementById('root')).render(livePage ? <Suspense fallback={null}><PlayerPage token={livePage[1]} /></Suspense>
  : signPage ? <Suspense fallback={null}><SignPage token={signPage[1]} /></Suspense> : <App />);
