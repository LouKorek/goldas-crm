import React, { useEffect, useState } from 'react';
import { pushState, enablePush, disablePush, removeDevice, sendTestPush } from 'data/push';
import { IosSteps } from 'components/push/InstallHint';
import { toast, useConfirm } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { t, fmtDateTime } from 'lib/i18n';

// "התראות לטלפון" on the Notifications page: this device on or off, a test,
// and every device of this user with remove. Turning it on is always a tap.
const STATE = {
  on:              { label: 'On on this device', bg: 'var(--green-bg)', fg: 'var(--green-ok)' },
  off:             { label: 'Off on this device', bg: 'var(--surface-2)', fg: 'var(--text-2)' },
  blocked:         { label: 'Blocked in the browser', bg: 'var(--red-bg)', fg: 'var(--red)' },
  unsupported:     { label: 'Not supported here', bg: 'var(--surface-2)', fg: 'var(--text-2)' },
  'needs-install': { label: 'Needs the app on the home screen', bg: 'var(--amber-bg)', fg: 'var(--amber)' },
};

export default function PushSettings() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState('');
  const { confirm, dialog } = useConfirm();
  useEffect(() => { let live = true; pushState().then((x) => live && setS(x)).catch(() => live && setS({ state: 'unsupported', devices: [], error: true })); return () => { live = false; }; }, []);

  const run = (what, fn, ok) => async () => {
    setBusy(what);
    try { const r = await fn(); if (r && r.state) setS(r); if (ok) toast.success(t(ok)); }
    catch (e) { toast.error(e.message || t('Something went wrong.')); }
    finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await sendTestPush();
      if (r.ok) toast.success(t('Test sent. It should appear in a few seconds.'));
      else toast.error(t('The test did not reach any device.'));
      setS(await pushState());
    } catch (e) { toast.error(e.message || t('Something went wrong.')); }
    finally { setBusy(''); }
  };
  const remove = (d) => async () => {
    if (!(await confirm(t('It will stop receiving notifications.'), { title: t('Remove this device?'), confirmLabel: t('Remove') }))) return;
    await run(`rm${d.id}`, () => removeDevice(d.id), 'Device removed.')();
  };

  const state = s ? STATE[s.state] : null;
  const devices = s?.devices || [];
  return (
    <section className="card card-body" style={{ padding: '14px 16px', marginBottom: 22 }} aria-label={t('Phone notifications')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Icon name="bell" size={14} />
        <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Phone notifications')}</div>
        {state && <span className="badge" style={{ background: state.bg, color: state.fg, whiteSpace: 'nowrap' }}>{t(state.label)}</span>}
        <span style={{ flex: 1 }} />
        {s?.state === 'off' && <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={run('on', enablePush, 'Phone notifications are on.')}>{t('Turn on')}</button>}
        {s?.state === 'on' && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={run('off', disablePush, 'Phone notifications are off on this device.')}>{t('Turn off')}</button>}
        {devices.length > 0 && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={test}><Icon name="send" size={12} /><span>{busy === 'test' ? t('Sending…') : t('Send a test')}</span></button>}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '8px 0 0' }}>
        {t('Urgent things only, once each, between 08:00 and 22:00: a contract or representation agreement ending within a week, a deal stuck too long, an overdue task, and for admins a late payment. Tapping one opens its page.')}
      </p>
      {!s && <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '10px 0 0' }}>{t('Loading…')}</p>}
      {s?.state === 'needs-install' && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 12.5, color: 'var(--text-1)', margin: '0 0 8px' }}>{t('On an iPhone, notifications work only from the app on the home screen (iOS 16.4 or later):')}</p>
          <IosSteps />
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '8px 0 0' }}>{t('Then open this page there and tap "Turn on".')}</p>
        </div>
      )}
      {s?.state === 'blocked' && <p style={{ fontSize: 12.5, color: 'var(--text-1)', margin: '10px 0 0' }}>{t('This browser was told not to show notifications from the CRM. Allow them in the site settings (the lock icon next to the address, or the phone\'s Settings → Notifications), then come back here.')}</p>}
      {s?.state === 'unsupported' && !s.error && <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '10px 0 0' }}>{t('This browser cannot receive notifications. Use Chrome on Android or a computer, or the app on an iPhone home screen.')}</p>}
      {s?.error && <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '10px 0 0' }}>{t('Could not read the notification settings. Check the connection and reload.')}</p>}
      {devices.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>{t('My devices')} ({devices.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {devices.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-1)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {d.device}
                    {d.thisDevice && <span className="badge" style={{ background: 'var(--gold-dim)', color: 'var(--gold)' }}>{t('This device')}</span>}
                    {d.failing && <span className="badge" style={{ background: 'var(--amber-bg)', color: 'var(--amber)' }}>{t('Last send failed')}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    {t('Added {d}', { d: d.createdAt ? fmtDateTime(new Date(d.createdAt)) : '—' })}
                    {d.lastOkAt ? ` · ${t('last received {d}', { d: fmtDateTime(new Date(d.lastOkAt)) })}` : ''}
                  </div>
                </div>
                <button className="btn btn-ghost btn-icon" disabled={!!busy} onClick={remove(d)} aria-label={t('Remove')} title={t('Remove')}><Icon name="trash" size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
      {dialog}
    </section>
  );
}
