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
            <text x={labelX} y={y + rowH / 2 + 4} textAnchor={rtl ? 'end' : 'start'} fill="currentColor" fontSize={12}>{truncate(g.label[lang], Math.floor(labelW / 7))}</text>
            <rect x={barX} y={y + 5} width={w} height={rowH - 12} fill={colorAt(i)} />
            <text x={valX} y={y + rowH / 2 + 4} textAnchor={rtl ? 'end' : 'start'} fill="var(--text-2)" fontSize={11.5} style={{ fontVariantNumeric: 'tabular-nums' }}>{format(g.value)}</text>
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
