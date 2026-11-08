import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, PATHS } from 'lib/db';
import { callFunction } from 'lib/api';
import { listenPlayers } from 'data/players';
import { listenMeetings, addMeeting, updateMeeting, deleteMeeting, restoreMeeting } from 'data/meetings';
import { listenTrainings, addTraining, updateTraining, deleteTraining, restoreTraining, cancelTrainingOccurrence, moveTrainingOccurrence, resetTrainingOccurrence, trainingsInRange } from 'data/trainings';
import { TIME_SLOTS, fmtDate } from 'lib/constants';
import { useRole } from 'lib/roleContext';
import { t, getLang, fmtLongDate } from 'lib/i18n';
import { israelDate, addDays, weekday, daysBetween, WEEKDAY_LABELS, describeRule, AGE_GROUPS, playerName } from '@goldas/domain';
import { PageHeader, Modal, Field, ChipGroup, DateInput, Empty, Skeleton, useConfirm, toast, RowActions, Spinner, ScraperCredits } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { SyncReport } from './Matches';

// One calendar for matches, trainings and meetings. Matches come from the
// matches collection (manual + the daily Israeli sync); trainings are stored
// as a rule ("every Sunday and Tuesday 17:30") and expanded here for the
// range on screen. A single training can be cancelled or moved; the rule
// stays. Meetings are Lou's agency calendar "Gold A&S", synced both ways.
const VIEWS = ['day', 'list', 'week', 'month'];
const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
const lang = () => (getLang() === 'he' ? 'he' : 'en');
const startOfWeek = (s) => addDays(s, -weekday(s));
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const [y, m] = s.split('-').map(Number); return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1); };

function rangeFor(view, anchor) {
  if (view === 'day') return [anchor, anchor];
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

const EMPTY_MEETING = { title: '', date: '', time: '10:00', endTime: '11:00', allDay: false, location: '', notes: '', linkedPlayers: [] };
const plusHour = (time) => { const [h, m] = String(time || '').split(':').map(Number); return Number.isFinite(h) ? `${String((h + 1) % 24).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}` : ''; };

function MeetingModal({ initial, players, onClose }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const s = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const list = q ? players.filter((p) => !p.deletedAt && playerName(p).toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  const setStart = (v) => setForm((p) => ({ ...p, time: v, endTime: !p.endTime || p.endTime <= v ? plusHour(v) : p.endTime }));
  const save = async () => {
    if (!form.title.trim()) { toast.error(t('Title is required.')); return; }
    if (!form.date) { toast.error(t('Date is required.')); return; }
    if (!form.allDay && !form.time) { toast.error(t('Pick a start time or mark it all day.')); return; }
    setBusy(true);
    try {
      const allDay = !!form.allDay;
      const endTime = allDay ? '' : form.endTime || plusHour(form.time);
      const data = {
        title: form.title.trim(), date: form.date, allDay, time: allDay ? '' : form.time, endTime,
        endDate: allDay ? form.date : (endTime && endTime <= form.time ? addDays(form.date, 1) : form.date),
        location: form.location, notes: form.notes, linkedPlayers: form.linkedPlayers,
      };
      if (initial.id) await updateMeeting(initial.id, data); else await addMeeting(data);
      toast.success(initial.id ? t('Meeting updated.') : t('Meeting added.'));
      onClose();
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={initial.id ? t('Edit meeting') : t('New meeting')} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save meeting')}</button>
    </>}>
      <Field label={t('Title')} required><input value={form.title} onChange={(e) => s('title')(e.target.value)} placeholder={t('e.g. Meeting with a player, club meeting')} /></Field>
      <Field label={t('Date')} required><DateInput value={form.date} onChange={s('date')} /></Field>
      <Field label={t('Time')}>
        <ChipGroup options={['timed', 'allday']} labels={[t('At a time'), t('All day')]} value={form.allDay ? 'allday' : 'timed'} onChange={(v) => s('allDay')(v === 'allday')} required />
      </Field>
      {!form.allDay && (
        <div className="form-grid-2">
          <Field label={t('From')}><select value={form.time} onChange={(e) => setStart(e.target.value)}><option value="">{t('Select time...')}</option>{TIME_SLOTS.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label={t('Until')}><select value={form.endTime} onChange={(e) => s('endTime')(e.target.value)}><option value="">—</option>{TIME_SLOTS.map((x) => <option key={x}>{x}</option>)}</select></Field>
        </div>
      )}
      <Field label={t('Place')}><input value={form.location} onChange={(e) => s('location')(e.target.value)} placeholder={t('Address, office or online')} /></Field>
      <Field label={t('Linked Players')}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {form.linkedPlayers.map((id) => <span key={id} className="chip active" onClick={() => s('linkedPlayers')(form.linkedPlayers.filter((x) => x !== id))} style={{ cursor: 'pointer' }}>{playerName(players.find((p) => p.id === id) || {}) || id} ✕</span>)}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Type to search')} />
        {list.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>{list.map((p) => <button key={p.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => { if (!form.linkedPlayers.includes(p.id)) s('linkedPlayers')([...form.linkedPlayers, p.id]); setQ(''); }}>{playerName(p)}</button>)}</div>}
      </Field>
      <Field label={t('Notes')}><textarea rows={3} value={form.notes} onChange={(e) => s('notes')(e.target.value)} /></Field>
      {initial.guests?.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('Guests')}: {initial.guests.join(', ')}</div>}
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>{t('Saved to your Google calendar "Gold A&S" as well. To invite guests, add them in Google Calendar.')}</div>
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

const typeColor = (type) => (type === 'meeting' ? 'var(--gold)' : type === 'match' ? 'var(--blue)' : 'var(--green-ok)');

export default function Calendar() {
  const navigate = useNavigate();
  const { canEdit, isAdmin } = useRole();
  const { confirm, dialog } = useConfirm();
  const [matches, setMatches] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [trainings, setTrainings] = useState([]);
  const [players, setPlayers] = useState([]);
  const [view, setView] = useState(localStorage.getItem('calendar-view') || (isPhone() ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(israelDate());
  const [kind, setKind] = useState('all');
  const [scope, setScope] = useState('all');
  const [playerFilter, setPlayerFilter] = useState('');
  const [modal, setModal] = useState(null);
  const [moving, setMoving] = useState(null);
  const [syncReport, setSyncReport] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [meetingModal, setMeetingModal] = useState(null);
  useEffect(() => { localStorage.setItem('calendar-view', view); }, [view]);
  useEffect(() => {
    const u = [listenCollection(PATHS.MATCHES, setMatches), listenTrainings(setTrainings), listenPlayers({}, setPlayers),
      onSnapshot(doc(db, 'app_meta', 'syncWarnings'), (s) => setSyncReport(s.exists() ? s.data() : null), () => setSyncReport(null))];
    return () => u.forEach((f) => f());
  }, []);
  useEffect(() => listenMeetings(setMeetings), []);

  // Admin-only: pull fixtures for every represented player (background function).
  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await callFunction('sync-matches-background', { method: 'POST' });
      if (res.status === 202 || res.ok) { toast.success(t("Sync started — matches will appear here as they're fetched (≈1–2 min).")); setTimeout(() => setSyncing(false), 90000); return; }
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Sync failed (${res.status})`);
    } catch (e) { toast.error(e.message || t('Sync failed.')); setSyncing(false); }
  };
  const [from, to] = rangeFor(view, anchor);
  const nameOf = (id) => playerName(players.find((p) => p.id === id) || {});
  const events = useMemo(() => {
    const out = [];
    if (kind === 'all' || kind === 'match') for (const m of matches || []) {
      if (m.deletedAt || !m.date || daysBetween(from, m.date) < 0 || daysBetween(m.date, to) < 0) continue;
      const youth = !!(m.homeTeamIsYouth || m.awayTeamIsYouth);
      if (scope === 'youth' && !youth) continue; if (scope === 'senior' && youth) continue;
      if (playerFilter && !(m.linkedPlayers || []).includes(playerFilter)) continue;
      out.push({ key: `m${m.id}`, type: 'match', date: m.date, time: m.time || '', title: `${m.homeTeam} – ${m.awayTeam}`, sub: [m.stadiumName, (m.linkedPlayers || []).map(nameOf).filter(Boolean).join(', ')].filter(Boolean).join(' · '), youth, record: m });
    }
    if (kind === 'all' || kind === 'training') for (const o of trainingsInRange(trainings, from, to)) {
      const tr = o.training || {};
      const youth = !!tr.ageGroup;
      if (scope === 'youth' && !youth) continue; if (scope === 'senior' && youth) continue;
      if (playerFilter && !(tr.linkedPlayers || []).includes(playerFilter)) continue;
      const g = AGE_GROUPS.find((x) => x.id === tr.ageGroup);
      out.push({ key: `t${o.trainingId}${o.sourceDate}`, type: 'training', date: o.date, time: o.time, cancelled: o.cancelled, moved: o.date !== o.sourceDate, title: tr.title || t('Training'), sub: [g ? g[lang()] : '', tr.place, (tr.linkedPlayers || []).map(nameOf).filter(Boolean).join(', '), o.recurring ? describeRule(tr, lang()) : '', ((tr.exceptions || []).find((x) => x.date === o.sourceDate) || {}).notes || ''].filter(Boolean).join(' · '), youth, occ: o, record: tr });
    }
    if ((kind === 'all' || kind === 'meeting') && scope === 'all') for (const m of meetings) {
      if (m.deletedAt || !m.date) continue;
      const end = m.endDate && m.endDate > m.date ? m.endDate : m.date;
      if (daysBetween(from, end) < 0 || daysBetween(m.date, to) < 0) continue;
      if (playerFilter && !(m.linkedPlayers || []).includes(playerFilter)) continue;
      const sub = [m.endTime ? `${t('until')} ${m.endTime}` : '', m.location, (m.linkedPlayers || []).map(nameOf).filter(Boolean).join(', '), (m.guests || []).length ? `${t('Guests')}: ${m.guests.join(', ')}` : ''].filter(Boolean).join(' · ');
      // A meeting longer than a day shows on each of its days in range.
      for (let d = daysBetween(from, m.date) < 0 ? from : m.date; daysBetween(d, end) >= 0 && daysBetween(d, to) >= 0; d = addDays(d, 1)) {
        out.push({ key: `g${m.id}${d}`, type: 'meeting', date: d, time: d === m.date ? (m.time || '') : '', title: m.title, sub, record: m });
      }
    }
    return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }, [matches, trainings, meetings, from, to, kind, scope, playerFilter, players]); // eslint-disable-line

  const byDay = useMemo(() => { const m = new Map(); for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); } return m; }, [events]);
  const step = (dir) => setAnchor((a) => view === 'month' ? addDays(monthStart(a), dir > 0 ? 32 : -1).slice(0, 7) + '-01' : addDays(a, (view === 'week' ? 7 : view === 'day' ? 1 : 30) * dir));
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

  const editMeeting = (m) => setMeetingModal({ ...EMPTY_MEETING, ...m, endTime: m.endTime || '', linkedPlayers: m.linkedPlayers || [] });
  const delMeeting = async (m) => {
    const ok = await confirm(t('Delete the meeting "{title}"? It is removed from Google Calendar too.', { title: m.title }));
    if (!ok) return;
    await deleteMeeting(m.id);
    toast.success(t('Deleted.'), { undo: () => restoreMeeting(m.id) });
  };

  const Event = ({ e }) => (
    <div className="card" style={{ padding: '8px 11px', marginBottom: 6, borderInlineStart: `3px solid ${e.type === 'meeting' ? 'var(--gold)' : e.type === 'match' ? 'var(--blue)' : e.cancelled ? 'var(--text-3)' : 'var(--green-ok)'}`, opacity: e.cancelled ? 0.55 : 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', minWidth: 38 }}>{e.time || '—'}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: typeColor(e.type) }}>{e.type === 'meeting' ? t('MEETING') : e.type === 'match' ? t('MATCH') : t('TRAINING')}</span>
        <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, textDecoration: e.cancelled ? 'line-through' : 'none' }}>{e.title}{e.moved ? <span style={{ fontSize: 10, color: 'var(--amber)' }}> · {t('moved')}</span> : null}</span>
        {e.youth && <span style={{ fontSize: 9, color: 'var(--green-ok)', border: '1px solid var(--green-bg)', padding: '0 4px' }}>{t('Youth')}</span>}
        {canEdit && e.type === 'training' && (
          <RowActions onEdit={() => editTraining(e)} onDelete={() => delTraining(e)}>
            {e.occ.recurring && !e.cancelled && <button type="button" className="btn btn-ghost btn-sm" title={t('Cancel this one')} onClick={() => cancelOcc(e)}>✕1</button>}
            {!e.cancelled && <button type="button" className="btn btn-ghost btn-sm" title={t('Move this one')} onClick={() => setMoving(e.occ)}>⇄</button>}
            {(e.cancelled || e.moved) && <button type="button" className="btn btn-ghost btn-sm" title={t('Restore')} onClick={() => resetTrainingOccurrence(e.record, e.occ.sourceDate)}>↺</button>}
          </RowActions>
        )}
        {e.type === 'match' && <Link to="/matches" state={{ focus: e.record.id }} style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>{t('Open')}</Link>}
        {e.type === 'meeting' && e.record.meetUrl && <a href={e.record.meetUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>Meet</a>}
        {e.type === 'meeting' && canEdit && <RowActions onEdit={() => editMeeting(e.record)} onDelete={() => delMeeting(e.record)} />}
      </div>
      {e.sub && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, marginInlineStart: 46 }}>{e.sub}</div>}
    </div>
  );

  if (!matches) return <Skeleton rows={6} />;
  const label = view === 'month' ? fmtLongDate(new Date(anchor), { month: 'long', year: 'numeric' }) : view === 'day' ? fmtLongDate(new Date(anchor)) : view === 'week' ? `${fmtDate(from)} – ${fmtDate(to)}` : `${t('From')} ${fmtDate(from)}`;

  return (
    <div>
      <PageHeader title={t('Calendar')} subtitle={`${events.filter((e) => e.type === 'match').length} ${t('matches')} · ${events.filter((e) => e.type === 'training' && !e.cancelled).length} ${t('trainings')}${meetings.length ? ` · ${new Set(events.filter((e) => e.type === 'meeting').map((e) => e.record.id)).size} ${t('meetings')}` : ''}`}
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && <button className="btn btn-primary" style={{ height: 36 }} title={t('Add training')} aria-label={t('Add training')} onClick={() => setModal({ ...EMPTY, start: israelDate() })}><Icon name="calendar" size={14} /><span className="btn-text">{t('Add training')}</span></button>}
          {canEdit && <button className="btn btn-secondary" style={{ height: 36 }} title={t('Add Match')} aria-label={t('Add Match')} onClick={() => navigate('/matches', { state: { add: true } })}><Icon name="matches" size={14} /><span className="btn-text">{t('Add Match')}</span></button>}
          {canEdit && <button className="btn btn-secondary" style={{ height: 36 }} title={t('Add meeting')} aria-label={t('Add meeting')} onClick={() => setMeetingModal({ ...EMPTY_MEETING, date: anchor })}><Icon name="team" size={14} /><span className="btn-text">{t('Add meeting')}</span></button>}
          {isAdmin && <button className="btn btn-ghost btn-sm" style={{ height: 36, whiteSpace: 'nowrap' }} onClick={syncNow} disabled={syncing} title={t('Pull match fixtures from IFA / 365 / SofaScore for every represented player')}>{syncing ? <><Spinner size={12} /><span className="btn-text">{t('Syncing…')}</span></> : <><Icon name="refresh" size={12} /><span className="btn-text">{t('Sync Now')}</span></>}</button>}
        </div>}>
        <div className="filter-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12, padding: '10px 12px', background: 'var(--surface-1)', border: '1px solid var(--border)' }}>
          <ChipGroup options={VIEWS} labels={[t('Day'), t('List'), t('Week'), t('Month')]} value={view} onChange={setView} required />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => step(-1)}>‹</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, minWidth: 130, textAlign: 'center' }}>{label}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => step(1)}>›</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnchor(israelDate())}>{t('Today')}</button>
          </div>
          <ChipGroup options={['all', 'match', 'training', 'meeting']} labels={[t('All'), t('Matches'), t('Trainings'), t('Meetings')]} value={kind} onChange={setKind} required />
          <ChipGroup options={['all', 'youth', 'senior']} labels={[t('Everyone'), t('Youth only'), t('Senior only')]} value={scope} onChange={setScope} required />
          <select value={playerFilter} onChange={(e) => setPlayerFilter(e.target.value)} style={{ width: 'auto', height: 36, fontSize: 12 }}>
            <option value="">{t('All players')}</option>
            {players.filter((p) => (p.stage || 'represented') === 'represented').sort((a, b) => playerName(a).localeCompare(playerName(b))).map((p) => <option key={p.id} value={p.id}>{playerName(p)}</option>)}
          </select>
          <ScraperCredits />
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
                {list.map((e) => <div key={e.key} title={`${e.time} ${e.title}`} style={{ fontSize: 10, color: typeColor(e.type), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: e.cancelled ? 'line-through' : 'none' }}>{e.time ? `${e.time} ` : ''}{e.title}</div>)}
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
      {meetingModal && <MeetingModal initial={meetingModal} players={players} onClose={() => setMeetingModal(null)} />}
      {dialog}
    </div>
  );
}
