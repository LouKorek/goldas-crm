import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider } from 'lib/firebase';
import { t } from 'lib/i18n';
import { useTheme } from 'lib/theme';
import Icon from 'components/ui/Icons';

// Sign-in: one card on the day or night ground, the brand tile on top, one
// button. The night switch sits in the corner so the first screen already
// follows the person's choice.
export default function Login({ denied }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [theme, toggleTheme] = useTheme();

  const login = async () => {
    setLoading(true); setError('');
    try { await signInWithPopup(auth, googleProvider); }
    catch (e) {
      console.error(e);
      setLoading(false);
      // A silent failure looked like a dead button. Name the cause.
      const code = e?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      setError(code === 'auth/unauthorized-domain'
        ? t('This address is not yet authorized for sign-in. Try again in a minute.')
        : t('Sign-in failed: {code}', { code: code || e?.message || 'unknown' }));
    }
  };

  const themeLabel = theme === 'dark' ? t('Light Mode') : t('Dark Mode');

  return (
    <div className="login-root" style={{
      minHeight: '100vh', minWidth: 0,
      background: 'var(--bg)', color: 'var(--text-1)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'calc(16px + env(safe-area-inset-top, 0px)) 16px calc(24px + env(safe-area-inset-bottom, 0px))',
      position: 'relative',
    }}>
      <style>{`
        @keyframes loginIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .login-card { animation: loginIn 0.45s cubic-bezier(0.2,0,0,1) both; }
        .login-theme { position: absolute; top: calc(14px + env(safe-area-inset-top, 0px)); inset-inline-end: 14px; }
        .login-pitch { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 22px; }
        .login-pitch div { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
        .login-pitch svg { color: var(--accent); }
        @media (prefers-reduced-motion: reduce) { .login-card { animation: none; } }
      `}</style>

      <button type="button" className="iconbtn login-theme" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
      </button>

      <div className="login-card" style={{
        width: '100%', maxWidth: 400,
        background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 16,
        boxShadow: 'var(--shadow-md)', padding: '32px 28px 28px', textAlign: 'center',
      }}>
        <div className="brand-tile" style={{ width: 72, height: 72, borderRadius: 18, margin: '0 auto 16px' }}>
          <img src="/brand-mark.png" alt="Gold A&S" style={{ width: 54, height: 54 }} />
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, lineHeight: 1.15 }}>{t('Gold A&S')}</h1>
        <p style={{ color: 'var(--text-2)', fontSize: 14, marginTop: 4 }}>{t('Football Agency')}</p>

        <p style={{ color: 'var(--text-2)', fontSize: 14, lineHeight: 1.55, margin: '22px auto 0', maxWidth: 320 }}>
          {t('Player representation and transfer management, run from a single front office.')}
        </p>

        {denied && (
          <div role="alert" style={{
            background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid transparent',
            borderRadius: 10, fontSize: 13.5, margin: '20px 0 0', padding: '12px 14px',
            display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'start',
          }}>
            <Icon name="alert" size={16} />
            <span>{t('Access denied. This platform is restricted to authorized personnel only.')}</span>
          </div>
        )}

        <button type="button" className="btn btn-primary btn-lg" onClick={login} disabled={loading} style={{ width: '100%', marginTop: 24, gap: 12 }}>
          {loading ? (
            <span className="spinner" style={{ width: 18, height: 18, borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} />
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
          )}
          {loading ? t('Signing in...') : t('Continue with Google')}
        </button>
        {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>{error}</p>}

        <div className="login-pitch" aria-hidden="true">
          {[t('Player Representation'), t('Transfer Window Management'), t('Real-time Collaboration'), t('Contract Tracking')].map((f) => (
            <div key={f}><Icon name="check" size={14} /><span>{f}</span></div>
          ))}
        </div>

        <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 22 }}>
          {t('Authorised personnel only')} · gold-as.com
        </p>
      </div>
    </div>
  );
}
