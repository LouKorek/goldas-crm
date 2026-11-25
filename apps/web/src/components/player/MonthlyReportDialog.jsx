import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { monthlyReportFacts, cleanReportText, reportOf, reportMonths, lastFullMonth, monthName, playerName,
  REPORT_DID_MAX_LINES, REPORT_DID_LINE_MAX, REPORT_NEXT_MAX } from '@goldas/domain';
import { PATHS, updateDoc_ } from 'lib/db';
import { t, getLang } from 'lib/i18n';
import { Modal, Field, toast, useConfirm } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { StatTile } from './PlayerCard';

// The monthly report for a represented player and his family: the month's
// numbers and matches exactly as the PDF prints them (no rating, no note,
// no watcher), the two written parts, a draft saved on the player
// (players/{id}.monthlyReports['YYYY-MM'], the same field Golda writes) and
// the PDF in Hebrew or English from the same builder Golda uses.
const formOf = (entry) => ({ did: (entry?.did || []).join('\n'), next: entry?.next || '' });
const day = (d) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
// "64′", "90′ · 1 Goal · 2 assists", or "did not play": as the page prints it, in words.
const count = (n, one, many) => `${n} ${n === 1 ? t(one) : t(many)}`;
const statLine = (m) => (!m.played ? t('did not play')
  : [`${m.minutes}′`, m.goals ? count(m.goals, 'Goal', 'goals') : '', m.assists ? count(m.assists, 'Assist', 'assists') : ''].filter(Boolean).join(' · '));

export default function MonthlyReportDialog({ player, matches, email, onClose }) {
  const navigate = useNavigate();
  const he = getLang() === 'he';
  const months = useMemo(() => reportMonths(), []);
  const [month, setMonth] = useState(() => lastFullMonth());
  const saved = reportOf(player, month);
  const [form, setForm] = useState(() => formOf(reportOf(player, lastFullMonth())));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const facts = useMemo(() => monthlyReportFacts(matches, player.id, month), [matches, player.id, month]);
  const name = playerName(player);
  const text = cleanReportText(form);
  const lines = form.did.split('\n').filter((l) => l.trim()).length;

  const { confirm, dialog } = useConfirm();
  const pick = async (m) => {
    if (dirty && !(await confirm(t('Discard the changes to this month?'), { title: t('Monthly report'), confirmLabel: t('Discard') }))) return;
    setMonth(m);
    setForm(formOf(reportOf(player, m)));
    setDirty(false);
  };
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setDirty(true); };

  const save = async () => {
    if (!text.did.length) { toast.error(t('Write at least one line of what we did.')); return; }
    if (!text.next) { toast.error(t('Write the next step.')); return; }
    setBusy('save');
    try {
      // Changing the text makes it a draft again: Lou approves what goes out.
      const same = saved && JSON.stringify(cleanReportText(saved)) === JSON.stringify(text);
      if (!same) await updateDoc_(PATHS.PLAYERS, player.id, { [`monthlyReports.${month}`]: { ...text, status: 'draft', by: email || '', at: new Date().toISOString() } });
      setDirty(false);
      toast.success(t('Draft saved.'));
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    setBusy('');
  };

  const download = async (lang) => {
    setBusy(lang);
    try {
      const { exportMonthlyReport } = await import('lib/monthlyReport');
      await exportMonthlyReport({ playerName: name, currentClub: player.currentClub || '' }, { ...facts, ...text }, { lang });
    } catch (e) { console.error(e); toast.error(t('Could not build the PDF.')); }
    setBusy('');
  };

  const askGolda = () => navigate('/golda', { state: { tab: 'chat', prefill: he ? `דוח חודשי ל${name} ל${monthName(month, 'he')}` : `Monthly report for ${name} for ${monthName(month, 'en')}` } });
  const status = saved ? (saved.status === 'approved' ? t('Approved') : t('Draft')) : t('Not written yet');
  const t_ = facts.monthTotals;

  return (
    <Modal title={`${t('Monthly report')} · ${name}`} onClose={onClose} isDirty={dirty} onSave={save} wide
      footer={<>
        {/* Short labels, so the three fit a phone's width; the title says it in full. */}
        <button className="btn btn-ghost" onClick={() => download('en')} disabled={!!busy} title={t('PDF (English)')} aria-label={t('PDF (English)')}><Icon name="download" size={12} /> {t('English')}</button>
        <button className="btn btn-secondary" onClick={() => download('he')} disabled={!!busy} title={t('PDF (Hebrew)')} aria-label={t('PDF (Hebrew)')}><Icon name="download" size={12} /> {t('Hebrew')}</button>
        <button className="btn btn-primary" onClick={save} disabled={!!busy}>
          {busy === 'save' ? <><span className="spinner" style={{ width: 14, height: 14 }} /> {t('Saving…')}</> : t('Save draft')}
        </button>
      </>}>
      <Field label={t('Month')}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={month} onChange={(e) => pick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            {months.map((m) => <option key={m} value={m}>{monthName(m, he ? 'he' : 'en')}</option>)}
          </select>
          <span className="badge" style={{ whiteSpace: 'nowrap', background: saved?.status === 'approved' ? 'var(--gold-dim)' : 'var(--surface-2)', color: saved?.status === 'approved' ? 'var(--gold)' : 'var(--text-2)' }}>{status}</span>
        </div>
      </Field>

      <div className="section-label">{t('The month in numbers')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <StatTile compact label={t('Matches')} value={t_.apps} />
        <StatTile compact label={t('Minutes')} value={t_.minutes} />
        <StatTile compact label={t('Goals')} value={t_.goals} />
        <StatTile compact label={t('Assists')} value={t_.assists} />
      </div>
      {facts.season.apps + facts.season.goals + facts.season.assists > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', margin: '6px 0 0' }}>
          {t('Season {s} to the end of the month: {apps} matches · {min} min · {g} goals · {a} assists', { s: facts.season.label, apps: facts.season.apps, min: facts.season.minutes, g: facts.season.goals, a: facts.season.assists })}
        </div>
      )}

      <div className="section-label" style={{ marginTop: 16 }}>{t("This month's matches")}</div>
      {facts.matches.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: 0 }}>{t('No matches of his were recorded this month.')}</p>
      ) : facts.matches.map((m) => (
        <div key={m.matchId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', minWidth: 38 }}>{day(m.date)}</span>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            <span className="bidi">{m.title}</span>
            {m.competition && <span style={{ color: 'var(--text-3)', fontSize: 11.5 }}> · {m.competition}</span>}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{statLine(m)}</span>
        </div>
      ))}

      <div style={{ marginTop: 16 }}>
        <Field label={t('What we did this month')} hint={t('One line per row, up to {n} lines.', { n: REPORT_DID_MAX_LINES })}
          error={lines > REPORT_DID_MAX_LINES ? t('Only the first {n} lines go into the report.', { n: REPORT_DID_MAX_LINES }) : null}>
          <textarea dir="auto" rows={5} value={form.did} onChange={set('did')} maxLength={(REPORT_DID_LINE_MAX + 1) * (REPORT_DID_MAX_LINES + 2)} />
        </Field>
        <Field label={t('The next step')} hint={t('One or two sentences.')}>
          <textarea dir="auto" rows={3} value={form.next} onChange={set('next')} maxLength={REPORT_NEXT_MAX} />
        </Field>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
          <span style={{ flex: '1 1 220px' }}>{t('Written for the player and his family: no ratings, contract terms, deals, other clubs or players.')}</span>
          <button type="button" onClick={askGolda} style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>{t('Ask Golda to write it')}</button>
        </div>
      </div>
      {dialog}
    </Modal>
  );
}
