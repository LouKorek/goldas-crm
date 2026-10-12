import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listenCollection, PATHS } from 'lib/db';
import { listenPlayers, promoteToRepresented } from 'data/players';
import { listenDeals, openDeal, advanceDeal, checkTransition, reopenDeal } from 'data/deals';
import { listenInteractions, addInteraction } from 'data/interactions';
import { fmtDate } from 'lib/constants';
import { useRole } from 'lib/roleContext';
import { t, tv, fmtDateTime, relDays, getLang } from 'lib/i18n';
import { DEAL_STAGES, DEAL_STAGE_LABELS, CLOSED_STAGES, daysInStage, isStale, funnel, playerName, clubKey } from '@goldas/domain';
import { PageHeader, Modal, Empty, Skeleton, useConfirm, toast, ChipGroup, Field, SearchInput } from 'components/ui/UI';
import Icon from 'components/ui/Icons';

// The deals board: one column per stage, a card per deal with the time it
// has sat in that stage. Opening a card shows its history and timeline and
// lets the user move it through the state machine (engines/deals.ts): a
// mandate needs a document or confirmation, a signed contract offers to
// promote the candidate, "not relevant" closes the deal.
const OPEN_STAGES = DEAL_STAGES.filter((s) => !CLOSED_STAGES.includes(s));
const stageLabel = (s) => (getLang() === 'he' ? DEAL_STAGE_LABELS[s] || s : s);

const Days = ({ deal }) => {
  const d = daysInStage(deal);
  if (d === null) return null;
  const stale = isStale(deal);
  return <span title={t('Days in this stage')} style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: stale ? 'var(--red)' : 'var(--text-3)', fontWeight: stale ? 700 : 400 }}>{d} {t('d')}{stale ? ' ⚠' : ''}</span>;
};

function DealCard({ deal, onOpen }) {
  const stale = isStale(deal);
  return (
    <button type="button" onClick={() => onOpen(deal)} className="card" style={{
      display: 'block', width: '100%', textAlign: 'start', padding: '9px 11px', marginBottom: 8, cursor: 'pointer',
      borderInlineStart: `3px solid ${deal.closedAt ? 'var(--text-3)' : stale ? 'var(--red)' : 'var(--gold)'}`, background: 'var(--card)', color: 'inherit', font: 'inherit',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deal.playerName}</span>
        <Days deal={deal} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{deal.clubName}</div>
      {deal.category && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>{tv({ men: 'Men', women: 'Women', youth: 'Youth', jewish: 'Jewish abroad' }[deal.category] || deal.category)}</div>}
    </button>
  );
}

function DealDrawer({ deal, players, onClose }) {
  const { canEdit, email } = useRole();
  const { confirm, dialog } = useConfirm();
  const [interactions, setInteractions] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  useEffect(() => listenInteractions({ dealId: deal.id }, setInteractions), [deal.id]);
  const player = players.find((p) => p.id === deal.playerId);
  const he = getLang() === 'he';

  const move = async (stage) => {
    if (!stage || stage === deal.stage) return;
    const check = checkTransition(deal, stage);
    if (!check.ok) { toast.error(check.reason?.[he ? 'he' : 'en'] || t('Not allowed')); return; }
    let confirmed = false;
    if (check.confirm) {
      const ok = await confirm(check.confirm[he ? 'he' : 'en'], { confirmLabel: t('Confirm mandate') });
      if (!ok) return;
      confirmed = true;
    }
    setBusy(true);
    try {
      const fx = await advanceDeal(deal, stage, note.trim(), { confirmed });
      setNote('');
      toast.success(`${stageLabel(stage)} ✓`);
      if (fx?.suggestPromote && player && (player.stage || 'represented') !== 'represented') {
        const ok = await confirm(t('Contract signed — make {name} a represented player?', { name: deal.playerName }), { confirmLabel: t('Promote') });
        if (ok) { await promoteToRepresented(player); toast.success(t('{name} is now represented.', { name: deal.playerName })); }
      }
      if (fx?.freeRequirement) toast.success(t('The requirement is open again.'));
      if (fx?.closed) onClose();
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(false); }
  };
  const reopen = async () => {
    const ok = await confirm(t('Reopen this deal?'), { confirmLabel: t('Reopen') });
    if (!ok) return;
    try { await reopenDeal(deal); toast.success(t('Deal reopened.')); onClose(); } catch (e) { toast.error(e.message); }
  };
  const saveNote = async () => {
    if (!note.trim()) return;
    await addInteraction({ kind: 'note', dealId: deal.id, playerId: deal.playerId, clubId: deal.clubId || '', text: note.trim(), by: email });
    setNote(''); toast.success(t('Note added.'));
  };
  const history = [...(deal.history || [])].reverse();

  return (
    <Modal title={`${deal.playerName} ↔ ${deal.clubName}`} onClose={onClose} wide viewOnly>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <span className="badge" style={{ background: 'var(--gold-dim)', color: 'var(--gold)', fontSize: 12 }}>{stageLabel(deal.stage)}</span>
        <Days deal={deal} />
        {deal.closedAt && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('Closed')} · {fmtDate(deal.closedAt.slice(0, 10))}</span>}
        <span style={{ flex: 1 }} />
        {deal.playerId && <Link to={`/players/${deal.playerId}`} style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>{t('Player 360')} ↗</Link>}
      </div>

      {canEdit && !deal.closedAt && (
        <div className="card card-body" style={{ padding: 12, marginBottom: 14 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>{t('Move to stage')}</div>
          <ChipGroup options={DEAL_STAGES.filter((s) => s !== deal.stage)} labels={DEAL_STAGES.filter((s) => s !== deal.stage).map(stageLabel)} value={target} onChange={setTarget} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Note (optional)')} style={{ flex: 1 }} />
            <button className="btn btn-primary" disabled={!target || busy} onClick={() => move(target)}>{busy ? t('Saving…') : t('Move')}</button>
            <button className="btn btn-ghost" disabled={!note.trim()} onClick={saveNote}>{t('Add note')}</button>
          </div>
          {target === 'Mandate Received' && !(deal.mandateFiles?.length) && !deal.mandateConfirmed && (
            <div className="form-hint" style={{ marginTop: 8 }}>{t('A mandate needs a document or your confirmation that it was received.')}</div>
          )}
          {target === 'Not Relevant' && <div className="form-hint" style={{ marginTop: 8 }}>{t('Closes the deal and frees the club requirement.')}</div>}
        </div>
      )}
      {canEdit && deal.closedAt && <button className="btn btn-secondary" style={{ marginBottom: 14 }} onClick={reopen}>{t('Reopen deal')}</button>}

      <div className="view-grid-2">
        <div>
          <div className="form-section-title">{t('History')}</div>
          {history.length === 0 ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>—</p> : history.map((h, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--rule)', fontSize: 12.5 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', minWidth: 92 }}>{fmtDateTime(h.at)}</span>
              <span style={{ flex: 1 }}>{stageLabel(h.stage)}{h.note ? <span style={{ color: 'var(--text-3)' }}> · {h.note}</span> : null}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{String(h.by || '').split('@')[0]}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="form-section-title">{t('Timeline')}</div>
          {interactions.length === 0 ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{t('No interactions yet.')}</p> : interactions.slice(0, 30).map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--rule)', fontSize: 12.5 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', minWidth: 92 }}>{fmtDateTime(x.at)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--gold)', minWidth: 56, paddingTop: 2 }}>{t(x.kind)}</span>
              <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{x.text}</span>
            </div>
          ))}
        </div>
      </div>
      {dialog}
    </Modal>
  );
}

function NewDealModal({ players, clubs, requirements, onClose }) {
  const [q, setQ] = useState('');
  const [player, setPlayer] = useState(null);
  const [club, setClub] = useState('');
  const [reqId, setReqId] = useState('');
  const [stage, setStage] = useState('Initial Talks');
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => players.filter((p) => (p.stage || 'represented') !== 'not_relevant' && playerName(p).toLowerCase().includes(q.toLowerCase())).slice(0, 12), [players, q]);
  const clubNames = useMemo(() => {
    const seen = new Map();
    clubs.forEach((c) => { const n = (c.name || c.clubName || '').trim(); if (n && !seen.has(clubKey(n))) seen.set(clubKey(n), n); });
    requirements.forEach((r) => { const n = (r.clubName || '').trim(); if (n && !seen.has(clubKey(n))) seen.set(clubKey(n), n); });
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [clubs, requirements]);
  const reqsForClub = requirements.filter((r) => clubKey(r.clubName) === clubKey(club) && r.status !== 'filled' && r.status !== 'closed');
  const save = async () => {
    if (!player || !club.trim()) { toast.error(t('Pick a player and a club.')); return; }
    setBusy(true);
    try {
      const c = clubs.find((x) => clubKey(x.name || x.clubName) === clubKey(club));
      await openDeal(player, { clubId: c?.id || '', clubName: club.trim() }, stage, { requirementId: reqId });
      toast.success(t('Deal opened.')); onClose();
    } catch (e) { toast.error(e.message || t('Save failed.')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={t('New deal')} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn btn-primary" onClick={save} disabled={busy}>{t('Open deal')}</button>
    </>}>
      <Field label={t('Player')} required>
        {player ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><strong>{playerName(player)}</strong><button className="btn btn-ghost btn-sm" onClick={() => setPlayer(null)}>{t('Change')}</button></div>
        ) : (<>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search player…')} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
            {list.map((p) => <button key={p.id} type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => setPlayer(p)}>{playerName(p)} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>· {tv(p.primaryPosition)} · {p.currentClub || tv(p.contractStatus) || ''}</span></button>)}
          </div>
        </>)}
      </Field>
      <Field label={t('Club')} required>
        <input list="deal-clubs" value={club} onChange={(e) => { setClub(e.target.value); setReqId(''); }} placeholder={t('Club name')} />
        <datalist id="deal-clubs">{clubNames.map((n) => <option key={n} value={n} />)}</datalist>
      </Field>
      {reqsForClub.length > 0 && (
        <Field label={t('Club requirement')}>
          <select value={reqId} onChange={(e) => setReqId(e.target.value)}>
            <option value="">{t('None')}</option>
            {reqsForClub.map((r) => <option key={r.id} value={r.id}>{[r.requiredPosition, r.ageMin && r.ageMax ? `${r.ageMin}–${r.ageMax}` : '', r.gender].filter(Boolean).join(' · ') || r.id}</option>)}
          </select>
        </Field>
      )}
      <Field label={t('Stage')}>
        <ChipGroup options={OPEN_STAGES} labels={OPEN_STAGES.map(stageLabel)} value={stage} onChange={setStage} required />
      </Field>
    </Modal>
  );
}

export default function Deals() {
  const { canEdit } = useRole();
  const [deals, setDeals] = useState(null);
  const [players, setPlayers] = useState([]);
  const [clubs, setClubs] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    const u = [listenDeals({}, setDeals), listenPlayers({}, setPlayers), listenCollection(PATHS.CLUBS, setClubs), listenCollection(PATHS.CLUB_REQUIREMENTS, setRequirements)];
    return () => u.forEach((f) => f());
  }, []);
  // Deep link from an alert: /market/deals?deal=<id>
  useEffect(() => {
    const id = params.get('deal');
    if (id && deals) { const d = deals.find((x) => x.id === id); if (d) { setOpen(d); setParams({}, { replace: true }); } }
  }, [params, deals, setParams]);
  // Keep the drawer on the live document.
  useEffect(() => { if (open && deals) { const d = deals.find((x) => x.id === open.id); if (d && d !== open) setOpen(d); } }, [deals]); // eslint-disable-line

  const visible = useMemo(() => (deals || []).filter((d) => {
    if (d.deletedAt) return false;
    if (!showClosed && d.closedAt) return false;
    if (category && d.category !== category) return false;
    if (search && !`${d.playerName} ${d.clubName}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [deals, showClosed, category, search]);
  const counts = useMemo(() => funnel(visible), [visible]);
  const stale = visible.filter((d) => isStale(d)).length;
  const columns = showClosed ? DEAL_STAGES : OPEN_STAGES;

  if (!deals) return <Skeleton rows={6} />;
  return (
    <div>
      <PageHeader title={t('Deals')} subtitle={`${visible.length} ${t('deals')}${stale ? ` · ${stale} ${t('waiting too long')}` : ''}`}
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && <button className="btn btn-primary" style={{ height: 36 }} onClick={() => setAdding(true)}><Icon name="plus" size={12} /><span className="btn-text">{t('New deal')}</span></button>}
          <SearchInput value={search} onChange={setSearch} placeholder={t('Search...')} />
        </div>}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <ChipGroup options={['all', 'men', 'women', 'youth', 'jewish']} labels={[t('All'), t('Men'), t('Women'), t('Youth'), t('Jewish abroad')]} value={category || 'all'} onChange={(v) => setCategory(v === 'all' ? '' : v)} required />
          <button type="button" className={`chip${showClosed ? ' active' : ''}`} onClick={() => setShowClosed((v) => !v)}>{t('Show closed')}</button>
        </div>
      </PageHeader>

      {visible.length === 0 ? <Empty message={t('No deals yet. Open one from a candidate or a club requirement.')} /> : (
        <div className="kanban" style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(220px, 1fr)', gap: 12, overflowX: 'auto', paddingBottom: 12 }}>
          {columns.map((s) => (
            <div key={s} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: '2px solid var(--border-2)' }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{stageLabel(s)}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gold)' }}>{counts[s] || 0}</span>
              </div>
              {visible.filter((d) => d.stage === s).sort((a, b) => (daysInStage(b) ?? 0) - (daysInStage(a) ?? 0)).map((d) => <DealCard key={d.id} deal={d} onOpen={setOpen} />)}
            </div>
          ))}
        </div>
      )}

      {open && <DealDrawer deal={open} players={players} onClose={() => setOpen(null)} />}
      {adding && <NewDealModal players={players} clubs={clubs} requirements={requirements} onClose={() => setAdding(false)} />}
    </div>
  );
}
