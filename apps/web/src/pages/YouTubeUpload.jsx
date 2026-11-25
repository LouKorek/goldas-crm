// /yt/<token>: the page Golda sends when a video is too big for WhatsApp.
// The writer opens it on the phone and picks the file; it goes straight from
// the phone to YouTube with the title and description already agreed with
// Golda. No sign-in: the token in the link is the key, good for this one
// video (netlify/functions/youtube-upload.js).
//
// Highlights: when the writer asked Golda for chosen moments of a match, the
// job carries them (info.highlights, from the server, never from the link).
// The writer picks the full match video; the page cuts the moments out of it
// here on the phone (lib/highlights-cut.js, loaded only then) and uploads
// only that cut. The match file itself goes nowhere.
import React, { useEffect, useRef, useState } from 'react';
import { formatClock, formatMoment } from '@goldas/domain';
import { getLang, t } from 'lib/i18n';
import { uploadInfo, openUploadSession, uploadFinished, sendFile, sendStream } from 'data/youtube';

const PRIVACY = { public: ['ציבורי', 'Public'], unlisted: ['לא רשום (רק עם קישור)', 'Unlisted'], private: ['פרטי', 'Private'] };
const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const PERCENT = 100;

export default function YouTubeUpload({ token }) {
  const he = getLang() === 'he';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [gone, setGone] = useState(false);            // the link itself is no longer good
  const [file, setFile] = useState(null);
  const [total, setTotal] = useState(0);              // bytes that go to YouTube: the file, or the cut
  const [sent, setSent] = useState(0);
  const [phase, setPhase] = useState('idle');         // idle | reading | cutting | sending | closing | done
  const [clip, setClip] = useState({ n: 0, of: 0 });  // which clip is being cut
  const [link, setLink] = useState('');
  const input = useRef(null);
  const moments = info?.highlights?.moments || null;

  useEffect(() => {
    document.title = he ? 'העלאת סרטון · Gold A&S' : 'Video upload · Gold A&S';
    uploadInfo(token).then((d) => {
      setInfo(d);
      if (d.link && (d.status === 'uploaded' || d.status === 'done')) { setLink(d.link); setPhase('done'); }
    }).catch((e) => { setGone(true); setError(e.message); });
  }, [token]); // eslint-disable-line

  // Leaving in the middle loses the upload: the browser asks first.
  const busy = phase === 'reading' || phase === 'cutting' || phase === 'sending' || phase === 'closing';
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // The whole file goes up as it is.
  const sendWhole = async (f) => {
    setTotal(f.size); setPhase('sending');
    const url = await openUploadSession(token, f);
    return sendFile(url, f, (n) => setSent(n));
  };
  // Highlights: cut the moments out of the match here, send only the cut.
  const sendHighlights = async (f) => {
    setPhase('reading');
    const { prepareCut } = await import('lib/highlights-cut');
    const cut = await prepareCut(f, moments, {
      onProgress: (p) => { if (p.step === 'cutting') { setClip({ n: p.clip, of: p.clips }); setPhase('cutting'); } },
    });
    try {
      setTotal(cut.size); setPhase('sending');
      const url = await openUploadSession(token, { size: cut.size, type: cut.type }, { seconds: cut.duration, clips: cut.clips.length });
      return await sendStream(url, cut.size, cut.stream(), (n) => setSent(n));
    } finally { cut.close(); }
  };

  const start = async (f) => {
    if (!f) return;
    if (f.type && !/^video\//.test(f.type)) { setError(he ? 'זה לא קובץ וידאו. בחר סרטון.' : 'That is not a video file. Pick a video.'); return; }
    // The phase first, so the pick button goes at once; a second try starts its bar from nothing.
    setError(''); setFile(f); setSent(0); setTotal(0); setClip({ n: 0, of: 0 }); setPhase(moments ? 'reading' : 'sending');
    let lock = null;
    try { lock = await navigator.wakeLock?.request('screen'); } catch { /* the screen may sleep; the upload goes on while the page is open */ }
    try {
      const video = await (moments ? sendHighlights(f) : sendWhole(f));
      setPhase('closing');
      const done = await uploadFinished(token, video.id);
      setLink(done.link || `https://youtu.be/${video.id}`);
      setPhase('done');
    } catch (e) {
      // A file that cannot be cut says why in a sentence of its own (CutError: the English text is the key).
      setError(e.name === 'CutError' ? t(e.message, e.vars || undefined) : (e.message && t(e.message)) || (he ? 'ההעלאה נכשלה.' : 'The upload failed.'));
      if (e.status === 404) setGone(true);
      setPhase('idle');
    } finally { try { await lock?.release(); } catch { /* already released */ } }
  };

  const cutting = phase === 'reading' || phase === 'cutting';
  // While cutting the bar counts clips; while sending, bytes.
  const pct = cutting
    ? (clip.of ? Math.round(((clip.n - 1) / clip.of) * PERCENT) : 0)
    : total ? Math.min(PERCENT, Math.round((sent / total) * PERCENT)) : 0;
  const row = (k, child) => (
    <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-3)' }}>{k}</span>{child}
    </div>
  );
  const fact = (k, v) => (v ? row(k, <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><bdi>{v}</bdi></span>) : null);
  const title = moments
    ? (phase === 'done' ? t('The highlights are up') : t('Upload highlights to YouTube'))
    : (phase === 'done' ? (he ? 'הסרטון עלה' : 'The video is up') : (he ? 'העלאת סרטון ליוטיוב' : 'Upload a video to YouTube'));

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
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, lineHeight: 1.15 }}>{title}</h1>

        {!info && !error && <div style={{ marginTop: 24 }}><span className="spinner" style={{ width: 22, height: 22, display: 'inline-block' }} /></div>}

        {info && (
          <div style={{ display: 'grid', gap: 6, margin: '20px 0 0', textAlign: 'start' }}>
            {fact(he ? 'שחקן' : 'Player', info.player)}
            {fact(he ? 'כותרת' : 'Title', info.title)}
            {fact(he ? 'פרטיות' : 'Privacy', (PRIVACY[info.privacy] || [info.privacy, info.privacy])[he ? 0 : 1])}
            {moments && row(t('Moments'), (
              <ul aria-label={t('The moments that will be cut, as times in the video')} style={{ listStyle: 'none', margin: 0, padding: 0, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                {moments.map((m) => <li key={m.start} dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoment(m)}</li>)}
              </ul>
            ))}
            {moments && fact(t('Length'), t('about {length}', { length: formatClock(info.highlights.total) }))}
          </div>
        )}

        {info && phase === 'idle' && !gone && (
          <>
            <input ref={input} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; start(f); }} />
            <button type="button" className="btn btn-primary btn-lg" onClick={() => input.current?.click()} style={{ width: '100%', marginTop: 24 }}>
              {moments ? t('Pick the match video') : (he ? 'בחר סרטון' : 'Pick the video')}
            </button>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>
              {moments
                ? t('Pick the full match video. This phone cuts the moments out of it and uploads only them; the match itself is not uploaded. Each moment may start a second or two early. Keep this page open until it ends.')
                : (he ? 'ההעלאה מתחילה מיד אחרי הבחירה. השאר את העמוד פתוח עד שהיא מסתיימת.' : 'The upload starts as soon as you pick. Keep this page open until it ends.')}
            </p>
          </>
        )}

        {busy && file && (
          <div style={{ marginTop: 24 }}>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={cutting ? t('Cutting progress') : (he ? 'התקדמות ההעלאה' : 'Upload progress')}
              style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s linear' }} />
            </div>
            <p style={{ fontSize: 14, marginTop: 12 }} aria-live="polite">
              {phase === 'reading' && t('Reading the video…')}
              {phase === 'cutting' && <>{t('Cutting the moments')} · <span dir="ltr">{clip.n}/{clip.of}</span></>}
              {phase === 'sending' && (total
                ? <>{moments ? <>{t('Uploading the highlights')} · </> : null}<span dir="ltr">{pct}%</span> · <span dir="ltr">{mb(sent)} / {mb(total)}</span></>
                : <span dir="ltr">0%</span>)}
              {phase === 'closing' && (he ? 'מסיים…' : 'Finishing…')}
            </p>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              {cutting
                ? t('Keep this page open. The cutting happens on this phone, and nothing is uploaded yet.')
                : (he ? 'השאר את העמוד פתוח. אם הרשת נופלת, ההעלאה ממשיכה מאיפה שעצרה.' : 'Keep this page open. If the network drops, the upload goes on from where it stopped.')}
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
