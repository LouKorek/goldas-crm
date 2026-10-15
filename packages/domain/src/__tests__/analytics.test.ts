import { describe, it, expect } from 'vitest';
import {
  buildCtx, applyFilters, slice, kpis, monthly, encodeState, decodeState, drillInto, drillUp,
  breadcrumbs, parseMoney, DEFAULT_STATE, dimensionsFor, measuresFor, COLUMNS, periodRange,
  matrix, dealFunnel, FUNNEL_STAGES, contractTimeline, trends, urgencyOf,
} from '../engines/analytics';

const now = new Date('2026-10-15T09:00:00Z'); // season 2026/27
const players = [
  { id: 'p1', name: 'Avi', stage: 'represented', category: 'youth', dob: '2010-03-01', primaryPosition: 'CB', currentClub: 'Maccabi Haifa', leagueCountry: 'Israel', contractStatus: 'Under Contract', contractEnd: '2026-12-01', createdAt: '2026-09-02', nationalities: ['Israel', 'France'] },
  { id: 'p2', name: 'Ben', stage: 'represented', category: 'youth', dob: '2011-05-10', primaryPosition: 'ST', currentClub: 'Maccabi Haifa', leagueCountry: 'Israel', contractStatus: 'Free', createdAt: '2026-10-03' },
  { id: 'p3', name: 'Chen', stage: 'represented', category: 'men', dob: '2000-01-01', primaryPosition: 'GK', currentClub: 'Hapoel Tel Aviv', leagueCountry: 'Israel', contractStatus: 'Under Contract', contractEnd: '2027-06-30', createdAt: '2025-01-01' },
  { id: 'p4', name: 'Dana', stage: 'in_process', category: 'women', dob: '2004-07-07', primaryPosition: 'CM', currentClub: 'Valencia', leagueCountry: 'Spain', createdAt: '2026-10-10' },
  { id: 'p5', name: 'Gone', stage: 'represented', category: 'men', deletedAt: 'x' },
];
const deals = [
  { id: 'd1', playerId: 'p1', playerName: 'Avi', category: 'youth', clubName: 'Maccabi Haifa', stage: 'Negotiation', commission: '5,000 €', transferFee: '100k', enteredStageAt: '2026-10-01', createdAt: '2026-09-15' },
  { id: 'd2', playerId: 'p3', playerName: 'Chen', category: 'men', clubName: 'Hapoel Tel Aviv', stage: 'Contract Signed', commission: '12000', closedAt: '2026-09-20', enteredStageAt: '2026-09-20', createdAt: '2026-08-01' },
  { id: 'd3', playerId: 'p4', playerName: 'Dana', category: 'women', clubName: 'Valencia', stage: 'Waiting Response', enteredStageAt: '2026-08-01', createdAt: '2026-08-01' },
];
const matches = [
  { id: 'm1', date: '2026-10-18', homeTeam: 'Maccabi Haifa', awayTeam: 'Beitar', linkedPlayers: ['p1', 'p2'] },
  { id: 'm2', date: '2026-10-01', homeTeam: 'Beitar', awayTeam: 'Hapoel Tel Aviv', linkedPlayers: [] },
  { id: 'm3', date: '2026-11-20', homeTeam: 'X', awayTeam: 'Y', linkedPlayers: ['p4'] },
];
const tasks = [
  { id: 't1', title: 'Call', owner: 'lou@x', dueDate: '2026-10-01', done: false },
  { id: 't2', title: 'Mail', owner: 'lou@x', dueDate: '2026-10-30', done: false },
  { id: 't3', title: 'Old', owner: 'lou@x', dueDate: '2026-09-01', done: true },
];
const input = { players, deals, matches, tasks, now };

describe('analytics engine', () => {
  const ctx = buildCtx(input);

  it('parses money strings', () => {
    expect(parseMoney('5,000 €')).toBe(5000);
    expect(parseMoney('100k')).toBe(100000);
    expect(parseMoney('1.5M')).toBe(1500000);
    expect(parseMoney('')).toBeNull();
  });

  it('slices players by category with shares, skipping deleted rows', () => {
    const rows = applyFilters(players, 'players', [], ctx);
    expect(rows).toHaveLength(4);
    const r = slice(rows, 'players', 'category', 'count', ctx);
    expect(r.groups.map((g) => [g.key, g.count])).toEqual([['men', 1], ['women', 1], ['youth', 2]]);
    expect(r.groups[2].share).toBeCloseTo(0.5);
    expect(r.groups[2].label.he).toBe('נוער');
    expect(r.total).toBe(4);
  });

  it('counts multi-valued keys once per value and sorts free text by count', () => {
    const r = slice(players.slice(0, 4), 'players', 'nationality', 'count', ctx);
    expect(r.groups.map((g) => [g.key, g.count]).sort()).toEqual([['France', 1], ['Israel', 1]]);
    const c = slice(players.slice(0, 4), 'players', 'club', 'count', ctx);
    expect(c.groups[0]).toMatchObject({ key: 'Maccabi Haifa', count: 2 });
  });

  it('computes averages and sums', () => {
    const age = slice(players.slice(0, 4), 'players', 'category', 'avgAge', ctx);
    expect(age.groups.find((g) => g.key === 'youth')?.value).toBe(15.5);
    const money = slice(deals, 'deals', 'dealStage', 'commission', ctx);
    expect(money.groups.find((g) => g.key === 'Negotiation')?.value).toBe(5000);
    expect(money.total).toBe(17000);
  });

  it('applies top-N with an "other" bucket', () => {
    const r = slice(players.slice(0, 4), 'players', 'club', 'count', ctx, { topN: 1 });
    expect(r.groups.map((g) => g.key)).toEqual(['Maccabi Haifa', '__other']);
    expect(r.groups[1].count).toBe(2);
  });

  it('drills across sources through the player', () => {
    const f = [{ dim: 'category', value: 'youth' }];
    expect(applyFilters(deals, 'deals', f, ctx).map((d) => d.id)).toEqual(['d1']);
    expect(applyFilters(matches, 'matches', f, ctx).map((m) => m.id)).toEqual(['m1']);
    // Club filter on matches matches either team; a match with no linked ids falls back to the club roster.
    expect(applyFilters(matches, 'matches', [{ dim: 'club', value: 'Hapoel Tel Aviv' }], ctx).map((m) => m.id)).toEqual(['m2']);
    expect(applyFilters(matches, 'matches', [{ dim: 'position', value: 'GK' }], ctx).map((m) => m.id)).toEqual(['m2']);
  });

  it('filters by period on the source date', () => {
    expect(periodRange({ kind: 'season' }, now)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(applyFilters(players, 'players', [], ctx, { kind: 'month' }).map((p) => p.id)).toEqual(['p2', 'p4']);
    expect(applyFilters(matches, 'matches', [], ctx, { kind: 'next90' }).map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(applyFilters(deals, 'deals', [], ctx, { kind: 'custom', from: '2026-09-01', to: '2026-09-30' }).map((d) => d.id)).toEqual(['d1']);
  });

  it('buckets dates by quarter and month in order', () => {
    const q = slice(players.slice(0, 4), 'players', 'contractEndQ', 'count', ctx);
    expect(q.groups.map((g) => g.key)).toEqual(['2026-Q4', '2027-Q2']);
    expect(q.groups[0].label.he).toBe('רבעון 4 2026');
    const m = slice(players.slice(0, 4), 'players', 'addedMonth', 'count', ctx);
    expect(m.groups.map((g) => g.key)).toEqual(['2025-01', '2026-09', '2026-10']);
  });

  it('builds the KPI tiles', () => {
    const k = Object.fromEntries(kpis(input).map((x) => [x.id, x.value]));
    expect(k.represented).toBe(3);
    expect(k.in_process).toBe(1);
    expect(k.open_deals).toBe(2);
    expect(k.commission).toBe(5000);
    expect(k.signed_season).toBe(1);
    expect(k.contracts90).toBe(1);
    expect(k.matches_week).toBe(1);
    expect(k.overdue_tasks).toBe(1);
    expect(k.no_contract).toBe(1);
    // Filters narrow every tile.
    const y = Object.fromEntries(kpis({ ...input, filters: [{ dim: 'category', value: 'youth' }] }).map((x) => [x.id, x.value]));
    expect(y.represented).toBe(2);
    expect(y.open_deals).toBe(1);
  });

  it('gives a 12-month trend ending this month', () => {
    const tr = monthly(players.slice(0, 4), 'players', ctx, 3);
    expect(tr.map((p) => [p.key, p.value])).toEqual([['2026-08', 0], ['2026-09', 1], ['2026-10', 2]]);
  });

  it('round-trips the drill state through the URL', () => {
    let s = drillInto(DEFAULT_STATE, 'category', 'youth', 'ageGroup');
    s = drillInto(s, 'ageGroup', 'nearim_a');
    s = { ...s, period: { kind: 'season' } };
    const q = encodeState(s);
    expect(q).toBe('dim=stage&f=category%3Ayouth%7CageGroup%3Anearim_a&period=season');
    expect(decodeState(q)).toEqual(s);
    expect(decodeState('source=nope&dim=zzz')).toMatchObject({ source: 'players', dim: 'stage' });
    expect(drillUp(s, 1).filters).toEqual([{ dim: 'category', value: 'youth' }]);
    expect(drillUp(s, -1).filters).toEqual([]);
  });

  it('labels breadcrumbs with counts', () => {
    const s = drillInto(drillInto(DEFAULT_STATE, 'category', 'youth'), 'club', 'Maccabi Haifa');
    expect(breadcrumbs(s, players, ctx)).toEqual([
      { label: 'הכל', count: 4 }, { label: 'נוער', count: 2 }, { label: 'Maccabi Haifa', count: 2 },
    ]);
  });

  it('declares dimensions, measures and columns for every source', () => {
    for (const src of ['players', 'deals', 'matches', 'requirements', 'tasks', 'trainings', 'interactions'] as const) {
      expect(dimensionsFor(src).length).toBeGreaterThan(0);
      expect(measuresFor(src)[0].id).toBe('count');
      expect(COLUMNS[src].length).toBeGreaterThan(2);
    }
    const row = COLUMNS.players.map((c) => c.get(players[0], ctx));
    expect(row.slice(0, 5)).toEqual(['Avi', 'מיוצג', 'נוער', 16, "נערים א'"]);
  });

  // ── stage B ──────────────────────────────────────────────────────
  it('weekday and hour dimensions bucket matches', () => {
    const rows = [
      { id: 'a', date: '2026-10-18', time: '19:00' }, // Sunday
      { id: 'b', date: '2026-10-19', time: '19:30' }, // Monday
      { id: 'c', date: '2026-10-25', time: '7:05' },  // Sunday
      { id: 'd', date: '2026-10-26' },                 // no time
    ];
    const wd = slice(rows, 'matches', 'weekday', 'count', ctx);
    expect(wd.groups.map((g) => [g.key, g.count])).toEqual([['0', 2], ['1', 2]]);
    expect(wd.groups[0].label.he).toBe('ראשון');
    const hr = slice(rows, 'matches', 'hour', 'count', ctx);
    expect(hr.groups.map((g) => [g.key, g.count])).toEqual([['07', 1], ['19', 2]]);
    expect(hr.totalCount).toBe(4);
  });

  it('matrix counts rows by two dimensions with totals and max', () => {
    const live = applyFilters(players, 'players', [], ctx);
    const m = matrix(live, 'players', 'stage', 'position', ctx);
    expect(m.rowsAxis.map((a) => a.key)).toEqual(['in_process', 'represented']); // STAGES order
    expect(m.colsAxis.map((a) => a.key)).toEqual(['GK', 'CB', 'CM', 'ST']); // POSITIONS order
    expect(m.cells.represented.CB.count).toBe(1);
    expect(m.cells.in_process.CM.count).toBe(1);
    expect(m.cells.in_process.GK).toBeUndefined();
    expect(m.max).toBe(1);
    expect(m.total).toBe(4);
    expect(m.rowsAxis[1].total).toBe(3);
    const top = matrix(live, 'players', 'stage', 'position', ctx, { topCols: 2 });
    expect(top.colsAxis).toHaveLength(2);
  });

  it('funnel keeps pipeline order and cumulative reach', () => {
    const f = dealFunnel(deals);
    expect(f.map((s) => s.key)).toEqual(FUNNEL_STAGES);
    expect(FUNNEL_STAGES).not.toContain('Not Relevant');
    const at = Object.fromEntries(f.map((s) => [s.key, s.at]));
    expect(at['Waiting Response']).toBe(1);
    expect(at['Negotiation']).toBe(1);
    expect(at['Contract Signed']).toBe(1);
    const reached = Object.fromEntries(f.map((s) => [s.key, s.reached]));
    expect(reached['Not Contacted']).toBe(3);
    expect(reached['Waiting Response']).toBe(3);
    expect(reached['Initial Talks']).toBe(2);
    expect(reached['Contract Signed']).toBe(1);
    expect(f[0].share).toBe(1);
    expect(f[f.length - 1].share).toBeCloseTo(1 / 3);
    expect(f.find((s) => s.key === 'Negotiation')!.commission).toBe(5000);
  });

  it('contract timeline lists represented players soonest first with urgency', () => {
    const tl = contractTimeline(players, ctx);
    expect(tl.map((x) => x.id)).toEqual(['p1', 'p3']); // p2 has no end, p4 not represented, p5 deleted
    expect(tl[0].daysLeft).toBe(47);
    expect(tl[0].urgency).toBe('critical');
    expect(tl[1].urgency).toBe('ok');
    expect(contractTimeline(players, ctx, { months: 1 }).map((x) => x.id)).toEqual([]);
    expect(urgencyOf(-1)).toBe('expired');
    expect(urgencyOf(120)).toBe('warning');
  });

  it('trends gives one monthly series per source over the same months', () => {
    const t = trends({ players, deals, matches }, ctx, 6);
    const ids = t.map((s) => s.id);
    expect(ids).toEqual(['players', 'deals', 'signed', 'matches']);
    for (const s of t) expect(s.points).toHaveLength(6);
    expect(t[0].points.map((p) => p.key)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(t.find((s) => s.id === 'players')!.points.at(-1)!.value).toBe(2); // p2 + p4 in October
    expect(t.find((s) => s.id === 'signed')!.points.find((p) => p.key === '2026-09')!.value).toBe(1);
    expect(t.find((s) => s.id === 'matches')!.total).toBe(2); // m3 is next month
  });
});
