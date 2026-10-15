// In-house SVG charts for the Snapshot screen and the reports. No library:
// a few hundred records never need one, every mark is clickable (drill-down),
// the drawing is RTL-aware and theme-aware, and the same SVG is rasterised to
// PNG for the Excel and PDF exports (see toPng). Colors are literal hex on
// purpose so the exported picture matches the screen.
import React, { useId, useState } from 'react';

export const PALETTE = ['#C8A24A', '#5B9DE0', '#4DBE7A', '#9C8AE0', '#D9A036', '#E05A55', '#E4C87A', '#48B5C4', '#F472B6', '#8A6B22', '#6F7C70', '#A3E635'];
export const colorAt = (i) => PALETTE[i % PALETTE.length];

const FONT = 'Heebo, Arial, sans-serif';
const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('he-IL', { maximumFractionDigits: 1 }) : String(v ?? ''));
const pct = (s) => `${Math.round((s || 0) * 100)}%`;

/** Props shared by the charts: groups from slice(), the active key, a pick handler. */
const useHover = () => { const [h, setH] = useState(null); return [h, setH]; };

// ── Donut ───────────────────────────────────────────────────────────
export function Donut({ groups, lang = 'he', onPick, active, format = fmt, size = 220, title }) {
  const [hover, setHover] = useHover();
  const total = groups.reduce((s, g) => s + Math.max(0, g.value), 0);
  const r = size / 2 - 6, ri = r * 0.62, cx = size / 2, cy = size / 2;
  let a0 = -Math.PI / 2;
  const arcs = groups.map((g, i) => {
    const frac = total ? Math.max(0, g.value) / total : 0;
    const a1 = a0 + frac * Math.PI * 2;
    const d = arcPath(cx, cy, r, ri, a0, a1);
    const mid = (a0 + a1) / 2;
    a0 = a1;
    return { g, i, d, frac, mid };
  });
  const shown = hover != null ? arcs[hover] : null;
  return (
    <div className="chart donut" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title} style={{ flexShrink: 0, fontFamily: FONT, color: 'var(--text-1)' }}>
        {arcs.map(({ g, i, d, frac }) => frac > 0 && (
          <path key={g.key} d={d} fill={colorAt(i)} stroke="var(--surface-1)" strokeWidth={1.5}
            opacity={active && active !== g.key ? 0.35 : hover != null && hover !== i ? 0.6 : 1}
            style={{ cursor: onPick ? 'pointer' : 'default', transition: 'opacity .12s' }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            onClick={() => onPick && onPick(g.key)}>
            <title>{`${g.label[lang]}: ${format(g.value)} (${pct(g.share)})`}</title>
          </path>
        ))}
        {total === 0 && <circle cx={cx} cy={cy} r={(r + ri) / 2} fill="none" stroke="var(--border-2)" strokeWidth={r - ri} />}
        <text x={cx} y={cy - 4} textAnchor="middle" fill="currentColor" fontSize={size > 160 ? 26 : 18} fontWeight={700} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {shown ? format(shown.g.value) : format(total)}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" fill="var(--text-3)" fontSize={11}>
          {shown ? shown.g.label[lang] : (lang === 'he' ? 'סה״כ' : 'Total')}
        </text>
      </svg>
      <Legend groups={groups} lang={lang} onPick={onPick} active={active} format={format} hover={hover} setHover={setHover} />
    </div>
  );
}

function arcPath(cx, cy, r, ri, a0, a1) {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const [x0, y0] = p(r, a0), [x1, y1] = p(r, a1), [x2, y2] = p(ri, a1), [x3, y3] = p(ri, a0);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${ri},${ri} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
}

export function Legend({ groups, lang, onPick, active, format = fmt, hover, setHover }) {
  return (
    <ul className="chart-legend" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 160px' }}>
      {groups.map((g, i) => (
        <li key={g.key} onClick={() => onPick && onPick(g.key)}
          onMouseEnter={() => setHover && setHover(i)} onMouseLeave={() => setHover && setHover(null)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: onPick ? 'pointer' : 'default', padding: '3px 4px',
            background: hover === i || active === g.key ? 'var(--gold-dim)' : 'transparent', opacity: active && active !== g.key ? 0.6 : 1 }}>
          <span style={{ width: 10, height: 10, background: colorAt(i), flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label[lang]}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{format(g.value)}</span>
          <span style={{ color: 'var(--text-3)', fontSize: 11, width: 34, textAlign: 'end' }}>{pct(g.share)}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Horizontal bars (one row per group) ─────────────────────────────
export function Bars({ groups, lang = 'he', onPick, active, format = fmt, width = 520, rowH = 26, title, rtl = true }) {
  const [hover, setHover] = useHover();
  const max = Math.max(1, ...groups.map((g) => g.value));
  const labelW = Math.min(180, Math.max(90, ...groups.map((g) => g.label[lang].length * 7 + 12)));
  const valueW = 64;
  const barW = Math.max(60, width - labelW - valueW - 16);
  const h = groups.length * rowH + 8;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${h}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }} direction={rtl ? 'rtl' : 'ltr'}>
      {groups.map((g, i) => {
        const y = 4 + i * rowH;
        const w = Math.max(2, (g.value / max) * barW);
        const dim = (active && active !== g.key) || (hover != null && hover !== i);
        const labelX = rtl ? width - 4 : 4;
        const barX0 = rtl ? width - labelW - 8 : labelW + 8;
        const barX = rtl ? barX0 - w : barX0;
        const valX = rtl ? barX0 - w - 6 : barX0 + w + 6;
        return (
          <g key={g.key} style={{ cursor: onPick ? 'pointer' : 'default' }} onClick={() => onPick && onPick(g.key)}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} opacity={dim ? 0.5 : 1}>
            <title>{`${g.label[lang]}: ${format(g.value)} (${pct(g.share)})`}</title>
            <rect x={rtl ? 0 : 0} y={y} width={width} height={rowH - 2} fill={hover === i ? 'var(--gold-dim)' : 'transparent'} />
            {/* direction=rtl flips "start" to the right-hand side, so "start" is right in both modes */}
            <text x={labelX} y={y + rowH / 2 + 4} textAnchor="start" fill="currentColor" fontSize={12}>{truncate(g.label[lang], Math.floor(labelW / 7))}</text>
            <rect x={barX} y={y + 5} width={w} height={rowH - 12} fill={colorAt(i)} />
            <text x={valX} y={y + rowH / 2 + 4} textAnchor="start" fill="var(--text-2)" fontSize={11.5} style={{ fontVariantNumeric: 'tabular-nums' }}>{format(g.value)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Columns (temporal dimensions, trends) ───────────────────────────
export function Columns({ groups, lang = 'he', onPick, active, format = fmt, width = 520, height = 200, title, color = PALETTE[0], rtl = true }) {
  const [hover, setHover] = useHover();
  const n = groups.length || 1;
  const max = Math.max(1, ...groups.map((g) => g.value));
  const padB = 34, padT = 18, padX = 8;
  const innerW = width - padX * 2, innerH = height - padB - padT;
  const slot = innerW / n, bw = Math.min(46, slot * 0.66);
  const ordered = rtl ? [...groups].reverse() : groups;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }}>
      {ticks.map((tv, i) => {
        const y = padT + innerH - (tv / max) * innerH;
        return <g key={i}><line x1={padX} x2={width - padX} y1={y} y2={y} stroke="var(--border)" strokeDasharray={i ? '2 3' : ''} /></g>;
      })}
      {ordered.map((g, j) => {
        const i = groups.indexOf(g);
        const x = padX + j * slot + (slot - bw) / 2;
        const bh = (g.value / max) * innerH;
        const y = padT + innerH - bh;
        const dim = (active && active !== g.key) || (hover != null && hover !== i);
        return (
          <g key={g.key} style={{ cursor: onPick ? 'pointer' : 'default' }} onClick={() => onPick && onPick(g.key)}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} opacity={dim ? 0.5 : 1}>
            <title>{`${g.label[lang]}: ${format(g.value)}`}</title>
            <rect x={x} y={y} width={bw} height={Math.max(bh, g.value ? 2 : 0)} fill={color} />
            {g.value > 0 && <text x={x + bw / 2} y={y - 4} textAnchor="middle" fill="var(--text-2)" fontSize={10.5} style={{ fontVariantNumeric: 'tabular-nums' }}>{format(g.value)}</text>}
            <text x={x + bw / 2} y={height - padB + 14} textAnchor="middle" fill="var(--text-3)" fontSize={10.5}
              transform={n > 8 ? `rotate(-35 ${x + bw / 2} ${height - padB + 14})` : undefined}>{truncate(g.label[lang], n > 8 ? 9 : 14)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Line (trend) ────────────────────────────────────────────────────
export function Line({ points, lang = 'he', width = 520, height = 160, title, color = PALETTE[1], rtl = true, format = fmt }) {
  const n = points.length || 1;
  const max = Math.max(1, ...points.map((p) => p.value));
  const padB = 26, padT = 14, padX = 14;
  const innerW = width - padX * 2, innerH = height - padB - padT;
  const ordered = rtl ? [...points].reverse() : points;
  const xy = ordered.map((p, j) => [padX + (n === 1 ? innerW / 2 : (j / (n - 1)) * innerW), padT + innerH - (p.value / max) * innerH]);
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${xy[xy.length - 1]?.[0] ?? 0},${padT + innerH} L${xy[0]?.[0] ?? 0},${padT + innerH} Z`;
  const last = rtl ? xy[0] : xy[xy.length - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }}>
      <line x1={padX} x2={width - padX} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-2)" />
      <path d={area} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {xy.map(([x, y], j) => (
        <g key={ordered[j].key}>
          <title>{`${ordered[j].label[lang]}: ${format(ordered[j].value)}`}</title>
          <circle cx={x} cy={y} r={last === xy[j] ? 4 : 2.5} fill={color} />
          {(n <= 8 || j % 2 === 0) && <text x={x} y={height - 6} textAnchor="middle" fill="var(--text-3)" fontSize={10}>{ordered[j].label[lang]}</text>}
        </g>
      ))}
      {last && <text x={last[0]} y={last[1] - 8} textAnchor="middle" fill="currentColor" fontSize={11} fontWeight={700}>{format(rtl ? points[points.length - 1].value : points[points.length - 1].value)}</text>}
    </svg>
  );
}

// ── Multi-line (several monthly series on one time axis) ────────────
// Legend click hides/shows a series; the axis is left-to-right time in both
// languages (a timeline reads that way even in Hebrew), labels are localised.
export function MultiLine({ series, lang = 'he', width = 760, height = 220, title, format = fmt }) {
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useHover();
  const shown = series.filter((s) => !hidden.has(s.id));
  const keys = series[0]?.points.map((p) => p.key) ?? [];
  const n = keys.length || 1;
  const max = Math.max(1, ...shown.flatMap((s) => s.points.map((p) => p.value)));
  const padB = 28, padT = 16, padL = 34, padR = 24;
  const innerW = width - padL - padR, innerH = height - padB - padT;
  const X = (j) => padL + (n === 1 ? innerW / 2 : (j / (n - 1)) * innerW);
  const Y = (v) => padT + innerH - (v / max) * innerH;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const toggle = (id) => setHidden((h) => { const next = new Set(h); next.has(id) ? next.delete(id) : next.add(id); return next; });
  return (
    <div className="chart multiline" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }} direction="ltr">
        {ticks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={Y(tv)} y2={Y(tv)} stroke="var(--border)" strokeDasharray={i ? '2 3' : ''} />
            <text x={padL - 6} y={Y(tv) + 3.5} textAnchor="end" fill="var(--text-3)" fontSize={10} style={{ fontVariantNumeric: 'tabular-nums' }}>{format(tv)}</text>
          </g>
        ))}
        {hover != null && <line x1={X(hover)} x2={X(hover)} y1={padT} y2={padT + innerH} stroke="var(--border-2)" />}
        {shown.map((s) => {
          const i = series.indexOf(s);
          const color = s.color || colorAt(i);
          const path = s.points.map((p, j) => `${j ? 'L' : 'M'}${X(j).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
          return (
            <g key={s.id}>
              <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
              {s.points.map((p, j) => (
                <circle key={p.key} cx={X(j)} cy={Y(p.value)} r={hover === j ? 4 : 2.5} fill={color}>
                  <title>{`${s.label[lang]} · ${p.label[lang]}: ${format(p.value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {keys.map((k, j) => (
          <g key={k} onMouseEnter={() => setHover(j)} onMouseLeave={() => setHover(null)}>
            <rect x={X(j) - innerW / n / 2} y={padT} width={innerW / n} height={innerH} fill="transparent" />
            {(n <= 8 || j % 2 === (n - 1) % 2) && <text x={X(j)} y={height - 8} textAnchor="middle" fill="var(--text-3)" fontSize={10}>{series[0].points[j].label[lang]}</text>}
          </g>
        ))}
        {hover != null && shown.map((s, k) => (
          <text key={s.id} x={X(hover) + (hover > n / 2 ? -6 : 6)} y={padT + 10 + k * 12} textAnchor={hover > n / 2 ? 'end' : 'start'} fill={s.color || colorAt(series.indexOf(s))} fontSize={10.5} fontWeight={700}>
            {`${s.label[lang]} ${format(s.points[hover].value)}`}
          </text>
        ))}
      </svg>
      <ul className="chart-legend" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
        {series.map((s, i) => (
          <li key={s.id} onClick={() => toggle(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', opacity: hidden.has(s.id) ? 0.4 : 1, textDecoration: hidden.has(s.id) ? 'line-through' : 'none' }}>
            <span style={{ width: 14, height: 3, background: s.color || colorAt(i), flexShrink: 0 }} />
            <span>{s.label[lang]}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{format(s.total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Funnel (deal pipeline) ──────────────────────────────────────────
// One centred band per stage, width = deals that reached the stage; the
// number inside is how many sit there now, with the commission beside it.
export function Funnel({ steps, lang = 'he', onPick, active, width = 380, rowH = 34, title, money = fmt, rtl = true }) {
  const [hover, setHover] = useHover();
  const top = Math.max(1, steps[0]?.reached ?? 0);
  const labelW = 120, numW = 92;
  const bandW = width - labelW - numW - 16;
  const h = steps.length * rowH + 6;
  const labelX = rtl ? width - 4 : 4;
  const bandX0 = rtl ? numW + 8 : labelW + 8;
  const numX = rtl ? numW : width - numW;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${h}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }} direction={rtl ? 'rtl' : 'ltr'}>
      {steps.map((s, i) => {
        const y = 3 + i * rowH;
        const w = Math.max(6, (s.reached / top) * bandW);
        const x = bandX0 + (bandW - w) / 2;
        const dim = (active && active !== s.key) || (hover != null && hover !== i);
        const done = s.key === 'Contract Signed';
        return (
          <g key={s.key} style={{ cursor: onPick ? 'pointer' : 'default' }} onClick={() => onPick && onPick(s.key)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} opacity={dim ? 0.45 : 1}>
            <title>{`${s.label[lang]}: ${s.at} (${lang === 'he' ? 'הגיעו' : 'reached'} ${s.reached}, ${Math.round(s.share * 100)}%)${s.commission ? ' · ' + money(s.commission) : ''}`}</title>
            <rect x={0} y={y} width={width} height={rowH - 2} fill={hover === i ? 'var(--gold-dim)' : 'transparent'} />
            <text x={labelX} y={y + rowH / 2 + 4} textAnchor="start" fill="currentColor" fontSize={12}>{truncate(s.label[lang], 16)}</text>
            <rect x={x} y={y + 5} width={w} height={rowH - 12} fill={done ? '#4DBE7A' : PALETTE[0]} opacity={done ? 1 : 0.45 + 0.55 * (1 - i / Math.max(1, steps.length - 1))} />
            {s.at > 0 && <text x={bandX0 + bandW / 2} y={y + rowH / 2 + 4} textAnchor="middle" fill={done || i > steps.length / 2 ? '#0A140D' : '#0A140D'} fontSize={12} fontWeight={700} style={{ fontVariantNumeric: 'tabular-nums' }}>{s.at}</text>}
            <text x={numX} y={y + rowH / 2 + 4} textAnchor={rtl ? 'start' : 'end'} fill="var(--text-2)" fontSize={11} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {`${Math.round(s.share * 100)}%${s.commission ? ' · ' + money(s.commission) : ''}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Heat-map (dimension × dimension) ────────────────────────────────
export function Heatmap({ m, lang = 'he', onPick, active, width = 380, cellH = 26, title, rtl = true }) {
  const [hover, setHover] = useHover();
  const rows = m.rowsAxis, cols = m.colsAxis;
  const labelW = Math.min(110, Math.max(56, ...rows.map((a) => a.label[lang].length * 6.5 + 10)));
  const headH = 22, gridW = width - labelW - 8;
  const cw = cols.length ? gridW / cols.length : gridW;
  const h = headH + rows.length * cellH + 4;
  const gx0 = rtl ? 0 : labelW + 8;
  const labelX = rtl ? width - 2 : 2;
  const colX = (j) => gx0 + (rtl ? cols.length - 1 - j : j) * cw;
  const shade = (c) => (m.max ? 0.08 + 0.82 * (c / m.max) : 0);
  const isActive = (r, c) => active && (active.row === r.key || active.col === c.key);
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${h}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }} direction={rtl ? 'rtl' : 'ltr'}>
      {cols.map((c, j) => (
        <text key={c.key} x={colX(j) + cw / 2} y={14} textAnchor="middle" fill={active?.col === c.key ? 'var(--gold)' : 'var(--text-3)'} fontSize={10} fontWeight={active?.col === c.key ? 700 : 400}>
          <title>{`${c.label[lang]}: ${c.total}`}</title>{truncate(c.label[lang], Math.max(3, Math.floor(cw / 6.5)))}
        </text>
      ))}
      {rows.map((r, i) => {
        const y = headH + i * cellH;
        return (
          <g key={r.key}>
            <text x={labelX} y={y + cellH / 2 + 4} textAnchor="start" fill={active?.row === r.key ? 'var(--gold)' : 'currentColor'} fontSize={11.5} fontWeight={active?.row === r.key ? 700 : 400}>
              <title>{`${r.label[lang]}: ${r.total}`}</title>{truncate(r.label[lang], Math.floor(labelW / 6.5))}
            </text>
            {cols.map((c, j) => {
              const cell = m.cells[r.key]?.[c.key];
              const n = cell?.count ?? 0;
              const hot = hover && hover[0] === i && hover[1] === j;
              return (
                <g key={c.key} style={{ cursor: onPick && n ? 'pointer' : 'default' }} onClick={() => n && onPick && onPick(r.key, c.key)}
                  onMouseEnter={() => setHover([i, j])} onMouseLeave={() => setHover(null)}>
                  <title>{`${r.label[lang]} × ${c.label[lang]}: ${n}`}</title>
                  <rect x={colX(j) + 1} y={y + 1} width={cw - 2} height={cellH - 2} fill={n ? PALETTE[0] : 'var(--border)'} opacity={n ? shade(n) : 0.35}
                    stroke={hot || isActive(r, c) ? 'var(--gold)' : 'none'} strokeWidth={hot ? 2 : 1} />
                  {n > 0 && <text x={colX(j) + cw / 2} y={y + cellH / 2 + 4} textAnchor="middle" fill={shade(n) > 0.5 ? '#0A140D' : 'currentColor'} fontSize={11} fontWeight={600} style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{n}</text>}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// ── Contract timeline (Gantt-like, soonest expiry first) ────────────
// Time runs left to right from today; each bar ends where the contract does
// and is coloured by urgency. Click opens the player.
const URGENCY = { expired: '#8A6B22', critical: '#E05A55', warning: '#D9A036', ok: '#4DBE7A' };
export function Timeline({ items, lang = 'he', now, months = 24, width = 760, rowH = 24, title, onPick, rtl = true }) {
  const [hover, setHover] = useHover();
  const today = now ?? new Date();
  const narrow = width < 520;
  const labelW = narrow ? 118 : 170, dayW = narrow ? 44 : 56;
  const axisX0 = rtl ? dayW + 6 : labelW + 8;
  const axisW = width - labelW - dayW - 20;
  const headH = 20;
  const h = headH + items.length * rowH + 6;
  const totalDays = months * 30.4;
  const minDays = Math.min(0, ...items.map((x) => x.daysLeft));
  const span = totalDays - minDays;
  // Hebrew reads the axis right-to-left: today sits beside the names and the
  // future runs leftwards, like a Hebrew Gantt chart.
  const X = (d) => (rtl ? axisX0 + axisW - ((d - minDays) / span) * axisW : axisX0 + ((d - minDays) / span) * axisW);
  const ticks = [];
  for (let k = 0; k <= months; k += months > 12 ? (narrow ? 6 : 3) : 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + k, 1));
    const days = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (days >= minDays && days <= totalDays) ticks.push({ x: X(days), label: `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)}` });
  }
  const labelX = rtl ? width - 4 : 4;
  const dayX = rtl ? dayW : width - dayW;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${h}`} role="img" aria-label={title} style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: width, display: 'block' }} direction={rtl ? 'rtl' : 'ltr'}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} x2={t.x} y1={headH - 4} y2={h - 4} stroke="var(--border)" strokeDasharray="2 3" />
          <text x={t.x} y={11} textAnchor="middle" fill="var(--text-3)" fontSize={9.5} direction="ltr">{t.label}</text>
        </g>
      ))}
      <line x1={X(0)} x2={X(0)} y1={headH - 4} y2={h - 4} stroke="var(--gold)" strokeWidth={1.5} />
      {items.map((it, i) => {
        const y = headH + i * rowH;
        const xa = X(Math.min(0, it.daysLeft)), xb = X(Math.max(0, it.daysLeft));
        const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
        const dim = hover != null && hover !== i;
        return (
          <g key={it.id} style={{ cursor: onPick ? 'pointer' : 'default' }} onClick={() => onPick && onPick(it)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} opacity={dim ? 0.5 : 1}>
            <title>{`${it.name} · ${it.club} · ${it.end} (${it.daysLeft} ${lang === 'he' ? 'ימים' : 'days'})`}</title>
            <rect x={0} y={y} width={width} height={rowH - 1} fill={hover === i ? 'var(--gold-dim)' : 'transparent'} />
            <text x={labelX} y={y + rowH / 2 + 4} textAnchor="start" fill="currentColor" fontSize={11.5}>{truncate(`${it.name}${it.club ? ' · ' + it.club : ''}`, narrow ? 17 : 26)}</text>
            <rect x={x0} y={y + 6} width={Math.max(3, x1 - x0)} height={rowH - 12} fill={URGENCY[it.urgency]} rx={2} />
            <text x={dayX} y={y + rowH / 2 + 4} textAnchor={rtl ? 'start' : 'end'} fill={URGENCY[it.urgency]} fontSize={11} fontWeight={700} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {it.daysLeft < 0 ? (lang === 'he' ? 'פג' : 'expired') : `${it.daysLeft}${lang === 'he' ? ' י׳' : 'd'}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Rasterise an SVG element to a PNG data URL (for Excel / PDF) ────
// CSS variables are resolved to literal colors first, because an <img>
// rendering the SVG has no access to the page's stylesheet.
export async function toPng(svgEl, { scale = 2, light = true } = {}) {
  if (!svgEl) return null;
  // A wrapper element is fine: the first SVG inside it is the chart.
  if (svgEl.tagName?.toLowerCase() !== 'svg') svgEl = svgEl.querySelector('svg');
  if (!svgEl) return null;
  const clone = svgEl.cloneNode(true);
  const vars = light
    ? { '--text-1': '#16201a', '--text-2': '#3b463e', '--text-3': '#6f7c70', '--border': '#e2ddd0', '--border-2': '#cfc8b6', '--surface-1': '#ffffff', '--gold-dim': 'rgba(200,162,74,0.12)' }
    : { '--text-1': '#edf1ec', '--text-2': '#b7c0b8', '--text-3': '#6f7c70', '--border': '#26302a', '--border-2': '#3a463e', '--surface-1': '#0d110e', '--gold-dim': 'rgba(200,162,74,0.12)' };
  const resolve = (v) => String(v).replace(/var\((--[a-z0-9-]+)\)/gi, (_, name) => vars[name] || '#888');
  const all = [clone, ...clone.querySelectorAll('*')];
  for (const el of all) {
    for (const attr of ['fill', 'stroke']) {
      const v = el.getAttribute(attr);
      if (v && v.includes('var(')) el.setAttribute(attr, resolve(v));
      if (v === 'currentColor') el.setAttribute(attr, vars['--text-1']);
    }
    const st = el.getAttribute('style');
    if (st) el.setAttribute('style', resolve(st).replace(/color:\s*[^;]+;?/, ''));
    el.removeAttribute('class');
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = (clone.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  const w = vb[2] || Number(clone.getAttribute('width')) || 520;
  const h = vb[3] || Number(clone.getAttribute('height')) || 200;
  clone.setAttribute('width', String(w)); clone.setAttribute('height', String(h));
  clone.style.maxWidth = ''; clone.style.color = vars['--text-1'];
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = light ? '#ffffff' : '#0d110e'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
}
