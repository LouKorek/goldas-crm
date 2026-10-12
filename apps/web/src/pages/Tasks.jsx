import React, { useState, useEffect, useMemo, useRef } from 'react';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { fmtDate } from 'lib/constants';
import {
  Modal, Field, ChipGroup, DateInput, SearchInput, PageHeader,
  Empty, Spinner, useConfirm, toast, RowActions,
} from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { useRole } from 'lib/roleContext';
import { OWNER_EMAIL } from 'lib/firebase';

// Personal task list. Every task belongs to exactly one signed-in user
// (`owner` = their email) and is only ever shown to that user; nobody sees
// anybody else's list. The screen is open to all users rather than the owner
// alone, so each of them gets their own board.
//
// The starter-task seeder that used to live here has been removed: it wiped
// the whole collection before re-seeding, which was harmless when Lou was the
// only person with tasks and destructive the moment anyone else had some.

// ─────────────────────────── Constants ───────────────────────────
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const PRIORITY_RANK = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
const PRIORITY_COLOR = {
  Low:     { bg: 'rgba(96,165,250,0.14)',  fg: '#60A5FA', border: 'rgba(96,165,250,0.35)' },
  Normal:  { bg: 'rgba(212,176,98,0.14)',  fg: '#D4B062', border: 'rgba(212,176,98,0.35)' },
  High:    { bg: 'rgba(251,191,36,0.16)',  fg: '#FBBF24', border: 'rgba(251,191,36,0.42)' },
  Urgent:  { bg: 'rgba(248,113,113,0.18)', fg: '#F87171', border: 'rgba(248,113,113,0.45)' },
};

const EMPTY = {
  title: '',
  dueDate: '',
  priority: 'Normal',
  notes: '',
  linkedPlayers: [],
  done: false,
};

// ─────────────────────────── Helpers ────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}

function dueLabel(dateStr) {
  if (!dateStr) return null;
  const days = daysUntil(dateStr);
  if (days < 0)   return { text: `Overdue · ${fmtDate(dateStr)}`, color: 'var(--red)' };
  if (days === 0) return { text: `Today · ${fmtDate(dateStr)}`,   color: 'var(--amber)' };
  if (days === 1) return { text: `Tomorrow · ${fmtDate(dateStr)}`,color: 'var(--amber)' };
  if (days <= 7)  return { text: `${days}d · ${fmtDate(dateStr)}`, color: 'var(--gold)' };
  return            { text: fmtDate(dateStr), color: 'var(--text-2)' };
}

// ─────────────────────────── Player-multi-select ────────────────
function PlayersMultiSelect({ allPlayers, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ]       = useState('');
  const wrapRef         = useRef(null);

  const filtered = q
    ? allPlayers.filter(p => (p.fullName || '').toLowerCase().includes(q.toLowerCase()))
    : allPlayers;
  const toggle = (id) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  const selected = allPlayers.filter(p => value.includes(p.id));
  const allChecked = allPlayers.length > 0 && value.length >= allPlayers.length;
  const someChecked = value.length > 0 && !allChecked;
  const toggleAll = () => onChange(allChecked ? [] : allPlayers.map(p => p.id));

  // Close on click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('touchstart', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('touchstart', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', minHeight: 40, padding: '8px 12px',
          background: 'var(--input-bg)', border: '1.5px solid var(--border)',
          borderRadius: 0, color: 'var(--input-text)',
          textAlign: 'left', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        }}>
        {selected.length === 0 && <span style={{ color: 'var(--text-3)' }}>Link represented players…</span>}
        {allChecked ? (
          <span style={{
            background: 'var(--gold-dim)', border: '1px solid rgba(212,176,98,0.3)',
            borderRadius: 0, padding: '2px 10px', color: 'var(--gold)', fontSize: 12, fontWeight: 600,
          }}>All represented ({allPlayers.length})</span>
        ) : (
          selected.map(p => (
            <span key={p.id} style={{
              background: 'var(--gold-dim)', border: '1px solid rgba(212,176,98,0.3)',
              borderRadius: 0, padding: '2px 8px', color: 'var(--gold)', fontSize: 12,
              whiteSpace: 'nowrap',
            }}>{p.fullName}</span>
          ))
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
          maxHeight: 320, overflowY: 'auto', zIndex: 80,
          background: 'var(--surface-2)', border: '1px solid var(--border-2)',
          borderRadius: 0, boxShadow: '0 12px 32px rgba(0,0,0,0.5)', padding: 8,
        }}>
          {/* Sticky header: search + select-all toggle + close */}
          <div style={{
            position: 'sticky', top: -8, marginTop: -8, paddingTop: 8,
            background: 'var(--surface-2)', zIndex: 1,
            display: 'flex', flexDirection: 'column', gap: 8,
            marginBottom: 6,
          }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search players…" autoFocus
                style={{ flex: 1, minWidth: 0 }} />
              <button type="button" onClick={() => setOpen(false)}
                title="Close"
                style={{
                  width: 32, height: 32, padding: 0, flexShrink: 0,
                  border: '1px solid var(--border-2)', borderRadius: 0,
                  background: 'transparent', color: 'var(--text-2)',
                  cursor: 'pointer', fontSize: 16, lineHeight: 1,
                }}>×</button>
            </div>
            <button type="button" onClick={toggleAll}
              style={{
                width: '100%', padding: '7px 10px',
                background: allChecked ? 'var(--gold-dim)' : 'transparent',
                border: `1px solid ${allChecked ? 'rgba(212,176,98,0.45)' : 'var(--border-2)'}`,
                borderRadius: 0, color: allChecked ? 'var(--gold)' : 'var(--text-2)',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
              <span>{allChecked ? 'All selected' : (someChecked ? `${value.length} of ${allPlayers.length} selected` : 'Select all')}</span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                {allChecked ? 'Tap to clear' : 'Tap to select all'}
              </span>
            </button>
          </div>
          {filtered.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-3)', padding: 8 }}>No matching players.</div>
          ) : filtered.map(p => (
            <label key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px',
              cursor: 'pointer', borderRadius: 0,
              background: value.includes(p.id) ? 'var(--gold-dim)' : 'transparent',
            }}>
              <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} />
              <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{p.fullName}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── Page ────────────────────────────────
export default function Tasks() {
  const { email, name, canEdit } = useRole();
  const [allItems, setAllItems] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);
  const [form, setForm]       = useState(EMPTY);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [search, setSearch]   = useState('');
  const [showDone, setShowDone] = useState(false);
  const { confirm, dialog }   = useConfirm();

  useEffect(() => listenCollection(PATHS.TASKS, data => { setAllItems(data); setLoading(false); }), []);
  useEffect(() => listenCollection(PATHS.PLAYERS, setPlayers), []);

  // Only ever work with this user's own tasks. Documents written before the
  // list became personal carry no `owner` — they are Lou's, and the effect
  // below stamps them, so until that lands they stay visible to him alone.
  const items = useMemo(
    () => allItems.filter(t => (t.owner || OWNER_EMAIL) === email),
    [allItems, email]);

  // ── Ownership backfill ──────────────────────────────────────────
  // Every task written before this screen became personal predates the
  // `owner` field. They are all Lou's, so his next visit stamps them once and
  // the question never comes up again. Runs by itself — no button, no console.
  const claimedRef = useRef(false);
  const allItemsRef = useRef([]);
  useEffect(() => { allItemsRef.current = allItems; }, [allItems]);

  useEffect(() => {
    if (loading || claimedRef.current) return;
    if (email !== OWNER_EMAIL || !canEdit) return;
    claimedRef.current = true;

    // Let the listener settle first, so a partial first snapshot doesn't make
    // this run twice over the same documents.
    const tid = setTimeout(async () => {
      const orphans = allItemsRef.current.filter(t => !t.owner);
      if (!orphans.length) return;
      try {
        for (const t of orphans) {
          await updateDoc_(PATHS.TASKS, t.id, { owner: OWNER_EMAIL });
        }
      } catch (e) {
        claimedRef.current = false;
        toast.error(e.message || 'Could not assign existing tasks.');
      }
    }, 1500);
    return () => clearTimeout(tid);
  }, [loading, email, canEdit]);

  const s = k => v => { setForm(p => ({ ...p, [k]: v })); setIsDirty(true); };
  const f = k => form[k] ?? '';

  const openAdd  = () => { setForm({ ...EMPTY }); setModal('add'); setIsDirty(false); };
  const openEdit = (t) => { setForm({ ...EMPTY, ...t }); setModal({ edit: t }); setIsDirty(false); };

  const save = async () => {
    if (!form.title.trim()) { toast.error('Title is required.'); return; }
    setSaving(true);
    try {
      // owner is set on create and never rewritten, so a task can't drift to
      // another list by being edited.
      const data = { ...form, title: form.title.trim(), owner: form.owner || email };
      if (modal === 'add') { await addDoc_(PATHS.TASKS, data); toast.success('Task added!'); }
      else { await updateDoc_(PATHS.TASKS, modal.edit.id, data); toast.success('Task updated.'); }
      setModal(null);
    } catch (e) { toast.error(e.message || 'Save failed.'); }
    finally { setSaving(false); }
  };

  const del = async (t) => {
    const ok = await confirm(`Delete "${t.title}"?`);
    if (!ok) return;
    try { await deleteDoc_(PATHS.TASKS, t.id); toast.success('Deleted.'); }
    catch (e) { toast.error(e.message || 'Delete failed.'); }
  };

  const toggleDone = async (t) => {
    try {
      await updateDoc_(PATHS.TASKS, t.id, {
        done: !t.done,
        completedAt: !t.done ? new Date().toISOString() : null,
      });
    } catch (e) { toast.error(e.message || 'Could not update task.'); }
  };

  // Sort: by due date (no due last), then by priority within same date.
  const sorted = useMemo(() => {
    const arr = [...items];
    arr.sort((a, b) => {
      const da = a.dueDate || '9999-12-31';
      const db = b.dueDate || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      return (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
    });
    return arr;
  }, [items]);

  const matchesSearch = (t) => !search ||
    `${t.title} ${t.notes || ''}`.toLowerCase().includes(search.toLowerCase());

  const open = sorted.filter(t => !t.done && matchesSearch(t));
  const done = sorted.filter(t =>  t.done && matchesSearch(t));

  return (
    <div className="tasks-page">
      <PageHeader
        title="My Tasks"
        subtitle={`${open.length} open  ·  ${done.length} done  ·  private to ${name || email}`}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {canEdit && (
              <button className="btn btn-primary" onClick={openAdd} style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">Add Task</span></button>
            )}
            <div style={{ height: 36, display: 'flex', alignItems: 'center' }}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
          </div>
        }
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
      ) : items.length === 0 ? (
        <Empty message={canEdit ? 'No tasks yet — add your first one.' : 'No tasks yet.'}
          action={canEdit ? <button className="btn btn-primary" onClick={openAdd}>+ Add Task</button> : null} />
      ) : (
        <>
          {/* Open tasks */}
          {open.length === 0 ? (
            <Empty message={search ? 'No open tasks match your search.' : 'All caught up — no open tasks.'} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {open.map(t => <TaskCard key={t.id} t={t} players={players} canEdit={canEdit}
                onToggle={() => toggleDone(t)} onEdit={() => openEdit(t)} onDelete={() => del(t)} />)}
            </div>
          )}

          {/* Completed tasks — collapsed section */}
          {done.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <button type="button" onClick={() => setShowDone(v => !v)}
                style={{
                  width: '100%', background: 'transparent', border: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 4px', cursor: 'pointer',
                  color: 'var(--text-3)', fontSize: 13, fontStyle: 'italic',
                  borderTop: '1px solid var(--border)',
                }}>
                <span>Completed ({done.length})</span>
                <span style={{ fontSize: 11 }}>{showDone ? '▲ hide' : '▼ show'}</span>
              </button>
              {showDone && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, opacity: 0.7 }}>
                  {done.map(t => <TaskCard key={t.id} t={t} players={players} canEdit={canEdit}
                    onToggle={() => toggleDone(t)} onEdit={() => openEdit(t)} onDelete={() => del(t)} />)}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Task' : 'Edit Task'}
          onClose={() => setModal(null)} isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : 'Save Task'}
            </button>
          </>}
        >
          <Field label="Title" required>
            <input value={f('title')} onChange={e => s('title')(e.target.value)} placeholder="What needs to happen?" autoFocus />
          </Field>

          <div className="form-grid-2">
            <Field label="Due Date">
              <DateInput value={f('dueDate')} onChange={s('dueDate')} />
            </Field>
            <Field label="Priority">
              <ChipGroup options={PRIORITIES} value={f('priority')} onChange={s('priority')} required />
            </Field>
          </div>

          <Field label="Linked Players" hint="Optional — attach one or more represented players to this task.">
            <PlayersMultiSelect allPlayers={players} value={form.linkedPlayers || []}
              onChange={(v) => s('linkedPlayers')(v)} />
          </Field>

          <Field label="Notes">
            <textarea value={f('notes')} onChange={e => s('notes')(e.target.value)}
              placeholder="Details, links, who to contact…" rows={4} />
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}

// ─────────────────────────── Task Card ───────────────────────────
function TaskCard({ t, players, canEdit, onToggle, onEdit, onDelete }) {
  const due       = dueLabel(t.dueDate);
  const linked    = (t.linkedPlayers || []).map(id => players.find(p => p.id === id)).filter(Boolean);
  const pri       = PRIORITY_COLOR[t.priority] || PRIORITY_COLOR.Normal;
  // Collapse the chip list when every represented player is attached — a
  // task with 30 chips on a phone screen was unreadable.
  const allLinked = players.length > 0 && linked.length >= players.length;

  return (
    <div className="card card-body" style={{
      padding: '11px 14px', display: 'flex', gap: 10, alignItems: 'flex-start',
      borderLeft: `3px solid ${pri.fg}`,
    }}>
      {/* Done checkbox */}
      <button type="button" onClick={onToggle} className="task-check" disabled={!canEdit}
        title={canEdit ? (t.done ? 'Mark as open' : 'Mark as done') : 'View-only access'}
        style={{
          width: 24, height: 24, borderRadius: 0, flexShrink: 0,
          border: `1.5px solid ${t.done ? 'var(--green-ok)' : 'var(--border-2)'}`,
          background: t.done ? 'var(--green-ok)' : 'transparent',
          color: '#0A140D', cursor: canEdit ? 'pointer' : 'default', marginTop: 2,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 700,
        }}>
        {t.done ? '✓' : ''}
      </button>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 600, color: 'var(--text-1)',
          textDecoration: t.done ? 'line-through' : 'none',
          opacity: t.done ? 0.6 : 1,
          overflowWrap: 'anywhere',
        }}>
          {t.title}
        </div>

        {/* Metadata row: priority + due + linked players */}
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
          marginTop: 6, fontSize: 11.5,
        }}>
          <span style={{
            background: pri.bg, color: pri.fg, border: `1px solid ${pri.border}`,
            borderRadius: 0, padding: '2px 10px',
            fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{t.priority || 'Normal'}</span>

          {due && (
            <span style={{ color: due.color, fontWeight: 500 }}>
              {due.text}
            </span>
          )}

          {linked.length > 0 && (
            <span className="task-linked-row" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              flexWrap: 'wrap', rowGap: 4,
              color: 'var(--text-3)', minWidth: 0,
            }}>
              <span style={{ flexShrink: 0 }}>🤝</span>
              {allLinked ? (
                <span style={{
                  background: 'var(--gold-dim)', border: '1px solid rgba(212,176,98,0.35)',
                  borderRadius: 0, padding: '1px 8px', color: 'var(--gold)',
                  fontSize: 11, fontWeight: 600,
                }}>All represented ({players.length})</span>
              ) : (
                linked.map(p => (
                  <span key={p.id} className="task-linked-chip" style={{
                    background: 'var(--gold-dim)', border: '1px solid rgba(212,176,98,0.2)',
                    borderRadius: 0, padding: '1px 7px', color: 'var(--gold)', fontSize: 11,
                    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{p.fullName}</span>
                ))
              )}
            </span>
          )}
        </div>

        {t.notes && (
          <div style={{
            marginTop: 8, fontSize: 12.5, color: 'var(--text-2)',
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            paddingTop: 8, borderTop: '1px solid var(--border)',
          }}>
            {t.notes}
          </div>
        )}
      </div>

      {/* Edit + Delete actions */}
      {canEdit && <RowActions onEdit={onEdit} onDelete={onDelete} />}
    </div>
  );
}
