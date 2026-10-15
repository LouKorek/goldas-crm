// Snapshot: the numbers dashboard. Every chart is a question and every click
// is an answer that narrows the whole screen: picking a slice pushes a filter
// (a breadcrumb), the tiles, charts, trend and record list all recompute for
// that slice, and the exports carry exactly what is on screen. The engine is
// packages/domain/src/engines/analytics.ts; this file is only the view.
// The drill state lives in the URL, so refresh, back and shared links work.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listenCollection, PATHS } from 'lib/db';
import { t, getLang } from 'lib/i18n';
import { toast, SortTh, Skeleton } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { Donut, Bars, Columns, Line, toPng } from 'lib/charts/Charts';
import {
  SOURCES, SOURCE_LABELS, PERIOD_LABELS, buildCtx, applyFilters, slice, kpis, monthly, dimensionsFor, measuresFor,
  dimension, decodeState, encodeState, drillInto, drillUp, breadcrumbs, COLUMNS, recordPath, formatValue, DEFAULT_STATE,
} from '@goldas/domain';

const PERIODS = ['all', 'season', 'quarter', 'month', 'next90', 'last12m'];
// The dimensions offered as quick filters per source (the rest live in the chart picker).
const QUICK = {
  players: ['stage', 'category', 'ageGroup', 'club', 'country', 'position'],
  deals: ['dealStage', 'category', 'club', 'owner'],
  matches: ['category', 'ageGroup', 'player', 'club', 'when'],
  requirements: ['reqStatus', 'club', 'country', 'position'],
  tasks: ['taskStatus', 'owner'],
  trainings: ['category', 'ageGroup', 'player'],
  interactions: ['kind', 'owner'],
};
const MINIS = {
  players: ['stage', 'category', 'ageGroup', 'position', 'club', 'contractStatus'],
  deals: ['dealStage', 'category', 'club', 'stageAge'],
  matches: ['category', 'player', 'homeAway', 'when'],
  requirements: ['reqStatus', 'position', 'country'],
  tasks: ['taskStatus', 'owner'],
  trainings: ['category', 'player'],
  interactions: ['kind', 'owner'],
};
const TONE = { good: 'var(--green-ok)', warning: 'var(--amber)', critical: 'var(--red)', gold: 'var(--gold)', neutral: 'var(--text-3)' };

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
  const [chartType, setChartType] = useState('auto');
  const [topN, setTopN] = useState(10);
  const [recSort, setRecSort] = useState(null);
  const [limit, setLimit] = useState(60);
  const mainRef = useRef(null);
  const miniRefs = useRef({});

  const src = state.source;
  const rowsAll = data[src] || [];
  const rows = useMemo(() => applyFilters(rowsAll, src, state.filters, ctx, state.period), [rowsAll, src, state.filters, state.period, ctx]);
  const dims = dimensionsFor(src);
  const measures = measuresFor(src);
  const dimId = dims.some((d) => d.id === state.dim) ? state.dim : dims[0].id;
  const main = useMemo(() => slice(rows, src, dimId, state.measure, ctx, { sort: state.sort, dir: state.dir, lang, topN: topN || undefined, includeUnknown: true }), [rows, src, dimId, state.measure, state.sort, state.dir, lang, topN, ctx]);
  const tiles = useMemo(() => kpis({ ...data, now, filters: state.filters, period: state.period }), [data, now, state.filters, state.period]);
  const crumbs = useMemo(() => breadcrumbs(state, rowsAll, ctx, lang), [state, rowsAll, ctx, lang]);
  const trend = useMemo(() => monthly(rows, src, ctx, 12), [rows, src, ctx]);
  const minis = useMemo(() => (MINIS[src] || []).filter((d) => d !== dimId && !state.filters.some((f) => f.dim === d)).slice(0, 3)
    .map((d) => ({ id: d, res: slice(rows, src, d, 'count', ctx, { lang, topN: 6 }) })), [rows, src, dimId, state.filters, ctx, lang]);
  const columns = COLUMNS[src];
  const records = useMemo(() => {
    const list = rows.map((r) => ({ row: r, cells: Object.fromEntries(columns.map((c) => [c.key, c.get(r, ctx)])) }));
    if (recSort) {
      const { field, dir } = recSort;
      list.sort((a, b) => { const x = a.cells[field], y = b.cells[field]; const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), lang); return dir === 'asc' ? r : -r; });
    }
    return list;
  }, [rows, columns, ctx, recSort, lang]);

  const fmt = (v) => formatValue(v, main.measure.format, lang);
  const pick = (dId) => (key) => { if (key === '__other' || key === '') return; setState(drillInto(state, dId, key)); };
  const type = chartType === 'auto' ? (main.dim.temporal ? 'columns' : main.groups.length > 7 ? 'bars' : 'donut') : chartType;
  const temporal = main.dim.temporal;

  // ── Export: everything on screen, charts included.
  const [busy, setBusy] = useState(false);
  const exportAs = async (kind) => {
    if (busy) return;
    setBusy(true);
    const win = kind === 'print' ? window.open('', '_blank') : null;
    try {
      const mainPng = await toPng(mainRef.current).catch(() => null);
      const miniPngs = await Promise.all(minis.map((m) => toPng(miniRefs.current[m.id]).catch(() => null)));
      const periodLabel = PERIOD_LABELS[state.period.kind][lang];
      const pathLabel = crumbs.map((c) => c.label).join(' › ');
      const report = {
        filename: `${t('Snapshot')} ${SOURCE_LABELS[src][lang]}`,
        title: `${t('Snapshot')} · ${SOURCE_LABELS[src][lang]}`,
        subtitle: `${pathLabel} · ${periodLabel}`,
        lang,
        meta: [
          { label: t('Period'), value: periodLabel },
          { label: t('Slice'), value: pathLabel },
          { label: t('Records'), value: String(rows.length) },
        ],
        kpis: tiles.map((k) => ({ label: k.label[lang], value: formatValue(k.value, k.format, lang) })),
        sections: [
          { title: `${main.measure.label[lang]} ${t('by')} ${main.dim.label[lang]}`, columns: groupColumns(main, lang), rows: groupRows(main, lang), chart: mainPng, totals: main.measure.agg !== 'avg' },
          ...minis.map((m, i) => ({ title: `${t('Count')} ${t('by')} ${m.res.dim.label[lang]}`, columns: groupColumns(m.res, lang), rows: groupRows(m.res, lang), chart: miniPngs[i], totals: true })),
        ],
        records: { title: `${SOURCE_LABELS[src][lang]} · ${pathLabel}`, columns: columns.map((c) => ({ key: c.key, label: c.label[lang], numeric: c.numeric })), rows: records.map((r) => r.cells) },
      };
      if (kind === 'excel') { const { exportExcel } = await import('lib/report/excel'); await exportExcel(report); }
      else { const { exportPdf } = await import('lib/report/pdf'); await exportPdf(report, { print: kind === 'print', win }); }
    } catch (e) {
      if (win && !win.closed) win.close();
      toast.error(e?.message || t('Export failed.'));
    } finally { setBusy(false); }
  };

  const Chip = ({ active, onClick, children }) => <button type="button" className={`chip${active ? ' active' : ''}`} onClick={onClick}>{children}</button>;
  const Select = ({ value, onChange, options, label }) => (
    <label className="snap-select"><span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>
  );

  return (
    <div className="snapshot">
      {/* ── Source + period */}
      <div className="card card-body snap-toolbar">
        <div className="chip-group snap-sources">
          {SOURCES.map((s) => <Chip key={s} active={s === src} onClick={() => setState({ ...DEFAULT_STATE, source: s, dim: dimensionsFor(s)[0].id, period: state.period, filters: state.filters.filter((f) => dimension(f.dim)?.sources.includes(s) || dimension(f.dim)?.sources.includes('players')) })}>{SOURCE_LABELS[s][lang]}</Chip>)}
        </div>
        <div className="chip-group snap-periods">
          {PERIODS.map((p) => <Chip key={p} active={state.period.kind === p} onClick={() => setState({ ...state, period: { kind: p } })}>{PERIOD_LABELS[p][lang]}</Chip>)}
        </div>
      </div>

      {/* ── Breadcrumbs + quick filters */}
      <div className="snap-crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="snap-sep">›</span>}
            <button type="button" className={`snap-crumb${i === crumbs.length - 1 ? ' current' : ''}`} onClick={() => setState(drillUp(state, i))}>
              {c.label} <b>{c.count}</b>
            </button>
          </React.Fragment>
        ))}
        {state.filters.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setState(drillUp(state, -1))}>{t('✕ Clear')}</button>}
        <span style={{ flex: 1 }} />
        <div className="snap-export">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => exportAs('excel')}><Icon name="external" size={12} /><span className="btn-text">Excel</span><span className="btn-text-sm">XLS</span></button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => exportAs('pdf')}><Icon name="clipboard" size={12} /><span className="btn-text">PDF</span><span className="btn-text-sm">PDF</span></button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => exportAs('print')}><Icon name="external" size={12} /><span className="btn-text">{busy ? t('Exporting…') : t('Print')}</span><span className="btn-text-sm">{t('Print')}</span></button>
        </div>
      </div>
      <div className="filter-bar snap-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {(QUICK[src] || []).filter((d) => !state.filters.some((f) => f.dim === d)).map((d) => {
          const res = slice(rows, src, d, 'count', ctx, { lang });
          const dm = dimension(d);
          return (
            <div key={d} className="filter-cell" style={{ minWidth: 140 }}>
              <select value="" onChange={(e) => e.target.value && setState(drillInto(state, d, e.target.value))}>
                <option value="">{dm.label[lang]}{t(': All')}</option>
                {res.groups.map((g) => <option key={g.key} value={g.key}>{g.label[lang]} ({g.count})</option>)}
              </select>
            </div>
          );
        })}
      </div>

      {/* ── KPI tiles */}
      <div className="snap-kpis">
        {tiles.map((k) => (
          <button type="button" key={k.id} className="snap-kpi" style={{ borderTopColor: TONE[k.tone || 'neutral'] }}
            onClick={() => setState({ ...state, source: k.drill.source, dim: k.drill.dim || dimensionsFor(k.drill.source)[0].id, measure: 'count', filters: mergeFilters(state.filters, k.drill.filters || []) })}>
            <span className="snap-kpi-value" style={{ color: TONE[k.tone || 'neutral'] }}>{formatValue(k.value, k.format, lang)}</span>
            <span className="snap-kpi-label">{k.label[lang]}</span>
          </button>
        ))}
      </div>

      {/* ── Main chart */}
      <div className="card card-body snap-main">
        <div className="snap-main-head">
          <div className="section-label" style={{ marginBottom: 0 }}>{main.measure.label[lang]} {t('by')} {main.dim.label[lang]}</div>
          <span style={{ flex: 1 }} />
          <Select label={t('Break down by')} value={dimId} onChange={(v) => setState({ ...state, dim: v })} options={dims.filter((d) => !state.filters.some((f) => f.dim === d.id)).map((d) => [d.id, d.label[lang]])} />
          <Select label={t('Measure')} value={main.measure.id} onChange={(v) => setState({ ...state, measure: v })} options={measures.map((m) => [m.id, m.label[lang]])} />
          <Select label={t('Sort')} value={`${state.sort || (main.dim.order ? 'natural' : 'count')}:${state.dir || ''}`} onChange={(v) => { const [sort, dir] = v.split(':'); setState({ ...state, sort, dir: dir || undefined }); }}
            options={[['count:desc', t('Largest first')], ['count:asc', t('Smallest first')], ['label:asc', t('By name')], ...(main.dim.order ? [['natural:asc', t('Natural order')]] : [])]} />
          <Select label={t('Chart')} value={chartType} onChange={setChartType} options={[['auto', t('Auto')], ['donut', t('Donut')], ['bars', t('Bars')], ['columns', t('Columns')]]} />
          <Select label={t('Show')} value={String(topN)} onChange={(v) => setTopN(Number(v))} options={[['10', t('Top 10')], ['25', t('Top 25')], ['0', t('All')]]} />
        </div>
        {main.groups.length === 0 ? <p className="snap-empty">{t('Nothing here for this slice.')}</p> : (
          <div ref={mainRef} className="snap-chart">
            {type === 'donut' && <Donut groups={main.groups} lang={lang} onPick={pick(dimId)} format={fmt} title={main.dim.label[lang]} />}
            {type === 'bars' && <Bars groups={main.groups} lang={lang} onPick={pick(dimId)} format={fmt} title={main.dim.label[lang]} rtl={lang === 'he'} width={640} />}
            {type === 'columns' && <Columns groups={main.groups} lang={lang} onPick={pick(dimId)} format={fmt} title={main.dim.label[lang]} rtl={lang === 'he'} width={640} height={240} />}
          </div>
        )}
        {temporal && <p className="snap-hint">{t('Tip: click a bar to see only that period.')}</p>}
      </div>

      {/* ── Minis + trend */}
      <div className="snap-minis">
        {minis.map((m) => (
          <div key={m.id} className="card card-body snap-mini">
            <div className="section-label">{t('Count')} {t('by')} {m.res.dim.label[lang]}</div>
            <div ref={(el) => { miniRefs.current[m.id] = el; }}>
              {m.res.dim.temporal
                ? <Columns groups={m.res.groups} lang={lang} onPick={pick(m.id)} rtl={lang === 'he'} width={360} height={170} title={m.res.dim.label[lang]} />
                : <Donut groups={m.res.groups} lang={lang} onPick={pick(m.id)} size={150} title={m.res.dim.label[lang]} />}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setState({ ...state, dim: m.id })}>{t('Open this view')}</button>
          </div>
        ))}
        <div className="card card-body snap-mini">
          <div className="section-label">{t('Trend, last 12 months')}</div>
          <Line points={trend} lang={lang} rtl={lang === 'he'} width={360} height={170} title={t('Trend, last 12 months')} />
          <p className="snap-hint">{t('New {what} per month', { what: SOURCE_LABELS[src][lang] })}</p>
        </div>
      </div>

      {/* ── Records */}
      <div className="card snap-records">
        <div className="card-body" style={{ paddingBottom: 8, display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div className="section-label" style={{ marginBottom: 0 }}>{t('Records')}</div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gold)' }}>{rows.length}</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{crumbs.map((c) => c.label).join(' › ')}</span>
        </div>
        {records.length === 0 ? <p className="snap-empty" style={{ padding: '0 20px 18px' }}>{t('Nothing here for this slice.')}</p> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>{columns.map((c) => <SortTh key={c.key} label={c.label[lang]} field={c.key} sort={recSort} setSort={setRecSort} />)}<th /></tr></thead>
              <tbody>
                {records.slice(0, limit).map(({ row, cells }, i) => {
                  const to = recordPath(src, row);
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
    </div>
  );
}

const mergeFilters = (current, extra) => {
  const out = current.filter((f) => !extra.some((e) => e.dim === f.dim));
  return out.concat(extra);
};
const groupColumns = (res, lang) => [
  { key: 'label', label: res.dim.label[lang] },
  { key: 'value', label: res.measure.label[lang], numeric: true },
  ...(res.measure.agg !== 'avg' ? [{ key: 'share', label: lang === 'he' ? 'אחוז' : 'Share' }] : []),
  ...(res.measure.id !== 'count' ? [{ key: 'count', label: lang === 'he' ? 'רשומות' : 'Rows', numeric: true }] : []),
];
const groupRows = (res, lang) => res.groups.map((g) => ({ label: g.label[lang], value: g.value, share: `${Math.round(g.share * 100)}%`, count: g.count }));
