// /yt/<token>: the page Golda sends when a video is too big for WhatsApp.
// The writer opens it on the phone and picks the file; it goes straight from
// the phone to YouTube with the title and description already agreed with
// Golda. No sign-in: the token in the link is the key, good for this one
// video (netlify/functions/youtube-upload.js).
import React, { useEffect, useRef, useState } from 'react';
import { getLang } from 'lib/i18n';
import { uploadInfo, openUploadSession, uploadFinished, sendFile } from 'data/youtube';

const PRIVACY = { public: ['ציבורי', 'Public'], unlisted: ['לא רשום (רק עם קישור)', 'Unlisted'], private: ['פרטי', 'Private'] };
const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

export default function YouTubeUpload({ token }) {
  const he = getLang() === 'he';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [gone, setGone] = useState(false);            // the link itself is no longer good
  const [file, setFile] = useState(null);
  const [sent, setSent] = useState(0);
  const [phase, setPhase] = useState('idle');         // idle | sending | closing | done
  const [link, setLink] = useState('');
  const input = useRef(null);

  useEffect(() => {
    document.title = he ? 'העלאת סרטון · Gold A&S' : 'Video upload · Gold A&S';
    uploadInfo(token).then((d) => {
      setInfo(d);
      if (d.link && (d.status === 'uploaded' || d.status === 'done')) { setLink(d.link); setPhase('done'); }
    }).catch((e) => { setGone(true); setError(e.message); });
  }, [token]); // eslint-disable-line

  // Leaving in the middle loses the upload: the browser asks first.
  useEffect(() => {
    if (phase !== 'sending' && phase !== 'closing') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const start = async (f) => {
    if (!f) return;
    if (f.type && !/^video\//.test(f.type)) { setError(he ? 'זה לא קובץ וידאו. בחר סרטון.' : 'That is not a video file. Pick a video.'); return; }
    setError(''); setFile(f); setSent(0); setPhase('sending');
    let lock = null;
    try { lock = await navigator.wakeLock?.request('screen'); } catch { /* the screen may sleep; the upload goes on while the page is open */ }
    try {
      const url = await openUploadSession(token, f);
      const video = await sendFile(url, f, (n) => setSent(n));
      setPhase('closing');
      const done = await uploadFinished(token, video.id);
      setLink(done.link || `https://youtu.be/${video.id}`);
      setPhase('done');
    } catch (e) {
      setError(e.message || (he ? 'ההעלאה נכשלה.' : 'The upload failed.'));
      if (e.status === 404) setGone(true);
      setPhase('idle');
    } finally { try { await lock?.release(); } catch { /* already released */ } }
  };

  const pct = file && file.size ? Math.min(100, Math.round((sent / file.size) * 100)) : 0;
  const busy = phase === 'sending' || phase === 'closing';
  const fact = (k, v) => (v ? (
    <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-3)' }}>{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><bdi>{v}</bdi></span>
    </div>
  ) : null);

  return (
    <main style={{
      minHeight: '100vh', minWidth: 0, background: 'var(--bg)', color: 'var(--text-1)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'calc(16px + env(safe-area-inset-top, 0px)) 16px calc(24px + env(safe-area-inset-bottom, 0px))',
    }}>
      <div style={{
        width: '100%', maxWidth: 400, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 16,
        boxShadow: 'var(--shadow-md)', padding: '32px 28px 28px', textAlign: 'center',
      }}>
        <div className="brand-tile" style={{ width: 72, height: 72, borderRadius: 18, margin: '0 auto 16px' }}>
          <img src="/brand-mark.png" alt="Gold A&S" style={{ width: 54, height: 54 }} />
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, lineHeight: 1.15 }}>
          {phase === 'done' ? (he ? 'הסרטון עלה' : 'The video is up') : (he ? 'העלאת סרטון ליוטיוב' : 'Upload a video to YouTube')}
        </h1>

        {!info && !error && <div style={{ marginTop: 24 }}><span className="spinner" style={{ width: 22, height: 22, display: 'inline-block' }} /></div>}

        {info && (
          <div style={{ display: 'grid', gap: 6, margin: '20px 0 0', textAlign: 'start' }}>
            {fact(he ? 'שחקן' : 'Player', info.player)}
            {fact(he ? 'כותרת' : 'Title', info.title)}
            {fact(he ? 'פרטיות' : 'Privacy', (PRIVACY[info.privacy] || [info.privacy, info.privacy])[he ? 0 : 1])}
          </div>
        )}

        {info && phase === 'idle' && !gone && (
          <>
            <input ref={input} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; start(f); }} />
            <button type="button" className="btn btn-primary btn-lg" onClick={() => input.current?.click()} style={{ width: '100%', marginTop: 24 }}>
              {he ? 'בחר סרטון' : 'Pick the video'}
            </button>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
              {he ? 'ההעלאה מתחילה מיד אחרי הבחירה. השאר את העמוד פתוח עד שהיא מסתיימת.' : 'The upload starts as soon as you pick. Keep this page open until it ends.'}
            </p>
          </>
        )}

        {busy && file && (
          <div style={{ marginTop: 24 }}>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={he ? 'התקדמות ההעלאה' : 'Upload progress'}
              style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s linear' }} />
            </div>
            <p style={{ fontSize: 14, marginTop: 12 }} aria-live="polite">
              {phase === 'closing' ? (he ? 'מסיים…' : 'Finishing…') : <><span dir="ltr">{pct}%</span> · <span dir="ltr">{mb(sent)} / {mb(file.size)}</span></>}
            </p>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              {he ? 'השאר את העמוד פתוח. אם הרשת נופלת, ההעלאה ממשיכה מאיפה שעצרה.' : 'Keep this page open. If the network drops, the upload goes on from where it stopped.'}
            </p>
          </div>
        )}

        {phase === 'done' && (
          <>
            <p style={{ color: 'var(--text-2)', fontSize: 14, lineHeight: 1.55, margin: '20px auto 0' }}>
              {he ? 'הקישור של השחקן במערכת הוחלף, וגולדה שולחת לך את הפרטים בוואטסאפ. אפשר לסגור את העמוד.' : 'The player’s link in the CRM was replaced, and Golda is sending you the details on WhatsApp. You can close this page.'}
            </p>
            {link && (
              <a className="btn btn-primary btn-lg" href={link} target="_blank" rel="noreferrer" style={{ width: '100%', marginTop: 24, textDecoration: 'none' }}>
                {he ? 'פתח ביוטיוב' : 'Open on YouTube'}
              </a>
            )}
          </>
        )}

        {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>{error}</p>}
      </div>
    </main>
  );
}
