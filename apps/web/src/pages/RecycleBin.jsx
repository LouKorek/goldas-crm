import React, { useState, useEffect } from 'react';
import { listenRecycleBin, restoreItem, purgeItem, RECYCLE_LABELS, recycleTitle } from 'data/recycle';
import { PageHeader, Empty, Spinner, useConfirm, toast, ActionBtn } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';
import { t } from 'lib/i18n';

const KEEP_DAYS = 30;
const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);

export default function RecycleBin() {
  const [items, setItems] = useState(null);
  const { confirm, dialog } = useConfirm();
  const { canEdit, isAdmin } = useRole();
  useEffect(() => listenRecycleBin((rows) => {
    rows.sort((a, b) => (toDate(b.deletedAt)?.getTime() || 0) - (toDate(a.deletedAt)?.getTime() || 0));
    setItems(rows);
  }), []);

  const restore = async (it) => {
    try { await restoreItem(it); toast.success(`"${recycleTitle(it._path, it)}" restored.`); } catch (e) { toast.error(e.message); }
  };
  const purge = async (it) => {
    if (!(await confirm(`Delete "${recycleTitle(it._path, it)}" permanently? This cannot be undone.`, { confirmLabel: t("Delete forever") }))) return;
    try { await purgeItem(it); toast.success(t("Deleted permanently.")); } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <PageHeader title={t("Recycle Bin")} subtitle={`Deleted records stay here for ${KEEP_DAYS} days and can be restored with one click.`} />
      {items === null ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
        : items.length === 0 ? <Empty message={t("The recycle bin is empty.")} />
        : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th style={{ width: 70 }}></th><th>{t("Type")}</th><th>{t("Record")}</th><th>{t("Deleted")}</th><th>{t("By")}</th><th>{t("Days left")}</th></tr></thead>
                <tbody>
                  {items.map((it) => {
                    const d = toDate(it.deletedAt);
                    const left = d ? Math.max(0, KEEP_DAYS - Math.floor((Date.now() - d.getTime()) / 86400000)) : KEEP_DAYS;
                    return (
                      <tr key={`${it._path}/${it.id}`}>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {canEdit && <ActionBtn icon="refresh" tone="green" title={t("Restore")} onClick={() => restore(it)} />}
                            {isAdmin && <ActionBtn icon="trash" tone="red" title={t("Delete forever")} onClick={() => purge(it)} />}
                          </div>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{RECYCLE_LABELS[it._path] || it._path}</td>
                        <td style={{ fontWeight: 600 }}>{recycleTitle(it._path, it) || it.id}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{d ? d.toLocaleString('he-IL') : '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{it.deletedBy || '—'}</td>
                        <td style={{ fontSize: 12, color: left <= 5 ? 'var(--red)' : 'var(--text-2)' }}>{left}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      {dialog}
    </div>
  );
}
