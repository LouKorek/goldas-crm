/* global __BUILD_ID__ */
// The admin area, admin only: five tabs that show what the system did and
// let the admin act without a terminal.
//   Health   every night job: last run, result, duration, last error, "run now"
//   Quotas   ScraperAPI credits, Netlify deploys this month, Golda's usage
//            today, the TM Watch credit budget (editable)
//   Backups  the weekly backups, "back up now", download as a file
//   Audit    every change anyone (or Golda) made, with filters
//   Errors   what the app itself reported from people's browsers
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRole } from 'lib/roleContext';
import { t, fmtDateTime, getLang } from 'lib/i18n';
import { PageHeader, Skeleton, Empty, ChipGroup, Field, SearchInput, toast, useConfirm } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import {
  JOBS, listenJobs, runJobNow, groupRuns, fetchScraperStatus, listenTmWatchMeta, saveTmWatchBudget, listenDeploys,
  listenGoldaUsage, listenBackups, downloadBackup, listenAudit, listenClientErrors,
} from 'data/admin';

const VERSION = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
const TABS = [['health', 'בריאות', 'Health'], ['quotas', 'מכסות', 'Quotas'], ['backups', 'גיבויים', 'Backups'], ['audit', 'יומן פעולות', 'Audit log'], ['errors', 'שגיאות', 'Errors']];
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
};
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
    </div>
  );
}

// ── Health ───────────────────────────────────────────────────────
function Health({ he }) {
  const [runs, setRuns] = useState(null);
  const [starting, setStarting] = useState('');
  const [open, setOpen] = useState('');
  useEffect(() => listenJobs(setRuns), []);
  const by = useMemo(() => groupRuns(runs || []), [runs]);
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
  const failing = names.filter((j) => (by[j.name] || [])[0]?.status === 'error');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, background: failing.length ? 'var(--red)' : 'var(--green-ok)', flexShrink: 0 }} />
        <div style={{ fontWeight: 700 }}>{failing.length ? (he ? `${failing.length} עבודות נכשלו בריצה האחרונה` : `${failing.length} jobs failed on their last run`) : (he ? 'כל העבודות הצליחו בריצה האחרונה' : 'Every job succeeded on its last run')}</div>
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{he ? 'גרסה' : 'Version'} <Mono>{VERSION}</Mono> · {runs.length} {he ? 'ריצות ב-60 הימים האחרונים' : 'runs in the last 60 days'}</div>
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
                const last = list[0];
                const lastErr = list.find((r) => r.status === 'error');
                const isOpen = open === j.name;
                return (
                  <React.Fragment key={j.name}>
                    <tr onClick={() => setOpen(isOpen ? '' : j.name)} style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 600 }}>{he ? j.he : j.name}<div><Mono style={{ color: 'var(--text-3)', fontSize: 10 }}>{j.name}</Mono></div></td>
                      <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{j.when}</td>
                      <td style={{ fontSize: 12 }} title={last ? fmtDateTime(toDate(last.startedAt)) : ''}>{ago(toDate(last?.startedAt), he)}{last?.trigger === 'manual' && <span style={{ color: 'var(--text-3)' }}> · {he ? 'ידני' : 'manual'}</span>}</td>
                      <td>{last ? <Badge status={last.status} he={he} /> : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
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
function Gauge({ used, limit, label, sub, warnAt = 0.8 }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const color = !limit ? 'var(--text-3)' : used >= limit ? 'var(--red)' : pct >= warnAt * 100 ? 'var(--amber)' : 'var(--green-ok)';
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>{label}</div>
        <Mono style={{ color }}>{limit ? `${Number(used).toLocaleString()} / ${Number(limit).toLocaleString()}` : Number(used).toLocaleString()}</Mono>
      </div>
      <div style={{ height: 6, background: 'var(--surface-3)', marginTop: 10 }}><div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width var(--trans)' }} /></div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>{sub}</div>}
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
    </div>
  );
}

// ── Backups ──────────────────────────────────────────────────────
function Backups({ he }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState('');
  const { confirm, dialog } = useConfirm();
  useEffect(() => listenBackups(setList), []);
  const backupNow = async () => {
    if (!(await confirm(he ? 'לגבות את כל המערכת עכשיו? זה לוקח כמה דקות ומופיע כאן כשמסתיים.' : 'Back up everything now? It takes a few minutes and appears here when done.', { confirmLabel: he ? 'גבה' : 'Back up' }))) return;
    setBusy('new');
    try { await runJobNow('backup'); toast.success(he ? 'הגיבוי התחיל.' : 'Backup started.'); } catch (e) { toast.error(e.message); }
    setBusy('');
  };
  const download = async (b) => {
    setBusy(b.id);
    try { const r = await downloadBackup(b); toast.success(he ? `הקובץ ${r.name} ירד.` : `${r.name} downloaded.`); } catch (e) { toast.error(e.message); }
    setBusy('');
  };
  if (!list) return <Skeleton rows={4} />;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {dialog}
      <Card style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{he ? 'גיבוי שבועי אוטומטי בכל יום ראשון, 8 הגיבויים האחרונים נשמרים. השחזור מתועד ב-docs/runbooks.md.' : 'An automatic weekly backup every Sunday; the last 8 are kept. Restore is documented in docs/runbooks.md.'}</div>
        <button className="btn btn-primary" onClick={backupNow} disabled={!!busy} style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">{he ? 'גבה עכשיו' : 'Back up now'}</span></button>
      </Card>
      {!list.length ? <Empty message={he ? 'אין גיבויים עדיין.' : 'No backups yet.'} /> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}><div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>{he ? 'תאריך' : 'Date'}</th><th>{he ? 'מצב' : 'Status'}</th><th>{he ? 'מסמכים' : 'Documents'}</th><th>{he ? 'גודל' : 'Size'}</th><th>{he ? 'אוספים' : 'Collections'}</th><th style={{ width: 110 }}></th></tr></thead>
            <tbody>{list.map((b) => (
              <tr key={b.id}>
                <td><Mono>{fmtDateTime(toDate(b.startedAt))}</Mono></td>
                <td><Badge status={b.status === 'done' || b.status === 'ok' ? 'ok' : b.status === 'error' ? 'error' : 'running'} he={he} />{b.partial && <span style={{ color: 'var(--amber)', fontSize: 11, marginInlineStart: 6 }}>{he ? 'חלקי' : 'partial'}</span>}</td>
                <td><Mono>{(b.docs || 0).toLocaleString()}</Mono></td>
                <td><Mono>{b.chars ? `${(b.chars / 1048576).toFixed(1)} MB` : ''}</Mono></td>
                <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{(b.collections || []).length}</td>
                <td style={{ textAlign: 'end' }}>{b.chunks > 0 && <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => download(b)} style={{ height: 30 }}>{busy === b.id ? '…' : (he ? 'הורד' : 'Download')}</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
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
