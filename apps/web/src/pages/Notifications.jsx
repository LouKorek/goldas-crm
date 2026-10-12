import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { listenCollection, PATHS } from 'lib/db';
import { listenPlayers } from 'data/players';
import { fmtDate } from 'lib/constants';
import { DEFAULT_SETTINGS, loadSettings, persistSettings, unifiedAlerts, alertLink } from 'lib/alerts';
import { PageHeader, Modal, toast } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { useRole } from 'lib/roleContext';
import { t, getLang, relDays } from 'lib/i18n';

// Every alert in one list, from the same engine Home and the daily email use
// (packages/domain/src/engines/alerts.ts): contracts, representation,
// passports, birthdays, deals waiting too long, expired requirements,
// overdue tasks, failed night jobs, and the matches of the coming week.
const ALL_OPTIONS = [0, 3, 7, 14, 30, 60, 90, 180];

const TYPE = {
  contract:            { tag: 'CON', title: 'Contract Expiry' },
  repr:                { tag: 'REP', title: 'Representation Expiry' },
  passport:            { tag: 'PAS', title: 'Passport Expiry' },
  birthday:            { tag: 'DOB', title: 'Upcoming Birthdays' },
  deal_stale:          { tag: 'DEAL', title: 'Deals waiting too long' },
  requirement_expired: { tag: 'REQ', title: 'Expired club requirements' },
  task_overdue:        { tag: 'TASK', title: 'Overdue tasks' },
  job_failed:          { tag: 'JOB', title: 'Failed night jobs' },
  match:               { tag: 'FIX', title: 'Upcoming Matches' },
};
const COLORS = { critical: 'var(--red)', warning: 'var(--amber)', info: 'var(--blue)', gold: 'var(--gold)' };

function AlertCard({ a }) {
  const he = getLang() === 'he';
  const c = COLORS[a.severity] || COLORS.info;
  const body = (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderInlineStart: `2px solid ${c}`,
      padding: '11px 14px', display: 'flex', gap: 12, alignItems: 'flex-start', transition: 'background 0.11s linear',
    }}
    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--card-hover)'}
    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--card)'}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: c, flexShrink: 0, width: 30, paddingTop: 2 }}>{TYPE[a.type]?.tag}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, fontSize: 13.5, color: 'var(--text-1)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {a.overdue && a.type !== 'deal_stale' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', background: 'rgba(240,114,110,0.14)', color: 'var(--red)', border: '1px solid rgba(240,114,110,0.4)', padding: '1px 7px' }}>{t('OVERDUE')}</span>}
          {a.subject.name}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3 }}>{a.proof[he ? 'he' : 'en']}</div>
        {a.dueDate && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{fmtDate(a.dueDate)}{a.days !== null ? ` · ${relDays(a.days)}` : ''}</div>}
      </div>
    </div>
  );
  return <Link to={alertLink(a)} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link>;
}

function SettingsModal({ settings, onSave, onClose }) {
  const [s, setS] = useState({ ...DEFAULT_SETTINGS, ...settings });
  const toggle = (key, val) => setS((prev) => ({ ...prev, [key]: prev[key].includes(val) ? prev[key].filter((v) => v !== val) : [...prev[key], val].sort((a, b) => a - b) }));
  const label = (d) => (d === 0 ? t('Same day') : t('{n} days before', { n: d }));
  return (
    <Modal title={t('Notification Settings')} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={() => onSave(s)}>{t('Save Settings')}</button>
    </>}>
      <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 20 }}>{t('Choose when to receive alerts for each category. Multiple values = multiple alerts.')}</p>
      {[['contractDays', t('Contract Expiry')], ['reprDays', t('Representation Expiry')], ['passportDays', t('Passport Expiry')], ['birthdayDays', t('Player Birthdays')]].map(([key, lbl]) => (
        <div key={key} style={{ marginBottom: 20 }}>
          <div className="form-label">{lbl}</div>
          <div className="chip-group">
            {ALL_OPTIONS.map((d) => <button key={d} type="button" className={`chip${s[key]?.includes(d) ? ' active' : ''}`} onClick={() => toggle(key, d)}>{label(d)}</button>)}
          </div>
        </div>
      ))}
      <div style={{ marginBottom: 8 }}>
        <div className="form-label">{t('Deal waiting too long after')}</div>
        <div className="chip-group">
          {[7, 10, 14, 21, 30].map((d) => <button key={d} type="button" className={`chip${(s.dealStaleDays || 14) === d ? ' active' : ''}`} onClick={() => setS((p) => ({ ...p, dealStaleDays: d }))}>{t('{n} days', { n: d })}</button>)}
        </div>
      </div>
    </Modal>
  );
}

export default function Notifications() {
  const { canEdit, email } = useRole();
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [deals, setDeals] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const u = [
      listenPlayers({ stage: 'represented' }, setPlayers),
      listenCollection(PATHS.MATCHES, setMatches),
      listenCollection(PATHS.DEALS, setDeals),
      listenCollection(PATHS.CLUB_REQUIREMENTS, setRequirements),
      listenCollection(PATHS.TASKS, (rows) => setTasks(rows.filter((x) => x.owner === email))),
      listenCollection('jobs', setJobs),
    ];
    loadSettings().then(setSettings);
    return () => u.forEach((f) => f());
  }, [email]);

  const saveSettings = async (s) => {
    try { await persistSettings(s); setSettings(s); setShowSettings(false); toast.success(t('Notification settings saved.')); }
    catch (e) { toast.error(e.message || t('Could not save settings.')); }
  };

  const r = useMemo(() => unifiedAlerts({ players, matches, deals, requirements, tasks, jobs, settings }), [players, matches, deals, requirements, tasks, jobs, settings]);
  const order = ['job_failed', 'deal_stale', 'contract', 'repr', 'passport', 'requirement_expired', 'task_overdue', 'birthday', 'match'];

  return (
    <div>
      <PageHeader
        title={t('Notifications')}
        subtitle={t('{n} active alerts', { n: r.total })}
        action={canEdit ? <button className="btn btn-ghost" onClick={() => setShowSettings(true)}><Icon name="bell" size={12} /><span className="btn-text">{t('Alert Settings')}</span></button> : null}
      />
      {r.alerts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '44px 20px', color: 'var(--text-3)' }}>
          <div style={{ width: 42, height: 1, background: 'var(--gold-dk)', margin: '0 auto 18px' }} />
          <p style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{t('All clear — no active alerts')}</p>
          {canEdit && <button className="btn btn-ghost" style={{ marginTop: 18 }} onClick={() => setShowSettings(true)}>{t('Configure alert timing')}</button>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {order.map((type) => {
            const items = r.byType[type];
            if (!items?.length) return null;
            return (
              <div key={type}>
                <div className="section-label" style={{ marginBottom: 12 }}>{TYPE[type].tag} {t(TYPE[type].title)} ({items.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{items.slice(0, type === 'match' ? 10 : 100).map((a, i) => <AlertCard key={`${a.type}${a.subject.id}${i}`} a={a} />)}</div>
              </div>
            );
          })}
        </div>
      )}
      {showSettings && <SettingsModal settings={settings} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
