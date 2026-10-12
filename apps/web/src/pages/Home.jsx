import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listenCollection, PATHS } from 'lib/db';
import { listenPlayers } from 'data/players';
import { loadSettings, computeAlerts } from 'lib/alerts';
import { fmtDate } from 'lib/constants';
import { useRole } from 'lib/roleContext';
import { t, relDays, fmtDateTime, getLang } from 'lib/i18n';
import { DEAL_STALE_DAYS, playerName } from '@goldas/domain';
import { PageHeader, Skeleton } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import Dashboard from './Dashboard';

// Home has two tabs. "Today" is the opening screen: what needs action,
// today's and tomorrow's games, what Golda did in the last 24 hours and
// whether the overnight jobs ran. "Snapshot" is the numbers dashboard. The
// last tab chosen is remembered per user.
const TAB_KEY = 'home-tab';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening');
};

export default function Home() {
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab = tabParam === 'snapshot' || tabParam === 'today' ? tabParam : (localStorage.getItem(TAB_KEY) || 'today');
  useEffect(() => { if (!tabParam) navigate(`/home/${tab}`, { replace: true }); }, [tabParam, tab, navigate]);
  useEffect(() => { if (tabParam) localStorage.setItem(TAB_KEY, tabParam); }, [tabParam]);
  const { name } = useRole();

  return (
    <div>
      <PageHeader title={`${greeting()}, ${name?.split(' ')[0] || ''}`} subtitle={fmtDateTime(new Date()).slice(0, 8)}>
        <div className="tabs" role="tablist" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-2)', marginTop: 8 }}>
          {[['today', t('Today')], ['snapshot', t('Snapshot')]].map(([k, label]) => (
            <Link key={k} to={`/home/${k}`} role="tab" aria-selected={tab === k}
              style={{
                padding: '10px 18px', textDecoration: 'none', fontSize: 13, fontWeight: tab === k ? 700 : 500,
                color: tab === k ? 'var(--gold)' : 'var(--text-3)', borderBottom: `2px solid ${tab === k ? 'var(--gold)' : 'transparent'}`, marginBottom: -1,
              }}>{label}</Link>
          ))}
        </div>
      </PageHeader>
      {tab === 'snapshot' ? <Dashboard embedded /> : <Today />}
    </div>
  );
}

function Section({ title, sub, children, to, count }) {
  return (
    <section className="card card-body" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <div className="section-label" style={{ marginBottom: 0 }}>{title}</div>
        {count !== undefined && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gold)' }}>{count}</span>}
        {sub && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</span>}
        <span style={{ flex: 1 }} />
        {to && <Link to={to} style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>{t('View all')}</Link>}
      </div>
      {children}
    </section>
  );
}

function Row({ tag, color, title, sub, to, onClick }) {
  const body = (
    <div className="alert-row" style={{ borderInlineStartColor: color, cursor: to || onClick ? 'pointer' : 'default' }} onClick={onClick}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color, flexShrink: 0, minWidth: 30, paddingTop: 3 }}>{tag}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{title}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{sub}</div>}
      </div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link> : body;
}

const Quiet = ({ children }) => <p style={{ color: 'var(--text-3)', fontSize: 12.5, padding: '6px 0' }}>{children}</p>;

function Today() {
  const { email } = useRole();
  const [players, setPlayers] = useState(null);
  const [matches, setMatches] = useState([]);
  const [deals, setDeals] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [audit, setAudit] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    const u = [
      listenPlayers({ stage: 'represented' }, setPlayers),
      listenCollection(PATHS.MATCHES, setMatches),
      listenCollection(PATHS.DEALS, setDeals),
      listenCollection(PATHS.TASKS, (rows) => setTasks(rows.filter((x) => x.owner === email && !x.done))),
      listenCollection('wa_audit', setAudit),
      listenCollection('jobs', setJobs),
    ];
    loadSettings().then(setSettings);
    return () => u.forEach((f) => f());
  }, [email]);

  const now = new Date();
  const dayMs = 86400000;
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + dayMs).toISOString().slice(0, 10);
  const he = getLang() === 'he';

  const alerts = useMemo(() => (players ? computeAlerts(players, matches, settings || undefined, now) : null), [players, matches, settings]); // eslint-disable-line

  const actions = useMemo(() => {
    if (!alerts) return [];
    const out = [];
    const push = (tag, color, title, sub, to, order) => out.push({ tag, color, title, sub, to, order });
    for (const a of alerts.contract) push(t('CON'), a.overdue || a.days <= 7 ? 'var(--red)' : 'var(--amber)', a.player.fullName, `${t('Contract ends')} ${fmtDate(a.player.contractEnd)} · ${a.overdue ? `${-a.days} ${t('days overdue')}` : relDays(a.days)}`, `/players/${a.id}`, a.days);
    for (const a of alerts.repr) push(t('REP'), a.overdue || a.days <= 7 ? 'var(--red)' : 'var(--amber)', a.player.fullName, `${t('Representation ends')} ${fmtDate(a.player.reprEnd)} · ${relDays(a.days)}`, `/players/${a.id}`, a.days);
    for (const a of alerts.passport) push(t('PAS'), a.overdue || a.days <= 30 ? 'var(--red)' : 'var(--amber)', a.player.fullName, `${t('Passport expires')} ${fmtDate(a.player.passportExpiry)} · ${relDays(a.days)}`, `/players/${a.id}`, a.days);
    for (const a of alerts.birthday) push(a.turning18 ? '18' : 'DOB', 'var(--gold)', a.player.fullName, `${t('Birthday')} · ${relDays(a.days)} · ${a.age}`, `/players/${a.id}`, 1000 + a.days);
    for (const d of deals) {
      if (d.closedAt || d.deletedAt) continue;
      const since = Math.floor((now - new Date(d.enteredStageAt || d.createdAt?.toDate?.() || now)) / dayMs);
      if (since >= DEAL_STALE_DAYS) push(t('Deal waiting'), 'var(--amber)', `${d.playerName} ↔ ${d.clubName}`, `${t(d.stage)} · ${since} ${t('days')}`, `/pipeline/${d.category || 'men'}`, 500 - since);
    }
    for (const x of tasks) {
      if (!x.dueDate || x.dueDate > today) continue;
      const days = Math.round((new Date(x.dueDate) - new Date(today)) / dayMs);
      push(t('Task due'), days < 0 ? 'var(--red)' : 'var(--gold)', x.title, days < 0 ? `${-days} ${t('days overdue')}` : t('Today'), '/tasks', days);
    }
    return out.sort((a, b) => a.order - b.order);
  }, [alerts, deals, tasks, today]); // eslint-disable-line

  const games = useMemo(() => matches
    .filter((m) => m.date === today || m.date === tomorrow)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))), [matches, today, tomorrow]);
  const nameOf = (id) => playerName((players || []).find((p) => p.id === id) || {});

  const golda = useMemo(() => audit
    .filter((a) => (a.at?.toMillis?.() || 0) > now.getTime() - dayMs)
    .sort((a, b) => (b.at?.toMillis?.() || 0) - (a.at?.toMillis?.() || 0))
    .slice(0, 8), [audit]); // eslint-disable-line

  const night = useMemo(() => jobs
    .filter((j) => (j.startedAt?.toMillis?.() || 0) > now.getTime() - dayMs)
    .sort((a, b) => (b.startedAt?.toMillis?.() || 0) - (a.startedAt?.toMillis?.() || 0)), [jobs]); // eslint-disable-line
  const failed = night.filter((j) => j.status === 'error');

  if (!players) return <Skeleton rows={6} />;
  const ACTION = { create: he ? 'יצרה' : 'created', update: he ? 'עדכנה' : 'updated', delete: he ? 'מחקה' : 'deleted' };

  return (
    <div className="home-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
      <Section title={t('What needs action')} count={actions.length} to="/notifications">
        {actions.length === 0 ? <Quiet>{t('Nothing needs action today.')}</Quiet> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{actions.slice(0, 12).map((a, i) => <Row key={i} {...a} />)}</div>
        )}
      </Section>

      <Section title={t('Games and trainings')} sub={t('Today and tomorrow')} to="/matches">
        {games.length === 0 ? <Quiet>{t('No games today or tomorrow.')}</Quiet> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {games.map((m) => (
              <Row key={m.id} tag={m.date === today ? t('Today') : t('Tomorrow')} color="var(--blue)"
                title={`${m.homeTeam} ${t('vs')} ${m.awayTeam}`}
                sub={[m.time, m.stadiumName, (m.linkedPlayers || []).map(nameOf).filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                to="/matches" />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('What Golda did')} sub={t('Last 24 hours')} to="/golda">
        {golda.length === 0 ? <Quiet>{t('Golda made no changes in the last 24 hours.')}</Quiet> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {golda.map((a) => (
              <Row key={a.id} tag={a.action === 'delete' ? '✕' : a.action === 'create' ? '+' : '✎'} color="var(--gold)"
                title={`${ACTION[a.action] || a.action} ${t(a.collection === 'players' ? 'player' : a.collection?.startsWith('pipeline') ? 'Candidates' : a.collection || '')}: ${a.after?.fullName || a.after?.playerName || a.after?.title || a.before?.fullName || a.before?.playerName || a.docId || ''}`}
                sub={`${fmtDateTime(a.at?.toDate?.())}${a.sender ? ` · ${a.sender}` : ''}`} />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('Overnight jobs')} count={night.length}>
        {night.length === 0 ? <Quiet>{t('Everything ran fine.')}</Quiet> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {failed.map((j) => <Row key={j.id} tag={t('failed')} color="var(--red)" title={j.name} sub={`${fmtDateTime(j.startedAt?.toDate?.())} · ${String(j.error || '').slice(0, 120)}`} />)}
            {night.filter((j) => j.status !== 'error').slice(0, 6).map((j) => (
              <Row key={j.id} tag={j.status === 'running' ? '…' : '✓'} color={j.status === 'running' ? 'var(--amber)' : 'var(--green-ok)'} title={j.name}
                sub={`${fmtDateTime(j.startedAt?.toDate?.())}${j.durationMs ? ` · ${Math.round(j.durationMs / 1000)}s` : ''}`} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
