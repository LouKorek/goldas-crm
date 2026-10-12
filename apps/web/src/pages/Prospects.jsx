import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listenPlayers } from 'data/players';
import { listenDeals } from 'data/deals';
import { calcAge, fmtDate } from 'lib/constants';
import { useRole } from 'lib/roleContext';
import { t, tv, getLang } from 'lib/i18n';
import { DEAL_STAGES, DEAL_STAGE_LABELS, STAGE_LABELS, CATEGORY_LABELS, playerName, resolveAgeGroup, isYouthAge } from '@goldas/domain';
import { PageHeader, Empty, Skeleton, SearchInput, ChipGroup, FilterBar, SortTh } from 'components/ui/UI';
import Icon from 'components/ui/Icons';

// Every candidate the agency follows, across the four markets, in one place:
// a table or a board by pipeline status. Editing stays on the category
// screens; this is the overview Lou opens to see where everything stands.
const CAT_COLOR = { men: '#4ADE80', women: '#F472B6', youth: '#60A5FA', jewish: '#A78BFA' };
const stageLabel = (s) => (getLang() === 'he' ? DEAL_STAGE_LABELS[s] || s : s);

export const AgeGroupChip = ({ player, size = 9 }) => {
  if (!player?.dob || !isYouthAge(player.dob)) return null;
  const g = resolveAgeGroup(player);
  if (!g) return null;
  return <span title={t('Age group')} style={{ background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.35)', color: '#60A5FA', fontSize: size, fontWeight: 700, padding: '1px 5px', whiteSpace: 'nowrap' }}>{getLang() === 'he' ? g.he : g.en}{player.ageGroupOverride ? ' ✎' : ''}</span>;
};

export default function Prospects() {
  const navigate = useNavigate();
  const { canEdit } = useRole();
  const he = getLang() === 'he';
  const [players, setPlayers] = useState(null);
  const [deals, setDeals] = useState([]);
  const [view, setView] = useState(localStorage.getItem('prospects-view') || 'table');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ field: 'playerName', dir: 'asc' });
  useEffect(() => { localStorage.setItem('prospects-view', view); }, [view]);
  useEffect(() => {
    const u = [listenPlayers({ notStage: 'represented' }, setPlayers), listenDeals({ open: true }, setDeals)];
    return () => u.forEach((f) => f());
  }, []);

  const openDealsOf = useMemo(() => { const m = {}; deals.forEach((d) => { if (!d.deletedAt) (m[d.playerId] = m[d.playerId] || []).push(d); }); return m; }, [deals]);

  const rows = useMemo(() => (players || []).filter((p) => {
    if (p.deletedAt) return false;
    if (!filters.showGone && (p.stage === 'not_relevant')) return false;
    if (filters.category && p.category !== filters.category) return false;
    if (filters.status && p.status !== filters.status) return false;
    if (filters.position && p.primaryPosition !== filters.position) return false;
    if (search && !`${playerName(p)} ${p.currentClub || ''} ${p.primaryPosition || ''} ${p.agentName || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => {
    const av = a[sort.field] ?? '', bv = b[sort.field] ?? '';
    const c = String(av).localeCompare(String(bv));
    return sort.dir === 'asc' ? c : -c;
  }), [players, filters, search, sort]);

  if (!players) return <Skeleton rows={6} />;
  const positions = [...new Set(players.map((p) => p.primaryPosition).filter(Boolean))].sort();
  const Cat = ({ p }) => <span style={{ fontSize: 10, fontWeight: 700, color: CAT_COLOR[p.category] || 'var(--text-3)' }}>{CATEGORY_LABELS[p.category]?.[he ? 'he' : 'en'] || p.category}</span>;
  const Status = ({ p }) => p.status ? <span className="badge" style={{ background: 'var(--gold-dim)', color: 'var(--gold)', fontSize: 10 }}>{stageLabel(p.status)}</span> : <span style={{ color: 'var(--text-3)' }}>—</span>;

  return (
    <div>
      <PageHeader title={t('Candidates')} subtitle={`${rows.length} ${t('candidates across all markets')}`}
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && <Link to={`/pipeline/${filters.category || 'men'}`} state={{ add: true }} className="btn btn-primary" style={{ height: 36, textDecoration: 'none' }}><Icon name="plus" size={12} /><span className="btn-text">{t('Add Player')}</span></Link>}
          <SearchInput value={search} onChange={setSearch} placeholder={t('Search...')} />
        </div>}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <ChipGroup options={['table', 'board']} labels={[t('Table'), t('Board')]} value={view} onChange={setView} required />
          <ChipGroup options={['all', 'men', 'women', 'youth', 'jewish']} labels={[t('All'), t('Men'), t('Women'), t('Youth'), t('Jewish abroad')]} value={filters.category || 'all'} onChange={(v) => setFilters((f) => ({ ...f, category: v === 'all' ? '' : v }))} required />
          <FilterBar filters={filters} setFilters={setFilters} options={[
            { key: 'status', label: t('Status'), values: DEAL_STAGES },
            { key: 'position', label: t('Position'), values: positions },
          ]} />
          <button type="button" className={`chip${filters.showGone ? ' active' : ''}`} onClick={() => setFilters((f) => ({ ...f, showGone: !f.showGone }))}>{t('Show not relevant')}</button>
        </div>
      </PageHeader>

      {rows.length === 0 ? <Empty message={t('No candidates match.')} /> : view === 'board' ? (
        <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(210px, 1fr)', gap: 12, overflowX: 'auto', paddingBottom: 12 }}>
          {DEAL_STAGES.map((s) => {
            const col = rows.filter((p) => (p.status || 'Not Contacted') === s);
            if (!col.length && s === 'Not Relevant') return null;
            return (
              <div key={s}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8, paddingBottom: 6, borderBottom: '2px solid var(--border-2)' }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{stageLabel(s)}</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gold)' }}>{col.length}</span>
                </div>
                {col.map((p) => (
                  <button key={p.id} type="button" className="card" onClick={() => navigate(`/players/${p.id}`)} style={{ display: 'block', width: '100%', textAlign: 'start', padding: '9px 11px', marginBottom: 8, cursor: 'pointer', borderInlineStart: `3px solid ${CAT_COLOR[p.category] || 'var(--gold)'}`, background: 'var(--card)', color: 'inherit', font: 'inherit' }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{playerName(p)}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 2 }}>{[tv(p.primaryPosition), p.dob ? calcAge(p.dob) : null, p.currentClub].filter(Boolean).join(' · ')}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}><Cat p={p} /><AgeGroupChip player={p} />{(openDealsOf[p.id] || []).length > 0 && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>· {openDealsOf[p.id].length} {t('deals')}</span>}</div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="mobile-cards">
            {rows.map((p) => (
              <div key={p.id} className="m-card" onClick={() => navigate(`/players/${p.id}`)}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600, fontSize: 14.5 }}>{playerName(p)}</span> <Cat p={p} /></div>
                  <Status p={p} />
                </div>
                <div className="m-meta" style={{ marginTop: 5 }}>
                  {p.primaryPosition && <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{tv(p.primaryPosition)}</span>}
                  {p.dob && <span>{calcAge(p.dob)}</span>}
                  <AgeGroupChip player={p} />
                  <span>{p.currentClub || tv('Free')}</span>
                  {(openDealsOf[p.id] || []).map((d) => <span key={d.id} className="m-sub">↔ {d.clubName}</span>)}
                </div>
              </div>
            ))}
          </div>
          <div className="card desktop-table" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <SortTh label={t('Name')} field="playerName" sort={sort} setSort={setSort} />
                  <SortTh label={t('Market')} field="category" sort={sort} setSort={setSort} />
                  <SortTh label={t('Status')} field="status" sort={sort} setSort={setSort} />
                  <SortTh label={t('Pos')} field="primaryPosition" sort={sort} setSort={setSort} />
                  <SortTh label={t('Born')} field="dob" sort={sort} setSort={setSort} />
                  <SortTh label={t('Club')} field="currentClub" sort={sort} setSort={setSort} />
                  <th>{t('Open deals')}</th>
                  <th>{t('Stage')}</th>
                </tr></thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id} onClick={() => navigate(`/players/${p.id}`)} style={{ cursor: 'pointer' }}>
                      <td><span style={{ fontWeight: 600 }}>{playerName(p)}</span></td>
                      <td><Cat p={p} /></td>
                      <td><Status p={p} /></td>
                      <td style={{ textAlign: 'center', fontWeight: 500 }}>{tv(p.primaryPosition) || '—'}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{p.dob ? `${fmtDate(p.dob)} (${calcAge(p.dob)})` : '—'} <AgeGroupChip player={p} /></td>
                      <td>{p.currentClub || <span style={{ color: 'var(--text-3)' }}>{tv('Free')}</span>}</td>
                      <td style={{ fontSize: 11.5 }}>{(openDealsOf[p.id] || []).map((d) => <div key={d.id}>{d.clubName} <span style={{ color: 'var(--text-3)' }}>· {stageLabel(d.stage)}</span></div>)}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{STAGE_LABELS[p.stage || 'tracking']?.[he ? 'he' : 'en']}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
