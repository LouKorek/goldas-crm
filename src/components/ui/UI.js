import React, { useState, useRef, useEffect, useCallback } from 'react';
import { COUNTRIES } from 'lib/constants';

// ── Toast ─────────────────────────────────────────────────────────
let _addToast = null;
export const toast = {
  success: (msg) => _addToast?.({ msg, type:'success' }),
  error:   (msg) => _addToast?.({ msg, type:'error' }),
  warning: (msg) => _addToast?.({ msg, type:'warning' }),
  info:    (msg) => _addToast?.({ msg, type:'info' }),
};
export function ToastProvider() {
  const [toasts, setToasts] = useState([]);
  _addToast = useCallback((t) => {
    const id = Date.now();
    setToasts(p => [...p, { ...t, id }]);
    setTimeout(() => setToasts(p => p.filter(x => x.id !== id)), 3500);
  }, []);
  if (!toasts.length) return null;
  const icons = { success:'✓', error:'✕', warning:'⚠', info:'ℹ' };
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type||''}`}>
          <span>{icons[t.type]||'ℹ'}</span>
          <span style={{flex:1}}>{t.msg}</span>
          <button style={{background:'none',border:'none',color:'inherit',cursor:'pointer',fontSize:16,lineHeight:1}}
            onClick={() => setToasts(p=>p.filter(x=>x.id!==t.id))}>×</button>
        </div>
      ))}
    </div>
  );
}

// ── Modal — only X closes it ──────────────────────────────────────
export function Modal({ title, onClose, children, footer, wide, viewOnly, isDirty=false, onSave }) {
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

  const handleClose = () => {
    if (viewOnly || !isDirty) { onClose(); return; }
    if (window.confirm('Discard unsaved changes?')) onClose();
  };

  return (
    <div className="modal-overlay">
      <div className={`modal-box${wide ? ' modal-wide' : ''}`}>

        {/* Header - rendered first in flex-col, never scrolls */}
        <div className="modal-header-frozen">
          <span className="modal-title">{title}</span>
          <button className="modal-close-btn" onClick={handleClose}>×</button>
        </div>

        {/* Body - this part scrolls */}
        <div className="modal-scroll-body">
          {children}
          {footer && (
            <div className="modal-footer-bar">
              {!viewOnly && onSave && (
                <span style={{fontSize:10,color:'var(--text-3)',marginRight:'auto',alignSelf:'center'}}>
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
    const h = (e) => { if (e.key === 'Escape') handleCancel(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [state, handleCancel]);
  const dialog = state ? (
    <div className="modal-overlay" style={{zIndex:300}}>
      <div className="modal-box" style={{maxWidth:380}}>
        <div className="modal-header-frozen"><span className="modal-title" style={{fontSize:16}}>{state.title || 'Confirm'}</span></div>
        <div className="modal-scroll-body">
          <p style={{color:'var(--text-1)',marginBottom:20,fontSize:14,lineHeight:1.6}}>{state.msg}</p>
          <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
            <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
            <button className="btn btn-danger" onClick={handleConfirm}>{state.confirmLabel || '🗑 Delete'}</button>
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
      {label && <label className="form-label">{label}{required&&<span style={{color:'var(--red)',marginLeft:2}}>*</span>}</label>}
      {children}
      {hint  && <div className="form-hint">{hint}</div>}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

// ── Chip group ────────────────────────────────────────────────────
export function ChipGroup({ options, value, onChange, multi, labels }) {
  const vals = multi ? (Array.isArray(value) ? value : []) : [];
  const isActive = (o) => multi ? vals.includes(o) : value === o;
  const toggle   = (o) => {
    if (multi) onChange(vals.includes(o) ? vals.filter(v=>v!==o) : [...vals,o]);
    else       onChange(value === o ? '' : o);
  };
  return (
    <div className="chip-group">
      {options.map((o,i) => (
        <button key={o} type="button" className={`chip${isActive(o)?' active':''}`} onClick={()=>toggle(o)}>
          {labels?.[i] || o}
        </button>
      ))}
    </div>
  );
}

// ── Country select ────────────────────────────────────────────────
export function CountrySelect({ value=[], onChange, single }) {
  const [q, setQ]     = useState('');
  const [open, setOpen] = useState(false);
  const ref           = useRef();
  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const filtered = q ? COUNTRIES.filter(c => c.toLowerCase().includes(q.toLowerCase())) : COUNTRIES;
  const vals     = single ? (value ? [value] : []) : (Array.isArray(value) ? value : []);
  const select = (c) => {
    if (single) { onChange(c); setOpen(false); setQ(''); }
    else onChange(vals.includes(c) ? vals.filter(v=>v!==c) : [...vals, c]);
  };
  const display = open ? q : (single ? (value||'') : vals.slice(0,2).join(', ') + (vals.length>2?` +${vals.length-2}`:''));
  return (
    <div ref={ref} className="dropdown-wrap">
      <div style={{position:'relative'}}>
        <input value={display} onChange={e=>{setQ(e.target.value);setOpen(true);}}
          onFocus={()=>{setOpen(true);if(!open)setQ('');}}
          placeholder={single?'Type country name...':'Select countries...'} />
        {!single && vals.length>0 && (
          <button type="button" onClick={()=>onChange([])}
            style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',fontSize:18,lineHeight:1}}>×</button>
        )}
      </div>
      <div className={`dropdown-list${open?' open':''}`}>
        {!single && (
          <div style={{padding:'6px 10px',display:'flex',gap:8,borderBottom:'1px solid var(--border)'}}>
            <button type="button" className="btn btn-ghost btn-sm" onMouseDown={()=>onChange([...COUNTRIES])}>All</button>
            <button type="button" className="btn btn-ghost btn-sm" onMouseDown={()=>onChange([])}>Clear</button>
          </div>
        )}
        {filtered.slice(0,80).map(c => (
          <div key={c} className={`dropdown-item${vals.includes(c)?' sel':''}`} onMouseDown={()=>select(c)}>
            {!single && <input type="checkbox" readOnly checked={vals.includes(c)} style={{pointerEvents:'none',width:14,height:14,accentColor:'var(--gold)'}} />}
            {c}
          </div>
        ))}
        {filtered.length===0 && <div style={{padding:'10px 12px',color:'var(--text-3)',fontSize:12}}>No results</div>}
      </div>
    </div>
  );
}

export function CountryInput({ value, onChange }) {
  return <CountrySelect value={value} onChange={onChange} single />;
}

// ── Number input ──────────────────────────────────────────────────
export function NumberInput({ value, onChange, placeholder, allowNotSpecified }) {
  const display = value==='Not specified' ? 'Not specified' : (value ? Number(String(value).replace(/,/g,'')).toLocaleString() : '');
  return (
    <div>
      <input value={display} placeholder={placeholder}
        onChange={e => { const raw=e.target.value; if(raw===''){onChange('');return;} onChange(raw.replace(/[^0-9]/g,'')); }} />
      {allowNotSpecified && (
        <div style={{marginTop:4}}>
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={()=>onChange(value==='Not specified'?'':'Not specified')}>
            {value==='Not specified'?'Enter value':'Not specified'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Phone display ─────────────────────────────────────────────────
export function PhoneDisplay({ phone }) {
  if (!phone) return <span style={{color:'var(--text-3)'}}>—</span>;
  return (
    <div style={{display:'flex',gap:5,alignItems:'center'}}>
      <span style={{color:'var(--text-1)',fontSize:12}}>{phone}</span>
      <a href={`tel:${phone}`} className="btn btn-ghost btn-sm btn-icon" data-tooltip="Call" style={{textDecoration:'none',fontSize:13}}>📞</a>
      <a href={`https://wa.me/${phone.replace(/[^0-9]/g,'')}`} target="_blank" rel="noopener noreferrer"
        className="btn btn-ghost btn-sm btn-icon" data-tooltip="WhatsApp" style={{textDecoration:'none',fontSize:13}}>💬</a>
    </div>
  );
}

export function LinkIcon({ url, emoji='🔗', label='' }) {
  if (!url||url==='-'||url==='') return <span style={{color:'var(--text-3)'}}>—</span>;
  const href = url.startsWith('http://')||url.startsWith('https://') ? url : 'https://'+url;
  return <a href={href} target="_blank" rel="noopener noreferrer"
    style={{color:'var(--gold)',textDecoration:'none',fontSize:18}} data-tooltip={label||url}>{emoji}</a>;
}

// ── Date input ────────────────────────────────────────────────────
export function DateInput({ value, onChange }) {
  return <input type="date" value={value||''} onChange={e=>onChange(e.target.value)} style={{colorScheme:'dark'}} />;
}

// ── Search input ──────────────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder='Search...' }) {
  return (
    <div style={{position:'relative'}}>
      <span style={{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:'var(--text-3)',pointerEvents:'none',fontSize:14}}>🔍</span>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{paddingLeft:32,height:36,width:180}} />
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────
export function StatusBadge({ status, colorMap }) {
  if (!status) return null;
  const c = colorMap?.[status] || { bg:'var(--surface-3)', text:'var(--text-2)' };
  return <span className="badge" style={{background:c.bg,color:c.text}}>{status}</span>;
}

export function EUBadge({ is }) {
  return (
    <span className="badge" style={{
      background: is?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',
      color: is?'var(--blue)':'var(--red)',
    }}>{is?'🇪🇺 EU':'Non-EU'}</span>
  );
}

export function Spinner({ size=20 }) {
  return <span className="spinner" style={{width:size,height:size}} />;
}

export function Empty({ icon='📋', message='No records yet', action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <p style={{marginBottom:action?16:0,fontSize:14}}>{message}</p>
      {action}
    </div>
  );
}

// ── File upload ───────────────────────────────────────────────────
export function FileUpload({ label, onUpload, history=[], accept='.pdf,.doc,.docx,.jpg,.png' }) {
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
    catch(e) { console.error(e); }
    setUploading(false);
  };
  return (
    <div>
      {history.length > 0 && (
        <div style={{marginBottom:8}}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={()=>setShowH(!showH)}>
            📎 {history.length} file{history.length>1?'s':''} — {showH?'Hide':'View'} history
          </button>
          {showH && (
            <div style={{marginTop:8,display:'flex',flexDirection:'column',gap:4,padding:'8px',background:'var(--surface-3)',borderRadius:8}}>
              {history.map((h,i) => (
                <div key={i} style={{display:'flex',gap:8,alignItems:'center',fontSize:12}}>
                  <a href={h.url} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>📄 {h.name}</a>
                  <span style={{color:'var(--text-3)'}}>{new Date(h.uploadedAt).toLocaleDateString('en-GB')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {mode==='prompt' ? (
        <div style={{display:'flex',gap:8,marginBottom:8,flexWrap:'wrap'}}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setMode('replace')}>Replace existing</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setMode('keep')}>Keep both</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={()=>{setFile(null);setMode(null);}}>Cancel</button>
        </div>
      ) : file ? (
        <div style={{display:'flex',gap:8,alignItems:'flex-start',flexWrap:'wrap',background:'var(--surface-3)',padding:12,borderRadius:8,border:'1px solid var(--border)'}}>
          <div style={{flex:1,minWidth:140}}>
            <div style={{fontSize:11,color:'var(--text-3)',marginBottom:4}}>File: {file.name}</div>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="Enter file name..." />
          </div>
          <div style={{display:'flex',gap:6,paddingTop:18}}>
            <button type="button" className="btn btn-primary btn-sm" disabled={!name.trim()||uploading} onClick={()=>doUpload()}>
              {uploading?<><span className="spinner" style={{width:12,height:12}}/> Uploading...</>:'⬆ Upload'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={()=>setFile(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="file-drop" onClick={()=>fileRef.current?.click()}
          onDragOver={e=>e.preventDefault()}
          onDrop={e=>{e.preventDefault();handleFile(e.dataTransfer.files[0]);}}>
          <input ref={fileRef} type="file" accept={accept} style={{display:'none'}}
            onChange={e=>handleFile(e.target.files[0])} />
          <span style={{fontSize:13}}>📎 Click or drag to upload {label}</span>
        </div>
      )}
    </div>
  );
}

// ── Sort header ───────────────────────────────────────────────────
export function SortTh({ label, field, sort, setSort }) {
  const active = sort?.field === field;
  return (
    <th onClick={()=>setSort(s=>s?.field===field?{...s,dir:s.dir==='asc'?'desc':'asc'}:{field,dir:'asc'})}>
      {label} {active?(sort.dir==='asc'?'↑':'↓'):<span style={{opacity:.25}}>↕</span>}
    </th>
  );
}

// ── Filter bar ────────────────────────────────────────────────────
export function FilterBar({ filters, setFilters, options }) {
  return (
    <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
      {options.map(opt => (
        <div key={opt.key} style={{minWidth:140}}>
          <select value={filters[opt.key]||''} onChange={e=>setFilters(f=>({...f,[opt.key]:e.target.value}))}>
            <option value="">{opt.label}: All</option>
            {opt.values.map(v=><option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      ))}
      {Object.values(filters).some(Boolean) && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={()=>setFilters({})}>✕ Clear</button>
      )}
    </div>
  );
}

// ── Page header ───────────────────────────────────────────────────
export function PageHeader({ title, subtitle, action, children }) {
  return (
    <div className="page-header">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:12}}>
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {action && <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>{action}</div>}
      </div>
      {children}
    </div>
  );
}

// ── Universal ActionButtons — 2×2 grid ───────────────────────────
export function ActionButtons({ onView, onWhatsApp, onEdit, onDuplicate, onDelete }) {
  const BTN = {width:26,height:26,padding:0,display:'flex',alignItems:'center',
               justifyContent:'center',fontSize:13,border:'none',borderRadius:6,
               cursor:'pointer',transition:'all 0.15s',flexShrink:0};
  const hasLeft = !!(onView || onWhatsApp);
  // When onDuplicate exists we always want a 2×2 grid — add a placeholder if top-left is empty
  const alwaysGrid = !!onDuplicate;
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:3,width:56}}>
      {onView && (
        <button style={{...BTN,background:'rgba(96,165,250,0.15)',color:'#60A5FA'}}
          title="View" onClick={onView}
          onMouseEnter={e=>e.currentTarget.style.background='rgba(96,165,250,0.3)'}
          onMouseLeave={e=>e.currentTarget.style.background='rgba(96,165,250,0.15)'}>👁</button>
      )}
      {onWhatsApp && !onView && (
        <button style={{...BTN,background:'rgba(37,211,102,0.12)',color:'#25D166'}}
          title="WhatsApp" onClick={onWhatsApp}
          onMouseEnter={e=>e.currentTarget.style.background='rgba(37,211,102,0.25)'}
          onMouseLeave={e=>e.currentTarget.style.background='rgba(37,211,102,0.12)'}>💬</button>
      )}
      {!hasLeft && alwaysGrid && <div />}
      <button style={{...BTN,background:'rgba(248,113,113,0.15)',color:'var(--red)'}}
        title="Delete" onClick={onDelete}
        onMouseEnter={e=>e.currentTarget.style.background='rgba(248,113,113,0.3)'}
        onMouseLeave={e=>e.currentTarget.style.background='rgba(248,113,113,0.15)'}>🗑</button>
      <button style={{...BTN,background:'rgba(201,168,76,0.15)',color:'var(--gold)',
                      gridColumn: (hasLeft||alwaysGrid)?'auto':'1 / -1'}}
        title="Edit" onClick={onEdit}
        onMouseEnter={e=>e.currentTarget.style.background='rgba(201,168,76,0.3)'}
        onMouseLeave={e=>e.currentTarget.style.background='rgba(201,168,76,0.15)'}>✏️</button>
      {onDuplicate && (
        <button style={{...BTN,background:'rgba(167,139,250,0.15)',color:'#A78BFA'}}
          title="Duplicate" onClick={onDuplicate}
          onMouseEnter={e=>e.currentTarget.style.background='rgba(167,139,250,0.3)'}
          onMouseLeave={e=>e.currentTarget.style.background='rgba(167,139,250,0.15)'}>⧉</button>
      )}
    </div>
  );
}
