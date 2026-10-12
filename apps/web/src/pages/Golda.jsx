import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { useRole } from 'lib/roleContext';
import { t, fmtDateTime, getLang } from 'lib/i18n';
import { PageHeader, Skeleton, Empty, ChipGroup, Field, toast, useConfirm } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { DEAL_STAGE_LABELS } from '@goldas/domain';
import {
  PHYSICAL, listenGoldaAudit, undoGoldaAction, sendToGolda, listenInboxMessage, listenGoldaThread, sessionKeyFor,
  listenMyUser, saveMyPrefs,
} from 'data/golda';

// Golda's area, three tabs. "Chat" talks to the same Golda as WhatsApp (and
// shows the same conversation when the person's number is on their record).
// "Actions" is the paper trail: every change she made, with who asked and a
// one-click undo. "Settings" is the person's own morning briefing.

const TAB_KEY = 'golda-tab';

const COLLECTION_LABEL = {
  he: {
    players: 'שחקנים', pipeline_men: 'מועמדים (גברים)', pipeline_women: 'מועמדות (נשים)', pipeline_youth: 'מועמדים (נוער)',
    pipeline_jewish: 'יהודים', club_requirements: 'דרישות מועדונים', contacts: 'אנשי קשר', matches: 'משחקים',
    tasks: 'משימות', clubs: 'מועדונים', deals: 'עסקאות', trainings: 'אימונים', tmWatch: 'מעקב TM',
  },
  en: {
    players: 'Players', pipeline_men: 'Candidates (men)', pipeline_women: 'Candidates (women)', pipeline_youth: 'Candidates (youth)',
    pipeline_jewish: 'Jewish', club_requirements: 'Club requirements', contacts: 'Contacts', matches: 'Matches',
    tasks: 'Tasks', clubs: 'Clubs', deals: 'Deals', trainings: 'Trainings', tmWatch: 'TM Watch',
  },
};
const FIELD_LABEL = {
  he: {
    fullName: 'שם', playerName: 'שם', currentClub: 'מועדון', primaryPosition: 'עמדה', secondaryPositions: 'עמדות נוספות',
    dob: 'תאריך לידה', height: 'גובה', foot: 'רגל', nationalities: 'אזרחויות', contractEnd: 'סיום חוזה', contractStatus: 'סטטוס חוזה',
    reprEnd: 'סיום ייצוג', passportExpiry: 'תוקף דרכון', phone: 'טלפון', contactPhone: 'טלפון', email: 'אימייל', notes: 'הערות',
    status: 'סטטוס', stage: 'שלב', category: 'קטגוריה', agentName: 'סוכן', videoLink: 'וידאו', profileLink: 'פרופיל',
    contractFiles: 'מסמכי חוזה', passportFiles: 'מסמכי דרכון', reprFiles: 'מסמכי ייצוג', title: 'כותרת', dueDate: 'תאריך יעד',
    done: 'בוצע', clubName: 'מועדון', contactName: 'איש קשר', contactRole: 'תפקיד', date: 'תאריך', time: 'שעה',
    homeTeam: 'קבוצה ביתית', awayTeam: 'קבוצה אורחת', venue: 'מגרש', salary: 'שכר', position: 'עמדה', linkedClubs: 'מועדונים מקושרים',
    place: 'מקום', rule: 'חזרה', exceptions: 'חריגים', validUntil: 'בתוקף עד', enteredStageAt: 'נכנס לשלב', history: 'היסטוריה',
  },
  en: {},
};
const HIDDEN_FIELDS = /^(updatedAt|lastEdited|createdAt|enteredStageAt|history|closedAt|name)$|^lastEdited/;

const nameOf = (d) => d?.fullName || d?.playerName || d?.name || d?.title || d?.clubName || d?.contactName
  || (d?.homeTeam && d?.awayTeam ? `${d.homeTeam} – ${d.awayTeam}` : '') || '';

/** Where a record lives in the app, for the row's link. */
const linkFor = (a) => {
  const col = PHYSICAL[a.collection] || a.collection;
  if (col === 'players') return `/players/${a.docId}`;
  if (col === 'deals') return `/market/deals?deal=${a.docId}`;
  if (col === 'club_requirements') return `/market/requirements?req=${a.docId}`;
  if (col === 'tasks') return '/tasks';
  if (col === 'matches' || col === 'trainings') return '/calendar';
  if (col === 'clubs') return `/clubs/${a.docId}`;
  if (col === 'contacts') return '/contacts';
  return null;
};

const QUICK = [
  'מה דורש פעולה היום?',
  'מי מתאים לדרישות המועדונים הפתוחות?',
  'אילו חוזים מסתיימים בחודשיים הקרובים?',
  'מה עשית ב-24 השעות האחרונות?',
];

export default function Golda() {
  const { email, name, canEdit } = useRole();
  const location = useLocation();
  const navigate = useNavigate();
  const he = getLang() === 'he';
  const [tab, setTab] = useState(() => location.state?.tab || localStorage.getItem(TAB_KEY) || 'chat');
  useEffect(() => { localStorage.setItem(TAB_KEY, tab); }, [tab]);
  const [me, setMe] = useState(null);
  useEffect(() => listenMyUser(email, setMe), [email]);

  return (
    <div>
      <PageHeader title={t('Golda')} subtitle={he ? 'העוזרת של הסוכנות. מדברים איתה כאן או בוואטסאפ, וכל שינוי שהיא עושה נרשם עם מי ביקש.' : 'The agency assistant. Talk to her here or on WhatsApp; every change she makes is recorded with who asked.'}>
        <div className="tabs" role="tablist" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-2)', marginTop: 8 }}>
          {[['chat', t('Chat')], ['actions', t('Actions')], ['settings', t('My briefing')]].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              style={{ background: 'none', border: 'none', borderBottom: tab === k ? '2px solid var(--gold)' : '2px solid transparent', color: tab === k ? 'var(--text-1)' : 'var(--text-3)', padding: '8px 14px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: -1 }}>
              {label}
            </button>
          ))}
        </div>
      </PageHeader>
      {tab === 'chat' && <Chat me={me} email={email} name={name} prefill={location.state?.prefill} onPrefilled={() => navigate(location.pathname, { replace: true, state: {} })} />}
      {tab === 'actions' && <Actions email={email} canEdit={canEdit} he={he} />}
      {tab === 'settings' && <Settings me={me} email={email} he={he} />}
    </div>
  );
}

// ── Chat ─────────────────────────────────────────────────────────
function Chat({ me, email, name, prefill, onPrefilled }) {
  const he = getLang() === 'he';
  const key = useMemo(() => (me ? sessionKeyFor({ ...me, email }) : null), [me, email]);
  const [history, setHistory] = useState(null);
  const [pending, setPending] = useState([]);     // messages sent from here and not yet in the thread
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => { if (key) return listenGoldaThread(key, setHistory); }, [key]);
  useEffect(() => { if (prefill) { setText(prefill); onPrefilled?.(); setTimeout(() => taRef.current?.focus(), 50); } }, [prefill]); // eslint-disable-line

  // Follow each sent message until the worker has answered (the thread then carries it).
  useEffect(() => {
    const unsubs = pending.filter((p) => !p.state || p.state === 'queued' || p.state === 'processing').map((p) => listenInboxMessage(p.id, (m) => {
      if (!m) return;
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, state: m.state, reply: m.reply, error: m.error } : x)));
    }));
    return () => unsubs.forEach((u) => u());
  }, [pending.map((p) => `${p.id}:${p.state}`).join('|')]); // eslint-disable-line

  // Once the thread shows the turn, the pending copy is redundant.
  useEffect(() => {
    if (!history) return;
    setPending((list) => list.filter((p) => !(p.state === 'done' && history.some((h) => h.role === 'user' && h.text === p.text && h.at >= p.sentAt - 1000))));
  }, [history]);

  const items = useMemo(() => {
    const out = (history || []).map((h, i) => ({ id: `h${i}`, role: h.role, text: h.text, at: h.at, channel: h.channel }));
    for (const p of pending) {
      out.push({ id: p.id, role: 'user', text: p.text, at: p.sentAt, mine: true });
      if (p.state === 'done' || p.state === 'error' || p.state === 'reply_pending') out.push({ id: `${p.id}_r`, role: 'assistant', text: p.reply || (he ? 'משהו השתבש.' : 'Something went wrong.'), at: p.sentAt + 1, error: p.state === 'error' });
      else out.push({ id: `${p.id}_typing`, role: 'assistant', typing: true, at: p.sentAt + 1 });
    }
    return out;
  }, [history, pending, he]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [items.length]);

  const send = async (msg) => {
    const body = String(msg ?? text).trim();
    if (!body || sending) return;
    setSending(true); setText('');
    try {
      const id = await sendToGolda(body);
      setPending((list) => [...list, { id, text: body, sentAt: Date.now(), state: 'queued' }]);
    } catch (e) {
      toast.error(e.message || t('Could not send.'));
      setText(body);
    } finally { setSending(false); taRef.current?.focus(); }
  };

  if (!me || history === null) return <Skeleton rows={6} />;
  const first = (name || '').split(' ')[0];

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 'min(72vh, 720px)', padding: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-3)', fontSize: 13, maxWidth: 420 }}>
            <div style={{ fontSize: 15, color: 'var(--text-1)', fontWeight: 600, marginBottom: 6 }}>{he ? `שלום ${first}, אני גולדה.` : `Hi ${first}, I'm Golda.`}</div>
            {he ? 'שאלו אותי על השחקנים, המועדונים והעסקאות, או בקשו ממני לעדכן משהו. אפשר להתחיל מאחת השאלות למטה.' : 'Ask me about players, clubs and deals, or ask me to update something.'}
          </div>
        )}
        {items.map((m) => <Bubble key={m.id} m={m} he={he} />)}
        <div ref={endRef} />
      </div>
      {items.length < 4 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 16px 10px' }}>
          {QUICK.map((q) => <button key={q} type="button" className="chip" onClick={() => send(q)}>{q}</button>)}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--rule)', alignItems: 'flex-end' }}>
        <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder={he ? 'כתבו לגולדה…' : 'Write to Golda…'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ minHeight: 42, maxHeight: 140, resize: 'none', flex: 1 }} />
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending} style={{ height: 42 }}>
          <Icon name="chat" size={12} /><span className="btn-text">{t('Send')}</span>
        </button>
      </form>
    </div>
  );
}

function Bubble({ m, he }) {
  const mine = m.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-start' : 'flex-end' }}>
      <div style={{
        maxWidth: '82%', padding: '9px 12px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        background: mine ? 'var(--surface-3)' : 'rgba(201,168,76,0.10)', border: `1px solid ${mine ? 'var(--border)' : 'rgba(201,168,76,0.35)'}`,
        color: m.error ? 'var(--red)' : 'var(--text-1)',
      }}>
        {m.typing ? <Typing he={he} /> : <Rich text={m.text} />}
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, textAlign: 'end' }}>
          {m.at ? fmtDateTime(new Date(m.at)) : ''}{m.channel === 'whatsapp' && mine ? ' · WhatsApp' : ''}
        </div>
      </div>
    </div>
  );
}

function Typing({ he }) {
  return <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>{he ? 'גולדה כותבת…' : 'Golda is typing…'}</span>;
}

/** WhatsApp-style text: *bold*, _italic_, and links that open the app in place. */
function Rich({ text }) {
  const parts = String(text || '').split(/(\*[^*\n]+\*|_[^_\n]+_|https?:\/\/\S+)/g);
  return parts.map((p, i) => {
    if (/^\*[^*\n]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
    if (/^_[^_\n]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    if (/^https?:\/\//.test(p)) {
      const m = /^https?:\/\/goldas-crm\.netlify\.app(\/[^\s)]*)/.exec(p);
      const label = p.replace(/^https?:\/\//, '').slice(0, 48);
      return m ? <Link key={i} to={m[1]} style={{ color: 'var(--gold)' }}>{label}</Link> : <a key={i} href={p} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>{label}</a>;
    }
    return p;
  });
}

// ── Actions ───────────────────────────────────────────────────────
function Actions({ email, canEdit, he }) {
  const [rows, setRows] = useState(null);
  const [names, setNames] = useState({});
  const [scope, setScope] = useState('all');
  const pending = useRef(new Set());
  const { confirm, dialog } = useConfirm();
  useEffect(() => listenGoldaAudit(setRows), []);
  const L = he ? 'he' : 'en';
  const list = useMemo(() => (rows || []).filter((a) => scope === 'all' || a.onBehalfOf === email).slice(0, 200), [rows, scope, email]);

  // Resolve the names the rows themselves do not carry, once per record.
  useEffect(() => {
    const missing = list.filter((a) => !nameOf(a.after) && !nameOf(a.before) && a.docId && a.collection
      && names[`${a.collection}/${a.docId}`] === undefined && !pending.current.has(`${a.collection}/${a.docId}`));
    if (!missing.length) return;
    missing.forEach(async (a) => {
      const key = `${a.collection}/${a.docId}`;
      pending.current.add(key);
      try {
        const snap = await getDoc(doc(db, PHYSICAL[a.collection] || a.collection, a.docId));
        setNames((n) => ({ ...n, [key]: snap.exists() ? (nameOf(snap.data()) || '') : null }));
      } catch { setNames((n) => ({ ...n, [key]: '' })); }
    });
  }, [list, names]);

  const ACTION = { create: he ? 'יצרה' : 'created', update: he ? 'עדכנה' : 'updated', delete: he ? 'מחקה' : 'deleted' };
  const label = (a) => {
    const own = nameOf(a.after) || nameOf(a.before);
    if (own) return own;
    const cached = names[`${a.collection}/${a.docId}`];
    if (cached) return cached;
    if (cached === null) return he ? 'רשומה שנמחקה' : 'Deleted record';
    return he ? 'רשומה' : 'Record';
  };
  const collectionLabel = (c) => COLLECTION_LABEL[L][c] || COLLECTION_LABEL.en[c] || c || '';
  const fieldLabel = (k) => FIELD_LABEL[L][k] || k;
  const fieldValue = (k, v) => {
    if (k === 'stage' && he && DEAL_STAGE_LABELS?.[v]) return DEAL_STAGE_LABELS[v];
    if (Array.isArray(v) && v.length && v[0]?.name) return he ? `${v.length} קבצים` : `${v.length} files`;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? x?.name || x?.clubName || x?.stage || '' : String(x))).filter(Boolean).join(', ').slice(0, 60);
    if (v && typeof v === 'object') return v.toDate ? fmtDateTime(v.toDate()) : '…';
    if (typeof v === 'boolean') return v ? (he ? 'כן' : 'yes') : (he ? 'לא' : 'no');
    return String(v ?? '').slice(0, 60);
  };

  const undo = async (a) => {
    const ok = await confirm(he ? `לבטל את הפעולה "${ACTION[a.action] || a.action} · ${label(a)}"?` : `Undo "${ACTION[a.action] || a.action} · ${label(a)}"?`, { confirmLabel: he ? 'בטל פעולה' : 'Undo' });
    if (!ok) return;
    try { await undoGoldaAction(a); toast.success(he ? 'הפעולה בוטלה.' : 'Undone.'); }
    catch (e) { toast.error(e.message || t('Could not undo.')); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <ChipGroup options={['all', 'mine']} labels={[he ? 'כל הצוות' : 'Everyone', he ? 'שלי' : 'Mine']} value={scope} onChange={setScope} required />
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{rows ? `${list.length}` : ''}</span>
      </div>
      {!rows ? <Skeleton rows={8} /> : list.length === 0 ? <Empty message={t('Golda made no changes yet.')} /> : (
        <div className="card" style={{ padding: 0 }}>
          {list.map((a) => {
            const to = linkFor(a);
            return (
              <div key={a.id} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--rule)', alignItems: 'flex-start', opacity: a.undone ? 0.5 : 1 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: a.action === 'delete' ? 'var(--red)' : 'var(--gold)', minWidth: 46, paddingTop: 2 }}>{ACTION[a.action] || a.action}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {to && !a.undone && a.action !== 'delete' ? <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>{label(a)}</Link> : label(a)}
                    <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 12 }}> · {collectionLabel(a.collection)}</span>
                    {a.undone && <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}> · {he ? 'בוטל' : 'undone'}</span>}
                  </div>
                  {a.action === 'update' && a.after && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, overflowWrap: 'anywhere' }}>
                      {Object.entries(a.after).filter(([k]) => !HIDDEN_FIELDS.test(k)).slice(0, 4)
                        .map(([k, v]) => `${fieldLabel(k)}: ${fieldValue(k, v)}`).join(' · ')}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', textAlign: 'end', flexShrink: 0 }}>
                  <div>{fmtDateTime(a.at?.toDate?.())}</div>
                  <div>{a.sender || a.byName || ''}{a.channel === 'app' ? (he ? ' · באפליקציה' : ' · in app') : ''}</div>
                  {canEdit && !a.undone && (a.before !== undefined) && (
                    <button type="button" className="btn btn-ghost" onClick={() => undo(a)} style={{ padding: '3px 8px', fontSize: 10, marginTop: 4 }}>{he ? 'בטל' : 'Undo'}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {dialog}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────
const HOURS = Array.from({ length: 24 }, (_, i) => String(i));
function Settings({ me, email, he }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (me && !form) setForm({ whatsapp: me.whatsapp || '', channels: Array.isArray(me.channels) ? me.channels : ['email'], briefingHour: Number.isInteger(me.briefingHour) ? me.briefingHour : 7 });
  }, [me]); // eslint-disable-line
  if (!form) return <Skeleton rows={4} />;
  const save = async () => {
    setSaving(true);
    try { await saveMyPrefs(email, { ...form, whatsapp: normalizePhone(form.whatsapp) }); toast.success(he ? 'ההגדרות נשמרו.' : 'Saved.'); }
    catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setSaving(false); }
  };
  const wa = form.channels.includes('whatsapp');
  return (
    <div className="card card-body" style={{ maxWidth: 560 }}>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 0 }}>
        {he ? 'גולדה שולחת תדריך קצר כל בוקר: משחקים ואימונים היום, מה דורש פעולה ומה היא עשתה. התראות דחופות (חוזה שמסתיים תוך שבוע, עבודת לילה שנכשלה) נשלחות ברגע שהן מופיעות.'
          : 'Golda sends a short briefing every morning: today\'s games and trainings, what needs action and what she did. Urgent alerts (a contract ending within a week, a failed night job) go out as they appear.'}
      </p>
      <Field label={he ? 'ערוצים' : 'Channels'} hint={he ? 'האימייל היומי ממשיך להגיע למי שסימן אימייל במסך הצוות.' : 'The daily email keeps going to whoever has email alerts on.'}>
        <ChipGroup multi options={['whatsapp', 'email']} labels={[he ? 'וואטסאפ' : 'WhatsApp', he ? 'אימייל' : 'Email']} value={form.channels} onChange={(v) => setForm((f) => ({ ...f, channels: v }))} />
      </Field>
      <Field label={he ? 'מספר הוואטסאפ שלי' : 'My WhatsApp number'} required={wa} hint={he ? 'המספר שממנו כותבים לגולדה. גולדה מזהה לפיו מי כותב ופועלת בשמו.' : 'The number you write to Golda from. She recognises you by it and acts in your name.'}>
        <input value={form.whatsapp} inputMode="tel" dir="ltr" placeholder="0501234567" onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))} />
      </Field>
      <Field label={he ? 'שעת התדריך (שעון ישראל)' : 'Briefing hour (Israel time)'}>
        <select value={String(form.briefingHour)} onChange={(e) => setForm((f) => ({ ...f, briefingHour: Number(e.target.value) }))} style={{ maxWidth: 140 }}>
          {HOURS.map((h) => <option key={h} value={h}>{h.padStart(2, '0')}:30</option>)}
        </select>
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving || (wa && !normalizePhone(form.whatsapp))}>{saving ? t('Saving…') : t('Save')}</button>
      </div>
    </div>
  );
}

// An Israeli local number becomes international; anything else is kept as digits.
function normalizePhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0') && d.length === 10) return `972${d.slice(1)}`;
  return d.length >= 9 ? d : '';
}
