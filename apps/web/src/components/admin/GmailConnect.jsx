// System › Email: the agency's Gmail in the CRM. Mirrors System › YouTube: the
// state of the connection, the one button (a single Google "Allow", read-only),
// the last sync and how much is linked, and "disconnect", which also deletes
// every stored message. The Google client is the one saved in System › YouTube.
// Below them, "Addresses found": the contact addresses and club domains the
// server found by itself (lib/mail-addresses.js), with the ones still waiting
// for a decision.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Skeleton, toast, useConfirm } from 'components/ui/UI';
import { t, fmtDateTime, fmtLongDate } from 'lib/i18n';
import { listenYouTube } from 'data/youtube';
import {
  listenGmail, startGmailConnect, syncGmailNow, disconnectGmail,
  fetchFoundAddresses, acceptAddress, acceptAllAddresses, dismissAddress, undoAddress,
} from 'data/mail';

const Card = ({ children }) => <div className="card" style={{ padding: 16 }}>{children}</div>;

// Why the server saved a value or only suggests it (the reason codes of lib/mail-addresses.js).
const REASONS = {
  full_name: 'Full name match',
  website_mail: 'The club\'s website, and mail was sent there',
  website_only: 'From the club\'s website',
  same_name_two_addresses: 'The same name on two addresses',
  same_name_two_contacts: 'Two contacts have this name',
  address_in_use: 'Another contact has this address',
  address_fits_two_contacts: 'The address fits two contacts',
  shared_mailbox: 'A shared office address',
  one_word_name: 'A one-word name',
  name_contained: 'Part of the name matches',
  name_sounds_alike: 'The name sounds alike',
  address_spells_name: 'The address spells the name',
  shared_word_club_domain: 'One shared word, at the club\'s domain',
};

const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--rule)' };
const subLabel = { fontSize: 13, color: 'var(--text-3)' };

/** One found value: whose it is, the value, why, and its actions. */
function FoundRow({ r, children }) {
  const who = r.name || (r.kind === 'club' ? t('Club') : t('Contact'));
  return (
    <div style={rowStyle}>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div>
          <span className="bidi">{who}</span>
          {r.kind === 'contact' && r.club ? <> · <span className="bidi">{r.club}</span></> : null}
          {REASONS[r.reason] ? <>{' '}<span className="badge" style={{ background: 'var(--surface-3)', color: 'var(--text-2)' }}>{t(REASONS[r.reason])}</span></> : null}
        </div>
        <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}><span dir="ltr">{r.value}</span></div>
        {(r.seenName || r.times > 0) && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {r.seenName ? <>{t('Written in the mail as')} <bdi>{r.seenName}</bdi></> : null}
            {r.seenName && r.times > 0 ? ' · ' : null}
            {r.times > 0 ? <bdi>{r.times === 1 ? t('One sent message') : t('{n} sent messages', { n: r.times })}</bdi> : null}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** The addresses the server found: saved by itself, and waiting for a decision. */
function FoundAddresses({ counts, busy, act, confirm }) {
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setList(await fetchFoundAddresses()); setFailed(false); } catch { setFailed(true); }
  }, []);
  // The public counts change when a sync finds something: read the list again.
  const stamp = counts ? `${counts.filled || 0}|${counts.open || 0}` : '';
  useEffect(() => { load(); }, [load, stamp]);

  const run = async (name, fn, done) => {
    await act(name, async () => {
      // Read the list again after a failure too: the row may no longer be waiting.
      let out;
      try { out = await fn(); } finally { await load(); }
      if (typeof done === 'function') toast.success(done(out));
    }, typeof done === 'string' ? done : undefined);
  };
  const remove = async (r) => {
    const ok = await confirm(t('Remove this value from the record? It will not be filled in again, and its mail is no longer read.'), { confirmLabel: t('Remove') });
    if (ok) run(`undo:${r.id}`, () => undoAddress(r.id), t('Removed. It will not be filled in again.'));
  };
  const approveAll = async () => {
    const ok = await confirm(t('Approve every suggestion that stands alone? Suggestions that share a record or a value stay for you to decide one by one.'), { confirmLabel: t('Approve all') });
    if (ok) {
      run('accept_all', acceptAllAddresses, (out) => {
        const a = (out && out.accepted) || 0;
        const s = (out && out.skipped) || 0;
        const approved = a === 0 ? t('Nothing was approved.') : a === 1 ? t('One approved.') : t('{a} approved.', { a });
        const waiting = s === 0 ? '' : s === 1 ? t('One waits for your decision.') : t('{s} wait for a decision one by one.', { s });
        return [approved, waiting].filter(Boolean).join(' ');
      });
    }
  };

  const suggestions = (list && list.suggestions) || [];
  // "Approve all" approves the suggestions that stand alone (one for its record, a value suggested once): shown when there are two or more.
  const times = (key) => suggestions.reduce((m, r) => m.set(key(r), (m.get(key(r)) || 0) + 1), new Map());
  const perTarget = times((r) => `${r.kind}|${r.targetId}`);
  const perValue = times((r) => `${r.kind}|${r.value}`);
  const alone = suggestions.filter((r) => perTarget.get(`${r.kind}|${r.targetId}`) === 1 && perValue.get(`${r.kind}|${r.value}`) === 1 && r.reason !== 'address_in_use').length;
  const filled = (list && list.filled) || [];
  const search = (list && list.search) || {};
  const searchLine = {
    never: t('The search has not run yet. It runs with the next sync.'),
    running: search.readBackTo
      ? t('The search is still reading: so far back to {date}.', { date: fmtLongDate(search.readBackTo, { day: '2-digit', month: 'long', year: 'numeric' }) })
      : t('The search is still reading.'),
    done: search.lastRunAt
      ? t('Last search: {date}. It looks again once a day.', { date: fmtDateTime(search.lastRunAt) })
      : '',
  }[search.state] || '';

  return (
    <Card>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('Addresses found')}</div>
      <div style={{ ...subLabel, marginBottom: 12 }}>
        {t('The server looks only at the names and addresses of the people you sent mail to in the last year, never at what the mail says, and compares them with the names of your contacts. A full name match is saved by itself; anything less sure waits here for you. A club\'s e-mail domain comes from the website on its record.')}
      </div>
      {!list && !failed && <Skeleton rows={2} />}
      {failed && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ color: 'var(--red)' }}>{t('Could not load the addresses.')}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load}>{t('Try again')}</button>
        </div>
      )}
      {list && !failed && (
        <>
          {suggestions.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <span style={{ ...subLabel, flex: '1 1 180px', minWidth: 0 }}>{t('Waiting for your decision ({n})', { n: suggestions.length })}</span>
                {alone > 1 && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={approveAll}>
                    {busy === 'accept_all' ? t('Approving…') : t('Approve all')}
                  </button>
                )}
              </div>
              {suggestions.map((r) => (
                <FoundRow key={r.id} r={r}>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy}
                    aria-label={`${t('Approve')}: ${r.name || ''} ${r.value}`}
                    onClick={() => run(`accept:${r.id}`, () => acceptAddress(r.id), t('Saved on the record. Its mail comes in with the next sync.'))}>
                    {busy === `accept:${r.id}` ? t('Approving…') : t('Approve')}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy}
                    aria-label={`${t('Not this one')}: ${r.name || ''} ${r.value}`}
                    onClick={() => run(`dismiss:${r.id}`, () => dismissAddress(r.id), t('It will not be suggested again.'))}>
                    {t('Not this one')}
                  </button>
                </FoundRow>
              ))}
            </div>
          )}
          {filled.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ ...subLabel, marginBottom: 4 }}>{t('Saved automatically ({n})', { n: filled.length })}</div>
              {filled.map((r) => (
                <FoundRow key={r.id} r={r}>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy}
                    aria-label={`${t('Remove')}: ${r.name || ''} ${r.value}`} onClick={() => remove(r)}>
                    {t('Remove')}
                  </button>
                </FoundRow>
              ))}
            </div>
          )}
          {!suggestions.length && !filled.length && (
            <div style={{ ...subLabel, marginBottom: searchLine ? 8 : 0 }}>{t('Nothing found for the contacts and clubs that have no address yet.')}</div>
          )}
          {searchLine && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{searchLine}</div>}
        </>
      )}
    </Card>
  );
}

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
    no_addresses: t('Waiting for addresses: no contact has an e-mail and no club has an e-mail domain yet, so no mail is read. The search below looks for them.'),
    needs_api: t('The Gmail API is off on the Google project.'),
    error: t('The last sync failed.'),
  }[d.state];

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{t('The agency\'s e-mail')}</div>
        <div style={{ fontSize: 14, marginBottom: 8 }}>{state}</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>
          {t('Read-only. The CRM reads only mail to or from a contact\'s e-mail address or a club\'s e-mail domain, and keeps the date, the people, the subject, a short preview and attachment names. To find those addresses it looks only at who the mail you sent went to, never at what it says. It never reads other mail, never keeps the full text or the attachments, and never sends, deletes or marks anything.')}
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
        {apiOff && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {t('The server tries to switch it on once a day. If it stays off, switch on "Gmail API" in the Google Cloud console of the project the YouTube client belongs to.')}
          </div>
        )}
        {apiOff && d.api?.message && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, overflowWrap: 'anywhere' }}>{t('Google\'s answer')}: <bdi dir="ltr">{d.api.message}</bdi></div>
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
            <button type="button" className="btn btn-danger btn-sm" disabled={!!busy} onClick={disconnect}>
              {busy === 'disconnect' ? t('Disconnecting…') : t('Disconnect')}
            </button>
          </div>
        </Card>
      )}
      {d.connected && <FoundAddresses counts={d.found} busy={busy} act={act} confirm={confirm} />}
      {dialog}
    </div>
  );
}
