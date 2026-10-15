// Snapshot: one board, many charts, cross-filtering.
//
// Everything is on screen at once: the KPI tiles, then a grid of charts per
// area (players, deals, matches, requirements, tasks, activity). Clicking any
// slice, bar or tile adds a filter to the bar at the top; every chart and
// tile recomputes on the filtered set. A chart never hides its own values:
// it is computed with every filter except the one on its own dimension
// (faceted search), so picking "represented" in the stage donut highlights
// that slice and re-cuts all the OTHER charts to represented players, and the
// tile "in process" keeps its number instead of dropping to zero. Filters on
// one area translate to the others through the players (deals of youth
// players, matches of represented players). Clicking the active slice again
// removes its filter. The filter state and period live in the URL.
// The engine is packages/domain/src/engines/analytics.ts; this is the view.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listenCollection, PATHS } from 'lib/db';
import { t, getLang } from 'lib/i18n';
import { toast, SortTh, Skeleton } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { Donut, Bars, Columns, toPng } from 'lib/charts/Charts';
import {
  SOURCE_LABELS, PERIOD_LABELS, buildCtx, applyFilters, slice, kpis, measure as measureOf,
  dimension, decodeState, encodeState, drillInto, COLUMNS, recordPath, formatValue, DEFAULT_STATE,
} from '@goldas/domain';

const PERIODS = ['all', 'season', 'quarter', 'month', 'next90', 'last12m'];
const TONE = { good: 'var(--green-ok)', warning: 'var(--amber)', critical: 'var(--red)', gold: 'var(--gold)', neutral: 'var(--text-3)' };

// The board. Each chart: a source, a dimension, an optional measure and an
// optional fixed filter of its own (matches by player, upcoming only).
const BOARD = [
  { source: 'players', charts: [
    { dim: 'stage', type: 'donut' },
    { dim: 'category', type: 'donut' },
    { dim: 'ageGroup', type: 'columns' },
    { dim: 'position', type: 'bars', topN: 8 },
    { dim: 'club', type: 'bars', topN: 8 },
    { dim: 'country', type: 'donut', topN: 6 },
    { dim: 'contractStatus', type: 'donut' },
    { dim: 'contractEndQ', type: 'columns', fixed: [{ dim: 'stage', value: 'represented' }], title: { he: 'סיומי חוזה (מיוצגים)', en: 'Contract expiries (represented)' } },
    { dim: 'addedMonth', type: 'columns', title: { he: 'שחקנים חדשים לפי חודש', en: 'New players per month' } },
  ] },
  { source: 'deals', charts: [
    { dim: 'dealStage', type: 'donut' },
    { dim: 'dealStage', measure: 'commission', type: 'bars', title: { he: 'עמלות לפי שלב עסקה', en: 'Commission by deal stage' } },
    { dim: 'club', type: 'bars', topN: 8 },
    { dim: 'closedMonth', type: 'columns' },
  ] },
  { source: 'matches', charts: [
    { dim: 'month', type: 'columns' },
    { dim: 'player', type: 'bars', topN: 8, fixed: [{ dim: 'when', value: 'upcoming' }], title: { he: 'משחקים קרובים לפי שחקן', en: 'Upcoming matches by player' } },
    { dim: 'category', type: 'donut' },
    { dim: 'homeAway', type: 'donut' },
  ] },
  { source: 'requirements', charts: [
    { dim: 'reqStatus', type: 'donut' },
    { dim: 'position', type: 'bars', topN: 8 },
    { dim: 'country', type: 'donut', topN: 6 },
  ] },
  { source: 'tasks', charts: [
    { dim: 'taskStatus', type: 'donut' },
    { dim: 'owner', type: 'bars', topN: 8 },
  ] },
  { source: 'interactions', charts: [
    { dim: 'kind', type: 'donut' },
    { dim: 'month', type: 'columns' },
  ] },
];
// Tiles whose filters define the tile itself (click = toggle that filter). The
// rest (contracts ending, representation ending) only narrow to represented.
const FILTER_TILES = new Set(['represented', 'in_process', 'tracking', 'signed_season', 'matches_week', 'open_reqs', 'overdue_tasks', 'no_contract']);
const chartKey = (c) => `${c.source}:${c.dim}:${c.measure || 'count'}${c.fixed ? ':' + c.fixed.map((f) => f.value).join(',') : ''}`;

export default function Snapshot() {
  const lang = getLang() === 'he' ? 'he' : 'en';
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => decodeState(params.toString()), [params]);
  const setState = (next) => setParams(encodeState(next), { replace: false });

  const [data, setData] = useState({ players: null, deals: [], matches: [], requirements: [], tasks: [], trainings: [], interactions: [] });
  useEffect(() => {
    const set = (k) => (rows) => setData((d) => ({ ...d, [k]: rows }));
    const u = [
      listenCollection(PATHS.PLAYERS, set('players')),
      listenCollection(PATHS.DEALS, set('deals')),
      listenCollection(PATHS.MATCHES, set('matches')),
      listenCollection(PATHS.CLUB_REQUIREMENTS, set('requirements')),
      listenCollection(PATHS.TASKS, set('tasks')),
      listenCollection(PATHS.TRAININGS, set('trainings')),
      listenCollection(PATHS.INTERACTIONS, set('interactions')),
    ];
    return () => u.forEach((f) => f());
  }, []);

  if (!data.players) return <Skeleton rows={6} />;
  return <SnapshotView data={data} state={state} setState={setState} lang={lang} />;
}

// Exported for the dev harness (sample data, no Firestore).
export function SnapshotView({ data, state, setState, lang = 'he', now }) {
  const ctx = useMemo(() => buildCtx({ ...data, now }), [data, now]);
  const filters = state.filters;
  const period = state.period;
  const chartRefs = useRef({});
  const [openRecords, setOpenRecords] = useState(null); // source whose records are open
  const [recSort, setRecSort] = useState(null);
  const [limit, setLimit] = useState(60);

  const setFilters = (next) => setState({ ...state, filters: next });
  // Clicking a slice: same dimension replaces, clicking the active one clears it.
  const pick = (dim) => (key) => {
    if (key === '__other' || key === '') return;
    const cur = filters.find((f) => f.dim === dim);
    if (cur && cur.value === key) setFilters(filters.filter((f) => f.dim !== dim));
    else setState(drillInto(state, dim, key));
  };
  const activeOf = (dim) => filters.find((f) => f.dim === dim)?.value;

  // ── Charts: each computed without the filter on its own dimension.
  const charts = useMemo(() => BOARD.flatMap((g) => g.charts.map((c) => {
    const own = filters.filter((f) => f.dim !== c.dim).concat(c.fixed || []);
    const rows = applyFilters(data[g.source] || [], g.source, own, ctx, period);
    const res = slice(rows, g.source, c.dim, c.measure || 'count', ctx, { lang, topN: c.topN, includeUnknown: false });
    return { ...c, source: g.source, key: chartKey({ ...c, source: g.source }), res, rowCount: rows.length };
  })), [data, filters, period, ctx, lang]);

  // ── Per-area record counts on the full filter set.
  const areaRows = useMemo(() => Object.fromEntries(BOARD.map((g) => [g.source, applyFilters(data[g.source] || [], g.source, filters, ctx, period)])), [data, filters, period, ctx]);

  // ── Tiles: each computed without the filters it would itself set, so a
  //    tile never zeroes out because of its own dimension.
  const tiles = useMemo(() => {
    const base = kpis({ ...data, now, filters: [], period });
    const cache = new Map();
    return base.map((k) => {
      const skip = new Set((k.drill?.filters || []).map((f) => f.dim));
      const f = filters.filter((x) => !skip.has(x.dim));
      const key = f.map((x) => `${x.dim}:${x.value}`).join('|');
      if (!cache.has(key)) cache.set(key, kpis({ ...data, now, filters: f, period }));
      return cache.get(key).find((x) => x.id === k.id) || k;
    });
  }, [data, now, filters, period]);

  const columns = openRecords ? COLUMNS[openRecords] : null;
  const records = useMemo(() => {
    if (!openRecords) return [];
    const list = (areaRows[openRecords] || []).map((r) => ({ row: r, cells: Object.fromEntries(columns.map((c) => [c.key, c.get(r, ctx)])) }));
    if (recSort) {
      const { field, dir } = recSort;
      list.sort((a, b) => { const x = a.cells[field], y = b.cells[field]; const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), lang); return dir === 'asc' ? r : -r; });
    }
    return list;
  }, [openRecords, areaRows, columns, ctx, recSort, lang]);

  const filterLabel = (f) => {
    const dm = dimension(f.dim);
    const g = slice(data[dm.sources[0]] || [], dm.sources[0], f.dim, 'count', ctx, { lang, includeUnknown: true }).groups.find((x) => x.key === f.value);
    return `${dm.label[lang]}: ${g ? g.label[lang] : f.value}`;
  };
  const periodLabel = PERIOD_LABELS[period.kind][lang];
  const filterText = filters.length ? filters.map(filterLabel).join(' · ') : t('Everything');
  const titleOf = (c) => c.title ? c.title[lang] : `${c.res.measure.id === 'count' ? SOURCE_LABELS[c.source][lang] : c.res.measure.label[lang]} ${t('by')} ${c.res.dim.label[lang]}`;

  // ── Export: every chart on the board, the tiles and the records of each area.
  const [busy, setBusy] = useState(false);
  const exportAs = async (kind) => {
    if (busy) return;
    setBusy(true);
    const win = kind === 'print' ? window.open('', '_blank') : null;
    try {
      const pngs = await Promise.all(charts.map((c) => toPng(chartRefs.current[c.key]).catch(() => null)));
      const report = {
        filename: `${t('Snapshot')} ${filters.length ? filterText : ''}`.trim(),
        title: t('Snapshot'),
        subtitle: `${filterText} · ${periodLabel}`,
        lang,
        meta: [
          { label: t('Period'), value: periodLabel },
          { label: t('Filter'), value: filterText },
          ...BOARD.map((g) => ({ label: SOURCE_LABELS[g.source][lang], value: String((areaRows[g.source] || []).length) })),
        ],
        kpis: tiles.map((k) => ({ label: k.label[lang], value: formatValue(k.value, k.format, lang) })),
        sections: [
          ...charts.filter((c) => c.res.groups.length).map((c, i) => ({ title: titleOf(c), columns: groupColumns(c.res, lang), rows: groupRows(c.res, lang), chart: pngs[i], totals: c.res.measure.agg !== 'avg' })),
          ...BOARD.filter((g) => (areaRows[g.source] || []).length).map((g) => ({
            title: `${SOURCE_LABELS[g.source][lang]} · ${filterText}`,
            columns: COLUMNS[g.source].map((c) => ({ key: c.key, label: c.label[lang], numeric: c.numeric })),
            rows: areaRows[g.source].map((r) => Object.fromEntries(COLUMNS[g.source].map((c) => [c.key, c.get(r, ctx)]))),
          })),
        ],
      };
      if (kind === 'excel') { const { exportExcel } = await import('lib/report/excel'); await exportExcel(report); }
      else { const { exportPdf } = await import('lib/report/pdf'); await exportPdf(report, { print: kind === 'print', win }); }
    } catch (e) {
      if (win && !win.closed) win.close();
      toast.error(e?.message || t('Export failed.'));
    } finally { setBusy(false); }
  };

  const Chip = ({ active, onClick, children, className = '' }) => <button type="button" className={`chip${active ? ' active' : ''} ${className}`} onClick={onClick}>{children}</button>;
  const fmtFor = (res) => (v) => formatValue(v, res.measure.format, lang);

  return (
    <div className="snapshot">
      {/* ── Period + filters + export */}
      <div className="card card-body snap-toolbar">
        <div className="snap-toolbar-row">
          <div className="chip-group snap-periods">
            {PERIODS.map((p) => <Chip key={p} active={period.kind === p} onClick={() => setState({ ...state, period: { kind: p } })}>{PERIOD_LABELS[p][lang]}</Chip>)}
          </div>
          <span style={{ flex: 1 }} />
          <div className="snap-export">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => exportAs('excel')}><Icon name="external" size={12} /><span className="btn-text">Excel</span><span className="btn-text-sm">XLS</span></button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => exportAs('pdf')}><Icon name="clipboard" size={12} /><span className="btn-text">PDF</span><span className="btn-text-sm">PDF</span></button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => exportAs('print')}><Icon name="external" size={12} /><span className="btn-text">{busy ? t('Exporting…') : t('Print')}</span><span className="btn-text-sm">{t('Print')}</span></button>
          </div>
        </div>
        <div className="snap-filterbar">
          <span className="snap-filterbar-label">{t('Filter')}</span>
          {filters.length === 0 && <span className="snap-filterbar-empty">{t('Click any slice, bar or tile to filter the whole board.')}</span>}
          {filters.map((f) => (
            <button type="button" key={f.dim} className="chip active snap-filter" onClick={() => setFilters(filters.filter((x) => x.dim !== f.dim))} title={t('Remove')}>
              {filterLabel(f)} <span className="snap-filter-x">✕</span>
            </button>
          ))}
          {filters.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters([])}>{t('Clear all')}</button>}
        </div>
      </div>

      {/* ── KPI tiles */}
      <div className="snap-kpis">
        {tiles.map((k) => {
          const on = FILTER_TILES.has(k.id) && (k.drill?.filters || []).length > 0 && (k.drill.filters).every((f) => activeOf(f.dim) === f.value);
          return (
            <button type="button" key={k.id} className={`snap-kpi${on ? ' active' : ''}`} style={{ borderTopColor: TONE[k.tone || 'neutral'] }}
              onClick={() => {
                const own = k.drill?.filters || [];
                if (!own.length) { setOpenRecords(k.drill?.source || 'players'); return; }
                setFilters(on ? filters.filter((f) => !own.some((o) => o.dim === f.dim)) : mergeFilters(filters, own));
              }}>
              <span className="snap-kpi-value" style={{ color: TONE[k.tone || 'neutral'] }}>{formatValue(k.value, k.format, lang)}</span>
              <span className="snap-kpi-label">{k.label[lang]}</span>
            </button>
          );
        })}
      </div>

      {/* ── The board */}
      {BOARD.map((g) => {
        const count = (areaRows[g.source] || []).length;
        const list = charts.filter((c) => c.source === g.source);
        return (
          <section key={g.source} className="snap-area">
            <div className="snap-area-head">
              <h3 className="snap-area-title">{SOURCE_LABELS[g.source][lang]} <b>{count}</b></h3>
              <span style={{ flex: 1 }} />
              <button type="button" className={`btn btn-ghost btn-sm${openRecords === g.source ? ' active' : ''}`} onClick={() => { setOpenRecords(openRecords === g.source ? null : g.source); setLimit(60); setRecSort(null); }}>
                <Icon name="contacts" size={12} /> {openRecords === g.source ? t('Hide records') : t('Show records')}
              </button>
            </div>
            <div className="snap-board">
              {list.map((c) => (
                <div key={c.key} className={`card card-body snap-tile${activeOf(c.dim) ? ' has-active' : ''}`}>
                  <div className="section-label snap-tile-title">{titleOf(c)}</div>
                  {c.res.groups.length === 0 ? <p className="snap-empty">{t('Nothing here for this filter.')}</p> : (
                    <div ref={(el) => { chartRefs.current[c.key] = el; }} className="snap-chart">
                      {c.type === 'donut' && <Donut groups={c.res.groups} lang={lang} onPick={pick(c.dim)} active={activeOf(c.dim)} format={fmtFor(c.res)} size={150} title={titleOf(c)} />}
                      {c.type === 'bars' && <Bars groups={c.res.groups} lang={lang} onPick={pick(c.dim)} active={activeOf(c.dim)} format={fmtFor(c.res)} title={titleOf(c)} rtl={lang === 'he'} width={380} rowH={24} />}
                      {c.type === 'columns' && <Columns groups={c.res.groups} lang={lang} onPick={pick(c.dim)} active={activeOf(c.dim)} format={fmtFor(c.res)} title={titleOf(c)} rtl={lang === 'he'} width={380} height={170} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {openRecords === g.source && (
              <div className="card snap-records">
                <div className="card-body" style={{ paddingBottom: 8, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <div className="section-label" style={{ marginBottom: 0 }}>{t('Records')}</div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gold)' }}>{records.length}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{filterText} · {periodLabel}</span>
                </div>
                {records.length === 0 ? <p className="snap-empty" style={{ padding: '0 20px 18px' }}>{t('Nothing here for this filter.')}</p> : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr>{columns.map((c) => <SortTh key={c.key} label={c.label[lang]} field={c.key} sort={recSort} setSort={setRecSort} />)}<th /></tr></thead>
                      <tbody>
                        {records.slice(0, limit).map(({ row, cells }, i) => {
                          const to = recordPath(g.source, row);
                          return (
                            <tr key={row.id || i}>
                              {columns.map((c) => <td key={c.key} style={{ textAlign: c.numeric ? 'center' : undefined, fontVariantNumeric: 'tabular-nums' }}>{String(cells[c.key] ?? '')}</td>)}
                              <td>{to && <Link to={to} className="btn btn-ghost btn-sm">{t('Open')}</Link>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {records.length > limit && <div className="card-body" style={{ paddingTop: 6 }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit(limit + 100)}>{t('Show more')} ({records.length - limit})</button></div>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

const mergeFilters = (current, extra) => current.filter((f) => !extra.some((e) => e.dim === f.dim)).concat(extra);
const groupColumns = (res, lang) => [
  { key: 'label', label: res.dim.label[lang] },
  { key: 'value', label: res.measure.label[lang], numeric: true },
  ...(res.measure.agg !== 'avg' ? [{ key: 'share', label: lang === 'he' ? 'אחוז' : 'Share' }] : []),
  ...(res.measure.id !== 'count' ? [{ key: 'count', label: lang === 'he' ? 'רשומות' : 'Rows', numeric: true }] : []),
];
const groupRows = (res, lang) => res.groups.map((g) => ({ label: g.label[lang], value: g.value, share: `${Math.round(g.share * 100)}%`, count: g.count }));
