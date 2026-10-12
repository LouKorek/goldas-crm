import React, { useEffect, useMemo, useState } from 'react';
import { listenCollection } from 'lib/db';
import { t, fmtDateTime, getLang } from 'lib/i18n';
import { PageHeader, Skeleton, Empty } from 'components/ui/UI';

// Golda's area: what she changed in the CRM, newest first, with who asked.
// The chat itself happens on WhatsApp; this screen is the paper trail.
export default function Golda() {
  const [rows, setRows] = useState(null);
  useEffect(() => listenCollection('wa_audit', setRows), []);
  const he = getLang() === 'he';
  const list = useMemo(() => (rows || []).sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0)).slice(0, 200), [rows]);
  const ACTION = { create: he ? 'יצרה' : 'created', update: he ? 'עדכנה' : 'updated', delete: he ? 'מחקה' : 'deleted' };
  const label = (a) => a.after?.fullName || a.after?.playerName || a.after?.title || a.after?.clubName || a.after?.contactName
    || a.before?.fullName || a.before?.playerName || a.before?.title || a.before?.clubName || a.before?.contactName || a.docId;

  return (
    <div>
      <PageHeader title={t('Golda')} subtitle={he ? 'העוזרת בוואטסאפ. כל שינוי שהיא עושה במערכת נרשם כאן, עם מי ביקש ומתי.' : 'The WhatsApp assistant. Every change she makes to the CRM is recorded here, with who asked and when.'} />
      {!rows ? <Skeleton rows={8} /> : list.length === 0 ? <Empty message={t('Golda made no changes in the last 24 hours.')} /> : (
        <div className="card" style={{ padding: 0 }}>
          {list.map((a) => (
            <div key={a.id} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--rule)', alignItems: 'flex-start', opacity: a.undone ? 0.5 : 1 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: a.action === 'delete' ? 'var(--red)' : 'var(--gold)', minWidth: 46, paddingTop: 2 }}>{ACTION[a.action] || a.action}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{label(a)} <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 11.5 }}>· {t(a.collection || '')}</span>{a.undone && <span style={{ color: 'var(--text-3)', fontSize: 11 }}> · {t('Undo')}</span>}</div>
                {a.action === 'update' && a.after && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, overflowWrap: 'anywhere' }}>
                    {Object.entries(a.after).slice(0, 4).map(([k, v]) => `${t(k)}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40)}`).join(' · ')}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'end', flexShrink: 0 }}>
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
