import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from 'lib/firebase';

export default function Login({ denied }) {
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setLoading(true);
    try { await signInWithPopup(auth, googleProvider); }
    catch (e) { console.error(e); setLoading(false); }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0A1A0C',
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Animated background orbs */}
      <div style={{
        position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none',
      }}>
        <div style={{
          position: 'absolute', width: 600, height: 600,
          borderRadius: '50%', top: '-200px', right: '-100px',
          background: 'radial-gradient(circle, rgba(201,168,76,0.08) 0%, transparent 70%)',
          animation: 'pulse 8s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 500, height: 500,
          borderRadius: '50%', bottom: '-150px', left: '-100px',
          background: 'radial-gradient(circle, rgba(22,107,40,0.15) 0%, transparent 70%)',
          animation: 'pulse 10s ease-in-out infinite 2s',
        }} />
        <div style={{
          position: 'absolute', width: 300, height: 300,
          borderRadius: '50%', top: '40%', left: '30%',
          background: 'radial-gradient(circle, rgba(201,168,76,0.04) 0%, transparent 70%)',
          animation: 'pulse 12s ease-in-out infinite 4s',
        }} />
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1) translate(0,0); opacity: 0.8; }
          50% { transform: scale(1.1) translate(10px,-10px); opacity: 1; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .login-card { animation: fadeUp 0.6s ease forwards; }
        .google-btn:hover { transform: translateY(-2px) !important; box-shadow: 0 8px 30px rgba(201,168,76,0.3) !important; }
        .google-btn:active { transform: translateY(0) !important; }
      `}</style>

      {/* Left panel - branding */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '60px',
        position: 'relative',
        display: window.innerWidth < 768 ? 'none' : 'flex',
      }}>
        <div style={{ maxWidth: 480 }}>
          {/* Logo */}
          <div style={{
            width: 80, height: 80,
            borderRadius: 20,
            overflow: 'hidden',
            border: '1.5px solid rgba(201,168,76,0.3)',
            marginBottom: 32,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          }}>
            <img src="/logo.png" alt="Gold A&S" style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>

          <h1 style={{
            fontFamily: 'Cormorant Garamond, serif',
            fontSize: 52, fontWeight: 700,
            background: 'linear-gradient(135deg, #E8C96A, #C9A84C, #A07830)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            lineHeight: 1.1, marginBottom: 16,
          }}>Gold A&S<br />Football Agency</h1>

          <p style={{ color: '#7A9B7C', fontSize: 16, lineHeight: 1.7, marginBottom: 40 }}>
            Professional player representation &amp; transfer management platform. Built for agents who operate at the highest level.
          </p>

          {/* Feature pills */}
          {['Player Representation', 'Transfer Window Management', 'Real-time Collaboration', 'Contract Tracking'].map(f => (
            <div key={f} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: 'rgba(201,168,76,0.08)', border: '1px solid rgba(201,168,76,0.15)',
              borderRadius: 20, padding: '6px 14px', marginRight: 8, marginBottom: 8,
            }}>
              <span style={{width:6,height:6,borderRadius:'50%',background:'#C9A84C',flexShrink:0}} />
              <span style={{fontSize:12,color:'#A8C4AA',fontWeight:500}}>{f}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel - login form */}
      <div style={{
        width: window.innerWidth < 768 ? '100%' : 480,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '40px 32px',
        background: 'rgba(255,255,255,0.02)',
        borderLeft: window.innerWidth < 768 ? 'none' : '1px solid rgba(201,168,76,0.08)',
        position: 'relative',
      }}>
        <div className="login-card" style={{ width: '100%', maxWidth: 380 }}>

          {/* Mobile logo */}
          <div style={{ textAlign:'center', marginBottom:32, display: window.innerWidth >= 768 ? 'none' : 'block' }}>
            <div style={{
              width:64,height:64,borderRadius:18,
              overflow:'hidden',
              border:'1.5px solid rgba(201,168,76,0.3)',
              margin:'0 auto 16px',
            }}>
              <img src="/logo.png" alt="Gold A&S" style={{width:'100%',height:'100%',objectFit:'cover'}} />
            </div>
            <h2 style={{fontFamily:'Cormorant Garamond,serif',fontSize:32,color:'#C9A84C',fontWeight:700}}>Gold A&S</h2>
          </div>

          <h2 style={{
            fontFamily: 'Cormorant Garamond, serif',
            fontSize: 28, fontWeight: 700, color: '#F0F7F1',
            marginBottom: 8,
          }}>Welcome back</h2>
          <p style={{ color: '#7A9B7C', fontSize: 13, marginBottom: 32 }}>
            Sign in to access your agency dashboard
          </p>

          {denied && (
            <div style={{
              background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.25)',
              borderRadius: 10, color: '#F87171',
              fontSize: 13, marginBottom: 20, padding: '12px 16px',
              display: 'flex', gap: 8, alignItems: 'flex-start',
            }}>
              <span>⚠️</span>
              <span>Access denied. This platform is restricted to authorized personnel only.</span>
            </div>
          )}

          <button
            className="google-btn"
            onClick={login}
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px 20px',
              background: loading ? 'rgba(201,168,76,0.5)' : 'linear-gradient(135deg, #C9A84C, #B8902E)',
              border: 'none',
              borderRadius: 12,
              color: '#060E08',
              fontSize: 15,
              fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              transition: 'all 0.2s ease',
              fontFamily: 'Outfit, sans-serif',
              letterSpacing: '0.01em',
              boxShadow: '0 4px 20px rgba(201,168,76,0.2)',
            }}
          >
            {loading ? (
              <span style={{width:20,height:20,border:'2px solid rgba(6,14,8,0.3)',borderTopColor:'#060E08',borderRadius:'50%',animation:'spin 0.7s linear infinite',display:'inline-block'}} />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            {loading ? 'Signing in...' : 'Continue with Google'}
          </button>

          <div style={{
            marginTop: 28,
            padding: '16px',
            background: 'rgba(201,168,76,0.05)',
            border: '1px solid rgba(201,168,76,0.1)',
            borderRadius: 10,
          }}>
            <p style={{ color: '#5E8060', fontSize: 11, textAlign: 'center', lineHeight: 1.6 }}>
              🔒 Access restricted to authorized users only.<br />
              <span style={{color:'rgba(201,168,76,0.6)'}}>gold-as.com</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
