// Admin: the data migrations of the new model. Shows the dry-run report
// (what would be created, how club names were matched) and lets the admin
// run pending migrations now; production deploys also run them on their own.
import React, { useState, useEffect } from 'react';
import { callFunctionJson } from 'lib/api';
import { PageHeader, Spinner, toast, useConfirm } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';
import { t } from 'lib/i18n';

export default function Migrations() {
  const { isAdmin } = useRole();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const { confirm, dialog } = useConfirm();

  const load = async () => {
    setError(''); setReport(null);
    try { setReport(await callFunctionJson('migrate', { query: { dry: '1' } })); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  // The run happens in a background function; poll its recorded status.
  const run = async () => {
    if (!(await confirm(t("Run the pending migrations now? A full backup is written first."), { confirmLabel: t("Run") }))) return;
    setRunning(true);
    try {
      const r = await callFunctionJson('migrate', { method: 'POST' });
      if (!r.started) { toast.info(t("Nothing pending.")); setRunning(false); return load(); }
      toast.success(t("Started. A backup is written first; this screen refreshes on its own."));
      for (let i = 0; i < 180; i++) {
        await new Promise((res) => setTimeout(res, 5000));
        const s = await callFunctionJson('migrate');
        const rows = s.migrations || [];
        if (!rows.some((m) => m.status === 'running') && (rows.every((m) => m.status === 'done') || rows.some((m) => m.status === 'error') || i > 2)) {
          if (rows.every((m) => m.status === 'done')) break;
          if (rows.some((m) => m.status === 'error')) { toast.error(t("A migration failed; see its row.")); break; }
        }
      }
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setRunning(false); }
  };

  if (!isAdmin) return null;
  const pending = (report?.migrations || []).filter((m) => m.status === 'pending');
  return (
    <div>
      <PageHeader title={t("Data Migrations")} subtitle={t("Moves the records onto the new model. Idempotent: each step runs once.")}
        action={<div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={load} style={{ height: 36 }}>{t("Refresh")}</button>
          {pending.length > 0 && <button className="btn btn-primary" onClick={run} disabled={running} style={{ height: 36 }}>{running ? 'Running...' : `Run ${pending.length} pending`}</button>}
        </div>} />
      {error && <div className="card" style={{ padding: 14, color: 'var(--red)' }}>{error}</div>}
      {!report && !error && <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>}
      {report && (report.migrations || []).map((m) => (
        <div key={m.id} className="card" style={{ padding: 16, marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 700 }}>{m.id} <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>{m.title}</span></div>
            <span style={{ fontSize: 11, fontWeight: 700, color: m.status === 'done' ? '#4ADE80' : m.status === 'pending' ? 'var(--gold)' : 'var(--red)' }}>{m.status}{m.ranAt ? ` · ${new Date(m.ranAt).toLocaleString('he-IL')}` : ''}</span>
          </div>
          {m.report && <Report r={m.report} />}
        </div>
      ))}
      {dialog}
    </div>
  );
}

function Report({ r }) {
  return (
    <div style={{ marginTop: 10, fontSize: 12 }}>
      {r.summary && <div style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{r.summary}</div>}
      {Array.isArray(r.groups) && r.groups.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{t("Club names that will be merged into one club (")}{r.groups.length}):</div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t("Club")}</th><th>{t("Spellings found")}</th><th>{t("Mentions")}</th></tr></thead>
            <tbody>{r.groups.map((g) => (
              <tr key={g.key}><td style={{ fontWeight: 600 }}>{g.name}</td><td style={{ color: 'var(--text-2)' }}>{g.variants.join(' · ')}</td><td>{g.count}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
      {Array.isArray(r.notes) && r.notes.length > 0 && <ul style={{ marginTop: 8, color: 'var(--text-3)', paddingInlineStart: 18 }}>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </div>
  );
}
