// The "Live links" card on a player's page: the private live pages that exist
// for this player (one per club), until when each works, and who opened it.
// It shows only when the player has links. There is no "create" here on
// purpose: a live page is made when the owner asks Golda for one, and the PDF
// sheet stays the default. Whoever may edit can copy a link again, look at
// the page (their own look is not counted as an opening) and revoke it.
import React, { useEffect, useState } from 'react';
import { fmtDate } from 'lib/constants';
import { daysAway } from 'lib/alerts';
import { t, relDays, fmtDateTime } from 'lib/i18n';
import { useRole } from 'lib/roleContext';
import { toast, useConfirm } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { listPlayerLinks, revokePlayerLink } from 'data/playerPages';
import { PlayerCard } from './PlayerCard';

const STATE = {
  active: ['Link active', 'var(--green-bg)', 'var(--green-ok)'],
  expired: ['Link expired', 'var(--surface-2)', 'var(--text-3)'],
  revoked: ['Link revoked', 'var(--surface-2)', 'var(--text-3)'],
};
const day = (iso) => (iso ? iso.slice(0, 10) : '');

export default function PlayerLinks({ playerId }) {
  const { canEdit } = useRole();
  const { confirm, dialog } = useConfirm();
  const [links, setLinks] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    setLinks(null);
    if (!playerId) return undefined;
    listPlayerLinks(playerId).then((r) => { if (live) setLinks(r.links || []); })
      .catch((e) => { console.warn('live links:', e.message); if (live) setLinks([]); });
    return () => { live = false; };
  }, [playerId]);

  if (!links || links.length === 0) return null;

  const copy = async (link) => {
    try { await navigator.clipboard.writeText(link.url); toast.success(t('Link copied.')); }
    catch { toast.error(t('Could not copy the link.')); }
  };
  const revoke = async (link) => {
    const name = link.general ? t('General link') : link.club;
    if (!(await confirm(t('Revoke the link for {name}? It stops working at once and cannot be brought back.', { name }), { title: t('Revoke link'), confirmLabel: t('Revoke link') }))) return;
    setBusy(link.id);
    try {
      const r = await revokePlayerLink(link.id);
      setLinks((rows) => rows.map((x) => (x.id === link.id ? { ...x, ...r.link, url: null } : x)));
      toast.success(t('The link was revoked.'));
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    setBusy('');
  };

  return (
    <PlayerCard title={t('Live links')}>
      {links.map((l) => {
        const [label, bg, fg] = STATE[l.state] || STATE.expired;
        const when = l.state === 'revoked' ? `${t('revoked on')} ${fmtDate(day(l.revokedAt))}`
          : l.state === 'expired' ? `${t('expired on')} ${fmtDate(day(l.expiresAt))}`
            : `${t('works until')} ${fmtDate(day(l.expiresAt))} · ${relDays(daysAway(day(l.expiresAt)))}`;
        return (
          <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
            <div style={{ flex: '1 1 180px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="bidi" style={{ overflowWrap: 'anywhere' }}>{l.general ? t('General link') : l.club}</span>
                <span className="badge" style={{ background: bg, color: fg }}>{t(label)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {t('made on')} {fmtDate(day(l.createdAt))} · {when}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {l.opens > 0
                  ? <>{l.opens === 1 ? t('Opened once') : t('Opened {n} times', { n: l.opens })} · {t('last opening')} {fmtDateTime(l.lastOpenAt)}{l.openings?.[0] ? ` · ${t(l.openings[0].device === 'phone' ? 'from a phone' : 'from a computer')}` : ''}</>
                  : t('Not opened yet')}
              </div>
            </div>
            {canEdit && l.state === 'active' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {l.url && <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(l)}><Icon name="copy" size={11} /> {t('Copy link')}</button>}
                {l.url && <a className="btn btn-ghost btn-sm" href={l.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }} title={t('Your own look is not counted as an opening.')}><Icon name="eye" size={11} /> {t('Preview page')}</a>}
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === l.id} onClick={() => revoke(l)}><Icon name="close" size={11} /> {t('Revoke')}</button>
              </div>
            )}
          </div>
        );
      })}
      {dialog}
    </PlayerCard>
  );
}
