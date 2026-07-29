import React, { useState, useRef, useEffect, useCallback } from 'react';
import { COUNTRIES, formatPhone } from 'lib/constants';
import { resolveFileUrl } from 'lib/db';
import Icon from './Icons';

// ── Toast ─────────────────────────────────────────────────────────
let _addToast = null;
export const toast = {
  success: (msg) => _addToast?.({ msg, type: 'success' }),
  error:   (msg) => _addToast?.({ msg, type: 'error' }),
  warning: (msg) => _addToast?.({ msg, type: 'warning' }),
  info:    (msg) => _addToast?.({ msg, type: 'info' }),
};
export function ToastProvider() {
  const [toasts, setToasts] = useState([]);
  _addToast = useCallback((t) => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { ...t, id }]);
    setTimeout(() => setToasts(p => p.filter(x => x.id !== id)), 3500);
  }, []);
  if (!toasts.length) return null;
  const icons = { success: '✓', error: '✕', warning: '!', info: 'i' };
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type || ''}`}>
          <span style={{ fontSize: 15, opacity: 0.9 }}>{icons[t.type] || 'ℹ'}</span>
          <span style={{ flex: 1 }}>{t.msg}</span>
          <button
            style={{
              background: 'none', border: 'none', color: 'inherit',
              cursor: 'pointer', fontSize: 17, lineHeight: 1, opacity: 0.6,
              transition: 'opacity 0.15s'
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = '1'}
            onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
            onClick={() => setToasts(p => p.filter(x => x.id !== t.id))}
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ── Modal — swipe-to-close on mobile, Esc/Ctrl+Enter on desktop ──
export function Modal({ title, onClose, children, footer, wide, viewOnly, isDirty = false, onSave }) {
  const boxRef = useRef(null);
  const [drag, setDrag] = useState(0);
  const touchStart = useRef({ y: 0, time: 0, dragging: false });

  // Keyboard handlers
  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Escape') {
        if (viewOnly || !isDirty) { onClose(); return; }
        if (window.confirm('Discard unsaved changes?')) onClose();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSave && !viewOnly) {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, viewOnly, isDirty, onSave]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const handleClose = () => {
    if (viewOnly || !isDirty) { onClose(); return; }
    if (window.confirm('Discard unsaved changes?')) onClose();
  };

  // Swipe-to-close (mobile sheet)
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;

  const onTouchStart = (e) => {
    if (!isMobile) return;
    // Only initiate drag if touch starts in header area (top 80px)
    const headerEl = boxRef.current?.querySelector('.modal-header-frozen');
    const targetIsHeader = headerEl?.contains(e.target);
    if (!targetIsHeader) return;
    touchStart.current = { y: e.touches[0].clientY, time: Date.now(), dragging: true };
  };
  const onTouchMove = (e) => {
    if (!isMobile || !touchStart.current.dragging) return;
    const dy = e.touches[0].clientY - touchStart.current.y;
    if (dy > 0) setDrag(dy);
  };
  const onTouchEnd = () => {
    if (!isMobile || !touchStart.current.dragging) return;
    const elapsed = Date.now() - touchStart.current.time;
    const velocity = drag / Math.max(elapsed, 1); // px per ms
    touchStart.current.dragging = false;
    if (drag > 120 || velocity > 0.6) {
      // close
      setDrag(window.innerHeight);
      setTimeout(handleClose, 180);
    } else {
      setDrag(0);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        ref={boxRef}
        className={`modal-box${wide ? ' modal-wide' : ''}`}
        style={drag ? { transform: `translateY(${drag}px)`, transition: touchStart.current.dragging ? 'none' : 'transform 0.2s ease' } : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Header */}
        <div className="modal-header-frozen">
          <span className="modal-grab" />
          <span className="modal-title">{title}</span>
          <button className="modal-close-btn" onClick={handleClose} aria-label="Close"><Icon name="close" size={13} /></button>
        </div>

        {/* Body */}
        <div className="modal-scroll-body">
          {children}
          {footer && (
            <div className="modal-footer-bar">
              {!viewOnly && onSave && (
                <span
                  className="ctrl-enter-hint"
                  style={{ fontSize: 10, color: 'var(--text-3)', marginRight: 'auto', alignSelf: 'center' }}
                >
                  Ctrl+Enter to save
                </span>
              )}
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────
export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback((msg, opts = {}) => new Promise((resolve) => setState({ msg, resolve, ...opts })), []);
  const handleConfirm = useCallback(() => { if (state) { state.resolve(true); setState(null); } }, [state]);
  const handleCancel  = useCallback(() => { if (state) { state.resolve(false); setState(null); } }, [state]);
  useEffect(() => {
    if (!state) return;
    const h = (e) => {
      if (e.key === 'Escape') handleCancel();
      if (e.key === 'Enter')  handleConfirm();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [state, handleCancel, handleConfirm]);
  const dialog = state ? (
    <div className="modal-overlay" style={{ zIndex: 300 }}>
      <div className="modal-box" style={{ maxWidth: 400 }}>
        <div className="modal-header-frozen">
          <span className="modal-title" style={{ fontSize: 17 }}>{state.title || 'Confirm'}</span>
          <button className="modal-close-btn" onClick={handleCancel} aria-label="Close"><Icon name="close" size={13} /></button>
        </div>
        <div className="modal-scroll-body">
          <p style={{ color: 'var(--text-1)', marginBottom: 20, fontSize: 14, lineHeight: 1.6 }}>{state.msg}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
            <button className="btn btn-danger" onClick={handleConfirm}>{state.confirmLabel || 'Delete'}</button>
          </div>
        </div>
      </div>
    </div>
  ) : null;
  return { confirm, dialog };
}

// ── Field ─────────────────────────────────────────────────────────
export function Field({ label, children, hint, error, required }) {
  return (
    <div className="form-field">
      {label && (
        <label className="form-label">
          {label}{required && <span style={{ color: 'var(--red)', marginLeft: 2 }}>*</span>}
        </label>
      )}
      {children}
      {hint  && <div className="form-hint">{hint}</div>}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

// ── Chip group ────────────────────────────────────────────────────
// `required` (single-select only) suppresses the toggle-off behavior so
// clicking the currently selected chip is a no-op — useful where one of the
// options must always be chosen (e.g., view mode on the Matches screen).
export function ChipGroup({ options, value, onChange, multi, labels, required }) {
  const vals = multi ? (Array.isArray(value) ? value : []) : [];
  const isActive = (o) => multi ? vals.includes(o) : value === o;
  const toggle = (o) => {
    if (multi) onChange(vals.includes(o) ? vals.filter(v => v !== o) : [...vals, o]);
    else if (value === o) { if (!required) onChange(''); }
    else                    onChange(o);
  };
  return (
    <div className="chip-group">
      {options.map((o, i) => (
        <button
          key={o}
          type="button"
          className={`chip${isActive(o) ? ' active' : ''}`}
          onClick={() => toggle(o)}
        >
          {labels?.[i] || o}
        </button>
      ))}
    </div>
  );
}

// ── Country select ────────────────────────────────────────────────
export function CountrySelect({ value = [], onChange, single }) {
  const [q, setQ]       = useState('');
  const [open, setOpen] = useState(false);
  const ref             = useRef();
  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const filtered = q ? COUNTRIES.filter(c => c.toLowerCase().includes(q.toLowerCase())) : COUNTRIES;
  const vals     = single ? (value ? [value] : []) : (Array.isArray(value) ? value : []);
  const select = (c) => {
    if (single) { onChange(c); setOpen(false); setQ(''); }
    else onChange(vals.includes(c) ? vals.filter(v => v !== c) : [...vals, c]);
  };
  const display = open ? q : (single ? (value || '') : vals.slice(0, 2).join(', ') + (vals.length > 2 ? ` +${vals.length - 2}` : ''));
  return (
    <div ref={ref} className="dropdown-wrap">
      <div style={{ position: 'relative' }}>
        <input
          value={display}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); if (!open) setQ(''); }}
          placeholder={single ? 'Type country name...' : 'Select countries...'}
        />
        {!single && vals.length > 0 && (
          <button type="button" onClick={() => onChange([])}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', color: 'var(--text-3)',
              cursor: 'pointer', fontSize: 18, lineHeight: 1
            }}>×</button>
        )}
      </div>
      <div className={`dropdown-list${open ? ' open' : ''}`}>
        {!single && (
          <div style={{ padding: '6px 10px', display: 'flex', gap: 8, borderBottom: '1px solid var(--border)' }}>
            <button type="button" className="btn btn-ghost btn-sm" onMouseDown={() => onChange([...COUNTRIES])}>All</button>
            <button type="button" className="btn btn-ghost btn-sm" onMouseDown={() => onChange([])}>Clear</button>
          </div>
        )}
        {filtered.slice(0, 80).map(c => (
          <div key={c} className={`dropdown-item${vals.includes(c) ? ' sel' : ''}`} onMouseDown={() => select(c)}>
            {!single && (
              <input
                type="checkbox" readOnly checked={vals.includes(c)}
                style={{ pointerEvents: 'none', width: 14, height: 14, accentColor: 'var(--gold)' }}
              />
            )}
            {c}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ padding: '10px 12px', color: 'var(--text-3)', fontSize: 12 }}>No results</div>}
      </div>
    </div>
  );
}

export function CountryInput({ value, onChange }) {
  return <CountrySelect value={value} onChange={onChange} single />;
}

// ── Number input ──────────────────────────────────────────────────
export function NumberInput({ value, onChange, placeholder, allowNotSpecified }) {
  const display = value === 'Not specified'
    ? 'Not specified'
    : (value ? Number(String(value).replace(/,/g, '')).toLocaleString() : '');
  return (
    <div>
      <input
        value={display}
        placeholder={placeholder}
        onChange={e => {
          const raw = e.target.value;
          if (raw === '') { onChange(''); return; }
          onChange(raw.replace(/[^0-9]/g, ''));
        }}
      />
      {allowNotSpecified && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onChange(value === 'Not specified' ? '' : 'Not specified')}
          >
            {value === 'Not specified' ? 'Enter value' : 'Not specified'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Phone display ─────────────────────────────────────────────────
export function PhoneDisplay({ phone }) {
  if (!phone) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--text-1)', fontSize: 13 }}>{formatPhone(phone)}</span>
      <PhoneActions phone={phone} />
    </div>
  );
}

// Compact call + WhatsApp icons (icon-only) for table cells. Stacks
// vertically when `vertical` is set. Sized like the action icons.
export function PhoneActions({ phone, vertical }) {
  if (!phone) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const wa = phone.replace(/[^0-9]/g, '');
  const btn = {
    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 0, border: '1px solid var(--border)',
    textDecoration: 'none', fontSize: 11, fontWeight: 700, flexShrink: 0,
    letterSpacing: '0.04em',
    transition: 'border-color 0.12s linear',
  };
  const onEnter = (e) => { e.currentTarget.style.borderColor = 'currentColor'; };
  const onLeave = (e) => { e.currentTarget.style.borderColor = 'var(--border)'; };
  return (
    <span style={{ display: 'inline-flex', flexDirection: vertical ? 'column' : 'row', gap: 4, alignItems: 'center' }}>
      <a href={`tel:${phone}`} title="Call" onMouseEnter={onEnter} onMouseLeave={onLeave}
        style={{ ...btn, background: 'transparent', color: 'var(--blue)' }}>TEL</a>
      <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" title="WhatsApp"
        onMouseEnter={onEnter} onMouseLeave={onLeave}
        style={{ ...btn, background: 'transparent', color: 'var(--green-ok)' }}>WA</a>
    </span>
  );
}

export function LinkIcon({ url, emoji = '🔗', label = '' }) {
  if (!url || url === '-' || url === '') return <span style={{ color: 'var(--text-3)' }}>—</span>;
  const href = url.startsWith('http://') || url.startsWith('https://') ? url : 'https://' + url;
  return (
    <a
      href={href} target="_blank" rel="noopener noreferrer"
      style={{
        color: 'var(--gold)', textDecoration: 'none', fontSize: 18,
        transition: 'transform 0.15s, filter 0.15s', display: 'inline-block'
      }}
      data-tooltip={label || url}
      onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; e.currentTarget.style.filter = 'drop-shadow(0 0 6px rgba(201,168,76,0.5))'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.filter = ''; }}
    >{emoji}</a>
  );
}

// ── Date input ────────────────────────────────────────────────────
// DD/MM/YYYY locked across all browsers. The native <input type="date">
// honours the browser locale, which on most users' machines is en-US
// and renders MM/DD/YYYY — not what we want. So we render a masked text
// box ("__/__/____" feel) AND a small hidden native picker behind a
// calendar button so users can still pick visually if they like.
//
// Storage shape stays ISO YYYY-MM-DD (what Firestore + downstream code
// expects). The component just translates the user-facing display.
export function DateInput({ value, onChange }) {
  const isoToDisplay = (iso) => {
    if (!iso) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const displayToIso = (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m) return null;
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  };

  const [text, setText] = useState(isoToDisplay(value));
  const nativeRef = useRef(null);

  // Keep local text in sync if external value changes (e.g. form reset).
  useEffect(() => { setText(isoToDisplay(value)); }, [value]);

  const onTextInput = (e) => {
    let v = e.target.value.replace(/[^0-9]/g, '').slice(0, 8);
    if (v.length > 4) v = `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4)}`;
    else if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`;
    setText(v);
    const iso = displayToIso(v);
    if (iso) onChange(iso);
    else if (v === '') onChange('');
  };

  const onTextBlur = () => {
    // Snap back to last valid value on blur if partial.
    const iso = displayToIso(text);
    if (!iso) setText(isoToDisplay(value));
  };

  const openNative = () => {
    const el = nativeRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return; } catch {}
    }
    el.focus(); el.click();
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={text}
        onChange={onTextInput}
        onBlur={onTextBlur}
        placeholder="DD/MM/YYYY"
        inputMode="numeric"
        autoComplete="off"
        maxLength={10}
        style={{ paddingRight: 38 }}
      />
      <button type="button" onClick={openNative} tabIndex={-1}
        title="Open calendar"
        style={{
          position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
          width: 30, height: 30, padding: 0,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--gold)', lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icon name="matches" size={14} /></button>
      <input
        ref={nativeRef}
        type="date"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
          width: 30, height: 30, padding: 0,
          opacity: 0, pointerEvents: 'none',
          colorScheme: 'dark',
        }}
      />
    </div>
  );
}

// ── Search input ──────────────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder = 'Search...' }) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{
        position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
        color: 'var(--text-3)', pointerEvents: 'none', display: 'flex',
      }}><Icon name="search" size={13} /></span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="search-input-field"
        style={{ paddingLeft: 30, paddingRight: value ? 28 : 12, height: 36, width: 200 }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', color: 'var(--text-3)',
            cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 4,
          }}
        >×</button>
      )}
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────
export function StatusBadge({ status, colorMap }) {
  if (!status) return null;
  const c = colorMap?.[status] || { bg: 'var(--surface-3)', text: 'var(--text-2)' };
  return <span className="badge" style={{ background: c.bg, color: c.text }}>{status}</span>;
}

export function EUBadge({ is }) {
  return (
    <span className="badge" style={{
      background: is ? 'rgba(96,165,250,0.15)' : 'rgba(248,113,113,0.12)',
      color: is ? 'var(--blue)' : 'var(--red)',
    }}>{is ? '🇪🇺 EU' : 'Non-EU'}</span>
  );
}

export function Spinner({ size = 20 }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Empty({ icon, message = 'No records yet', action }) {
  return (
    <div className="empty-state">
      {/* A ruled void rather than a floating emoji. */}
      <div style={{
        width: 42, height: 1, background: 'var(--gold-dk)',
        margin: '0 auto 18px',
      }} />
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <p style={{
        marginBottom: action ? 18 : 0, fontSize: 12,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-3)',
      }}>{message}</p>
      {action}
    </div>
  );
}

// ── File upload ───────────────────────────────────────────────────
export function FileUpload({ label, onUpload, history = [], accept = '.pdf,.doc,.docx,.jpg,.png' }) {
  const [name, setName]     = useState('');
  const [file, setFile]     = useState(null);
  const [mode, setMode]     = useState(null);
  const [uploading, setUploading] = useState(false);
  const [showH, setShowH]   = useState(false);
  const fileRef             = useRef();
  const handleFile = (f) => {
    if (!f) return;
    setFile(f);
    setName(f.name.split('.')[0]);
    if (history.length > 0) setMode('prompt');
  };
  const doUpload = async (m) => {
    if (!file || !name.trim()) return;
    setUploading(true);
    try { await onUpload(file, name.trim(), m || mode || 'keep'); setFile(null); setName(''); setMode(null); }
    catch (e) { console.error(e); }
    setUploading(false);
  };
  const openHistoryFile = async (h) => {
    let w = null;
    try {
      w = window.open('', '_blank');               // open synchronously to avoid popup block
      const dataUrl = await resolveFileUrl(h);
      if (!dataUrl) { if (w) w.close(); toast.error('File unavailable.'); return; }
      const blob = await (await fetch(dataUrl)).blob();   // Chrome blocks raw data: URL navigation
      const burl = URL.createObjectURL(blob);
      if (w) w.location = burl; else window.open(burl, '_blank');
    } catch { if (w) w.close(); toast.error('Could not open file.'); }
  };
  return (
    <div>
      {history.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowH(!showH)}>
            📎 {history.length} file{history.length > 1 ? 's' : ''} — {showH ? 'Hide' : 'View'} history
          </button>
          {showH && (
            <div style={{
              marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4,
              padding: '8px', background: 'var(--surface-3)', borderRadius: 0
            }}>
              {history.map((h, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <button type="button" onClick={() => openHistoryFile(h)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--gold)', font: 'inherit' }}>
                    📄 {h.name}
                  </button>
                  <span style={{ color: 'var(--text-3)' }}>{new Date(h.uploadedAt).toLocaleDateString('en-GB')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {mode === 'prompt' ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('replace')}>Replace existing</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('keep')}>Keep both</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFile(null); setMode(null); }}>Cancel</button>
        </div>
      ) : file ? (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap',
          background: 'var(--surface-3)', padding: 12, borderRadius: 0,
          border: '1px solid var(--border)'
        }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>File: {file.name}</div>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Enter file name..." />
          </div>
          <div style={{ display: 'flex', gap: 6, paddingTop: 18 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={!name.trim() || uploading} onClick={() => doUpload()}>
              {uploading ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Uploading...</> : '⬆ Upload'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFile(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div
          className="file-drop"
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
        >
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
          <span style={{ fontSize: 13 }}>📎 Click or drag to upload {label}</span>
        </div>
      )}
    </div>
  );
}

// ── Sort header ───────────────────────────────────────────────────
export function SortTh({ label, field, sort, setSort }) {
  const active = sort?.field === field;
  return (
    <th onClick={() => setSort(s => s?.field === field ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' })}>
      {label} {active ? (sort.dir === 'asc' ? '↑' : '↓') : <span style={{ opacity: .25 }}>↕</span>}
    </th>
  );
}

// Filter bar
export function FilterBar({ filters, setFilters, options }) {
  return (
    <div className="filter-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {options.map(opt => (
        <div key={opt.key} style={{ minWidth: 140 }}>
          <select value={filters[opt.key] || ''} onChange={e => setFilters(f => ({ ...f, [opt.key]: e.target.value }))}>
            <option value="">{opt.label}: All</option>
            {opt.values.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      ))}
      {Object.values(filters).some(Boolean) && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters({})}>✕ Clear</button>
      )}
    </div>
  );
}

// ── ExportMenu — dropdown with "Excel" and "PDF" options ──────────
// Use anywhere in a page-header `action` slot. Pass:
//   filename:  base name for the downloaded file (no extension)
//   title:     human title that appears at the top of the export
//   subtitle:  optional context line (e.g. "filtered by Country: Spain")
//   columns:   [{ key, label, width?, format? }, ...]
//   rows:      the array of objects to export (already filtered + sorted
//              by the page — what's on screen is what gets exported).
export function ExportMenu({ filename, title, subtitle, columns, rows }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const run = async (kind) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const mod = await import('lib/exportView');
      const fn = kind === 'pdf' ? mod.exportToPdf : mod.exportToExcel;
      await fn({ filename, title, subtitle, columns, rows });
    } catch (e) {
      toast.error(e?.message || 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(o => !o)}
        disabled={busy || !rows?.length}
        title={rows?.length ? `Export ${rows.length} row${rows.length === 1 ? '' : 's'}` : 'Nothing to export'}
        style={{ height: 36, whiteSpace: 'nowrap' }}
      >
        {busy ? 'Exporting…' : <><Icon name="external" size={12} /> Export</>}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          minWidth: 180, zIndex: 60,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-2)',
          borderRadius: 0,
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          padding: 6,
          animation: 'dropdownIn 0.18s var(--ease-out)',
        }}>
          <button type="button" onClick={() => run('excel')}
            style={menuItemStyle}
            onMouseEnter={menuItemHover} onMouseLeave={menuItemLeave}>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Excel</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)' }}>Styled table with filters</div>
            </div>
          </button>
          <button type="button" onClick={() => run('pdf')}
            style={menuItemStyle}
            onMouseEnter={menuItemHover} onMouseLeave={menuItemLeave}>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>PDF</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)' }}>Branded document</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
const menuItemStyle = {
  display: 'flex', alignItems: 'center', gap: 10,
  width: '100%', padding: '9px 10px',
  background: 'transparent', border: 'none', borderRadius: 0,
  cursor: 'pointer', textAlign: 'left',
  transition: 'background 0.14s',
};
const menuItemHover = (e) => { e.currentTarget.style.background = 'var(--gold-dim)'; };
const menuItemLeave = (e) => { e.currentTarget.style.background = 'transparent'; };

// ── ScraperAPI credit meter ───────────────────────────────────────
// Small inline gauge shown next to every credit-consuming sync action:
// used/limit + the date the quota resets. Red when the tank is empty,
// amber when above 85%.
export function ScraperCredits() {
  const [c, setC] = useState(null);
  useEffect(() => {
    fetch('/.netlify/functions/scraper-status')
      .then(r => r.json()).then(setC).catch(() => setC(null));
  }, []);
  if (!c || c.error || c.requestLimit == null) return null;
  const used = Number(c.requestCount) || 0;
  const limit = Number(c.requestLimit) || 0;
  const empty = limit > 0 && used >= limit;
  const high = limit > 0 && used / limit > 0.85;
  const d = c.nextReset ? c.nextReset.split('-') : null;      // YYYY-MM-DD
  const resetTxt = d ? `${d[2]}/${d[1]}/${d[0].slice(2)}` : null;
  return (
    <span
      title={`ScraperAPI credits used this cycle${resetTxt ? ` — quota resets on ${resetTxt}` : ''}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 11, whiteSpace: 'nowrap', cursor: 'default',
        color: empty ? 'var(--red)' : high ? 'var(--amber)' : 'var(--text-3)',
      }}>
      <span style={{
        width: 6, height: 6, flexShrink: 0,
        background: empty ? 'var(--red)' : high ? 'var(--amber)' : 'var(--green-ok)',
      }} />
      <span style={{ fontFamily: 'var(--font-mono)' }}>{used.toLocaleString()}/{limit.toLocaleString()}</span>
      {resetTxt && <span style={{ opacity: 0.85 }}>· resets {resetTxt}</span>}
    </span>
  );
}

// Page header
export function PageHeader({ title, subtitle, action, children }) {
  return (
    <div className="page-header">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {action && <div className="action-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{action}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Action buttons — ONE definition for the whole app ────────────
// Every screen used to hand-roll its own row buttons, which is why edit and
// delete looked different depending on where you were. There is now a single
// square hairline button, a single set of tones, and a single canonical
// order: edit → duplicate → view → profile → video → delete (destructive
// last). Sizing is shared with .action-btns so mobile gets 38px targets.
const ACTION_TONES = {
  gold:    'var(--gold)',
  red:     'var(--red)',
  blue:    'var(--blue)',
  green:   'var(--green-ok)',
  neutral: 'var(--text-2)',
};

export function ActionBtn({ icon, title, onClick, href, tone = 'neutral', text }) {
  const color = ACTION_TONES[tone] || ACTION_TONES.neutral;
  const style = {
    width: 28, height: 28, padding: 0, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 0,
    color,
    cursor: 'pointer',
    textDecoration: 'none',
    fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
    transition: 'border-color 0.11s linear, background 0.11s linear',
  };
  const enter = (e) => { e.currentTarget.style.borderColor = color; e.currentTarget.style.background = 'var(--surface-2)'; };
  const leave = (e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'transparent'; };
  const body = icon ? <Icon name={icon} size={13} /> : text;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title}
        style={style} onMouseEnter={enter} onMouseLeave={leave}
        onClick={(e) => e.stopPropagation()}>{body}</a>
    );
  }
  return (
    <button type="button" title={title} aria-label={title} style={style}
      onMouseEnter={enter} onMouseLeave={leave}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}>{body}</button>
  );
}

// RowActions — the canonical action cluster. Pass only what applies; the
// order below is fixed so muscle memory works on every screen.
export function RowActions({ onEdit, onDuplicate, onView, onDelete, profileUrl, videoUrl, children }) {
  const abs = (u) => (u.startsWith('http://') || u.startsWith('https://')) ? u : 'https://' + u;
  return (
    <div className="action-btns" style={{ display: 'flex', gap: 4 }}>
      {onView      && <ActionBtn icon="social"   tone="blue"    title="View"      onClick={onView} />}
      {onEdit      && <ActionBtn icon="edit"     tone="gold"    title="Edit"      onClick={onEdit} />}
      {onDuplicate && <ActionBtn icon="copy"     tone="neutral" title="Duplicate" onClick={onDuplicate} />}
      {profileUrl  && <ActionBtn icon="players"  tone="blue"    title="Profile"   href={abs(profileUrl)} />}
      {videoUrl    && <ActionBtn icon="external" tone="green"   title="Video"     href={abs(videoUrl)} />}
      {children}
      {onDelete    && <ActionBtn icon="trash"    tone="red"     title="Delete"    onClick={onDelete} />}
    </div>
  );
}

// Kept as an alias so older call sites keep working — both render the same
// cluster now, which is the whole point.
export const ActionButtons = RowActions;
