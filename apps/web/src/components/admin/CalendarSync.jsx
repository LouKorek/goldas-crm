// System › Google calendar: is the "Gold A&S Player Schedule" sync connected,
// what did it do last, and the one button that connects it.
import React, { useEffect, useState } from 'react';
import { Skeleton, toast } from 'components/ui/UI';
import { listenCalendarSync, connectCalendar, runCalendarSync, CALENDAR_URL } from 'data/calendarSync';

const Card = ({ children }) => <div className="card" style={{ padding: 16 }}>{children}</div>;
const ago = (ms, he) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return he ? 'עכשיו' : 'just now';
  if (m < 60) return he ? `לפני ${m} דק׳` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return he ? `לפני ${h} שע׳` : `${h} h ago`;
  return new Date(ms).toLocaleString(he ? 'he-IL' : 'en-GB');
};

const STATES = {
  ok: ['מחובר. משחקים ואימונים מסתנכרנים בשני הכיוונים כל 10 דקות, ומיד אחרי שגולדה משנה משהו.', 'Connected. Games and trainings sync both ways every 10 minutes, and right after Golda changes something.'],
  needs_share: ['עוד לא מחובר: צריך לחבר את לוח השנה לשרת פעם אחת.', 'Not connected yet: the calendar has to be shared with the server once.'],
  needs_api: ['עוד לא מחובר: צריך לחבר את לוח השנה לשרת פעם אחת.', 'Not connected yet: the calendar has to be shared with the server once.'],
  error: ['הסנכרון האחרון נכשל.', 'The last sync failed.'],
};
const COUNTS = [['insert', 'נוספו', 'added'], ['push', 'עודכנו ביומן', 'updated in the calendar'], ['pull', 'עודכנו במערכת', 'updated in the CRM'],
  ['adopt', 'חוברו לאירוע קיים', 'linked to an existing event'], ['import', 'נקלטו מהיומן', 'imported'], ['deleted_in_calendar', 'בוטלו ביומן', 'cancelled in the calendar'], ['remove', 'הוסרו מהיומן', 'removed']];

export default function CalendarSync({ he }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => listenCalendarSync(setD), []);
  // The service account's address arrives with the first run: ask for one.
  useEffect(() => {
    if (d && !d.serviceAccount && !asked) { setAsked(true); runCalendarSync(true).catch(() => {}); }
  }, [d, asked]);
  if (!d) return <Skeleton rows={3} />;
  const state = d.state || 'needs_share';
  const connected = state === 'ok';
  const label = STATES[state] || STATES.error;
  const r = d.lastResult || {};
  const connect = async () => {
    setBusy(true);
    try {
      const res = await connectCalendar({ serviceAccount: d.serviceAccount, needsApi: state === 'needs_api' });
      (res.ok ? toast.success : toast.error)(res.message);
    } catch (e) {
      if (!/popup-closed|cancelled-popup/.test(String(e.code || e.message))) toast.error(e.message);
    } finally { setBusy(false); }
  };
  const syncNow = async () => {
    try { await runCalendarSync(true); toast.success(he ? 'הסנכרון התחיל.' : 'Sync started.'); } catch (e) { toast.error(e.message); }
  };
  const row = (k, v) => (v ? (
    <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-3)' }}>{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span>
    </div>
  ) : null);
  const counts = COUNTS.filter(([k]) => r[k]).map(([k, h, e]) => `${r[k]} ${he ? h : e}`).join(' · ') || (r.changed === false ? (he ? 'לא היה מה לעדכן' : 'nothing to update') : '');
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Gold A&amp;S Player Schedule</div>
        <div style={{ fontSize: 14, marginBottom: 12 }}>{he ? label[0] : label[1]}</div>
        {!connected && (
          <button type="button" className="btn btn-primary" onClick={connect} disabled={busy || !d.serviceAccount} style={{ height: 40 }}>
            {busy ? (he ? 'מחבר…' : 'Connecting…') : !d.serviceAccount ? (he ? 'מכין את החיבור…' : 'Preparing…') : (he ? 'חבר את לוח השנה' : 'Connect the calendar')}
          </button>
        )}
        {!connected && d.serviceAccount && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
            {he ? 'ייפתח חלון של Google: בחר את החשבון שלך ואשר. אם Google כותב שהאפליקציה לא אומתה, זו המערכת שלך: לחץ "מתקדם" ואז "המשך".'
              : 'A Google window opens: pick your account and allow. If Google says the app is not verified, it is your own system: press Advanced, then Continue.'}
          </div>
        )}
        {connected && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={syncNow} style={{ height: 32 }}>{he ? 'סנכרן עכשיו' : 'Sync now'}</button>
            <a className="btn btn-ghost btn-sm" href={CALENDAR_URL} target="_blank" rel="noreferrer" style={{ height: 32, textDecoration: 'none' }}>{he ? 'פתח את לוח השנה' : 'Open the calendar'}</a>
          </div>
        )}
        {state === 'error' && d.problem?.hint && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{d.problem.hint}</div>}
      </Card>
      {connected && (
        <Card>
          <div style={{ display: 'grid', gap: 6 }}>
            {row(he ? 'נבדק לאחרונה' : 'Last checked', d.lastCheckAt ? ago(d.lastCheckAt, he) : '')}
            {row(he ? 'סנכרון מלא אחרון' : 'Last full pass', d.lastFullMs ? ago(d.lastFullMs, he) : '')}
            {row(he ? 'ביומן' : 'In the calendar', r.items != null ? (he ? `${r.items} משחקים ואימונים ב-60 הימים הקרובים` : `${r.items} games and trainings in the next 60 days`) : '')}
            {row(he ? 'בסנכרון האחרון' : 'Last pass', counts)}
          </div>
        </Card>
      )}
    </div>
  );
}
