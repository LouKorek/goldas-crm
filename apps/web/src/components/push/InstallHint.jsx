import React, { useEffect, useState } from 'react';
import { platform, onInstallable, promptInstall, installHintDismissed, dismissInstallHint } from 'data/push';
import Icon from 'components/ui/Icons';
import { t } from 'lib/i18n';

// The iPhone's share icon (a square with an arrow up), as Safari draws it.
export const ShareIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: '-3px' }}>
    <path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
  </svg>
);

/** iPhone: installing cannot be started by the app, so the two taps are shown. */
export function IosSteps() {
  const step = { display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, color: 'var(--text-1)' };
  const num = { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--gold)', flexShrink: 0, width: 14 };
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <li style={step}><span style={num}>1</span><span>{t('In Safari, tap Share')} <span style={{ color: 'var(--blue)' }}><ShareIcon /></span></span></li>
      <li style={step}><span style={num}>2</span><span>{t('Choose "Add to Home Screen", then open Gold A&S from the home screen')}</span></li>
    </ol>
  );
}

/**
 * On a phone where the CRM is still a browser tab: once, until dismissed, how
 * to put it on the home screen. Android: the browser's own install button.
 */
export default function InstallHint() {
  const p = platform();
  const [hidden, setHidden] = useState(() => !p.mobile || p.standalone || installHintDismissed());
  const [canPrompt, setCanPrompt] = useState(false);
  useEffect(() => onInstallable(setCanPrompt), []);
  if (hidden) return null;
  const close = () => { dismissInstallHint(); setHidden(true); };
  const install = async () => { const r = await promptInstall(); if (r === 'accepted') close(); };
  return (
    <section className="card card-body" style={{ padding: '14px 16px', marginBottom: 14, borderInlineStart: '2px solid var(--gold)' }} aria-label={t('Install the app')}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{t('Put Gold A&S on your home screen')}</div>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '0 0 10px' }}>{t('It opens like an app and can alert you on the phone about urgent things: a contract ending, a stuck deal, a late task.')}</p>
          {p.ios ? <IosSteps /> : canPrompt
            ? <button className="btn btn-primary btn-sm" onClick={install}><Icon name="download" size={12} /><span>{t('Install')}</span></button>
            : <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: 0 }}>{t('In the browser menu (⋮), choose "Install app" or "Add to Home screen".')}</p>}
        </div>
        <button className="btn btn-ghost btn-icon" onClick={close} aria-label={t('Dismiss')} title={t('Dismiss')}><Icon name="close" size={14} /></button>
      </div>
    </section>
  );
}
