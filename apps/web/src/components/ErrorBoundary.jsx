// Catches a render error anywhere in the app, shows a plain recovery screen
// instead of a white page, and records the error in `client_errors` so the
// admin Errors tab shows what people hit and on which version. Errors that
// happen outside React (event handlers, promises) are caught by the window
// listeners installed in install().
import React from 'react';
import { reportClientError } from 'data/admin';
import { getLang } from 'lib/i18n';

export default class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { reportClientError(error, { source: 'render' }); }
  render() {
    if (!this.state.error) return this.props.children;
    const he = getLang() !== 'en';
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg)', color: 'var(--text-1)', fontFamily: 'var(--font-body)' }}>
        <div className="card" style={{ padding: 24, maxWidth: 440, width: '100%' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}>{he ? 'משהו נשבר במסך הזה' : 'Something broke on this screen'}</div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.6 }}>{he ? 'השגיאה נרשמה ותופיע במסך המערכת. אפשר לרענן או לחזור לדף הבית, הנתונים שלך בטוחים.' : 'The error was recorded and will show on the System screen. Refresh or go home; your data is safe.'}</p>
          <pre style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'pre-wrap', direction: 'ltr', textAlign: 'left', maxHeight: 120, overflow: 'auto' }}>{String(this.state.error?.message || this.state.error)}</pre>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <a className="btn btn-secondary" href="/home" style={{ textDecoration: 'none' }}>{he ? 'לדף הבית' : 'Home'}</a>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>{he ? 'רענון' : 'Refresh'}</button>
          </div>
        </div>
      </div>
    );
  }
}

let installed = false;
/** Report errors React never sees: uncaught exceptions and unhandled promise rejections. */
export function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => { if (e.error || e.message) reportClientError(e.error || new Error(e.message), { source: 'window' }); });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    // Firestore permission and network errors are expected offline; still worth seeing, but not as crashes.
    reportClientError(r instanceof Error ? r : new Error(String(r)), { source: 'promise' });
  });
}
