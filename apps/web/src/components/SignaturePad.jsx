// A drawn signature: a finger on a phone, a mouse or a pen on a computer.
// One component for both places a signature is drawn: the signing page
// (/sign/<token>, pages/SignPage.jsx, in the agency's public look) and the
// agency's own signature in System › Agreements (in the CRM's theme).
//
// The strokes are drawn on screen in the surrounding text colour (so it reads
// in either theme) and handed out as a PNG with dark ink on a transparent
// background, twice the size on screen, which is what goes into the signed
// PDF. onChange gets that PNG as a data: URL, or null once it is cleared.
import React, { useCallback, useEffect, useRef, useState } from 'react';

const EXPORT_SCALE = 2;
const EXPORT_INK = '#111111';       // the PDF's ink: always dark on paper
const MIN_POINTS = 8;               // fewer points than this is a tap, not a signature

function drawStrokes(ctx, strokes, { scale, colour, width }) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = width * scale;
  strokes.forEach((s) => {
    if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0][0] * scale, s[0][1] * scale, (width * scale) / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath();
    ctx.moveTo(s[0][0] * scale, s[0][1] * scale);
    s.slice(1).forEach(([x, y]) => ctx.lineTo(x * scale, y * scale));
    ctx.stroke();
  });
}

export default function SignaturePad({ onChange, label, clearLabel, hint, height = 180, className = '', disabled = false, canvasStyle, clearClassName = '', hintStyle }) {
  const canvas = useRef(null);
  const strokes = useRef([]);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  const paint = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    const { width, height: h } = c.getBoundingClientRect();
    if (c.width !== Math.round(width * ratio) || c.height !== Math.round(h * ratio)) { c.width = Math.round(width * ratio); c.height = Math.round(h * ratio); }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    drawStrokes(ctx, strokes.current, { scale: ratio, colour: getComputedStyle(c).color, width: 2.4 });
  }, []);

  useEffect(() => {
    paint();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(paint) : null;
    if (ro && canvas.current) ro.observe(canvas.current);
    return () => ro?.disconnect();
  }, [paint]);

  const exportPng = () => {
    const c = canvas.current;
    const { width, height: h } = c.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.round(width * EXPORT_SCALE);
    out.height = Math.round(h * EXPORT_SCALE);
    drawStrokes(out.getContext('2d'), strokes.current, { scale: EXPORT_SCALE, colour: EXPORT_INK, width: 2.4 });
    return out.toDataURL('image/png');
  };

  const point = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return [Math.max(0, Math.min(r.width, e.clientX - r.left)), Math.max(0, Math.min(r.height, e.clientY - r.top))];
  };
  const down = (e) => {
    if (disabled) return;
    e.preventDefault();
    canvas.current.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    strokes.current.push([point(e)]);
    paint();
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    strokes.current[strokes.current.length - 1].push(point(e));
    paint();
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const points = strokes.current.reduce((n, s) => n + s.length, 0);
    const has = points >= MIN_POINTS;
    setEmpty(!has);
    onChange?.(has ? exportPng() : null);
  };
  const clear = () => {
    strokes.current = [];
    setEmpty(true);
    paint();
    onChange?.(null);
  };

  return (
    <div className={`sigpad ${className}`} style={{ display: 'grid', gap: 8 }}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        className="sigpad-canvas"
        style={{ width: '100%', height, touchAction: 'none', display: 'block', cursor: disabled ? 'not-allowed' : 'crosshair', borderRadius: 12, ...canvasStyle }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span className="sigpad-hint" style={{ fontSize: 12.5, ...hintStyle }}>{empty ? hint : ''}</span>
        <button type="button" className={`sigpad-clear ${clearClassName}`} onClick={clear} disabled={empty || disabled}>{clearLabel}</button>
      </div>
    </div>
  );
}
