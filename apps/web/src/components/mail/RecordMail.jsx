// The agency's e-mail with one record: a deal, a club or a contact.
// One component for all three places (the deal dialog, the club page, the
// contact dialog). The list comes from the mail function, which already
// applied the role: admins and managers see a club's and a contact's mail,
// a deal's mail (its negotiation) only an admin. A viewer sees nothing here.
// The CRM never sends or changes mail; "Open in Gmail" is where Lou answers.
import React, { useEffect, useState } from 'react';
import { useCan } from 'lib/roleContext';
import { t, fmtDateTime, isRtl } from 'lib/i18n';
import { useConfirm, toast } from 'components/ui/UI';
import { fetchRecordMail, setMailDeals, hideMail, resetMail, gmailThreadUrl } from 'data/mail';

const FIRST = 8;
const muted = { color: 'var(--text-3)' };
const person = (p) => (p ? p.name || p.email : '');
const dealLabel = (d) => `${d.playerName || ''} ↔ ${d.clubName || ''}`;

/** kind: 'deal' | 'club' | 'contact'; deals: the deals a message may be put on (admins). */
export default function RecordMail({ kind, id, deals = [] }) {
  const canEdit = useCan('edit');
  const money = useCan('money');
  const allowed = canEdit && (kind !== 'deal' || money);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState('');
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(() => new Set());
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState('');
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (!allowed || !id) return undefined;
    let live = true;
    fetchRecordMail(kind, id)
      .then((d) => { if (live) { setData(d); setFailed(''); } })
      .catch((e) => { if (live) setFailed(e.message || t('Could not load the e-mail.')); });
    return () => { live = false; };
  }, [allowed, kind, id, tick]);

  if (!allowed) return null;

  const run = async (m, fn, done) => {
    setBusy(m.id);
    try { await fn(); toast.success(done); setTick((x) => x + 1); }
    catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(''); }
  };
  const moveTo = (m, dealId) => dealId && run(m, () => setMailDeals(m.id, [dealId]), t('Moved to the deal.'));
  const offDeal = (m) => run(m, () => setMailDeals(m.id, m.dealIds.filter((x) => x !== id)), t('Removed from this deal.'));
  const reset = (m) => run(m, () => resetMail(m.id), t('Back to the automatic links.'));
  const hide = async (m) => {
    const ok = await confirm(t('Not agency mail? The message leaves every record in the CRM and is not linked again. Gmail itself is not touched.'), { confirmLabel: t('Remove from the CRM') });
    if (ok) run(m, () => hideMail(m.id), t('Removed from the CRM.'));
  };
  const toggle = (threadId) => setOpen((s) => { const n = new Set(s); if (n.has(threadId)) n.delete(threadId); else n.add(threadId); return n; });
  const dealName = (dealId) => { const d = deals.find((x) => x.id === dealId); return d ? dealLabel(d) : ''; };

  const threads = data?.threads || [];
  const shown = all ? threads : threads.slice(0, FIRST);
  const body = () => {
    if (failed) return <p style={{ ...muted, fontSize: 12.5, margin: '6px 0 0' }}>{failed}</p>;
    if (!data) return <div className="skeleton" style={{ height: 44, borderRadius: 6, marginTop: 6 }} aria-busy="true" aria-label={t('Loading')} />;
    if (!data.connected) return <p style={{ ...muted, fontSize: 12.5, margin: '6px 0 0' }}>{t('The agency\'s Gmail is not connected to the CRM yet. An admin connects it in System › Email.')}</p>;
    if (!threads.length) {
      const hint = kind === 'club' ? t('No e-mail with this club yet. Mail comes in when the club\'s e-mail domain or a contact\'s e-mail address is saved.')
        : kind === 'contact' ? t('No e-mail with this contact yet. Mail comes in when the contact\'s e-mail address is saved.')
          : t('No e-mail on this deal yet. Mail joins a deal when it is with the deal\'s club or contact and names the player.');
      return <p style={{ ...muted, fontSize: 12.5, margin: '6px 0 0' }}>{hint}</p>;
    }
    return shown.map((th) => {
      const isOpen = open.has(th.threadId);
      const last = th.messages[0];
      return (
        <div key={th.threadId} style={{ borderTop: '1px solid var(--rule)', padding: '8px 0', fontSize: 12.5 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <button type="button" onClick={() => toggle(th.threadId)} aria-expanded={isOpen}
              style={{ flex: 1, minWidth: 0, textAlign: 'start', background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span dir="auto" style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{th.subject || t('(no subject)')}</span>
                <span style={{ ...muted, fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'nowrap' }}>{fmtDateTime(th.lastAt)}</span>
              </span>
              <span style={{ ...muted, display: 'block', fontSize: 11, overflowWrap: 'anywhere' }}>
                {th.people.join(', ')}{th.count > 1 ? ` · ${t('{n} messages', { n: th.count })}` : ''}
              </span>
              {!isOpen && last.snippet && (
                <span dir="auto" style={{ ...muted, display: 'block', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{last.snippet}</span>
              )}
            </button>
            <a href={gmailThreadUrl(data.address, th.threadId)} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none', whiteSpace: 'nowrap' }}>{t('Open in Gmail')} ↗</a>
          </div>
          {isOpen && th.messages.map((m) => (
            <div key={m.id} style={{ margin: '8px 0 0', padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6, opacity: busy === m.id ? 0.6 : 1 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 11 }}>
                <span className="badge" style={{ background: m.direction === 'out' ? 'var(--gold-dim)' : 'var(--surface-3)', color: m.direction === 'out' ? 'var(--gold)' : 'var(--text-2)' }}>
                  {m.direction === 'out' ? t('We wrote') : t('They wrote')}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{person(m.from)} {isRtl() ? '←' : '→'} {m.to.map(person).join(', ')}</span>
                <span style={{ ...muted, fontFamily: 'var(--font-mono)', fontSize: 10 }}>{fmtDateTime(m.at)}</span>
              </div>
              {m.snippet && <div dir="auto" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{m.snippet}</div>}
              {m.attachments.length > 0 && <div style={{ ...muted, marginTop: 4, fontSize: 11, overflowWrap: 'anywhere' }}>{t('Attachments')}: {m.attachments.join(', ')}</div>}
              {money && kind !== 'deal' && m.dealIds.length > 0 && (
                <div style={{ ...muted, marginTop: 4, fontSize: 11 }}>{t('On deal')}: {m.dealIds.map(dealName).filter(Boolean).join(', ') || m.dealIds.length}</div>
              )}
              {m.corrected && <div style={{ ...muted, marginTop: 4, fontSize: 11 }}>{t('Links corrected by hand; the sync keeps them.')}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {money && deals.some((d) => !m.dealIds.includes(d.id)) && (
                  <select aria-label={t('Move to deal')} value="" disabled={!!busy} onChange={(e) => moveTo(m, e.target.value)} style={{ maxWidth: 240, height: 28, fontSize: 12 }}>
                    <option value="">{t('Move to deal…')}</option>
                    {deals.filter((d) => !m.dealIds.includes(d.id)).map((d) => <option key={d.id} value={d.id}>{dealLabel(d)}</option>)}
                  </select>
                )}
                {money && kind === 'deal' && <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => offDeal(m)}>{t('Remove from this deal')}</button>}
                {m.corrected && <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => reset(m)}>{t('Undo correction')}</button>}
                <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => hide(m)}>{t('Not agency mail')}</button>
              </div>
            </div>
          ))}
        </div>
      );
    });
  };

  return (
    <div className="card card-body" style={{ padding: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <div className="section-label" style={{ flex: 1, margin: 0 }}>{t('E-mail')}{threads.length ? ` · ${threads.length}` : ''}</div>
      </div>
      {body()}
      {threads.length > FIRST && (
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setAll((x) => !x)}>
          {all ? t('Show fewer') : t('Show all {n}', { n: threads.length })}
        </button>
      )}
      {dialog}
    </div>
  );
}
