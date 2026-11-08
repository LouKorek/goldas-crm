// System › Google calendar: are Lou's two calendars connected ("Gold A&S
// Player Schedule" two-way with games and trainings, "Gold A&S" meetings for
// Golda and the Calendar screen), what the sync did last, and the one button
// that connects whatever is not connected yet.
import React, { useEffect, useState } from 'react';
import { Skeleton, toast } from 'components/ui/UI';
import { listenCalendarSync, listenAgencyCalendar, connectCalendar, runCalendarSync, CALENDAR_URL, CALENDAR_ID, AGENCY_CALENDAR_ID } from 'data/calendarSync';

const Card = ({ children }) => <div className="card" style={{ padding: 16 }}>{children}</div>;
const ago = (ms, he) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return he ? 'עכשיו' : 'just now';
  if (m < 60) return he ? `לפני ${m} דק׳` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return he ? `לפני ${h} שע׳` : `${h} h ago`;
  return new Date(ms).toLocaleString(he ? 'he-IL' : 'en-GB');
};

const AG_COUNTS = [['insert', 'נוספו ליומן', 'added to the calendar'], ['import', 'נקלטו מהיומן', 'imported'], ['push', 'עודכנו ביומן', 'updated in the calendar'],
  ['pull', 'עודכנו במערכת', 'updated in the CRM'], ['cancel_meeting', 'נמחקו ביומן', 'deleted in the calendar'], ['remove_event', 'הוסרו מהיומן', 'removed from the calendar'], ['revive', 'שוחזרו', 'restored']];

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
  const [ag, setAg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => listenCalendarSync(setD), []);
  useEffect(() => listenAgencyCalendar(setAg), []);
  // The service account's address arrives with the first run: ask for one.
  useEffect(() => {
    if (d && !d.serviceAccount && !asked) { setAsked(true); runCalendarSync(true).catch(() => {}); }
  }, [d, asked]);
  if (!d || !ag) return <Skeleton rows={3} />;
  const state = d.state || 'needs_share';
  const agState = ag.state || 'needs_share';
  const agOk = agState === 'ok';
  const connected = state === 'ok';
  const missing = [!connected && CALENDAR_ID, !agOk && AGENCY_CALENDAR_ID].filter(Boolean);
  const serviceAccount = d.serviceAccount || ag.serviceAccount;
  const label = STATES[state] || STATES.error;
  const r = d.lastResult || {};
  const connect = async () => {
    setBusy(true);
    try {
      const res = await connectCalendar({ serviceAccount, needsApi: state === 'needs_api' || agState === 'needs_api', calendarIds: missing });
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
  const ar = ag.lastResult || {};
  const agCounts = AG_COUNTS.filter(([k]) => ar[k]).map(([k, h, e]) => `${ar[k]} ${he ? h : e}`).join(' · ') || (ar.changed === false ? (he ? 'לא היה מה לעדכן' : 'nothing to update') : '');
  const counts = COUNTS.filter(([k]) => r[k]).map(([k, h, e]) => `${r[k]} ${he ? h : e}`).join(' · ') || (r.changed === false ? (he ? 'לא היה מה לעדכן' : 'nothing to update') : '');
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      {missing.length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'חיבור לוחות השנה' : 'Connect the calendars'}</div>
          <div style={{ fontSize: 14, marginBottom: 12 }}>
            {he ? (missing.length > 1 ? 'לחיצה אחת מחברת את שני הלוחות: לוח השחקנים ולוח הסוכנות.' : 'לחיצה אחת מחברת את הלוח שעוד לא מחובר.')
              : (missing.length > 1 ? 'One press connects both calendars: the player schedule and the agency calendar.' : 'One press connects the calendar that is not connected yet.')}
          </div>
          <button type="button" className="btn btn-primary" onClick={connect} disabled={busy || !serviceAccount} style={{ height: 40 }}>
            {busy ? (he ? 'מחבר…' : 'Connecting…') : !serviceAccount ? (he ? 'מכין את החיבור…' : 'Preparing…') : (he ? (missing.length > 1 ? 'חבר את לוחות השנה' : 'חבר את לוח השנה') : (missing.length > 1 ? 'Connect the calendars' : 'Connect the calendar'))}
          </button>
          {serviceAccount && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
              {he ? 'ייפתח חלון של Google: בחר את החשבון שלך ואשר. אם Google כותב שהאפליקציה לא אומתה, זו המערכת שלך: לחץ "מתקדם" ואז "המשך".'
                : 'A Google window opens: pick your account and allow. If Google says the app is not verified, it is your own system: press Advanced, then Continue.'}
            </div>
          )}
        </Card>
      )}
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Gold A&amp;S Player Schedule</div>
        <div style={{ fontSize: 14, marginBottom: 12 }}>{he ? label[0] : label[1]}</div>
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
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Gold A&amp;S</div>
        <div style={{ fontSize: 14, marginBottom: agOk ? 10 : 0 }}>
          {agOk ? (he ? 'מחובר. פגישות מסתנכרנות בשני הכיוונים: מה שתוסיף, תזיז או תמחק ביומן מגיע למערכת ולגולדה תוך 10 דקות, ומה שנעשה במערכת או דרך גולדה מגיע ליומן תוך דקה.' : 'Connected. Meetings sync both ways: what you add, move or delete in the calendar reaches the CRM and Golda within 10 minutes; what is done in the CRM or through Golda reaches the calendar within a minute.')
            : agState === 'error' ? (he ? 'הסנכרון האחרון נכשל.' : 'The last sync failed.')
              : (he ? 'עוד לא מחובר.' : 'Not connected yet.')}
        </div>
        {agOk && (
          <div style={{ display: 'grid', gap: 6 }}>
            {row(he ? 'נבדק לאחרונה' : 'Last checked', ag.lastCheckAt ? ago(ag.lastCheckAt, he) : '')}
            {row(he ? 'סנכרון מלא אחרון' : 'Last full pass', ag.lastFullMs ? ago(ag.lastFullMs, he) : '')}
            {row(he ? 'פגישות' : 'Meetings', ag.lastResult?.meetings != null ? (he ? `${ag.lastResult.meetings} במערכת` : `${ag.lastResult.meetings} in the CRM`) : '')}
            {row(he ? 'בסנכרון האחרון' : 'Last pass', agCounts)}
          </div>
        )}
        {agState === 'error' && ag.problem?.hint && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{ag.problem.hint}</div>}
      </Card>
    </div>
  );
}
