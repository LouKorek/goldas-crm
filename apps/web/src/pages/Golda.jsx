import React, { useEffect, useMemo, useRef, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection } from 'lib/db';
import { t, fmtDateTime, getLang } from 'lib/i18n';
import { PageHeader, Skeleton, Empty } from 'components/ui/UI';

// Golda's area: what she changed in the CRM, newest first, with who asked.
// The chat itself happens on WhatsApp; this screen is the paper trail.
//
// An audit row carries the record before and after the change, which for a
// document attachment or a single-field edit holds no name at all. Rather
// than show the document id, the referenced record is read once and its
// name cached, so every row reads "עדכנה · נועם ברזילאי · שחקנים".

// Golda still speaks in the old collection names; map them to where the
// records physically live and to a Hebrew/English label.
const PHYSICAL = { pipeline_men: 'players', pipeline_women: 'players', pipeline_youth: 'players', pipeline_jewish: 'players' };
const COLLECTION_LABEL = {
  he: {
    players: 'שחקנים', pipeline_men: 'מועמדים (גברים)', pipeline_women: 'מועמדות (נשים)', pipeline_youth: 'מועמדים (נוער)',
    pipeline_jewish: 'יהודים בחו"ל', club_requirements: 'דרישות מועדונים', contacts: 'אנשי קשר', matches: 'משחקים',
    tasks: 'משימות', clubs: 'מועדונים', deals: 'עסקאות', trainings: 'אימונים', tmWatch: 'מעקב TM',
  },
  en: {
    players: 'Players', pipeline_men: 'Candidates (men)', pipeline_women: 'Candidates (women)', pipeline_youth: 'Candidates (youth)',
    pipeline_jewish: 'Jewish abroad', club_requirements: 'Club requirements', contacts: 'Contacts', matches: 'Matches',
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
  },
  en: {},
};

const nameOf = (d) => d?.fullName || d?.playerName || d?.name || d?.title || d?.clubName || d?.contactName
  || (d?.homeTeam && d?.awayTeam ? `${d.homeTeam} – ${d.awayTeam}` : '') || '';

export default function Golda() {
  const [rows, setRows] = useState(null);
  const [names, setNames] = useState({});
  const pending = useRef(new Set());
  useEffect(() => listenCollection('wa_audit', setRows), []);
  const he = getLang() === 'he';
  const L = he ? 'he' : 'en';
  const list = useMemo(() => (rows || []).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0)).slice(0, 200), [rows]);

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
    if (Array.isArray(v) && v.length && v[0]?.name) return he ? `${v.length} קבצים` : `${v.length} files`;
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? x?.name || x?.clubName || '' : String(x))).filter(Boolean).join(', ').slice(0, 60);
    if (v && typeof v === 'object') return v.toDate ? fmtDateTime(v.toDate()) : '…';
    if (typeof v === 'boolean') return v ? (he ? 'כן' : 'yes') : (he ? 'לא' : 'no');
    return String(v ?? '').slice(0, 60);
  };

  return (
    <div>
      <PageHeader title={t('Golda')} subtitle={he ? 'העוזרת בוואטסאפ. כל שינוי שהיא עושה במערכת נרשם כאן, עם מי ביקש ומתי.' : 'The WhatsApp assistant. Every change she makes to the CRM is recorded here, with who asked and when.'} />
      {!rows ? <Skeleton rows={8} /> : list.length === 0 ? <Empty message={t('Golda made no changes in the last 24 hours.')} /> : (
        <div className="card" style={{ padding: 0 }}>
          {list.map((a) => (
            <div key={a.id} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--rule)', alignItems: 'flex-start', opacity: a.undone ? 0.5 : 1 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: a.action === 'delete' ? 'var(--red)' : 'var(--gold)', minWidth: 46, paddingTop: 2 }}>{ACTION[a.action] || a.action}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {label(a)} <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 12 }}>· {collectionLabel(a.collection)}</span>
                  {a.undone && <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}> · {he ? 'בוטל' : 'undone'}</span>}
                </div>
                {a.action === 'update' && a.after && (
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, overflowWrap: 'anywhere' }}>
                    {Object.entries(a.after).filter(([k]) => !/^(updatedAt|lastEdited|createdAt)/.test(k)).slice(0, 4)
                      .map(([k, v]) => `${fieldLabel(k)}: ${fieldValue(k, v)}`).join(' · ')}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', textAlign: 'end', flexShrink: 0 }}>
                <div>{fmtDateTime(a.at?.toDate?.())}</div>
                {a.sender && <div>{a.sender}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
