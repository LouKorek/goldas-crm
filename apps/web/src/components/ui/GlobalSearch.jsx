import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { listenCollection, PATHS } from 'lib/db';
import { listenPlayers } from 'data/players';
import { useRole } from 'lib/roleContext';
import { playerName, STAGE_LABELS } from '@goldas/domain';
import { DESTINATIONS } from 'lib/nav';
import { t, getLang } from 'lib/i18n';
import Icon from './Icons';

// One search for everything: players, candidates, clubs, contacts, deals,
// tasks and the screens themselves, plus a few actions. Tolerant to
// Hebrew/English and to spelling: matching is on normalised words. Data is
// subscribed only while the box is open.
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hit = (hay, words) => words.every((w) => hay.includes(w));

export default function GlobalSearch({ open, onClose }) {
  const navigate = useNavigate();
  const { isAdmin, email, canEdit } = useRole();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [players, setPlayers] = useState([]);
  const [clubs, setClubs] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [deals, setDeals] = useState([]);
  const [tasks, setTasks] = useState([]);
  const inputRef = useRef(null);
  const he = getLang() === 'he';

  useEffect(() => {
    if (!open) return;
    setQ(''); setSel(0);
    setTimeout(() => inputRef.current?.focus(), 30);
    const subs = [
      listenPlayers({}, setPlayers),
      listenCollection(PATHS.CLUBS, setClubs),
      listenCollection(PATHS.CONTACTS, setContacts),
      listenCollection(PATHS.DEALS, (rows) => setDeals(rows.filter((d) => !d.closedAt))),
      listenCollection(PATHS.TASKS, (rows) => setTasks(rows.filter((x) => x.owner === email && !x.done))),
    ];
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { subs.forEach((u) => u()); document.removeEventListener('keydown', onKey); };
  }, [open, email, onClose]);

  const results = useMemo(() => {
    const words = norm(q).split(' ').filter(Boolean);
    const out = [];
    if (!words.length) {
      // Empty query: actions and screens.
      if (canEdit) {
        out.push({ kind: 'action', label: t('Add candidate'), icon: 'plus', go: () => navigate('/pipeline/men', { state: { add: true } }) });
        out.push({ kind: 'action', label: t('Add represented player'), icon: 'plus', go: () => navigate('/players', { state: { add: true } }) });
        out.push({ kind: 'action', label: t('Sync matches'), icon: 'refresh', go: () => navigate('/matches', { state: { sync: true } }) });
      }
      for (const d of DESTINATIONS.filter((x) => !x.adminOnly || isAdmin)) out.push({ kind: 'screen', label: d.label, icon: d.icon, go: () => navigate(d.path) });
      return out.slice(0, 12);
    }
    for (const d of DESTINATIONS.filter((x) => !x.adminOnly || isAdmin)) {
      if (hit(norm(d.label), words)) out.push({ kind: 'screen', label: d.label, icon: d.icon, go: () => navigate(d.path) });
    }
    for (const a of [
      { label: t('Add candidate'), path: '/pipeline/men', state: { add: true } },
      { label: t('Add represented player'), path: '/players', state: { add: true } },
      { label: t('Sync matches'), path: '/matches', state: { sync: true } },
    ]) if (canEdit && hit(norm(a.label), words)) out.push({ kind: 'action', label: a.label, icon: 'plus', go: () => navigate(a.path, { state: a.state }) });

    for (const p of players) {
      const hay = norm([playerName(p), p.currentClub, p.primaryPosition, p.agentName, (p.nationalities || []).join(' ')].join(' '));
      if (!hit(hay, words)) continue;
      const st = p.stage || 'represented';
      const sub = [STAGE_LABELS[st]?.[he ? 'he' : 'en'], p.currentClub, p.primaryPosition].filter(Boolean).join(' · ');
      out.push({ kind: 'player', label: playerName(p), sub, icon: 'players', go: () => navigate(st === 'represented' ? `/players/${p.id}` : `/pipeline/${p.category || 'men'}`, { state: st === 'represented' ? undefined : { focus: p.id } }) });
      if (out.length > 40) break;
    }
    for (const c of clubs) {
      if (hit(norm([c.name, ...(c.aliases || [])].join(' ')), words)) out.push({ kind: 'club', label: c.name, sub: (c.aliases || []).join(' · '), icon: 'contacts', go: () => navigate(`/clubs/${c.id}`) });
    }
    for (const c of contacts) {
      if (hit(norm([c.contactName, c.clubName, c.contactRole, c.contactPhone].join(' ')), words)) out.push({ kind: 'contact', label: c.contactName || c.clubName, sub: [c.clubName, c.contactRole].filter(Boolean).join(' · '), icon: 'contacts', go: () => navigate('/contacts', { state: { focus: c.id } }) });
    }
    for (const d of deals) {
      if (hit(norm([d.playerName, d.clubName, d.stage].join(' ')), words)) out.push({ kind: 'deal', label: `${d.playerName} ↔ ${d.clubName}`, sub: t(d.stage), icon: 'clipboard', go: () => navigate(`/pipeline/${d.category || 'men'}`, { state: { focus: d.playerId } }) });
    }
    for (const x of tasks) {
      if (hit(norm([x.title, x.notes].join(' ')), words)) out.push({ kind: 'task', label: x.title, sub: x.dueDate || '', icon: 'tasks', go: () => navigate('/tasks', { state: { focus: x.id } }) });
    }
    return out.slice(0, 30);
  }, [q, players, clubs, contacts, deals, tasks, isAdmin, canEdit, navigate, he]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;
  const KIND = { action: t('Actions'), screen: t('Menu'), player: t('Players'), club: t('Clubs'), contact: t('Contacts'), deal: t('Deals'), task: t('Tasks') };
  const choose = (r) => { onClose(); r.go(); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    if (e.key === 'Enter' && results[sel]) { e.preventDefault(); choose(results[sel]); }
  };

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 400, alignItems: 'flex-start', paddingTop: 'max(8vh, 40px)' }} onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 620, padding: 0, overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border-2)' }}>
          <span style={{ color: 'var(--gold)', display: 'flex' }}><Icon name="search" size={16} /></span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder={t('Search everything…')} aria-label={t('Search')}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-1)', fontSize: 15, fontFamily: 'inherit' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-mute)' }}>{t('Esc to close')}</span>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {results.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>{t('Nothing found')}</div>
          )}
          {results.map((r, i) => {
            const first = i === 0 || results[i - 1].kind !== r.kind;
            return (
              <React.Fragment key={`${r.kind}-${r.label}-${i}`}>
                {first && <div style={{ padding: '10px 14px 4px', fontSize: 9.5, fontWeight: 700, color: 'var(--gold-dk)', letterSpacing: he ? 0 : '0.14em', textTransform: 'uppercase' }}>{KIND[r.kind]}</div>}
                <button onMouseEnter={() => setSel(i)} onClick={() => choose(r)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 44, padding: '8px 14px',
                    background: sel === i ? 'var(--surface-2)' : 'transparent', border: 'none', borderInlineStart: `2px solid ${sel === i ? 'var(--gold)' : 'transparent'}`,
                    color: 'var(--text-1)', cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit',
                  }}>
                  <span style={{ color: sel === i ? 'var(--gold)' : 'var(--text-3)', display: 'flex' }}><Icon name={r.icon} size={15} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                    {r.sub && <div style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</div>}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--text-mute)' }}>{t('Players, candidates, clubs, contacts, deals, tasks')}</div>
      </div>
    </div>,
    document.body,
  );
}
