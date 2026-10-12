import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, PATHS } from 'lib/db';
import { listenPlayers } from 'data/players';
import { listenTrainings, addTraining, updateTraining, deleteTraining, restoreTraining, cancelTrainingOccurrence, moveTrainingOccurrence, resetTrainingOccurrence, trainingsInRange } from 'data/trainings';
import { TIME_SLOTS, fmtDate } from 'lib/constants';
import { useRole } from 'lib/roleContext';
import { t, getLang, fmtLongDate } from 'lib/i18n';
import { israelDate, addDays, weekday, daysBetween, WEEKDAY_LABELS, describeRule, AGE_GROUPS, playerName } from '@goldas/domain';
import { PageHeader, Modal, Field, ChipGroup, DateInput, Empty, Skeleton, useConfirm, toast, RowActions } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { SyncReport } from './Matches';

// One calendar for matches and trainings. Matches come from the matches
// collection (manual + the daily Israeli sync); trainings are stored as a
// rule ("every Sunday and Tuesday 17:30") and expanded here for the range
// on screen. A single training can be cancelled or moved; the rule stays.
const VIEWS = ['list', 'week', 'month'];
const lang = () => (getLang() === 'he' ? 'he' : 'en');
const startOfWeek = (s) => addDays(s, -weekday(s));
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const [y, m] = s.split('-').map(Number); return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1); };

function rangeFor(view, anchor) {
  if (view === 'week') { const s = startOfWeek(anchor); return [s, addDays(s, 6)]; }
  if (view === 'month') return [monthStart(anchor), monthEnd(anchor)];
  return [anchor, addDays(anchor, 60)];
}

const EMPTY = { title: '', kind: 'weekly', date: '', time: '17:30', byWeekday: [], start: '', until: '', place: '', linkedPlayers: [], ageGroup: '', notes: '' };

function TrainingModal({ initial, players, onClose, onSaved }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const s = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const [q, setQ] = useState('');
  const youth = players.filter((p) => (p.stage || 'represented') === 'represented');
  const list = q ? youth.filter((p) => playerName(p).toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  const toggleDay = (d) => s('byWeekday')(form.byWeekday.includes(d) ? form.byWeekday.filter((x) => x !== d) : [...form.byWeekday, d].sort());
  const save = async () => {
    if (!form.title.trim()) { toast.error(t('Title is required.')); return; }
    if (form.kind === 'weekly' && !form.byWeekday.length) { toast.error(t('Pick at least one weekday.')); return; }
    if (form.kind === 'once' && !form.date) { toast.error(t('Date is required.')); return; }
    setBusy(true);
    try {
      const data = {
        title: form.title.trim(), time: form.time, place: form.place, notes: form.notes, linkedPlayers: form.linkedPlayers, ageGroup: form.ageGroup,
        date: form.kind === 'once' ? form.date : '',
        rule: form.kind === 'weekly' ? { freq: 'weekly', byWeekday: form.byWeekday, start: form.start || israelDate(), until: form.until || null } : null,
      };
      if (initial.id) await updateTraining(initial.id, data); else await addTraining(data);
      toast.success(initial.id ? t('Training updated.') : t('Training added.'));
      onSaved?.(); onClose();
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={initial.id ? t('Edit training') : t('New training')} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save training')}</button>
    </>}>
      <Field label={t('Title')} required><input value={form.title} onChange={(e) => s('title')(e.target.value)} placeholder={t('e.g. U17 training, fitness session')} /></Field>
      <Field label={t('Repeats')}>
        <ChipGroup options={['weekly', 'once']} labels={[t('Every week'), t('Once')]} value={form.kind} onChange={s('kind')} required />
      </Field>
      {form.kind === 'weekly' ? (<>
        <Field label={t('Weekdays')} required>
          <div className="chip-group">{WEEKDAY_LABELS[lang()].map((d, i) => <button key={i} type="button" className={`chip${form.byWeekday.includes(i) ? ' active' : ''}`} onClick={() => toggleDay(i)}>{d}</button>)}</div>
        </Field>
        <div className="form-grid-2">
          <Field label={t('From')} hint={t('Defaults to today')}><DateInput value={form.start} onChange={s('start')} /></Field>
          <Field label={t('Until')} hint={t('Leave empty for no end')}><DateInput value={form.until} onChange={s('until')} /></Field>
        </div>
      </>) : (
        <Field label={t('Date')} required><DateInput value={form.date} onChange={s('date')} /></Field>
      )}
      <div className="form-grid-2">
        <Field label={t('Time')}>
          <select value={form.time} onChange={(e) => s('time')(e.target.value)}><option value="">{t('Select time...')}</option>{TIME_SLOTS.map((x) => <option key={x}>{x}</option>)}</select>
        </Field>
        <Field label={t('Place')}><input value={form.place} onChange={(e) => s('place')(e.target.value)} placeholder={t('Field / venue')} /></Field>
      </div>
      <Field label={t('Age group')} hint={t('For youth group trainings')}>
        <select value={form.ageGroup} onChange={(e) => s('ageGroup')(e.target.value)}>
          <option value="">—</option>
          {AGE_GROUPS.map((g) => <option key={g.id} value={g.id}>{g[lang()]}</option>)}
        </select>
      </Field>
      <Field label={t('Linked Players')}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {form.linkedPlayers.map((id) => <span key={id} className="chip active" onClick={() => s('linkedPlayers')(form.linkedPlayers.filter((x) => x !== id))} style={{ cursor: 'pointer' }}>{playerName(players.find((p) => p.id === id) || {}) || id} ✕</span>)}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Type to search')} />
        {list.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>{list.map((p) => <button key={p.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => { if (!form.linkedPlayers.includes(p.id)) s('linkedPlayers')([...form.linkedPlayers, p.id]); setQ(''); }}>{playerName(p)}</button>)}</div>}
      </Field>
      <Field label={t('Notes')}><textarea rows={2} value={form.notes} onChange={(e) => s('notes')(e.target.value)} /></Field>
    </Modal>
  );
}

function MoveModal({ occ, onClose }) {
  const [date, setDate] = useState(occ.date);
  const [time, setTime] = useState(occ.time);
  const save = async () => {
    await moveTrainingOccurrence(occ.training, occ.sourceDate, date, time);
    toast.success(t('Training moved.')); onClose();
  };
  return (
    <Modal title={t('Move this training only')} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={save}>{t('Move')}</button>
    </>}>
      <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 12 }}>{t('Only the session of {date} moves; the weekly rule stays.', { date: fmtDate(occ.sourceDate) })}</p>
      <div className="form-grid-2">
        <Field label={t('Date')}><DateInput value={date} onChange={setDate} /></Field>
        <Field label={t('Time')}><select value={time} onChange={(e) => setTime(e.target.value)}>{TIME_SLOTS.map((x) => <option key={x}>{x}</option>)}</select></Field>
      </div>
    </Modal>
  );
}

export default function Calendar() {
  const navigate = useNavigate();
  const { canEdit } = useRole();
  const { confirm, dialog } = useConfirm();
  const [matches, setMatches] = useState(null);
  const [trainings, setTrainings] = useState([]);
  const [players, setPlayers] = useState([]);
  const [view, setView] = useState(localStorage.getItem('calendar-view') || 'week');
  const [anchor, setAnchor] = useState(israelDate());
  const [kind, setKind] = useState('all');
  const [scope, setScope] = useState('all');
  const [playerFilter, setPlayerFilter] = useState('');
  const [modal, setModal] = useState(null);
  const [moving, setMoving] = useState(null);
  const [syncReport, setSyncReport] = useState(null);
  useEffect(() => { localStorage.setItem('calendar-view', view); }, [view]);
  useEffect(() => {
    const u = [listenCollection(PATHS.MATCHES, setMatches), listenTrainings(setTrainings), listenPlayers({}, setPlayers),
      onSnapshot(doc(db, 'app_meta', 'syncWarnings'), (s) => setSyncReport(s.exists() ? s.data() : null), () => setSyncReport(null))];
    return () => u.forEach((f) => f());
  }, []);

  const [from, to] = rangeFor(view, anchor);
  const nameOf = (id) => playerName(players.find((p) => p.id === id) || {});
  const events = useMemo(() => {
    const out = [];
    if (kind !== 'training') for (const m of matches || []) {
      if (m.deletedAt || !m.date || daysBetween(from, m.date) < 0 || daysBetween(m.date, to) < 0) continue;
      const youth = !!(m.homeTeamIsYouth || m.awayTeamIsYouth);
      if (scope === 'youth' && !youth) continue; if (scope === 'senior' && youth) continue;
      if (playerFilter && !(m.linkedPlayers || []).includes(playerFilter)) continue;
      out.push({ key: `m${m.id}`, type: 'match', date: m.date, time: m.time || '', title: `${m.homeTeam} – ${m.awayTeam}`, sub: [m.stadiumName, (m.linkedPlayers || []).map(nameOf).filter(Boolean).join(', ')].filter(Boolean).join(' · '), youth, record: m });
    }
    if (kind !== 'match') for (const o of trainingsInRange(trainings, from, to)) {
      const tr = o.training || {};
      const youth = !!tr.ageGroup;
      if (scope === 'youth' && !youth) continue; if (scope === 'senior' && youth) continue;
      if (playerFilter && !(tr.linkedPlayers || []).includes(playerFilter)) continue;
      const g = AGE_GROUPS.find((x) => x.id === tr.ageGroup);
      out.push({ key: `t${o.trainingId}${o.sourceDate}`, type: 'training', date: o.date, time: o.time, cancelled: o.cancelled, moved: o.date !== o.sourceDate, title: tr.title || t('Training'), sub: [g ? g[lang()] : '', tr.place, (tr.linkedPlayers || []).map(nameOf).filter(Boolean).join(', '), o.recurring ? describeRule(tr, lang()) : ''].filter(Boolean).join(' · '), youth, occ: o, record: tr });
    }
    return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }, [matches, trainings, from, to, kind, scope, playerFilter, players]); // eslint-disable-line

  const byDay = useMemo(() => { const m = new Map(); for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); } return m; }, [events]);
  const step = (dir) => setAnchor((a) => view === 'month' ? addDays(monthStart(a), dir > 0 ? 32 : -1).slice(0, 7) + '-01' : addDays(a, (view === 'week' ? 7 : 30) * dir));
  const today = israelDate();

  const cancelOcc = async (e) => {
    const ok = await confirm(t('Cancel the training of {date} only?', { date: fmtDate(e.occ.sourceDate) }), { confirmLabel: t('Cancel training') });
    if (!ok) return;
    await cancelTrainingOccurrence(e.record, e.occ.sourceDate);
    toast.success(t('Training cancelled.'), { undo: () => resetTrainingOccurrence(e.record, e.occ.sourceDate) });
  };
  const delTraining = async (e) => {
    const ok = await confirm(t('Delete the whole training series "{title}"?', { title: e.title }));
    if (!ok) return;
    await deleteTraining(e.record.id);
    toast.success(t('Deleted.'), { undo: () => restoreTraining(e.record.id) });
  };
  const editTraining = (e) => {
    const tr = e.record;
    setModal({ id: tr.id, title: tr.title || '', kind: tr.rule ? 'weekly' : 'once', date: tr.date || '', time: tr.time || '', byWeekday: tr.rule?.byWeekday || [], start: tr.rule?.start || '', until: tr.rule?.until || '', place: tr.place || '', linkedPlayers: tr.linkedPlayers || [], ageGroup: tr.ageGroup || '', notes: tr.notes || '' });
  };

  const Event = ({ e }) => (
    <div className="card" style={{ padding: '8px 11px', marginBottom: 6, borderInlineStart: `3px solid ${e.type === 'match' ? 'var(--blue)' : e.cancelled ? 'var(--text-3)' : 'var(--green-ok)'}`, opacity: e.cancelled ? 0.55 : 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', minWidth: 38 }}>{e.time || '—'}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: e.type === 'match' ? 'var(--blue)' : 'var(--green-ok)' }}>{e.type === 'match' ? t('MATCH') : t('TRAINING')}</span>
        <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, textDecoration: e.cancelled ? 'line-through' : 'none' }}>{e.title}{e.moved ? <span style={{ fontSize: 10, color: 'var(--amber)' }}> · {t('moved')}</span> : null}</span>
        {e.youth && <span style={{ fontSize: 9, color: '#4ADE80', border: '1px solid rgba(74,222,128,0.3)', padding: '0 4px' }}>{t('Youth')}</span>}
        {canEdit && e.type === 'training' && (
          <RowActions onEdit={() => editTraining(e)} onDelete={() => delTraining(e)}>
            {e.occ.recurring && !e.cancelled && <button type="button" className="btn btn-ghost btn-sm" title={t('Cancel this one')} onClick={() => cancelOcc(e)}>✕1</button>}
            {!e.cancelled && <button type="button" className="btn btn-ghost btn-sm" title={t('Move this one')} onClick={() => setMoving(e.occ)}>⇄</button>}
            {(e.cancelled || e.moved) && <button type="button" className="btn btn-ghost btn-sm" title={t('Restore')} onClick={() => resetTrainingOccurrence(e.record, e.occ.sourceDate)}>↺</button>}
          </RowActions>
        )}
        {e.type === 'match' && <Link to="/matches" state={{ focus: e.record.id }} style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>{t('Open')}</Link>}
      </div>
      {e.sub && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, marginInlineStart: 46 }}>{e.sub}</div>}
    </div>
  );

  if (!matches) return <Skeleton rows={6} />;
  const label = view === 'month' ? fmtLongDate(new Date(anchor), { month: 'long', year: 'numeric' }) : view === 'week' ? `${fmtDate(from)} – ${fmtDate(to)}` : `${t('From')} ${fmtDate(from)}`;

  return (
    <div>
      <PageHeader title={t('Calendar')} subtitle={`${events.filter((e) => e.type === 'match').length} ${t('matches')} · ${events.filter((e) => e.type === 'training' && !e.cancelled).length} ${t('trainings')}`}
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && <button className="btn btn-primary" style={{ height: 36 }} onClick={() => setModal({ ...EMPTY, start: israelDate() })}><Icon name="plus" size={12} /><span className="btn-text">{t('Add training')}</span></button>}
          {canEdit && <button className="btn btn-secondary" style={{ height: 36 }} onClick={() => navigate('/matches', { state: { add: true } })}><Icon name="plus" size={12} /><span className="btn-text">{t('Add Match')}</span></button>}
        </div>}>
        <div className="filter-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12, padding: '10px 12px', background: 'var(--surface-1)', border: '1px solid var(--border)' }}>
          <ChipGroup options={VIEWS} labels={[t('List'), t('Week'), t('Month')]} value={view} onChange={setView} required />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => step(-1)}>‹</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, minWidth: 130, textAlign: 'center' }}>{label}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => step(1)}>›</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnchor(israelDate())}>{t('Today')}</button>
          </div>
          <ChipGroup options={['all', 'match', 'training']} labels={[t('All'), t('Matches'), t('Trainings')]} value={kind} onChange={setKind} required />
          <ChipGroup options={['all', 'youth', 'senior']} labels={[t('Everyone'), t('Youth only'), t('Senior only')]} value={scope} onChange={setScope} required />
          <select value={playerFilter} onChange={(e) => setPlayerFilter(e.target.value)} style={{ width: 'auto', height: 36, fontSize: 12 }}>
            <option value="">{t('All players')}</option>
            {players.filter((p) => (p.stage || 'represented') === 'represented').sort((a, b) => playerName(a).localeCompare(playerName(b))).map((p) => <option key={p.id} value={p.id}>{playerName(p)}</option>)}
          </select>
        </div>
      </PageHeader>

      {canEdit && <SyncReport report={syncReport} />}

      {events.length === 0 ? <Empty message={t('Nothing in this period.')} /> : view === 'month' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
          {WEEKDAY_LABELS[lang()].map((d) => <div key={d} style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textAlign: 'center' }}>{d}</div>)}
          {Array.from({ length: weekday(from) }).map((_, i) => <div key={`pad${i}`} />)}
          {Array.from({ length: daysBetween(from, to) + 1 }).map((_, i) => {
            const d = addDays(from, i); const list = byDay.get(d) || [];
            return (
              <div key={d} style={{ minHeight: 70, border: '1px solid var(--border)', padding: 4, background: d === today ? 'var(--gold-dim)' : 'var(--card)' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: d === today ? 'var(--gold)' : 'var(--text-3)' }}>{Number(d.slice(8))}</div>
                {list.map((e) => <div key={e.key} title={`${e.time} ${e.title}`} style={{ fontSize: 10, color: e.type === 'match' ? 'var(--blue)' : 'var(--green-ok)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: e.cancelled ? 'line-through' : 'none' }}>{e.time ? `${e.time} ` : ''}{e.title}</div>)}
              </div>
            );
          })}
        </div>
      ) : (
        [...byDay.keys()].sort().map((d) => (
          <div key={d} style={{ marginBottom: 18 }}>
            <div className="section-label" style={{ marginBottom: 8, color: d === today ? 'var(--gold)' : undefined }}>{fmtLongDate(new Date(d))}{d === today ? ` · ${t('Today')}` : ''}</div>
            {byDay.get(d).map((e) => <Event key={e.key} e={e} />)}
          </div>
        ))
      )}

      {modal && <TrainingModal initial={modal} players={players} onClose={() => setModal(null)} />}
      {moving && <MoveModal occ={moving} onClose={() => setMoving(null)} />}
      {dialog}
    </div>
  );
}
