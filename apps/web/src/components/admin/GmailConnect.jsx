// System › Email: the agency's Gmail in the CRM. Mirrors System › YouTube: the
// state of the connection, the one button (a single Google "Allow", read-only),
// the last sync and how much is linked, and "disconnect", which also deletes
// every stored message. The Google client is the one saved in System › YouTube.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Skeleton, toast, useConfirm } from 'components/ui/UI';
import { t, fmtDateTime } from 'lib/i18n';
import { listenYouTube } from 'data/youtube';
import { listenGmail, startGmailConnect, syncGmailNow, disconnectGmail } from 'data/mail';

const Card = ({ children }) => <div className="card" style={{ padding: 16 }}>{children}</div>;

export default function GmailConnect() {
  const [d, setD] = useState(null);
  const [yt, setYt] = useState(null);
  const [busy, setBusy] = useState('');
  const { confirm, dialog } = useConfirm();
  useEffect(() => listenGmail(setD), []);
  useEffect(() => listenYouTube(setYt), []);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('gm') === 'ok') toast.success(t('Gmail is connected. The first sync reads the last 90 days and takes a few minutes.'));
    if (p.get('gm') === 'error') toast.error(`${t('Sign-in failed:')} ${p.get('reason') || ''}`);
  }, []);
  if (!d || !yt) return <Skeleton rows={3} />;

  const act = async (name, fn, done) => {
    setBusy(name);
    try { await fn(); if (done) toast.success(done); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const connect = async () => {
    setBusy('connect');
    try { const { url } = await startGmailConnect(); window.location.assign(url); }
    catch (e) { toast.error(e.message); setBusy(''); }
  };
  const disconnect = async () => {
    const ok = await confirm(t('Disconnect Gmail? The CRM forgets the key and deletes every e-mail it stored. Nothing changes in Gmail itself.'), { confirmLabel: t('Disconnect and delete') });
    if (ok) act('disconnect', disconnectGmail, t('Disconnected. The stored mail was deleted.'));
  };
  const row = (k, v) => (v || v === 0 ? (
    <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', gap: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-3)' }}>{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span>
    </div>
  ) : null);

  const book = d.book || {};
  const apiOff = d.state === 'needs_api' || (d.api && d.api.state === 'off');
  const state = d.connected
    ? (d.address ? t('Connected to {address}.', { address: d.address }) : t('Connected. The address shows after the first sync.'))
    : yt.clientReady
      ? t('Not connected yet: one Google approval is needed.')
      : t('Not connected yet: first save the Google client in System › YouTube. Gmail uses the same one.');
  const syncState = {
    ok: t('Working'),
    no_addresses: t('Waiting for addresses: no contact has an e-mail and no club has an e-mail domain, so nothing is read.'),
    needs_api: t('The Gmail API is off on the Google project.'),
    error: t('The last sync failed.'),
  }[d.state];

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('The agency\'s e-mail')}</div>
        <div style={{ fontSize: 14, marginBottom: 8 }}>{state}</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>
          {t('Read-only. The CRM reads only mail to or from a contact\'s e-mail address or a club\'s e-mail domain, and keeps the date, the people, the subject, a short preview and attachment names. It never reads other mail, never keeps the full text or the attachments, and never sends, deletes or marks anything.')}
        </div>
        {!d.connected && yt.clientReady && (
          <>
            <button type="button" className="btn btn-primary" onClick={connect} disabled={!!busy} style={{ height: 40 }}>
              {busy === 'connect' ? t('Opening Google…') : t('Connect Gmail')}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
              {t('A Google screen opens: pick the agency\'s mailbox and allow "Read your email". If Google says the app is not verified, it is your own system: press Advanced, then Continue. The first sync reads back 90 days.')}
            </div>
          </>
        )}
        {!d.connected && !yt.clientReady && <Link to="/admin/youtube" className="btn btn-secondary btn-sm" style={{ textDecoration: 'none' }}>{t('Go to System › YouTube')}</Link>}
        {d.lastError?.message && !apiOff && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8, overflowWrap: 'anywhere' }}>{d.lastError.message}</div>}
        {apiOff && d.api?.message && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4, overflowWrap: 'anywhere' }}>{d.api.message}</div>}
        {apiOff && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {t('The server tries to switch it on once a day. If it stays off, switch on "Gmail API" in the Google Cloud console of the project the YouTube client belongs to.')}
          </div>
        )}
      </Card>

      {d.connected && (
        <Card>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {row(t('Mailbox'), d.address ? <span dir="ltr">{d.address}</span> : '')}
            {row(t('State'), syncState)}
            {row(t('Last sync'), d.lastSyncAt ? fmtDateTime(d.lastSyncAt) : t('Not yet'))}
            {row(t('Messages kept'), d.linkedCount ?? 0)}
            {row(t('Read from'), t('{e} contact addresses, {d} club domains', { e: book.emails ?? 0, d: book.domains ?? 0 }))}
            {d.backlog ? row(t('Waiting to be read'),t('{n} messages, read in the next runs', { n: d.backlog })) : null}
            {row(t('Connected on'),d.connectedAt ? fmtDateTime(d.connectedAt) : '')}
            {row(t('Connected by'), d.connectedBy)}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => act('sync', syncGmailNow, t('The sync started. It runs every 15 minutes on its own.'))}>
              {busy === 'sync' ? t('Starting…') : t('Sync now')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={connect}>{t('Connect again')}</button>
            <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={!!busy} onClick={disconnect}>
              {busy === 'disconnect' ? t('Disconnecting…') : t('Disconnect')}
            </button>
          </div>
        </Card>
      )}
      {dialog}
    </div>
  );
}
