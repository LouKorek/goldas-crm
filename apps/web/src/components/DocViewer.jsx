// Document viewer: the files attached to a record (contract, passport,
// representation agreement) opened inside the app. A stored file is a base64
// data URL reassembled from Firestore chunks; Chrome refuses to open such a
// URL in a new tab, so it is turned into a Blob URL and shown in a modal
// (image inline, anything else in an iframe) with a download button. Used by
// the players list and by the player page.
import React, { useState, useEffect } from 'react';
import { resolveFileUrl } from 'lib/db';
import { t } from 'lib/i18n';
import { Modal, toast } from 'components/ui/UI';

export default function DocViewer({ files, title, onClose, onRename, initialIndex = 0 }) {
  const [idx, setIdx] = useState(Math.min(initialIndex, Math.max(0, (files?.length || 1) - 1)));
  const [renaming, setRenaming] = useState(null);   // draft name while editing
  const file = files?.[idx];
  const [url, setUrl] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    setUrl(null);
    if (!file) return;
    setLoadingFile(true);
    resolveFileUrl(file)
      .then(async (dataUrl) => {
        if (!dataUrl) throw new Error('unavailable');
        // Convert to a Blob URL — Chrome blocks navigating/embedding raw data: URLs.
        const blob = await (await fetch(dataUrl)).blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => { if (!cancelled) toast.error(t("Could not load this file.")); })
      .finally(() => { if (!cancelled) setLoadingFile(false); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file]);
  // Share the file itself (WhatsApp, mail) where the browser allows it: phones mostly.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
  const share = async () => {
    try {
      const blob = await (await fetch(url)).blob();
      const f = new File([blob], file.name || 'file', { type: file.type || blob.type });
      if (!navigator.canShare({ files: [f] })) { toast.error(t('Sharing is not available here.')); return; }
      await navigator.share({ files: [f], title: file.name });
    } catch (e) { if (e?.name !== 'AbortError') toast.error(t('Could not share this file.')); }
  };
  const saveName = async () => {
    const name = (renaming || '').trim();
    if (!name) return;
    try { await onRename(idx, name); setRenaming(null); toast.success(t("File renamed.")); }
    catch (e) { toast.error(e.message || 'Rename failed.'); }
  };
  return (
    <Modal title={title} onClose={onClose} wide viewOnly>
      {!files?.length ? (
        <p style={{color:'var(--text-3)'}}>{t("No documents uploaded yet.")}</p>
      ) : (
        <>
          {files.length > 1 && (
            <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
              {files.map((f,i)=>(
                <button key={i} className={`chip${i===idx?' active':''}`} onClick={()=>{ setIdx(i); setRenaming(null); }}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
          {file && (
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                {renaming !== null ? (
                  <div style={{display:'flex',gap:6,flex:1,marginInlineEnd:8}}>
                    <input autoFocus value={renaming} onChange={e=>setRenaming(e.target.value)}
                      onKeyDown={e=>{ if (e.key==='Enter') saveName(); if (e.key==='Escape') setRenaming(null); }} />
                    <button className="btn btn-primary btn-sm" disabled={!renaming.trim()} onClick={saveName}>{t("Save")}</button>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setRenaming(null)}>{t("Cancel")}</button>
                  </div>
                ) : (
                  <div style={{fontSize:12,color:'var(--text-3)'}}>{file.name} · {new Date(file.uploadedAt).toLocaleDateString('en-GB')} · {file.uploadedBy}</div>
                )}
                <div style={{display:'flex',gap:6}}>
                  {onRename && renaming === null && <button className="btn btn-secondary btn-sm" onClick={()=>setRenaming(file.name||'')}>{t("✎ Rename")}</button>}
                  {url && canShare && <button type="button" className="btn btn-secondary btn-sm" onClick={share}>{t("Share")}</button>}
                  {url && <a href={url} download={file.name} className="btn btn-primary btn-sm">{t("⬇ Download")}</a>}
                </div>
              </div>
              {loadingFile || !url ? (
                <div style={{padding:40,textAlign:'center',color:'var(--text-3)'}}>{loadingFile ? 'Loading file…' : 'File unavailable.'}</div>
              ) : file.type?.startsWith('image/') ? (
                <img src={url} alt={file.name} style={{width:'100%',borderRadius: 0,border:'1px solid var(--border)'}} />
              ) : (
                <iframe src={url} style={{width:'100%',height:480,borderRadius: 0,border:'1px solid var(--border)'}} title={file.name} />
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}