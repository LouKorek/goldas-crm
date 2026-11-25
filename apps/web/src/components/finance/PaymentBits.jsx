import React, { useMemo, useState } from 'react';
import { CURRENCIES, PAYER_KINDS, formatMoney, paidSoFar, paymentRows, israelDate } from '@goldas/domain';
import { addPayment, updatePayment, deletePayment, markPaid } from 'data/deals';
import { fmtDate } from 'lib/constants';
import { t } from 'lib/i18n';
import { Modal, Field, ChipGroup, DateInput, RowActions, useConfirm, toast } from 'components/ui/UI';

// Payments on a deal (admin only: callers check can(role, 'money') first).
// The engine is packages/domain/src/engines/finance.ts; the writes are in
// data/deals.js and go through the audited updateDoc_.

const TONE = {
  paid:      { background: 'var(--green-bg)', color: 'var(--green-ok)' },
  partial:   { background: 'var(--blue-bg)', color: 'var(--blue)' },
  late:      { background: 'var(--red-bg)', color: 'var(--red)' },
  due_soon:  { background: 'var(--amber-bg)', color: 'var(--amber)' },
  scheduled: { background: 'var(--surface-3)', color: 'var(--text-2)' },
  excluded:  { background: 'var(--surface-3)', color: 'var(--text-3)' },
};
const STATUS_LABEL = {
  paid: 'Paid', partial: 'Partly paid', late: 'Late', due_soon: 'Due soon', scheduled: 'Scheduled', excluded: 'Deal not relevant',
};
const PAYER_LABEL = { club: 'Club', player: 'Player', other: 'Other' };

/** The status of one payment row as a coloured badge. */
export function PayStatus({ row }) {
  const key = row.excluded ? 'excluded' : row.status;
  const late = row.status === 'late' && !row.excluded;
  return (
    <span className="badge" style={{ ...TONE[key], whiteSpace: 'nowrap' }}>
      {t(STATUS_LABEL[key])}{late ? ` · ${t('{n} d', { n: row.daysLate })}` : ''}{late && row.partial ? ` · ${t('partly paid')}` : ''}
    </span>
  );
}

/** Money of a row: what is owed, or what came in when it is paid. */
export const rowMoney = (r) => formatMoney(r.status === 'paid' ? r.payment.amount : r.outstanding, r.payment.currency);

const blank = (deal) => ({
  label: '', amount: '', currency: 'EUR', dueDate: '', payerKind: 'club', payerName: deal.clubName || '', note: '', paidAt: '', paidAmount: '',
});
const fromPayment = (p) => ({
  label: p.label, amount: String(p.amount), currency: p.currency, dueDate: p.dueDate, payerKind: p.payer.kind, payerName: p.payer.name,
  note: p.note, paidAt: p.paidAt || '', paidAmount: p.paidAmount == null ? '' : String(p.paidAmount),
});

/** Add or edit one payment. `payment` set = edit. */
export function PaymentModal({ deal, payment, onClose }) {
  const [start] = useState(() => (payment ? fromPayment(payment) : blank(deal)));
  const [f, setF] = useState(start);
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const setKind = (kind) => setF((x) => ({
    ...x, payerKind: kind,
    payerName: kind === 'club' ? (deal.clubName || '') : kind === 'player' ? (deal.playerName || '') : '',
  }));
  const amountOk = Number(String(f.amount).replace(/[,\s]/g, '')) > 0;
  const dateOk = Boolean(f.dueDate);
  const save = async () => {
    setTried(true);
    if (!amountOk || !dateOk) return;
    setBusy(true);
    const data = {
      label: f.label, amount: f.amount, currency: f.currency, dueDate: f.dueDate,
      payer: { kind: f.payerKind, name: f.payerName }, note: f.note,
      ...(payment ? { paidAt: f.paidAt || null, paidAmount: f.paidAt && f.paidAmount ? f.paidAmount : null } : {}),
    };
    try {
      if (payment) await updatePayment(deal, payment.id, data);
      else await addPayment(deal, data);
      toast.success(payment ? t('Payment saved.') : t('Payment added.'));
      onClose();
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={payment ? t('Edit payment') : t('Add payment')} onClose={onClose} onSave={save} isDirty={dirty} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save')}</button>
    </>}>
      <Field label={t('What is it for')} hint={t('For example: commission, first instalment, bonus')}>
        <input value={f.label} onChange={(e) => set('label')(e.target.value)} placeholder={t('Commission')} />
      </Field>
      <div className="form-grid-2">
        <Field label={t('Amount')} required error={tried && !amountOk ? t('Enter an amount above 0.') : ''}>
          <input inputMode="decimal" value={f.amount} onChange={(e) => set('amount')(e.target.value)} placeholder="5,000" />
        </Field>
        <Field label={t('Due date')} required error={tried && !dateOk ? t('Pick the date it is due.') : ''}>
          <DateInput value={f.dueDate} onChange={set('dueDate')} />
        </Field>
      </div>
      <Field label={t('Currency')} required>
        <ChipGroup options={[...CURRENCIES]} labels={[...CURRENCIES]} value={f.currency} onChange={set('currency')} required />
      </Field>
      <Field label={t('Who pays')}>
        <ChipGroup options={[...PAYER_KINDS]} labels={PAYER_KINDS.map((k) => t(PAYER_LABEL[k]))} value={f.payerKind} onChange={setKind} required />
        <input style={{ marginTop: 8 }} value={f.payerName} onChange={(e) => set('payerName')(e.target.value)} placeholder={t('Payer name')} />
      </Field>
      {payment && (
        <div className="form-grid-2">
          <Field label={t('Paid on')} hint={t('Empty = not paid yet')}>
            <DateInput value={f.paidAt} onChange={set('paidAt')} />
          </Field>
          <Field label={t('Amount received')} hint={t('Empty = the full amount')}>
            <input inputMode="decimal" value={f.paidAmount} onChange={(e) => set('paidAmount')(e.target.value)} disabled={!f.paidAt} />
          </Field>
        </div>
      )}
      <Field label={t('Note')}>
        <input value={f.note} onChange={(e) => set('note')(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** "Mark paid": the date (today by default) and the full amount or part of it. */
export function MarkPaidModal({ deal, row, onClose }) {
  const p = row.payment;
  const already = paidSoFar(p);
  const [paidAt, setPaidAt] = useState(israelDate(new Date()));
  const [mode, setMode] = useState('full');
  const [now, setNow] = useState('');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const part = Number(String(now).replace(/[,\s]/g, ''));
  const partOk = mode === 'full' || (part > 0);
  const save = async () => {
    setTried(true);
    if (!paidAt || !partOk) return;
    setBusy(true);
    try {
      const total = mode === 'full' ? p.amount : already + part;
      await markPaid(deal, p.id, { paidAt, amount: total >= p.amount ? null : total });
      toast.success(total >= p.amount ? t('Marked paid.') : t('Part payment saved.'));
      onClose();
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={t('Mark paid')} onClose={onClose} onSave={save} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save')}</button>
    </>}>
      <p style={{ fontSize: 13.5, marginBottom: 14 }}>
        <strong>{formatMoney(p.amount, p.currency)}</strong>{p.label ? ` · ${p.label}` : ''}{p.payer.name ? ` · ${p.payer.name}` : ''}
        {already > 0 && <span style={{ color: 'var(--text-3)' }}> · {t('{x} received so far', { x: formatMoney(already, p.currency) })}</span>}
      </p>
      <Field label={t('Paid on')} required error={tried && !paidAt ? t('Pick the date it was paid.') : ''}><DateInput value={paidAt} onChange={setPaidAt} /></Field>
      <Field label={t('How much came in')} error={tried && !partOk ? t('Enter an amount above 0.') : ''}>
        <ChipGroup options={['full', 'part']} labels={[already > 0 ? t('The rest ({x})', { x: formatMoney(row.outstanding, p.currency) }) : t('The full amount'), t('Part of it')]} value={mode} onChange={setMode} required />
        {mode === 'part' && <input style={{ marginTop: 8 }} inputMode="decimal" value={now} onChange={(e) => setNow(e.target.value)} placeholder={t('Amount received now')} autoFocus />}
      </Field>
    </Modal>
  );
}

/** The Payments section of the deal dialog. */
export function DealPayments({ deal, canEdit }) {
  const rows = useMemo(() => paymentRows([{ ...deal, deletedAt: null }]), [deal]);
  const [editing, setEditing] = useState(null); // 'new' | payment
  const [paying, setPaying] = useState(null);
  const { confirm, dialog } = useConfirm();
  const remove = async (r) => {
    const ok = await confirm(t('Delete this payment ({x})?', { x: formatMoney(r.payment.amount, r.payment.currency) }));
    if (!ok) return;
    try { await deletePayment(deal, r.payment.id); toast.success(t('Payment deleted.')); } catch (e) { toast.error(e.message || t('Save failed.')); }
  };
  const owed = rows.filter((r) => !r.excluded && r.outstanding > 0);
  return (
    <div className="card card-body" style={{ padding: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: rows.length ? 8 : 0 }}>
        <div className="section-label" style={{ flex: 1, margin: 0 }}>{t('Payments')}</div>
        {canEdit && <button className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>+ {t('Add payment')}</button>}
      </div>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--text-3)', fontSize: 12.5, margin: '6px 0 0' }}>{t('No payments on this deal yet. Add one for each sum that should come in: the commission, an instalment, a bonus.')}</p>
      ) : rows.map((r) => (
        <div key={r.payment.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--rule)', fontSize: 12.5 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, minWidth: 86 }}>{rowMoney(r)}</span>
          <span style={{ flex: 1, minWidth: 140 }}>
            {r.payment.label || t('Payment')}
            {r.payment.payer.name && <span style={{ color: 'var(--text-3)' }}> · {r.payment.payer.name}</span>}
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>
              {t('Due')} {fmtDate(r.payment.dueDate)}
              {r.payment.paidAt ? ` · ${t('Paid on')} ${fmtDate(r.payment.paidAt)}` : ''}
              {r.partial ? ` · ${t('{x} of {y} received', { x: formatMoney(r.paid, r.payment.currency), y: formatMoney(r.payment.amount, r.payment.currency) })}` : ''}
            </span>
          </span>
          <PayStatus row={r} />
          {canEdit && (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {r.outstanding > 0 && <button className="btn btn-secondary btn-sm" onClick={() => setPaying(r)}>{t('Mark paid')}</button>}
              <RowActions onEdit={() => setEditing(r.payment)} onDelete={() => remove(r)} />
            </span>
          )}
        </div>
      ))}
      {owed.length > 0 && deal.stage !== 'Not Relevant' && (
        <div className="form-hint" style={{ marginTop: 6 }}>
          {t('Still owed')}: {Object.entries(owed.reduce((m, r) => ({ ...m, [r.payment.currency]: (m[r.payment.currency] || 0) + r.outstanding }), {})).map(([c, n]) => formatMoney(n, c)).join(' · ')}
        </div>
      )}
      {deal.stage === 'Not Relevant' && rows.some((r) => r.excluded) && (
        <div className="form-hint" style={{ marginTop: 6 }}>{t('The deal is not relevant, so its unpaid payments are left out of the totals and alerts.')}</div>
      )}
      {editing && <PaymentModal deal={deal} payment={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {paying && <MarkPaidModal deal={deal} row={paying} onClose={() => setPaying(null)} />}
      {dialog}
    </div>
  );
}
