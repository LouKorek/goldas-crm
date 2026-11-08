// Harness: the real shell and the real market/players/contacts screens on
// fixture data (dev/fixtures.js via dev/mock-db.js). vite.harness.config.js.
import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import CalendarSync from 'components/admin/CalendarSync';
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
applyTheme(new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light');
const role = { email: 'lou@example.com', name: 'לו קורק', role: 'admin', canEdit: true, isAdmin: true, canDelete: true };
setSessionAccess(role);
const App = () => (
  <RoleContext.Provider value={role}>
    <MemoryRouter initialEntries={[new URLSearchParams(location.search).get('path') || '/market/prospects']}>
      <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Layout user={{ email: role.email }} />}>
          <Route path="players" element={<Players />} />
          <Route path="market" element={<Navigate to="/market/prospects" replace />} />
          <Route path="market/prospects" element={<Prospects />} />
          <Route path="market/requirements" element={<Requirements />} />
          <Route path="market/deals" element={<Deals />} />
          <Route path="contacts" element={<Contacts />} />
          {['men', 'women', 'youth', 'jewish'].map((c) => <Route key={c} path={`pipeline/${c}`} element={<Pipeline category={c} />} />)}
          <Route path="calendar" element={<Calendar />} />
          <Route path="admin/calendar" element={<CalendarSync he />} />
          <Route path="*" element={<div>other</div>} />
        </Route>
      </Routes>
      </Suspense>
    </MemoryRouter>
  </RoleContext.Provider>
);
createRoot(document.getElementById('root')).render(<App />);
