import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth, ALLOWED_EMAILS } from 'lib/firebase';
import './index.css';

import Layout        from 'components/layout/Layout';
import Login         from 'pages/Login';
import Dashboard     from 'pages/Dashboard';
import Players       from 'pages/Players';
import Pipeline      from 'pages/Pipeline';
import Requirements  from 'pages/Requirements';
import Matches       from 'pages/Matches';
import Notifications from 'pages/Notifications';
import { ToastProvider } from 'components/ui/UI';

function Spinner() {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--bg)'}}>
      <div style={{textAlign:'center'}}>
        <div style={{
          width:48,height:48,border:'2px solid rgba(201,168,76,0.2)',
          borderTopColor:'var(--gold)',borderRadius:'50%',
          animation:'spin 0.8s linear infinite',margin:'0 auto 16px',
        }}/>
        <div style={{fontFamily:'Cormorant Garamond,serif',color:'var(--gold)',fontSize:18}}>Gold A&S</div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export default function App() {
  const [user, setUser]   = useState(undefined);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, u => {
      if (!u) { setUser(null); return; }
      if (ALLOWED_EMAILS.includes(u.email)) {
        setUser(u);
        setDenied(false);
      } else {
        signOut(auth);
        setUser(null);
        setDenied(true);
      }
    });
  }, []);

  if (user === undefined) return <Spinner />;
  if (!user)              return <Login denied={denied} />;

  return (
    <BrowserRouter>
      <ToastProvider />
      <Routes>
        <Route path="/" element={<Layout user={user} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"      element={<Dashboard />} />
          <Route path="players"        element={<Players />} />
          <Route path="matches"        element={<Matches />} />
          <Route path="requirements"   element={<Requirements />} />
          <Route path="pipeline/men"   element={<Pipeline category="men" />} />
          <Route path="pipeline/women" element={<Pipeline category="women" />} />
          <Route path="pipeline/youth" element={<Pipeline category="youth" />} />
          <Route path="pipeline/jewish"element={<Pipeline category="jewish" />} />
          <Route path="notifications"  element={<Notifications />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
