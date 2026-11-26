/* global __BUILD_ID__ */
// The admin area, admin only: five tabs that show what the system did and
// let the admin act without a terminal.
//   Health   every night job: last run, result, duration, last error, "run now"
//   Quotas   ScraperAPI credits, Netlify deploys this month, Golda's usage
//            today, what her model calls cost today with the daily ceiling
//            on the work she starts by herself (editable), the TM Watch
//            credit budget (editable)
//   Backups  the weekly backups, "back up now", download as a file, and
//            restore: one record, or everything
//   Audit    every change anyone (or Golda) made, with filters
//   Errors   what the app itself reported from people's browsers
//   WhatsApp the server's own Meta key (one Facebook sign-in) and Golda's
//            move to her own number, step by step
//   YouTube  the server's connection to the channel Golda uploads to, and
//            the style she learned from it
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRole } from 'lib/roleContext';
import { t, fmtDateTime, getLang } from 'lib/i18n';
import { PageHeader, Skeleton, Empty, ChipGroup, Field, SearchInput, Modal, toast, useConfirm } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import CalendarSync from 'components/admin/CalendarSync';
import YouTubeConnect from 'components/admin/YouTubeConnect';
import GmailConnect from 'components/admin/GmailConnect';
import WebsiteStatus from 'components/admin/WebsiteStatus';
import AgreementTemplates from 'components/admin/AgreementTemplates';
import {
  JOBS, listenJobs, runJobNow, groupRuns, fetchScraperStatus, listenTmWatchMeta, saveTmWatchBudget, listenDeploys,
  listenGoldaUsage, listenBackups, downloadBackup, listenAudit, listenClientErrors, listenMetaConnect, startMetaConnect,
  listenJobStatus, findInBackup, restoreRecord, restoreEverything, fetchOffsiteCopies, fetchGoldaCost, saveGoldaCostCap,
} from 'data/admin';

const VERSION = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
const TABS = [['health', 'בריאות', 'Health'], ['quotas', 'מכסות', 'Quotas'], ['backups', 'גיבויים', 'Backups'], ['audit', 'יומן פעולות', 'Audit log'], ['errors', 'שגיאות', 'Errors'], ['whatsapp', 'וואטסאפ', 'WhatsApp'], ['calendar', 'יומן Google', 'Google calendar'], ['youtube', 'יוטיוב', 'YouTube'], ['mail', 'מיילים', 'Email'], ['website', 'אתר', 'Website'], ['agreements', 'הסכמי ייצוג', 'Agreements']];
const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
const ago = (d, he) => {
  if (!d) return he ? 'מעולם' : 'never';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 60) return he ? `לפני ${m} דק'` : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return he ? `לפני ${h} שע'` : `${h} h ago`;
  return he ? `לפני ${Math.round(h / 24)} ימים` : `${Math.round(h / 24)} days ago`;
};
const dur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60000)}m`);

const STATUS = {
  ok: { he: 'הצליח', en: 'ok', color: 'var(--green-ok)', bg: 'var(--green-bg)' },
  error: { he: 'נכשל', en: 'failed', color: 'var(--red)', bg: 'var(--red-bg)' },
  running: { he: 'רץ', en: 'running', color: 'var(--amber)', bg: 'var(--amber-bg)' },
  cut: { he: 'נקטע', en: 'cut off', color: 'var(--red)', bg: 'var(--red-bg)' },
};
// No run lasts longer than a background function may (15 minutes): one still
// "running" after that was cut off before it could record how it ended.
const CUT_AFTER_MS = 20 * 60000;
const statusOf = (r) => (r && r.status === 'running' && Date.now() - (toDate(r.startedAt)?.getTime() || 0) > CUT_AFTER_MS ? 'cut' : r?.status);
function Badge({ status, he }) {
  const s = STATUS[status] || { he: status, en: status, color: 'var(--text-3)', bg: 'var(--surface-3)' };
  return <span style={{ display: 'inline-block', padding: '2px 8px', fontSize: 11, fontWeight: 700, color: s.color, background: s.bg }}>{he ? s.he : s.en}</span>;
}
const Card = ({ children, style }) => <div className="card" style={{ padding: 16, ...style }}>{children}</div>;
const Mono = ({ children, style }) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, ...style }}>{children}</span>;

export default function Admin() {
  const { isAdmin } = useRole();
  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  const he = getLang() === 'he';
  const tab = TABS.some(([k]) => k === tabParam) ? tabParam : 'health';
  if (!isAdmin) return null;
  return (
    <div>
      <PageHeader title={he ? 'מערכת' : 'System'} subtitle={he ? `מה המערכת עשתה בלילה, כמה נשאר במכסות, גיבויים ויומן הפעולות. גרסה ${VERSION}.` : `What the system did overnight, quotas, backups and the audit log. Version ${VERSION}.`}
        action={<Link to="/admin/design" className="btn btn-ghost btn-sm" style={{ height: 36, textDecoration: 'none' }}>{he ? 'מערכת העיצוב' : 'Design system'}</Link>}>
        <div className="tabs" role="tablist" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-2)', marginTop: 8, overflowX: 'auto' }}>
          {TABS.map(([k, heL, enL]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => navigate(`/admin/${k}`)}
              style={{ background: 'none', border: 'none', borderBottom: tab === k ? '2px solid var(--gold)' : '2px solid transparent', color: tab === k ? 'var(--text-1)' : 'var(--text-3)', padding: '8px 14px', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: -1, whiteSpace: 'nowrap' }}>
              {he ? heL : enL}
            </button>
          ))}
        </div>
      </PageHeader>
      {tab === 'health' && <Health he={he} />}
      {tab === 'quotas' && <Quotas he={he} />}
      {tab === 'backups' && <Backups he={he} />}
      {tab === 'audit' && <Audit he={he} />}
      {tab === 'errors' && <Errors he={he} />}
      {tab === 'whatsapp' && <WhatsApp he={he} />}
      {tab === 'calendar' && <CalendarSync he={he} />}
      {tab === 'youtube' && <YouTubeConnect he={he} />}
      {tab === 'mail' && <GmailConnect />}
      {tab === 'website' && <WebsiteStatus he={he} />}
      {tab === 'agreements' && <AgreementTemplates />}
    </div>
  );
}

// ── Health ───────────────────────────────────────────────────────
function Health({ he }) {
  const [runs, setRuns] = useState(null);
  const [starting, setStarting] = useState('');
  const [open, setOpen] = useState('');
  const [status, setStatus] = useState({});
  useEffect(() => listenJobs(setRuns), []);
  useEffect(() => listenJobStatus(setStatus), []);
  const by = useMemo(() => groupRuns(runs || []), [runs]);
  // The last run of a job: from the recent list, or, once hourly jobs have
  // pushed it out of that list, from the job's own last-run record.
  const lastOf = (name) => { const s = status[name] || {}; return (by[name] || [])[0] || (s.runningSince ? { status: 'running', startedAt: s.runningSince } : s.last) || null; };
  const names = useMemo(() => {
    const known = JOBS.map((j) => j.name);
    const extra = Object.keys(by).filter((n) => !known.includes(n) && n !== 'golda');
    return [...JOBS, ...extra.map((n) => ({ name: n, he: n, when: '', run: null }))];
  }, [by]);
  const start = async (job) => {
    setStarting(job.run);
    try { await runJobNow(job.run); toast.success(he ? `"${job.he}" התחיל. התוצאה תופיע כאן בתוך דקות.` : `${job.name} started; the run will show here within minutes.`); }
    catch (e) { toast.error(e.message); }
    setStarting('');
  };
  if (!runs) return <Skeleton rows={6} />;
  const failing = names.filter((j) => ['error', 'cut'].includes(statusOf(lastOf(j.name))));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, background: failing.length ? 'var(--red)' : 'var(--green-ok)', flexShrink: 0 }} />
        <div style={{ fontWeight: 700 }}>{failing.length ? (he ? `${failing.length} עבודות נכשלו בריצה האחרונה` : `${failing.length} jobs failed on their last run`) : (he ? 'כל העבודות הצליחו בריצה האחרונה' : 'Every job succeeded on its last run')}</div>
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{he ? 'גרסה' : 'Version'} <bdi><Mono>{VERSION}</Mono></bdi> · {he ? `${runs.length} הריצות האחרונות` : `the last ${runs.length} runs`}</div>
      </Card>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>{he ? 'עבודה' : 'Job'}</th><th>{he ? 'מתוזמן' : 'Schedule'}</th><th>{he ? 'ריצה אחרונה' : 'Last run'}</th><th>{he ? 'תוצאה' : 'Result'}</th><th>{he ? 'משך' : 'Duration'}</th><th>{he ? 'שגיאה אחרונה' : 'Last error'}</th><th style={{ width: 120 }}></th>
            </tr></thead>
            <tbody>
              {names.map((j) => {
                const list = by[j.name] || [];
                const last = lastOf(j.name);
                const lastErr = list.find((r) => r.status === 'error') || status[j.name]?.lastError;
                const isOpen = open === j.name;
                return (
                  <React.Fragment key={j.name}>
                    <tr onClick={() => setOpen(isOpen ? '' : j.name)} style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 600 }}>{he ? j.he : j.name}<div><Mono style={{ color: 'var(--text-3)', fontSize: 10 }}>{j.name}</Mono></div></td>
                      <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{j.when}</td>
                      <td style={{ fontSize: 12 }} title={last ? fmtDateTime(toDate(last.startedAt)) : ''}>{ago(toDate(last?.startedAt), he)}{last?.trigger === 'manual' && <span style={{ color: 'var(--text-3)' }}> · {he ? 'ידני' : 'manual'}</span>}</td>
                      <td>{last ? <Badge status={statusOf(last)} he={he} /> : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                      <td><Mono>{dur(last?.durationMs)}</Mono></td>
                      <td style={{ fontSize: 11, color: 'var(--red)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lastErr?.error || ''}>{lastErr ? `${ago(toDate(lastErr.startedAt), he)}: ${lastErr.error}` : ''}</td>
                      <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'end' }}>
                        {j.run && <button className="btn btn-secondary btn-sm" disabled={!!starting} onClick={() => start(j)} style={{ height: 30 }}>{starting === j.run ? '…' : (he ? 'הרץ עכשיו' : 'Run now')}</button>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr><td colSpan={7} style={{ background: 'var(--surface-1)', padding: 12 }}>
                        {!list.length ? <span style={{ color: 'var(--text-3)' }}>{he ? 'עדיין לא רץ.' : 'Has not run yet.'}</span> : list.slice(0, 10).map((r) => (
                          <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '130px 70px 60px 1fr', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--rule)', fontSize: 12, alignItems: 'start' }}>
                            <Mono>{fmtDateTime(toDate(r.startedAt))}</Mono>
                            <Badge status={r.status} he={he} />
                            <Mono>{dur(r.durationMs)}</Mono>
                            <div style={{ color: 'var(--text-2)', wordBreak: 'break-word' }}>
                              {r.error && <div style={{ color: 'var(--red)' }}>{r.error}</div>}
                              {r.summary && <Mono style={{ fontSize: 11 }}>{JSON.stringify(r.summary).slice(0, 400)}</Mono>}
                              {Array.isArray(r.notes) && r.notes.length > 0 && <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>{r.notes.slice(-6).join(' · ')}</div>}
                            </div>
                          </div>
                        ))}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Quotas ───────────────────────────────────────────────────────
const plain = (n) => Number(n).toLocaleString();
// A gauge without its card: the label, the numbers, the bar and a line under it.
function GaugeBody({ used, limit, label, sub, warnAt = 0.8, format = plain, mark = null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const color = !limit ? 'var(--text-3)' : used >= limit ? 'var(--red)' : pct >= warnAt * 100 ? 'var(--amber)' : 'var(--green-ok)';
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>{label}{mark}</div>
        <Mono style={{ color, whiteSpace: 'nowrap' }}>{limit ? `${format(used)} / ${format(limit)}` : format(used)}</Mono>
      </div>
      <div style={{ height: 6, background: 'var(--surface-3)', marginTop: 10 }}><div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width var(--trans)' }} /></div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>{sub}</div>}
    </>
  );
}
const Gauge = (props) => <Card><GaugeBody {...props} /></Card>;

// What Golda's model calls cost today, against the daily ceiling on the work
// she starts by herself (scouting, research and the like): one row across
// the grid, the gauge and the ceiling on one side, where the money went on
// the other. The numbers come from the golda-cost function; the ceiling is
// the one thing set here.
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const COST_KINDS = [['chat', 'Chats'], ['briefing', 'Briefings'], ['scouting', 'Scouting'], ['radar', 'Radar'], ['research', 'Research'], ['review', 'Reviews'], ['deal', 'Deal work'], ['other', 'Other work']];
const WIDE = { gridColumn: '1 / -1' };
const CostRow = ({ label, value, note, strong, first }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, padding: '6px 0', borderTop: first ? 'none' : '1px solid var(--rule)', fontSize: 12.5 }}>
    <span style={{ color: strong ? 'var(--text-1)' : 'var(--text-2)', fontWeight: strong ? 600 : 400 }}>{label}{note && <span style={{ color: 'var(--text-3)', marginInlineStart: 6 }}>{note}</span>}</span>
    <Mono>{value}</Mono>
  </div>
);
function GoldaCost() {
  const [meter, setMeter] = useState(null);
  const [cap, setCap] = useState('');
  const [saving, setSaving] = useState(false);
  const take = (m) => { setMeter(m); setCap(String(m.capUsd)); };
  useEffect(() => { fetchGoldaCost().then(take).catch((e) => setMeter({ error: e.message })); }, []);
  const title = t("Golda's own work today");
  if (!meter) return <Card style={WIDE}><div style={{ fontWeight: 700, marginBottom: 10 }}>{title}</div><Skeleton rows={3} height={18} /></Card>;
  if (meter.error) return <Card style={WIDE}><div style={{ fontWeight: 700 }}>{title}</div><div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>{t('Could not read what Golda cost today.')}</div></Card>;
  const { today, capUsd, capMax } = meter;
  const off = capUsd <= 0;
  const asked = cap.trim() === '' ? NaN : Number(cap);
  const valid = Number.isFinite(asked) && asked >= 0 && asked <= capMax;
  const save = async () => {
    if (!valid) { toast.error(t('Enter a number from 0 to {max}.', { max: capMax })); return; }
    setSaving(true);
    try { take(await saveGoldaCostCap(asked)); toast.success(t('The ceiling is saved.')); }
    catch (e) { toast.error(e.message); }
    setSaving(false);
  };
  const calls = (n) => (n === 1 ? t('One call') : t('{n} calls', { n }));
  const kinds = COST_KINDS.filter(([k]) => today.byKind?.[k]?.calls);
  const stopped = off ? t('Switched off') : today.capped ? t('Stopped until tomorrow') : '';
  return (
    <Card style={WIDE}>
      <div style={{ display: 'grid', gap: '16px 40px', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', alignItems: 'start' }}>
        <div>
          <GaugeBody label={title} used={today.backgroundUsd} limit={capUsd} format={usd}
            mark={stopped && <span style={{ display: 'inline-block', marginInlineStart: 8, padding: '2px 8px', fontSize: 11, fontWeight: 700, color: off ? 'var(--text-2)' : 'var(--red)', background: off ? 'var(--surface-3)' : 'var(--red-bg)' }}>{stopped}</span>}
            sub={off ? t('The ceiling is 0, so Golda starts no work by herself. Chats and briefings go on as usual.') : t('Scouting, research and the other work Golda starts by herself stop for the day once they reach the ceiling. Chats and briefings are never stopped.')} />
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label={t('Daily ceiling, in dollars')} hint={t('From 0 to {max}. At 0 Golda starts no work by herself.', { max: capMax })}>
                <input type="number" inputMode="decimal" min="0" max={capMax} step="0.5" value={cap} aria-invalid={!valid} onChange={(e) => setCap(e.target.value)} />
              </Field>
            </div>
            <button className="btn btn-primary btn-sm" disabled={saving || !valid || asked === capUsd} onClick={save} style={{ height: 40, flex: 'none', marginTop: 24 }}>{saving ? '…' : t('Save')}</button>
          </div>
        </div>
        <div>
          <CostRow first strong label={t('Everything today, chats included')} value={usd(today.totalUsd)} />
          {kinds.map(([k, label]) => <CostRow key={k} label={t(label)} note={calls(today.byKind[k].calls)} value={usd(today.byKind[k].usd)} />)}
          <CostRow label={t('Last {n} days', { n: meter.days.length })} value={usd(meter.periodUsd)} />
          {today.estimatedCalls > 0 && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 8 }}>{t('{n} calls ran on a model with no price in the table and count as 0.', { n: today.estimatedCalls })}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>{t('An estimate from the list prices of {date}, not an invoice.', { date: String(meter.pricesAsOf || '').split('-').reverse().join('/') })}</div>
        </div>
      </div>
    </Card>
  );
}

function Quotas({ he }) {
  const [scraper, setScraper] = useState(null);
  const [meta, setMeta] = useState(null);
  const [deploys, setDeploys] = useState(null);
  const [golda, setGolda] = useState(null);
  const [form, setForm] = useState(null);
  useEffect(() => { fetchScraperStatus().then(setScraper).catch((e) => setScraper({ error: e.message })); }, []);
  useEffect(() => listenTmWatchMeta(setMeta), []);
  useEffect(() => listenDeploys(setDeploys), []);
  useEffect(() => listenGoldaUsage(setGolda), []);
  useEffect(() => { if (meta && !form) setForm({ creditBudget: meta.creditBudget ?? 150, creditReserve: meta.creditReserve ?? 40 }); }, [meta]); // eslint-disable-line
  const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  const deployCount = deploys ? (deploys[month] || 0) : 0;
  const save = async () => {
    try { await saveTmWatchBudget(form); toast.success(he ? 'התקציב נשמר.' : 'Budget saved.'); }
    catch (e) { toast.error(e.message); }
  };
  if (!meta || !deploys || !golda) return <Skeleton rows={4} />;
  const reset = scraper?.nextReset ? scraper.nextReset.split('-').reverse().join('/') : '';
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
      <Gauge label={he ? 'קרדיטים ScraperAPI' : 'ScraperAPI credits'} used={scraper?.requestCount || 0} limit={scraper?.requestLimit || 0}
        sub={scraper?.error ? (he ? 'לא ניתן לקרוא את החשבון.' : 'Could not read the account.') : reset ? (he ? `מתאפס ב-${reset}. משמש רק את מעקב Transfermarkt.` : `Resets on ${reset}. Used only by TM Watch.`) : ''} />
      <Gauge label={he ? 'פריסות Netlify החודש' : 'Netlify production deploys this month'} used={deployCount} limit={0}
        sub={he ? `כל פריסה לייצור עולה כ-15 קרדיטים: כ-${deployCount * 15} קרדיטים החודש. לכן כל שלב עולה במיזוג אחד.` : `Each production deploy costs about 15 credits: about ${deployCount * 15} this month. That is why each phase ships as one merge.`} />
      <Gauge label={he ? 'הודעות לגולדה היום' : 'Golda messages today'} used={golda.count} limit={150 * Math.max(1, golda.sessions)}
        sub={he ? `${golda.sessions} שיחות · ${(golda.inputTokens + golda.outputTokens).toLocaleString()} טוקנים · המכסה היא 150 הודעות לאדם ביום.` : `${golda.sessions} conversations · ${(golda.inputTokens + golda.outputTokens).toLocaleString()} tokens · 150 messages per person per day.`} />
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>{he ? 'תקציב מעקב Transfermarkt' : 'TM Watch credit budget'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>{he ? 'כמה קרדיטים מותר לריצה אחת להוציא, וכמה חייבים להישאר בחשבון (סנכרון המשחקים שומר לעצמו 200 בכל מקרה).' : 'How many credits one run may spend and how many must stay in the account (the matches sync always keeps 200 for itself).'}</div>
        {form && (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
            <Field label={he ? 'תקציב לריצה' : 'Per run'}><input type="number" min="0" value={form.creditBudget} onChange={(e) => setForm({ ...form, creditBudget: e.target.value })} /></Field>
            <Field label={he ? 'רזרבה' : 'Reserve'}><input type="number" min="0" value={form.creditReserve} onChange={(e) => setForm({ ...form, creditReserve: e.target.value })} /></Field>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button className="btn btn-primary btn-sm" onClick={save} style={{ height: 32 }}>{t('Save')}</button></div>
      </Card>
      <GoldaCost />
    </div>
  );
}

// ── Backups ──────────────────────────────────────────────────────
const RECORD_HE = { players: 'שחקן', clubs: 'מועדון', contacts: 'איש קשר', deals: 'עסקה', club_requirements: 'דרישת מועדון', tasks: 'משימה', matches: 'משחק', trainings: 'אימון', meetings: 'פגישה', interactions: 'שיחה' };
const isGood = (b) => ['ok', 'done', 'partial'].includes(b.status) && b.verified !== false;

// Restore from one backup: find a record by name and put it back as it was,
// or put everything back. Both run in the background and leave a line in
// the audit log; the result shows on the Backups tab.
function RestoreDialog({ backup, he, onClose, confirm }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [legacy, setLegacy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState('');
  const when = fmtDateTime(toDate(backup.startedAt));
  useEffect(() => {
    const words = q.trim();
    if (words.length < 2) { setFound(null); setSearching(false); return undefined; }
    let live = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try { const r = await findInBackup(backup.id, words); if (live) { setFound(r.records || []); setLegacy(!!r.legacy); } }
      catch (e) { if (live) { setFound(null); toast.error(e.message); } }
      if (live) setSearching(false);
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [q, backup.id]);
  const one = async (r) => {
    const label = r.name || r.id;
    if (!(await confirm(he ? `להחזיר את "${label}" למצב שהיה בגיבוי מ-${when}? שינויים שנעשו ברשומה הזו אחרי הגיבוי יוחלפו. שאר המערכת לא משתנה.` : `Put "${label}" back as it was in the backup of ${when}? Changes made to this record since then are replaced. Nothing else changes.`, { title: he ? 'שחזור רשומה' : 'Restore a record', confirmLabel: he ? 'שחזר' : 'Restore' }))) return;
    setBusy(r.path);
    try { await restoreRecord(backup.id, r.path); toast.success(he ? `השחזור של "${label}" התחיל. התוצאה תופיע במסך הגיבויים בתוך דקה.` : `Restoring "${label}"; the result shows on the Backups tab within a minute.`); onClose(); }
    catch (e) { toast.error(e.message); }
    setBusy('');
  };
  const all = async () => {
    if (!(await confirm(he ? `להחזיר את כל המערכת למצב שהיה בגיבוי מ-${when}? כל שינוי שנעשה מאז ברשומות שהיו בגיבוי יוחלף. רשומות שנוספו אחרי הגיבוי נשארות, והחיבורים של המערכת (וואטסאפ, יומן, יוטיוב) לא משתנים. לפני השחזור נעשה גיבוי של המצב הנוכחי, כך שאפשר לחזור גם ממנו.` : `Put the whole system back as it was in the backup of ${when}? Every change made since to records that were in the backup is replaced. Records added after it stay, and the system's connections do not change. The current state is backed up first, so this too can be undone.`, { title: he ? 'שחזור של כל המערכת' : 'Restore everything', confirmLabel: he ? 'שחזר הכל' : 'Restore everything' }))) return;
    setBusy('all');
    try { await restoreEverything({ backupId: backup.id }); toast.success(he ? 'השחזור המלא התחיל. זה לוקח כמה דקות והתוצאה תופיע במסך הגיבויים.' : 'The full restore started. It takes a few minutes; the result shows on the Backups tab.'); onClose(); }
    catch (e) { toast.error(e.message); }
    setBusy('');
  };
  return (
    <Modal title={he ? `שחזור מהגיבוי של ${when}` : `Restore from the backup of ${when}`} onClose={onClose} viewOnly>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label={he ? 'רשומה אחת' : 'One record'} hint={he ? 'שם של שחקן, מועדון, איש קשר, עסקה, משימה או פגישה. הרשומה חוזרת כמו שהייתה בגיבוי, עם הקבצים שלה.' : 'The name of a player, club, contact, deal, task or meeting. It comes back as it was in the backup, with its files.'}>
          <div style={{ width: 'fit-content', maxWidth: '100%' }}><SearchInput value={q} onChange={setQ} placeholder={he ? 'חיפוש לפי שם' : 'Search by name'} /></div>
        </Field>
        {legacy && <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{he ? 'זה גיבוי ישן וגדול, ואי אפשר לחפש בו רשומה אחת. אפשר לשחזר ממנו את הכל, או לבחור גיבוי חדש יותר.' : 'This is an older, large backup that cannot be searched for one record. Restore everything from it, or pick a newer backup.'}</div>}
        {searching && !legacy && <Skeleton rows={2} height={36} />}
        {!searching && found && !legacy && (found.length ? (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>{found.map((r, i) => (
            <div key={r.path} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderTop: i ? '1px solid var(--rule)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{r.name || <Mono style={{ color: 'var(--text-3)' }}>{r.id.slice(0, 8)}</Mono>}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{he ? (RECORD_HE[r.collection] || r.collection) : r.collection}</div>
              <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => one(r)} style={{ height: 30 }}>{busy === r.path ? '…' : (he ? 'שחזר' : 'Restore')}</button>
            </div>
          ))}</div>
        ) : <Empty message={he ? 'אין בגיבוי הזה רשומה בשם הזה.' : 'No record by that name in this backup.'} />)}
        <div style={{ borderTop: '1px solid var(--border-2)', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', flex: '1 1 240px' }}>{he ? 'או להחזיר את כל המערכת למצב שהיה בגיבוי הזה. המצב הנוכחי מגובה קודם.' : 'Or put the whole system back as it was in this backup. The current state is backed up first.'}</div>
          <button className="btn btn-danger" disabled={!!busy} onClick={all} style={{ height: 36 }}>{busy === 'all' ? '…' : (he ? 'שחזר הכל' : 'Restore everything')}</button>
        </div>
      </div>
    </Modal>
  );
}

function Backups({ he }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState('');
  const [restoring, setRestoring] = useState(null);
  const [status, setStatus] = useState({});
  const [copies, setCopies] = useState(null);
  const { confirm, dialog } = useConfirm();
  useEffect(() => listenBackups(setList), []);
  useEffect(() => listenJobStatus(setStatus), []);
  // The copies outside the database matter when the database has no backup to show.
  const empty = !!list && !list.length;
  useEffect(() => { if (empty) fetchOffsiteCopies().then((r) => setCopies(r.copies || [])).catch(() => setCopies([])); }, [empty]);
  const backupNow = async () => {
    if (!(await confirm(he ? 'לגבות את כל המערכת עכשיו? זה לוקח כמה דקות ומופיע כאן כשמסתיים.' : 'Back up everything now? It takes a few minutes and appears here when done.', { title: he ? 'גיבוי' : 'Back up', confirmLabel: he ? 'גבה' : 'Back up' }))) return;
    setBusy('new');
    try { await runJobNow('backup'); toast.success(he ? 'הגיבוי התחיל.' : 'Backup started.'); } catch (e) { toast.error(e.message); }
    setBusy('');
  };
  const download = async (b) => {
    setBusy(b.id);
    try { const r = await downloadBackup(b); toast.success(he ? `הקובץ ${r.name} ירד.` : `${r.name} downloaded.`); } catch (e) { toast.error(e.message); }
    setBusy('');
  };
  const fromCopy = async (c) => {
    if (!(await confirm(he ? `להחזיר את כל המערכת מהעותק החיצוני של ${c.date}? רשומות קיימות שהיו בעותק יוחלפו, ורשומות שנוספו אחריו נשארות.` : `Put the whole system back from the outside copy of ${c.date}? Existing records that were in the copy are replaced; records added after it stay.`, { title: he ? 'שחזור מעותק חיצוני' : 'Restore from an outside copy', confirmLabel: he ? 'שחזר הכל' : 'Restore everything' }))) return;
    setBusy(c.key);
    try { await restoreEverything({ offsiteKey: c.key }); toast.success(he ? 'השחזור המלא התחיל. התוצאה תופיע כאן.' : 'The full restore started; the result shows here.'); } catch (e) { toast.error(e.message); }
    setBusy('');
  };
  if (!list) return <Skeleton rows={4} />;
  const restore = status['backup-restore'] || {};
  const lastRestore = restore.runningSince ? { status: 'running', startedAt: restore.runningSince } : restore.last;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {dialog}
      {restoring && <RestoreDialog backup={restoring} he={he} confirm={confirm} onClose={() => setRestoring(null)} />}
      <Card style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', flex: '1 1 320px' }}>
          {he ? 'גיבוי אוטומטי פעם בשבוע; אם לילה נכשל, המערכת מנסה שוב בלילה שאחריו. 8 הגיבויים התקינים האחרונים נשמרים. כל גיבוי נקרא בחזרה ונבדק, ועותק שלו נשמר גם מחוץ למסד הנתונים.' : 'An automatic backup once a week; a night that fails is retried the next night. The last 8 good backups are kept. Each one is read back and checked, and a copy is kept outside the database.'}
          {lastRestore && <div style={{ marginTop: 6 }}>{he ? 'שחזור אחרון' : 'Last restore'}: {ago(toDate(lastRestore.startedAt), he)} <Badge status={statusOf(lastRestore)} he={he} />{lastRestore.error && <span style={{ color: 'var(--red)', fontSize: 11, marginInlineStart: 6 }}>{lastRestore.error}</span>}</div>}
        </div>
        <button className="btn btn-primary" onClick={backupNow} disabled={!!busy} style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">{he ? 'גבה עכשיו' : 'Back up now'}</span></button>
      </Card>
      {!list.length ? <Empty message={he ? 'אין גיבויים עדיין.' : 'No backups yet.'} /> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}><div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{he ? 'תאריך' : 'Date'}</th><th>{he ? 'מצב' : 'Status'}</th><th>{he ? 'מסמכים' : 'Documents'}</th><th>{he ? 'גודל' : 'Size'}</th><th>{he ? 'אוספים' : 'Collections'}</th><th style={{ width: 190 }}></th></tr></thead>
            <tbody>{list.map((b) => {
              const st = statusOf(b);
              return (
                <tr key={b.id}>
                  <td><Mono>{fmtDateTime(toDate(b.startedAt))}</Mono></td>
                  <td title={b.error || b.offsiteError || ''}>
                    <Badge status={st === 'done' || st === 'ok' || st === 'partial' ? 'ok' : st === 'error' ? 'error' : st} he={he} />
                    {(b.partial || b.status === 'partial') && <span style={{ color: 'var(--amber)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'חלקי' : 'partial'}</span>}
                    {b.verified === true && <span style={{ color: 'var(--green-ok)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'נבדק' : 'checked'}</span>}
                    {b.offsite && <span style={{ color: 'var(--text-3)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'עותק חיצוני' : 'outside copy'}</span>}
                    {b.verified === true && !b.offsite && b.offsiteError && <span style={{ color: 'var(--amber)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'בלי עותק חיצוני' : 'no outside copy'}</span>}
                    {b.reason === 'before-restore' && <span style={{ color: 'var(--text-3)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'לפני שחזור' : 'before a restore'}</span>}
                    {b.reason === 'before-migration' && <span style={{ color: 'var(--text-3)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'לפני מיגרציה' : 'before a migration'}</span>}
                  </td>
                  <td><Mono>{(b.docs || 0).toLocaleString()}</Mono></td>
                  <td><Mono>{b.chars ? `${(b.chars / 1048576).toFixed(1)} MB` : ''}</Mono></td>
                  <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{(b.collections || []).length}</td>
                  <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>{b.chunks > 0 && (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {isGood(b) && <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => setRestoring(b)} style={{ height: 30 }}>{he ? 'שחזר' : 'Restore'}</button>}
                      <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => download(b)} style={{ height: 30 }}>{busy === b.id ? '…' : (he ? 'הורד' : 'Download')}</button>
                    </span>
                  )}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div></div>
      )}
      {empty && copies && copies.length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{he ? 'עותקים מחוץ למסד הנתונים' : 'Copies outside the database'}</div>
          <div style={{ display: 'grid', gap: 8 }}>{copies.map((c) => (
            <div key={c.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <Mono>{c.date}</Mono>
              <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => fromCopy(c)} style={{ height: 30 }}>{busy === c.key ? '…' : (he ? 'שחזר הכל' : 'Restore everything')}</button>
            </div>
          ))}</div>
        </Card>
      )}
    </div>
  );
}

// ── Audit ────────────────────────────────────────────────────────
const ACTION_HE = { create: 'יצירה', update: 'עדכון', delete: 'מחיקה', restore: 'שחזור', purge: 'מחיקה לצמיתות' };
function Audit({ he }) {
  const [rows, setRows] = useState(null);
  const [via, setVia] = useState('all');
  const [action, setAction] = useState('all');
  const [q, setQ] = useState('');
  useEffect(() => listenAudit(setRows), []);
  const list = useMemo(() => (rows || []).filter((r) =>
    (via === 'all' || (r.via || 'web') === via)
    && (action === 'all' || r.action === action)
    && (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))), [rows, via, action, q]);
  if (!rows) return <Skeleton rows={8} />;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <ChipGroup options={['all', 'web', 'golda']} labels={[he ? 'הכל' : 'All', he ? 'אפליקציה' : 'App', 'גולדה']} value={via} onChange={setVia} required />
        <ChipGroup options={['all', 'create', 'update', 'delete', 'restore']} labels={[he ? 'כל הפעולות' : 'All actions', ...['create', 'update', 'delete', 'restore'].map((a) => (he ? ACTION_HE[a] : a))]} value={action} onChange={setAction} required />
        <div style={{ flex: 1, minWidth: 200 }}><SearchInput value={q} onChange={setQ} placeholder={he ? 'חיפוש בשם, אוסף או מזהה' : 'Search by name, collection or id'} /></div>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{list.length} / {rows.length}</span>
      </Card>
      {!list.length ? <Empty message={he ? 'אין רשומות.' : 'No entries.'} /> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}><div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{he ? 'מתי' : 'When'}</th><th>{he ? 'מי' : 'Who'}</th><th>{he ? 'פעולה' : 'Action'}</th><th>{he ? 'אוסף' : 'Collection'}</th><th>{he ? 'רשומה' : 'Record'}</th><th>{he ? 'פרטים' : 'Details'}</th></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.id}>
                <td><Mono>{fmtDateTime(toDate(r.at))}</Mono></td>
                <td style={{ fontSize: 12 }}>{r.via === 'golda' ? <>גולדה <span style={{ color: 'var(--text-3)' }}>({r.onBehalfOfName || r.onBehalfOf || r.byName || ''})</span></> : (r.byName || r.by || '')}</td>
                <td><span style={{ fontSize: 11, fontWeight: 700, color: r.action === 'delete' || r.action === 'purge' ? 'var(--red)' : r.action === 'create' ? 'var(--green-ok)' : 'var(--text-2)' }}>{he ? (ACTION_HE[r.action] || r.action) : r.action}</span>{r.undone && <span style={{ fontSize: 10, color: 'var(--text-3)', marginInlineStart: 6 }}>{he ? 'בוטל' : 'undone'}</span>}</td>
                <td><Mono>{r.collection}</Mono></td>
                <td style={{ fontSize: 12 }}>{r.docName || r.name || <Mono style={{ color: 'var(--text-3)' }}>{String(r.docId || '').slice(0, 8)}</Mono>}</td>
                <td style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={JSON.stringify(r.changes || r.fields || r.before || '')}>
                  {r.summary || (Array.isArray(r.fields) ? r.fields.join(', ') : r.changes ? Object.keys(r.changes).join(', ') : r.before ? Object.keys(r.before).join(', ') : '')}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      )}
    </div>
  );
}

// ── Errors ───────────────────────────────────────────────────────
function Errors({ he }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState('');
  useEffect(() => listenClientErrors(setRows), []);
  if (!rows) return <Skeleton rows={4} />;
  if (!rows.length) return <Empty message={he ? 'האפליקציה לא דיווחה על שגיאות. 🙂' : 'The app reported no errors. 🙂'} />;
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}><div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>{he ? 'מתי' : 'When'}</th><th>{he ? 'מסך' : 'Screen'}</th><th>{he ? 'הודעה' : 'Message'}</th><th>{he ? 'גרסה' : 'Version'}</th><th>{he ? 'מי' : 'Who'}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <React.Fragment key={r.id}>
            <tr onClick={() => setOpen(open === r.id ? '' : r.id)} style={{ cursor: 'pointer' }}>
              <td><Mono>{fmtDateTime(toDate(r.at))}</Mono></td>
              <td><Mono>{r.screen}</Mono></td>
              <td style={{ fontSize: 12, color: 'var(--red)', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.message}</td>
              <td><Mono style={{ color: r.version === VERSION ? 'var(--text-2)' : 'var(--text-3)' }}>{r.version}</Mono></td>
              <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{r.email || ''}</td>
            </tr>
            {open === r.id && <tr><td colSpan={5} style={{ background: 'var(--surface-1)' }}><pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-2)', direction: 'ltr', textAlign: 'left' }}>{r.stack || r.message}{'\n'}{r.userAgent}</pre></td></tr>}
          </React.Fragment>
        ))}</tbody>
      </table>
    </div></div>
  );
}

// ── WhatsApp ─────────────────────────────────────────────────────
// One button gives the server its own key to Golda's account at Meta; from
// then on the hourly job (meta-onboard) moves her to her number by itself.
const STAGES = {
  not_connected: ['צריך להתחבר עם פייסבוק פעם אחת', 'Needs one Facebook sign-in'],
  needs_code: ['המספר עוד לא אומת בקוד SMS', 'The number still needs its SMS code'],
  waiting_for_meta: ['מחכים לאישור של Meta. בודקים שוב כל שעה, לבד', 'Waiting for Meta’s approval. Checked again every hour, automatically'],
  error: ['תקלה בקריאה מ-Meta', 'Could not read from Meta'],
  no_access: ['למפתח אין גישה לחשבון הוואטסאפ של גולדה. צריך להתחבר שוב ולבחור "Golda - Gold AS"', 'The key cannot see Golda’s WhatsApp account. Sign in again and pick “Golda - Gold AS”'],
  live: ['גולדה פעילה על המספר שלה ✅', 'Golda is live on her own number ✅'],
};
function WhatsApp({ he }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => listenMetaConnect(setD), []);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('meta') === 'ok') toast.success(he ? 'החיבור לפייסבוק הצליח. השרת ממשיך מכאן לבד.' : 'Connected to Facebook. The server takes it from here.');
    if (p.get('meta') === 'error') toast.error((he ? 'החיבור לא הצליח: ' : 'Sign-in failed: ') + (p.get('reason') || ''));
  }, []); // eslint-disable-line
  const connect = async () => {
    setBusy(true);
    try { const { url } = await startMetaConnect(); window.location.assign(url); }
    catch (e) { toast.error(e.message); setBusy(false); }
  };
  if (!d) return <Skeleton rows={3} />;
  const o = d.onboard || {};
  const stage = d.connected ? (o.stage || 'waiting_for_meta') : 'not_connected';
  const label = STAGES[stage] || [stage, stage];
  const exp = d.expiresAt ? new Date(d.expiresAt) : null;
  const seesAccount = d.reachesWaba === true || (o.phone && !o.phone.error) || (o.account && !o.account.error);
  const reconnect = d.connected && (stage === 'no_access' || (d.reachesWaba === false && !seesAccount));
  const row = (k, v) => v ? <div style={{ display: 'flex', gap: 8, fontSize: 13 }}><span style={{ color: 'var(--text-3)', minWidth: 140 }}>{k}</span><span>{v}</span></div> : null;
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>{he ? 'גולדה על המספר 055-295-9496' : 'Golda on 055-295-9496'}</div>
        <div style={{ fontSize: 14, marginBottom: 12 }}>{he ? label[0] : label[1]}</div>
        {(!d.connected || reconnect) && (
          <button className="btn btn-primary" onClick={connect} disabled={busy} style={{ height: 40 }}>
            {busy ? (he ? 'פותח את פייסבוק…' : 'Opening Facebook…') : (he ? 'התחבר עם פייסבוק' : 'Connect with Facebook')}
          </button>
        )}
        {d.connected && !reconnect && exp && exp.getTime() - Date.now() < 10 * 864e5 && (
          <button className="btn btn-ghost btn-sm" onClick={connect} disabled={busy} style={{ height: 32 }}>{he ? 'חדש את החיבור לפייסבוק' : 'Renew the Facebook connection'}</button>
        )}
        {d.lastError?.message && !d.connected && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{d.lastError.message}</div>}
      </Card>
      {d.connected && (
        <Card>
          <div style={{ display: 'grid', gap: 6 }}>
            {row(he ? 'מחובר מאז' : 'Connected', fmtDateTime(new Date(d.connectedAt)))}
            {row(he ? 'תוקף המפתח' : 'Key expires', exp ? fmtDateTime(exp) : (he ? 'לא פג' : 'never'))}
            {row(he ? 'סוג המפתח' : 'Key type', [d.tokenType, seesAccount ? (he ? 'רואה את החשבון של גולדה' : 'sees Golda’s account') : d.reachesWaba === false ? (he ? 'לא רואה את החשבון של גולדה' : 'cannot see Golda’s account') : ''].filter(Boolean).join(' · '))}
            {row(he ? 'בדיקת החשבון ב-Meta' : 'Meta account review', o.account?.review)}
            {row(he ? 'אימות העסק' : 'Business verification', o.account?.businessVerification)}
            {row(he ? 'מצב המספר' : 'Number status', o.phone && !o.phone.error ? `${o.phone.status || ''} · ${o.phone.platform || ''} · ${o.phone.verification || ''}` : '')}
            {row(he ? 'תבניות' : 'Templates', o.templates && !o.templates.error ? Object.entries(o.templates).map(([n, st]) => `${n}: ${st}`).join(' · ') : o.templates?.error)}
            {row(he ? 'תמונת פרופיל' : 'Profile photo', Object.entries(o.photo || {}).map(([id, p]) => `${id === '1410468102146516' ? '055' : (he ? 'המספר הנוכחי' : 'current number')}: ${p.ok ? (he ? 'הוגדרה' : 'set') : `${p.error?.code || ''} ${p.error?.message || ''}`.trim()}`).join(' · '))}
            {row(he ? 'נבדק לאחרונה' : 'Last checked', o.checkedAt ? ago(new Date(o.checkedAt), he) : '')}
            {row(he ? 'תשובת Meta אחרונה' : 'Meta’s last answer', o.lastError ? `${o.lastError.code}${o.lastError.subcode ? `/${o.lastError.subcode}` : ''}: ${o.lastError.message}${o.lastError.details ? ` (${o.lastError.details})` : ''}` : '')}
          </div>
        </Card>
      )}
    </div>
  );
}
