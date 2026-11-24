// System › YouTube: is the server connected to Lou's channel, the one button
// that connects it (a single Google "Allow"), what Golda learned about how the
// channel's videos are titled, described and covered, and who may ask her to
// upload.
import React, { useEffect, useState } from 'react';
import { Skeleton, toast } from 'components/ui/UI';
import { fmtDateTime } from 'lib/i18n';
import { listenYouTube, listenYouTubeStyle, startYouTubeConnect, saveYouTubeClient, relearnYouTubeStyle, setManagersMayUpload } from 'data/youtube';

const Card = ({ children }) => <div className="card" style={{ padding: 16 }}>{children}</div>;
const PRIVACY = { public: ['ציבורי', 'Public'], unlisted: ['לא רשום (רק עם קישור)', 'Unlisted'], private: ['פרטי', 'Private'] };
// The style's templates, in words a person reads: {name} | {positions} → שם | עמדות.
const WORDS = {
  name: ['שם', 'name'], firstName: ['שם פרטי', 'first name'], lastName: ['שם משפחה', 'last name'], position: ['עמדה', 'position'], positions: ['עמדות', 'positions'],
  club: ['קבוצה', 'club'], age: ['גיל', 'age'], birthYear: ['שנת לידה', 'birth year'], birthDate: ['תאריך לידה', 'date of birth'], birthDateDMY: ['תאריך לידה', 'date of birth'],
  birthDateDots: ['תאריך לידה', 'date of birth'], foot: ['רגל', 'foot'], footShort: ['רגל', 'foot'], nationality: ['אזרחות', 'nationality'], nationalityFlags: ['אזרחות ודגל', 'nationality and flag'],
  flags: ['דגל', 'flag'], height: ['גובה', 'height'], heightM: ['גובה', 'height'], heightCm: ['גובה', 'height'], season: ['עונה', 'season'], seasonLong: ['עונה', 'season'],
  year: ['שנה', 'year'], date: ['תאריך', 'date'], agency: ['סוכנות', 'agency'], extra: ['תוספת חופשית', 'free text'],
};
const inWords = (template, he) => String(template || '').replace(/\{(\w+)\}/g, (m, k) => (WORDS[k] ? WORDS[k][he ? 0 : 1] : m));
const AUDIENCE = { men: ['גברים', 'men'], women: ['נשים', 'women'], youth: ['נוער', 'youth'], all: ['כולם', 'everyone'] };

export default function YouTubeConnect({ he }) {
  const [d, setD] = useState(null);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [playlists, setPlaylists] = useState(null);       // null: follow what is already allowed
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => listenYouTube(setD), []);
  useEffect(() => listenYouTubeStyle(setSt), []);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('yt') === 'ok') toast.success(he ? 'יוטיוב חובר. גולדה לומדת עכשיו את סגנון הערוץ.' : 'YouTube is connected. Golda is learning the channel’s style.');
    if (p.get('yt') === 'error') toast.error((he ? 'החיבור לא הצליח: ' : 'Sign-in failed: ') + (p.get('reason') || ''));
  }, []); // eslint-disable-line
  if (!d || !st) return <Skeleton rows={3} />;

  const withPlaylists = playlists ?? !!d.playlistsAllowed;
  const connect = async () => {
    setBusy(true);
    try { const { url } = await startYouTubeConnect(withPlaylists); window.location.assign(url); }
    catch (e) { toast.error(e.message); setBusy(false); }
  };
  const saveClient = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveYouTubeClient(clientId.trim(), clientSecret.trim());
      setClientId(''); setClientSecret('');
      toast.success(he ? 'נשמר.' : 'Saved.');
    } catch (err) { toast.error(err.message); } finally { setSaving(false); }
  };
  const relearn = async () => {
    try { await relearnYouTubeStyle(); toast.success(he ? 'גולדה קוראת שוב את הערוץ. זה לוקח כדקה.' : 'Golda is reading the channel again. It takes about a minute.'); }
    catch (e) { toast.error(e.message); }
  };
  const managers = async (allow) => {
    try { await setManagersMayUpload(allow); } catch (e) { toast.error(e.message); }
  };
  const row = (k, v) => (v ? (
    <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-3)' }}>{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{v}</span>
    </div>
  ) : null);

  const s = st.style || {};
  const lists = (s.playlists || []).map((p) => `${p.title || ''} (${(AUDIENCE[p.for] || [p.for, p.for])[he ? 0 : 1]})`).join(' · ');
  const state = d.connected
    ? (he ? `מחובר לערוץ ${d.channel?.title || ''}. גולדה מעלה אליו סרטונים מהשרת, בלי תלות במחשב.` : `Connected to ${d.channel?.title || 'the channel'}. Golda uploads to it from the server.`)
    : d.clientReady
      ? (he ? 'עוד לא מחובר: צריך אישור אחד בגוגל.' : 'Not connected yet: one Google approval is needed.')
      : (he ? 'עוד לא מחובר: חסרים פרטי החיבור של גוגל (למטה).' : 'Not connected yet: the Google client details are missing (below).');
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'ערוץ היוטיוב' : 'The YouTube channel'}</div>
        <div style={{ fontSize: 14, marginBottom: 12 }}>{state}</div>
        {d.clientReady && (
          <>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={withPlaylists} onChange={(e) => setPlaylists(e.target.checked)} style={{ accentColor: 'var(--gold)', marginTop: 2 }} />
              <span>
                {he ? 'להכניס כל סרטון לפלייליסט של הערוץ' : 'File every video in the channel’s playlist'}
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)' }}>
                  {he ? 'דורש הרשאה רחבה יותר, שגוגל מציג כ"ניהול חשבון YouTube". בלי הסימון גולדה רק מעלה וקוראת.' : 'Needs a wider permission, which Google shows as “Manage your YouTube account”. Without it Golda only uploads and reads.'}
                </span>
              </span>
            </label>
            {!d.connected ? (
              <button type="button" className="btn btn-primary" onClick={connect} disabled={busy} style={{ height: 40 }}>
                {busy ? (he ? 'פותח את גוגל…' : 'Opening Google…') : (he ? 'חבר את יוטיוב' : 'Connect YouTube')}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={connect} disabled={busy} style={{ height: 32 }}>
                {busy ? (he ? 'פותח את גוגל…' : 'Opening Google…') : (he ? 'חבר מחדש' : 'Connect again')}
              </button>
            )}
            {!d.connected && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
                {he ? 'ייפתח מסך של Google: בחר את החשבון של הערוץ ואשר. אם Google כותב שהאפליקציה לא אומתה, זו המערכת שלך: לחץ "מתקדם" ואז "המשך".'
                  : 'A Google screen opens: pick the channel’s account and allow. If Google says the app is not verified, it is your own system: press Advanced, then Continue.'}
              </div>
            )}
          </>
        )}
        {d.lastError?.message && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{d.lastError.message}</div>}
      </Card>

      {d.connected && (
        <Card>
          <div style={{ display: 'grid', gap: 6 }}>
            {row(he ? 'מחובר מאז' : 'Connected', d.connectedAt ? fmtDateTime(new Date(d.connectedAt)) : '')}
            {row(he ? 'חיבר' : 'Connected by', d.connectedBy)}
            {row(he ? 'פלייליסטים' : 'Playlists', d.playlistsAllowed ? (he ? 'גולדה מכניסה סרטונים לפלייליסט' : 'Golda files videos in the playlist') : (he ? 'בלי הרשאה: גולדה לא מכניסה לפלייליסט' : 'No permission: Golda does not file videos'))}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!d.managersMayUpload} onChange={(e) => managers(e.target.checked)} style={{ accentColor: 'var(--gold)' }} />
            <span>{he ? 'גם מנהלים בצוות יכולים לבקש מגולדה להעלות סרטון (בלי הסימון: רק אדמין)' : 'Managers too may ask Golda to upload a video (unticked: admins only)'}</span>
          </label>
        </Card>
      )}

      {d.connected && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'הסגנון שגולדה למדה מהערוץ' : 'The style Golda learned from the channel'}</div>
          {st.learnedAt ? (
            <>
              <div style={{ fontSize: 14, marginBottom: 12 }}>{s.summaryHe || ''}</div>
              <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
                {row(he ? 'כותרת' : 'Title', inWords(s.title, he))}
                {row(he ? 'תיאור' : 'Description', inWords(s.description, he))}
                {row(he ? 'פרטיות' : 'Privacy', (PRIVACY[s.privacy] || [s.privacy, s.privacy])[he ? 0 : 1])}
                {row(he ? 'פלייליסט' : 'Playlist', lists)}
                {row(he ? 'נלמד מתוך' : 'Learned from', he ? `${st.playerVideos ?? st.fromVideos ?? 0} סרטוני שחקנים` : `${st.playerVideos ?? st.fromVideos ?? 0} player videos`)}
                {row(he ? 'נלמד לאחרונה' : 'Last learned', fmtDateTime(new Date(st.learnedAt)))}
              </div>
              {(st.examples || []).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 12 }}>
                  {st.examples.slice(0, 4).map((v) => (
                    <a key={v.id} href={`https://youtu.be/${v.id}`} target="_blank" rel="noreferrer" style={{ minWidth: 0, color: 'inherit', textDecoration: 'none', fontSize: 12 }}>
                      {v.cover && <img src={v.cover} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', display: 'block', marginBottom: 4 }} />}
                      <span style={{ display: 'block', overflowWrap: 'anywhere' }} dir="auto">{v.title}</span>
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 14, marginBottom: 12 }}>{he ? 'גולדה עוד קוראת את הערוץ. זה לוקח כדקה.' : 'Golda is still reading the channel. It takes about a minute.'}</div>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={relearn} style={{ height: 32 }}>{he ? 'למד מחדש מהערוץ' : 'Learn again from the channel'}</button>
          {st.problem && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{st.problem}</div>}
        </Card>
      )}

      <Card>
        <details open={!d.clientReady}>
          <summary style={{ fontWeight: 700, cursor: 'pointer' }}>{he ? 'פרטי החיבור של גוגל' : 'The Google client'}</summary>
          <div style={{ fontSize: 13, color: 'var(--text-3)', margin: '8px 0 12px' }}>
            {d.clientReady
              ? (he ? 'שמורים בשרת, והסוד מוצפן. ממלאים שוב רק כדי להחליף אותם.' : 'Stored on the server, the secret sealed. Fill in again only to replace them.')
              : (he ? 'מזהה הלקוח והסוד מ-Google Cloud. הסוד נשמר מוצפן בשרת ולא מוצג שוב.' : 'The client ID and secret from Google Cloud. The secret is sealed on the server and never shown again.')}
          </div>
          <form onSubmit={saveClient} style={{ display: 'grid', gap: 8 }}>
            <input className="input" aria-label={he ? 'מזהה לקוח' : 'Client ID'} placeholder={he ? 'מזהה לקוח (Client ID)' : 'Client ID'} value={clientId} onChange={(e) => setClientId(e.target.value)} dir="ltr" autoComplete="off" required />
            <input className="input" type="password" aria-label={he ? 'סוד לקוח' : 'Client secret'} placeholder={he ? 'סוד לקוח (Client secret)' : 'Client secret'} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} dir="ltr" autoComplete="off" required />
            <div>
              <button type="submit" className="btn btn-ghost btn-sm" disabled={saving} style={{ height: 32 }}>{saving ? (he ? 'שומר…' : 'Saving…') : (he ? 'שמור' : 'Save')}</button>
            </div>
          </form>
        </details>
      </Card>
    </div>
  );
}
