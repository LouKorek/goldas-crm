// The "Representation agreement" card on a player's page: the agreements made
// in the system for this player and where each one stands (waiting for the
// signature, signed, the link expired or stopped). Everyone who may see the
// player sees the card when there is something on it; an admin always sees
// it, makes a new agreement here, copies the signing link, issues a new one
// or stops it. The signed PDF is filed in the player's representation
// documents by itself and opens here in the in-app viewer.
//
// The browser never reads the agreement collections: everything comes from
// netlify/functions/player-agreements.js, which never sends the ID numbers
// the signers typed or their drawn signatures.
import React, { useEffect, useMemo, useState } from 'react';
import { agreementPeriod, isMinorOn, dayText, israelDate } from '@goldas/domain';
import { fmtDate } from 'lib/constants';
import { daysAway } from 'lib/alerts';
import { t, relDays, fmtDateTime } from 'lib/i18n';
import { useRole } from 'lib/roleContext';
import { toast, useConfirm, Modal, Field, DateInput } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import DocViewer from 'components/DocViewer';
import { listAgreements, createAgreement, revokeAgreementLink, reissueAgreementLink, retryAgreementFiling } from 'data/agreements';
import { PlayerCard } from './PlayerCard';

// [label, background, text] per state, in theme tokens.
const STATE = {
  waiting: ['Waiting for the signature', 'var(--amber-bg)', 'var(--amber)'],
  expired: ['Link expired', 'var(--surface-2)', 'var(--text-3)'],
  revoked: ['Link revoked', 'var(--surface-2)', 'var(--text-3)'],
  locked: ['Link locked', 'var(--red-bg)', 'var(--red)'],
  signed_filing: ['Signed, filing the PDF', 'var(--blue-bg)', 'var(--blue)'],
  filing_failed: ['Signed, filing failed', 'var(--red-bg)', 'var(--red)'],
  signed: ['Signed', 'var(--green-bg)', 'var(--green-ok)'],
};
const day = (iso) => (iso ? iso.slice(0, 10) : '');
const LINK_DAYS = 14;
const MAX_LINK_DAYS = 30;
// What a person reads when a language has no template yet (lib/agreements.js NO_TEMPLATE app).
const NO_TEMPLATE = 'There is no agreement template yet. Golda prepares it from the agency\'s existing agreements when she is asked for an agreement, or it can be written in System › Agreements.';

/** Making an agreement: language, period, who signs, how long the link works. */
function CreateDialog({ player, templates, onClose, onMade }) {
  const langs = ['he', 'en'].filter((l) => templates?.[l]);
  const [lang, setLang] = useState(langs[0] || 'he');
  const tpl = templates?.[lang] || null;
  const [today] = useState(israelDate);
  const [start, setStart] = useState(today);
  const [months, setMonths] = useState(String(tpl?.defaultMonths || 24));
  const [end, setEnd] = useState('');
  const known = isMinorOn(player.dob, israelDate());
  const [minorAsked, setMinorAsked] = useState(false);
  const minor = known === null ? minorAsked : known;
  const [guardian, setGuardian] = useState('');
  const [days, setDays] = useState(String(LINK_DAYS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState(null);

  useEffect(() => { if (tpl) setMonths(String(tpl.defaultMonths)); }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const period = useMemo(() => agreementPeriod({ start, end: end || undefined, months: end ? undefined : Number(months), defaultMonths: tpl?.defaultMonths, maxMonths: tpl?.maxMonths }), [start, end, months, tpl]);
  const periodError = !period.ok && {
    start: t('Choose the start date.'), end: t('The end date is not a date.'), order: t('The end date must be after the start date.'),
    months: t('The length is a whole number of months.'), tooLong: t('An agreement may run {n} months at most.', { n: period.maxMonths }),
  }[period.error];
  const guardianMissing = minor && guardian.trim().length < 2;
  // Closing asks first only once something was changed from how the dialog opened.
  const isDirty = lang !== (langs[0] || 'he') || start !== today || months !== String(tpl?.defaultMonths || 24) || !!end || minorAsked || !!guardian.trim() || days !== String(LINK_DAYS);

  if (!langs.length) {
    return (
      <Modal title={t('New representation agreement')} onClose={onClose} viewOnly>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-2)', margin: 0 }}>
          {t(NO_TEMPLATE)}
        </p>
      </Modal>
    );
  }

  const submit = async () => {
    setError('');
    if (!period.ok || guardianMissing) return;
    setBusy(true);
    try {
      const r = await createAgreement({
        playerId: player.id, lang, start, ...(end ? { end } : { months: Number(months) }),
        ...(minor ? { guardianName: guardian.trim() } : {}), ...(known === null ? { minor } : {}),
        days: Number(days) || LINK_DAYS,
      });
      setMade(r.agreement);
      onMade(r.agreement);
    } catch (e) { setError(e.code === 'no_template' ? t(NO_TEMPLATE) : e.message || t('Save failed.')); }
    setBusy(false);
  };

  if (made) {
    const copy = async () => {
      try { await navigator.clipboard.writeText(made.url); toast.success(t('Link copied.')); } catch { toast.error(t('Could not copy the link.')); }
    };
    return (
      <Modal title={t('Agreement made')} onClose={onClose} viewOnly
        footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>{t('Close')}</button><button type="button" className="btn btn-primary" onClick={copy}><Icon name="copy" size={12} /> {t('Copy link')}</button></>}>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '0 0 10px' }}>{t('Send this link to {who}. It works until {date}, once.', { who: minor ? guardian.trim() : player.fullName || player.name || '', date: fmtDate(day(made.linkExpiresAt)) })}</p>
        <div className="bidi" dir="ltr" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '10px 12px', border: '1px solid var(--border)', background: 'var(--surface-2)', overflowWrap: 'anywhere' }}>{made.url}</div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '10px 0 0' }}>{t('You will get a message from Golda as soon as it is signed. The signed PDF goes into the documents by itself.')}</p>
      </Modal>
    );
  }

  const who = minor ? `${guardian.trim() || t('the parent or guardian')} + ${player.fullName || ''}` : player.fullName || '';
  return (
    <Modal title={t('New representation agreement')} onClose={onClose} isDirty={isDirty} onSave={submit}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button><button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !period.ok || guardianMissing}>{busy ? t('Making…') : t('Make the agreement')}</button></>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label={t('Language')}>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {['he', 'en'].map((l) => <option key={l} value={l} disabled={!templates?.[l]}>{l === 'he' ? t('Hebrew') : t('English')}{templates?.[l] ? '' : ` (${t('no template')})`}</option>)}
          </select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <Field label={t('Start')} required><DateInput value={start} onChange={setStart} /></Field>
          <Field label={t('Length in months')} hint={t('Up to {n}.', { n: tpl?.maxMonths || 24 })}>
            <input type="number" min="1" max={tpl?.maxMonths || 24} value={months} onChange={(e) => setMonths(e.target.value)} disabled={!!end} />
          </Field>
          <Field label={t('Or an end date')}><DateInput value={end} onChange={setEnd} /></Field>
        </div>
        {known === null && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={minorAsked} onChange={(e) => setMinorAsked(e.target.checked)} />
            {t('The player is under 18 (his date of birth is not in the CRM)')}
          </label>
        )}
        {minor && (
          <Field label={t('Parent or guardian who signs (full name)')} required hint={t('The player signs too, on the same page.')} error={guardianMissing && guardian ? t('Write the full name.') : ''}>
            <input value={guardian} onChange={(e) => setGuardian(e.target.value)} maxLength={80} />
          </Field>
        )}
        <Field label={t('The link works for (days)')} hint={t('{d} days unless you choose otherwise, {max} at most.', { d: LINK_DAYS, max: MAX_LINK_DAYS })}>
          <input type="number" min="1" max={MAX_LINK_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <div style={{ fontSize: 12.5, padding: '10px 12px', border: '1px solid var(--border)', background: 'var(--surface-2)', lineHeight: 1.6 }}>
          {period.ok
            ? <>{t('From {a} to {b} ({n} months)', { a: dayText(period.start), b: dayText(period.end), n: period.months })} · {lang === 'he' ? t('Hebrew') : t('English')} · {t('signs:')} <span className="bidi">{who}</span></>
            : <span style={{ color: 'var(--red)' }}>{periodError}</span>}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

export default function PlayerAgreements({ player }) {
  const { isAdmin } = useRole();
  const { confirm, dialog } = useConfirm();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const playerId = player?.id;

  const load = () => listAgreements(playerId).then(setData).catch((e) => { console.warn('agreements:', e.message); setData({ agreements: [], canCreate: false, templates: {} }); });
  useEffect(() => {
    setData(null);
    if (playerId) load();
  }, [playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return null;
  const list = data.agreements || [];
  if (!list.length && !data.canCreate) return null;

  const replace = (a) => setData((d) => ({ ...d, agreements: d.agreements.map((x) => (x.id === a.id ? { ...x, ...a } : x)) }));
  const run = async (id, fn, ok) => {
    setBusy(id);
    try { const r = await fn(); if (r.agreement) replace(r.agreement); if (ok) toast.success(ok); } catch (e) { toast.error(e.message || t('Save failed.')); }
    setBusy('');
  };
  const copy = async (a) => {
    try { await navigator.clipboard.writeText(a.url); toast.success(t('Link copied.')); } catch { toast.error(t('Could not copy the link.')); }
  };
  const revoke = async (a) => {
    if (!(await confirm(t('Stop the signing link? It stops working at once; you can issue a new one later.'), { title: t('Revoke link'), confirmLabel: t('Revoke link') }))) return;
    run(a.id, () => revokeAgreementLink(a.id), t('The link was revoked.'));
  };
  const reissue = async (a) => {
    if (a.state === 'waiting' && !(await confirm(t('Issue a new signing link? The current link stops working at once.'), { title: t('New link'), confirmLabel: t('New link') }))) return;
    run(a.id, () => reissueAgreementLink(a.id, LINK_DAYS), t('A new link was made. Copy it and send it on.'));
  };
  const signedFile = (a) => (player.reprFiles || []).filter((f) => f && f.agreementId === a.id);

  return (
    <PlayerCard title={t('Representation agreement')}
      action={data.canCreate && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={11} /> {t('New agreement')}</button>}
      note={!list.length ? t('No agreement was made in the system yet.') : null}>
      {list.map((a) => {
        const [label, bg, fg] = STATE[a.state] || STATE.expired;
        const files = signedFile(a);
        return (
          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{fmtDate(a.start)} – {fmtDate(a.end)}</span>
                <span className="badge" style={{ background: bg, color: fg }}>{t(label)}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.lang === 'he' ? t('Hebrew') : t('English')}{a.minor ? ` · ${t('minor')}` : ''}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('made on')} {fmtDate(day(a.createdAt))}{a.createdByName ? ` · ${a.createdByName}` : ''}
                {a.state === 'waiting' && ` · ${t('works until')} ${fmtDate(day(a.linkExpiresAt))} · ${relDays(daysAway(day(a.linkExpiresAt)))}`}
              </div>
              {a.signedAt ? (
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {t('Signed')} {fmtDateTime(a.signedAt)} · {t(a.signedDevice === 'phone' ? 'from a phone' : 'from a computer')} · <span className="bidi">{a.signers.map((s) => s.name).join(', ')}</span>
                </div>
              ) : a.state === 'waiting' && (
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {a.opens > 0 ? <>{a.opens === 1 ? t('Opened once') : t('Opened {n} times', { n: a.opens })} · {t('last opening')} {fmtDateTime(a.lastOpenAt)} · {t(a.lastOpenDevice === 'phone' ? 'from a phone' : 'from a computer')}</> : t('Not opened yet')}
                </div>
              )}
              {a.state === 'filing_failed' && <div style={{ fontSize: 11, color: 'var(--red)' }}>{t('The signature is kept. Filing the PDF is retried by itself; Golda tells you when it is done.')}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {files.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setViewing(files)}><Icon name="search" size={11} /> {t('View signed PDF')}</button>}
              {isAdmin && a.state === 'waiting' && a.url && <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(a)}><Icon name="copy" size={11} /> {t('Copy link')}</button>}
              {isAdmin && a.state === 'waiting' && a.url && <a className="btn btn-ghost btn-sm" href={a.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }} title={t('Your own look is not counted and cannot sign.')}><Icon name="eye" size={11} /> {t('Preview page')}</a>}
              {isAdmin && ['waiting', 'expired', 'revoked', 'locked'].includes(a.state) && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === a.id} onClick={() => reissue(a)}>{t('New link')}</button>}
              {isAdmin && a.state === 'waiting' && <button type="button" className="btn btn-danger btn-sm" disabled={busy === a.id} onClick={() => revoke(a)}><Icon name="close" size={11} /> {t('Revoke')}</button>}
              {isAdmin && a.state === 'filing_failed' && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === a.id} onClick={() => run(a.id, () => retryAgreementFiling(a.id))}>{t('Retry now')}</button>}
            </div>
          </div>
        );
      })}
      {creating && <CreateDialog player={player} templates={data.templates} onClose={() => setCreating(false)} onMade={(a) => setData((d) => ({ ...d, agreements: [a, ...d.agreements] }))} />}
      {viewing && <DocViewer files={viewing} title={t('Representation agreement')} onClose={() => setViewing(null)} />}
      {dialog}
    </PlayerCard>
  );
}
