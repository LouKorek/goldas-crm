import React, { useState, useEffect } from 'react';
import { listenAppUsers, addAppUser, updateAppUser, removeAppUser, setUserEmailAlerts, updateUserPrefs } from 'lib/db';
import { OWNER_EMAIL } from 'lib/firebase';
import { useRole, roleLabel } from 'lib/roleContext';
import {
  PageHeader, Modal, Field, ChipGroup, Empty, Spinner, useConfirm, toast, RowActions,
} from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { t } from 'lib/i18n';

const ROLE_OPTIONS = ['Manager', 'Viewer'];
const ROLE_DESC = {
  admin:   'Full access + manages users',
  manager: 'Can view and edit all data',
  viewer:  'Read-only — cannot make changes',
};
const ROLE_COLOR = {
  admin:   { bg: 'rgba(201,168,76,0.15)', text: 'var(--gold)' },
  manager: { bg: 'rgba(74,222,128,0.15)', text: '#4ADE80' },
  viewer:  { bg: 'rgba(96,165,250,0.15)', text: '#60A5FA' },
};

const EMPTY = { email: '', name: '', role: 'Viewer', emailAlerts: true, whatsapp: '', channels: ['email'], briefingHour: 7 };
// An Israeli local number becomes international digits, the form WhatsApp reports.
const normalizePhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.startsWith('0') && d.length === 10 ? `972${d.slice(1)}` : d; };
const showPhone = (d) => (d && String(d).startsWith('972') ? `0${String(d).slice(3)}` : d || '');
const isOwner = (e) => (e || '').toLowerCase() === OWNER_EMAIL.toLowerCase();

export default function Team() {
  const { isAdmin } = useRole();
  const [users, setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]   = useState(null);          // 'add' | { edit: user }
  const [form, setForm]     = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog } = useConfirm();

  useEffect(() => listenAppUsers((data) => {
    data.sort((a, b) => {
      if (isOwner(a.email)) return -1;
      if (isOwner(b.email)) return 1;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });
    setUsers(data); setLoading(false);
  }), []);

  const openAdd  = () => { setForm({ ...EMPTY }); setModal('add'); };
  const openEdit = (u) => { setForm({ email: u.email, name: u.name || '', role: roleLabel(u.role), emailAlerts: u.emailAlerts !== false, whatsapp: showPhone(u.whatsapp), channels: Array.isArray(u.channels) ? u.channels : ['email'], briefingHour: Number.isInteger(u.briefingHour) ? u.briefingHour : 7 }); setModal({ edit: u }); };

  const toggleEmailAlerts = async (u) => {
    try {
      await setUserEmailAlerts(u.email, u.emailAlerts === false);   // flip
      toast.success(u.emailAlerts === false ? 'Email alerts enabled.' : 'Email alerts disabled.');
    } catch (e) {
      toast.error(e.message || 'Could not update.');
    }
  };

  const save = async () => {
    const email = form.email.trim().toLowerCase();
    if (!email) { toast.error(t("Email is required.")); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error(t("Please enter a valid email address.")); return; }
    if (isOwner(email)) { toast.error(t("The owner already has full access.")); return; }
    const role = form.role === 'Manager' ? 'manager' : 'viewer';
    setSaving(true);
    try {
      if (modal === 'add') {
        if (users.some(u => (u.email || '').toLowerCase() === email)) {
          toast.error(t("That email is already on the list.")); setSaving(false); return;
        }
        await addAppUser({ email, name: form.name, role, emailAlerts: form.emailAlerts });
        toast.success(`"${form.name.trim() || email}" can now sign in.`);
      } else if (!isOwner(email)) {
        await updateAppUser(email, { name: form.name.trim() || email, role, emailAlerts: form.emailAlerts });
        toast.success(t("User updated."));
      }
      // Golda's side of the record: how she recognises and reaches this person.
      await updateUserPrefs(email, { whatsapp: normalizePhone(form.whatsapp), channels: form.channels, briefingHour: form.briefingHour });
      setModal(null);
    } catch (e) {
      toast.error(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (u) => {
    const ok = await confirm(
      `Remove access for "${u.name || u.email}"? They will no longer be able to sign in.`,
      { confirmLabel: t("Remove") }
    );
    if (!ok) return;
    try { await removeAppUser(u.email); toast.success(t("Access removed.")); }
    catch (e) { toast.error(e.message || 'Could not remove user.'); }
  };

  if (!isAdmin) return null;

  return (
    <div>
      <PageHeader
        title={t("Team")}
        subtitle={t("Manage who can sign in and what they can do")}
        action={<button className="btn btn-primary" onClick={openAdd} style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">{t("Add User")}</span></button>}
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
      ) : users.length === 0 ? (
        <Empty message={t("No users yet.")} action={<button className="btn btn-primary" onClick={openAdd}><Icon name="plus" size={12} /><span className="btn-text">{t("Add User")}</span></button>} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}></th>
                  <th title={t("Name")}>{t("Name")}</th>
                  <th title={t("Email")}>{t("Email")}</th>
                  <th title={t("Role")}>{t("Role")}</th>
                  <th title={t("Access")}>{t("Access")}</th>
                  <th title={t("WhatsApp")}>{t("WhatsApp")}</th>
                  <th style={{ width: 80, textAlign: 'center' }} title={t("Receive email alerts")}>{t("Alerts")}</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const owner = isOwner(u.email);
                  const c = ROLE_COLOR[u.role] || ROLE_COLOR.viewer;
                  return (
                    <tr key={u.id}>
                      <td onClick={e => e.stopPropagation()}>
                        {owner ? (
                          <RowActions onEdit={() => openEdit(u)}><span style={{ fontSize: 9, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>OWNER</span></RowActions>
                        ) : (
                          <RowActions onEdit={() => openEdit(u)} onDelete={() => remove(u)} />
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{u.name || '—'}</td>
                      <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{u.email}</td>
                      <td>
                        <span style={{ display: 'inline-block', background: c.bg, color: c.text, borderRadius: 0, fontSize: 11, fontWeight: 600, padding: '3px 9px' }}>
                          {roleLabel(u.role)}
                        </span>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>{ROLE_DESC[u.role] || ''}</div>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: u.active === false ? 'var(--red)' : '#4ADE80' }}>
                          {u.active === false ? 'Disabled' : 'Active'}
                        </span>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-2)' }} dir="ltr">
                        {showPhone(u.whatsapp) || <span style={{ color: 'var(--text-3)' }}>—</span>}
                        {u.whatsapp && (Array.isArray(u.channels) && u.channels.includes('whatsapp')) && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('briefing at')} {String(Number.isInteger(u.briefingHour) ? u.briefingHour : 7).padStart(2, '0')}:30</div>}
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={u.emailAlerts !== false}
                          onChange={() => toggleEmailAlerts(u)}
                          title={u.emailAlerts !== false ? 'Receiving email alerts' : 'Not receiving email alerts'}
                          style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--gold)' }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add User' : `Edit: ${form.name || form.email}`}
          onClose={() => setModal(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>{t("Cancel")}</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>}
        >
          <Field label={t("Email")} required hint={t("Whoever signs in with Google using this address gets the access below.")}>
            <input value={form.email} disabled={modal !== 'add'}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder={t("name@example.com")} style={modal !== 'add' ? { opacity: 0.6 } : undefined} />
          </Field>
          <Field label={t("Name")}>
            <input value={form.name} disabled={isOwner(form.email)} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t("Display name")} />
          </Field>
          {!isOwner(form.email) && (
            <Field label={t("Role")}>
              <ChipGroup options={ROLE_OPTIONS} value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {form.role === 'Manager' ? ROLE_DESC.manager : ROLE_DESC.viewer}
              </div>
            </Field>
          )}
          <Field label={t("WhatsApp number")} hint={t("Golda recognises this person by this number and acts in their name.")}>
            <input value={form.whatsapp} inputMode="tel" dir="ltr" placeholder="0501234567" onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} />
          </Field>
          <Field label={t("Golda's channels")} hint={t("Where the morning briefing and urgent alerts go.")}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <ChipGroup multi options={['whatsapp', 'email']} labels={[t('WhatsApp'), t('Email')]} value={form.channels} onChange={v => setForm(f => ({ ...f, channels: v }))} />
              <select value={String(form.briefingHour)} onChange={e => setForm(f => ({ ...f, briefingHour: Number(e.target.value) }))} style={{ maxWidth: 120 }}>
                {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:30</option>)}
              </select>
            </div>
          </Field>
          <Field label={t("Email Alerts")}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '6px 0' }}>
              <input type="checkbox" checked={form.emailAlerts}
                onChange={e => setForm(f => ({ ...f, emailAlerts: e.target.checked }))}
                style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--gold)' }} />
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                {t("Receive email notifications when an alert is due")}
              </span>
            </label>
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
