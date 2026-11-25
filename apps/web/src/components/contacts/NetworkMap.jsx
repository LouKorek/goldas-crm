// The relationship map drawn in SVG (no library): each club is a circle with
// its people inside, the agency in the middle. With a few hundred contacts it
// stays readable because names show only when zoomed in, for the selected
// node and its links, and for the chosen way to a club. Pan by dragging (one
// finger on a phone), zoom with the wheel, two fingers or the buttons.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { warmthOf } from '@goldas/domain';
import { t } from 'lib/i18n';

const NODE_GAP = 22;          // distance between people inside a club circle
const CLUB_PAD = 14;          // room between the outer ring and the club circle
const CLUB_GAP = 26;          // room between club circles
const LABELS_AT = 2.5;        // zoom from which every name shows
const FOCUS_K = 2;           // zoom when a node is opened from the lists
const NAME_MAX = 18;          // longer names are cut on the map (the card shows them whole)
const MIN_K = 0.15;
const MAX_K = 4;
const DRAG_PX = 5;            // a press that moves less than this is a click
const HEIGHT = 520;

export const WARMTH_COLOR = { warm: 'var(--green-ok)', cool: 'var(--amber)', cold: 'var(--red)', none: 'var(--text-mute)' };

/** People in rings around the club's centre; returns offsets and the circle radius. */
function ringLayout(n) {
  const out = [];
  let r = n === 1 ? 0 : NODE_GAP;
  let left = n;
  while (left > 0) {
    const fit = r === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * r) / NODE_GAP));
    const take = Math.min(fit, left);
    for (let i = 0; i < take; i++) {
      const a = (2 * Math.PI * i) / take - Math.PI / 2;
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    left -= take;
    r += NODE_GAP;
  }
  const radius = (n <= 1 ? NODE_GAP : r - NODE_GAP) + CLUB_PAD;
  return { offsets: out, radius };
}

/** Club circles on a spiral around the agency, biggest first, never overlapping. */
function layout(net) {
  const members = new Map();
  const loose = [];
  for (const n of net.nodes.values()) {
    if (n.type === 'agency' || n.type === 'club') continue;
    if (n.club && net.nodes.has(n.club)) members.set(n.club, [...(members.get(n.club) || []), n]);
    else loose.push(n);
  }
  const clusters = [...members.entries()].map(([id, list]) => ({ id, node: net.nodes.get(id), list: list.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)) }));
  // Clubs nobody is linked to inside (only reached by a requirement or a knows link) still get a small circle.
  for (const n of net.nodes.values()) if (n.type === 'club' && !members.has(n.id) && (net.adj.get(n.id) || []).length) clusters.push({ id: n.id, node: n, list: [] });
  if (loose.length) clusters.push({ id: '~none', node: { id: '~none', name: t('No club'), type: 'club' }, list: loose });
  clusters.forEach((c) => Object.assign(c, ringLayout(Math.max(1, c.list.length))));
  clusters.sort((a, b) => b.radius - a.radius || a.node.name.localeCompare(b.node.name));

  const placed = [{ x: 0, y: 0, radius: 34 }];   // the agency
  const pos = new Map([['agency', { x: 0, y: 0 }]]);
  let angle = 0;
  for (const c of clusters) {
    let dist = placed[0].radius + c.radius + CLUB_GAP;
    for (let tries = 0; tries < 4000; tries++) {
      const x = dist * Math.cos(angle);
      const y = dist * Math.sin(angle);
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.radius + c.radius + CLUB_GAP)) {
        c.x = x; c.y = y; placed.push(c); break;
      }
      angle += 0.35;
      dist += 2.2;
    }
    pos.set(c.id, { x: c.x, y: c.y });
    c.list.forEach((n, i) => pos.set(n.id, { x: c.x + c.offsets[i][0], y: c.y + c.offsets[i][1] }));
  }
  const xs = placed.map((p) => [p.x - p.radius, p.x + p.radius]).flat();
  const ys = placed.map((p) => [p.y - p.radius, p.y + p.radius]).flat();
  return { clusters, pos, bounds: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } };
}

function Shape({ n, x, y, color, ring }) {
  const common = { style: { fill: color, stroke: ring ? 'var(--text-1)' : 'var(--surface-1)', strokeWidth: ring ? 2.2 : 1.2 } };
  if (n.type === 'player') return <rect x={x - 5} y={y - 5} width={10} height={10} rx={2} {...common} />;
  if (n.type === 'deal') return <rect x={x - 4.5} y={y - 4.5} width={9} height={9} transform={`rotate(45 ${x} ${y})`} {...common} />;
  return <circle cx={x} cy={y} r={6} {...common} />;
}

export default function NetworkMap({ net, selected, onSelect, path, focus, highlight }) {
  const wrap = useRef(null);
  const { clusters, pos, bounds } = useMemo(() => layout(net), [net]);
  const [view, setView] = useState(null);   // { tx, ty, k }
  const pointers = useRef(new Map());
  const drag = useRef(null);

  const fit = () => {
    const el = wrap.current;
    if (!el) return;
    const w = el.clientWidth || 360;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(w / (bounds.x1 - bounds.x0 + 40), HEIGHT / (bounds.y1 - bounds.y0 + 40))));
    setView({ k, tx: w / 2 - ((bounds.x0 + bounds.x1) / 2) * k, ty: HEIGHT / 2 - ((bounds.y0 + bounds.y1) / 2) * k });
  };
  useEffect(fit, [bounds.x0, bounds.x1, bounds.y0, bounds.y1]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Centre on a node asked for from the lists (a contact opened, a way chosen).
  useEffect(() => {
    const p = focus && pos.get(focus);
    const el = wrap.current;
    if (!p || !el) return;
    setView((v) => {
      const k = Math.max(v ? v.k : 1, FOCUS_K);
      return { k, tx: el.clientWidth / 2 - p.x * k, ty: HEIGHT / 2 - p.y * k };
    });
  }, [focus, pos]);

  const zoomAt = (factor, cx, cy) => setView((v) => {
    if (!v) return v;
    const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
    const f = k / v.k;
    return { k, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f };
  });
  const local = (e) => { const r = wrap.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const onWheel = (e) => { e.preventDefault(); const [x, y] = local(e); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, x, y); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e) => {
    pointers.current.set(e.pointerId, local(e));
    drag.current = { moved: 0, target: e.target.closest('[data-node]')?.getAttribute('data-node') || null };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId);
    const cur = local(e);
    if (pointers.current.size === 2) {
      const [other] = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
      const before = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
      const after = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
      if (before > 0) zoomAt(after / before, (cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2);
      if (drag.current) drag.current.moved += DRAG_PX;
    } else {
      const dx = cur[0] - prev[0];
      const dy = cur[1] - prev[1];
      if (drag.current) drag.current.moved += Math.abs(dx) + Math.abs(dy);
      setView((v) => (v ? { ...v, tx: v.tx + dx, ty: v.ty + dy } : v));
    }
    pointers.current.set(e.pointerId, cur);
  };
  const onUp = (e) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (d && pointers.current.size === 0) {
      if (d.moved < DRAG_PX) onSelect(d.target && d.target !== '~none' ? d.target : null);
      drag.current = null;
    }
  };

  const today = net.today;
  const nodeColor = (n) => {
    if (n.type === 'contact') return WARMTH_COLOR[warmthOf((net.last.get(n.id) || { date: '' }).date, today)];
    if (n.type === 'player') return 'var(--blue)';
    if (n.type === 'deal') return 'var(--purple)';
    return 'var(--accent)';
  };

  const sel = selected && net.nodes.has(selected) ? selected : null;
  const selLinks = sel ? (net.adj.get(sel) || []) : [];
  const near = new Set(sel ? [sel, ...selLinks.map((l) => (l.a === sel ? l.b : l.a))] : []);
  const pathIds = new Set((path || []).map((st) => st.node.id));
  const pathLinks = new Set((path || []).filter((st) => st.link).map((st) => st.link));
  const k = view ? view.k : 1;
  const showAll = k >= LABELS_AT;
  const hl = highlight || new Set();

  // Background links: between people and across clubs; never the agency's or "works at" (the circle shows that).
  const background = net.links.filter((l) => l.a !== 'agency' && l.b !== 'agency' && !l.kinds.every((x) => x === 'works_at' || x === 'plays_at'));

  const line = (l, cls, style) => {
    const a = pos.get(l.a); const b = pos.get(l.b);
    if (!a || !b) return null;
    return <line key={`${cls}${l.a}${l.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={style} />;
  };

  return (
    <div className="net-map" style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-1)', overflow: 'hidden' }}>
      <div ref={wrap} style={{ height: HEIGHT, touchAction: 'none', cursor: 'grab', userSelect: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <svg width="100%" height={HEIGHT} role="img" aria-label={t('Relationship map')} style={{ display: 'block' }}>
          {view && (
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
              {clusters.map((c) => (
                <g key={c.id} data-node={c.id === '~none' ? null : c.id} style={{ cursor: 'pointer' }}>
                  <circle cx={c.x} cy={c.y} r={c.radius} style={{ fill: pathIds.has(c.id) || sel === c.id ? 'var(--accent-bg)' : 'var(--surface-2)', stroke: pathIds.has(c.id) || sel === c.id ? 'var(--accent)' : 'var(--border)', strokeWidth: (pathIds.has(c.id) || sel === c.id ? 2 : 1) / k, strokeDasharray: c.id === '~none' ? `${4 / k} ${4 / k}` : undefined }} />
                  {(k > 0.35 || c.radius * k > 30 || pathIds.has(c.id) || sel === c.id) && (
                    <text x={c.x} y={c.y - c.radius - 4 / k} textAnchor="middle" style={{ fontSize: 12 / k, fill: 'var(--text-2)', fontWeight: 600, paintOrder: 'stroke', stroke: 'var(--surface-1)', strokeWidth: 3 / k }}>{c.node.name}</text>
                  )}
                </g>
              ))}
              <g style={{ pointerEvents: 'none' }}>
                {background.map((l) => line(l, 'b', { stroke: 'var(--border-2)', strokeWidth: 1 / k, opacity: sel ? 0.2 : 0.5 }))}
                {selLinks.map((l) => line(l, 's', { stroke: WARMTH_COLOR[warmthOf(l.date, today)], strokeWidth: 2 / k }))}
                {[...pathLinks].map((l) => line(l, 'p', { stroke: 'var(--accent)', strokeWidth: 4 / k, strokeLinecap: 'round' }))}
              </g>
              <g data-node="agency" style={{ cursor: 'pointer' }}>
                <circle cx={0} cy={0} r={16} style={{ fill: 'var(--accent-fill)', stroke: 'var(--surface-1)', strokeWidth: 2 }} />
                <text x={0} y={4} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: 'var(--on-accent)' }}>A&S</text>
              </g>
              {clusters.map((c) => c.list.map((n) => {
                const p = pos.get(n.id);
                const on = near.has(n.id) || pathIds.has(n.id) || hl.has(n.id);
                const label = showAll || on;
                return (
                  <g key={n.id} data-node={n.id} style={{ cursor: 'pointer', opacity: sel && !on ? 0.45 : 1 }}>
                    <Shape n={n} x={p.x} y={p.y} color={nodeColor(n)} ring={n.id === sel || pathIds.has(n.id) || hl.has(n.id)} />
                    {label && <text x={p.x} y={p.y + 6 + 12 / k} textAnchor="middle" style={{ fontSize: 11 / k, fill: 'var(--text-1)', paintOrder: 'stroke', stroke: 'var(--surface-1)', strokeWidth: 3 / k, fontWeight: n.id === sel ? 700 : 400 }}>{n.name.length > NAME_MAX ? `${n.name.slice(0, NAME_MAX - 1)}…` : n.name}</text>}
                  </g>
                );
              }))}
            </g>
          )}
        </svg>
      </div>
      <div style={{ position: 'absolute', insetInlineEnd: 8, top: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" className="btn btn-secondary btn-sm" aria-label={t('Zoom in')} onClick={() => zoomAt(1.4, (wrap.current?.clientWidth || 0) / 2, HEIGHT / 2)}>+</button>
        <button type="button" className="btn btn-secondary btn-sm" aria-label={t('Zoom out')} onClick={() => zoomAt(1 / 1.4, (wrap.current?.clientWidth || 0) / 2, HEIGHT / 2)}>−</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={fit}>{t('Fit')}</button>
      </div>
      <div className="net-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-2)' }}>
        {[['warm', t('Spoke within 3 months')], ['cool', t('Within a year')], ['cold', t('Over a year')], ['none', t('No record')]].map(([w, label]) => (
          <span key={w} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: WARMTH_COLOR[w], display: 'inline-block' }} />{label}</span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--blue)', display: 'inline-block' }} />{t('Player')}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, background: 'var(--purple)', transform: 'rotate(45deg)', display: 'inline-block' }} />{t('Deal')}</span>
        <span>{t('Drag to move, pinch or wheel to zoom, tap for details.')}</span>
      </div>
    </div>
  );
}
