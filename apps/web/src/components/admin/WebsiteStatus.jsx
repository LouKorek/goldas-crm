// System › Website: can Golda publish to gold-as.com, how to ask her, and what
// she published lately. Lou's own panel on the site keeps working beside her.
import React, { useEffect, useState } from 'react';
import { Skeleton, toast } from 'components/ui/UI';
import { fmtDateTime } from 'lib/i18n';
import { listenWebsite, checkWebsite, WEBSITE_URL } from 'data/website';

const Card = ({ children }) => <div className="card" style={{ padding: 16 }}>{children}</div>;

export default function WebsiteStatus({ he }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => listenWebsite(setD), []);
  if (!d) return <Skeleton rows={3} />;

  const c = d.connection || null;
  const check = async () => {
    setBusy(true);
    try {
      const r = await checkWebsite();
      if (r.ok) toast.success(he ? 'גולדה מחוברת לאתר.' : 'Golda is connected to the website.');
      else toast.error(he ? 'גולדה עוד לא יכולה לפרסם באתר.' : 'Golda cannot publish to the website yet.');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const row = (k, v, ltr) => (v ? (
    <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-3)' }}>{k}</span><span dir={ltr ? 'ltr' : undefined} style={{ minWidth: 0, overflowWrap: 'anywhere', textAlign: 'start' }}>{v}</span>
    </div>
  ) : null);

  const state = !c
    ? (he ? 'החיבור עוד לא נבדק.' : 'The connection has not been checked yet.')
    : c.ok
      ? (he ? 'גולדה מחוברת לאתר ומפרסמת בו שינויים מהשרת, בלי תלות במחשב. הפאנל שלך באתר ממשיך לעבוד כרגיל.' : 'Golda is connected to the website and publishes to it from the server. Your own panel on the site keeps working as before.')
      : c.waitingForPanel
        ? (he ? 'עוד לא מחובר: השרת של פאנל האתר עוד לא מכיר את גולדה.' : 'Not connected yet: the server of the website panel does not know Golda yet.')
        : (he ? 'החיבור לאתר לא עובד כרגע.' : 'The connection to the website is not working right now.');
  const recent = Array.isArray(d.recent) ? d.recent : [];
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'האתר gold-as.com' : 'The website gold-as.com'}</div>
        <div style={{ fontSize: 14, marginBottom: 12 }}>{state}</div>
        <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          {row(he ? 'שחקנים באתר' : 'Players on the site', d.playerCount != null ? String(d.playerCount) : '')}
          {row(he ? 'נבדק לאחרונה' : 'Last checked', c?.at ? fmtDateTime(new Date(c.at)) : '')}
          {c && !c.ok && row(he ? 'הכתובת של גולדה' : 'Golda’s address', c.serviceEmail, true)}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={check} disabled={busy} style={{ height: 32 }}>
            {busy ? (he ? 'בודק…' : 'Checking…') : (he ? 'בדוק חיבור' : 'Check the connection')}
          </button>
          <a className="btn btn-ghost btn-sm" href={WEBSITE_URL} target="_blank" rel="noreferrer" style={{ height: 32, textDecoration: 'none' }}>{he ? 'פתח את האתר' : 'Open the website'}</a>
        </div>
        {c && !c.ok && !c.waitingForPanel && c.why && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }} dir="auto">{c.why}</div>}
      </Card>

      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'איך מבקשים מגולדה' : 'How to ask Golda'}</div>
        <div style={{ fontSize: 14 }}>
          {he
            ? 'כותבים לגולדה בוואטסאפ מה לשנות באתר: כרטיס שחקן חדש, עדכון או הסרה של כרטיס, טקסט או קישור. היא מראה טיוטה ומפרסמת רק אחרי "כן". "תבטלי את השינוי באתר" מחזיר את האתר לקדמותו.'
            : 'Write to Golda on WhatsApp what to change on the site: a new player card, a card to update or remove, a text or a link. She shows a draft and publishes only after a yes. “Undo the website change” brings the site back.'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
          {he
            ? 'תמונה לכרטיס: שחקן חתוך מהרקע (PNG עם רקע שקוף), נשלח לגולדה כמסמך כדי שהשקיפות תישמר.'
            : 'A card photo: the player cut out of the background (a PNG with a transparent background), sent to Golda as a document so the transparency survives.'}
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'פרסומים אחרונים' : 'Recent publishes'}</div>
        {recent.length === 0 ? (
          <div style={{ fontSize: 14 }}>{he ? 'גולדה עוד לא פרסמה שינויים באתר.' : 'Golda has not published anything to the website yet.'}</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {recent.map((p) => (
              <div key={p.id} style={{ minWidth: 0, fontSize: 13 }}>
                <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 2 }}>
                  {fmtDateTime(new Date(p.at))}{p.by ? ` · ${p.by}` : ''}
                  {p.undoOf ? ` · ${he ? 'ביטול של פרסום קודם' : 'an undo of an earlier publish'}` : ''}
                  {p.undone ? ` · ${he ? 'בוטל' : 'undone'}` : ''}
                </div>
                {(p.lines || []).map((l, i) => <div key={i} dir="auto" style={{ overflowWrap: 'anywhere', textDecoration: p.undone ? 'line-through' : 'none' }}>{l}</div>)}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
