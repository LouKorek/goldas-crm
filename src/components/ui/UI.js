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
export function Modal({ title, onClose, children, footer, wide, viewOnly, isDirty=false }) {
  useEffect(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return;
      if (viewOnly || !isDirty) { onClose(); return; }
      if (window.confirm('Discard unsaved changes?')) onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, viewOnly, isDirty]);

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
            <div className="modal-footer-bar">{footer}</div>
          )}
        </div>

      </div>
    </div>
  );
}


