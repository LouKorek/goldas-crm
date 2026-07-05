import React, { useState, useEffect } from 'react';
import { listenAppUsers, addAppUser, updateAppUser, removeAppUser, setUserEmailAlerts } from 'lib/db';
import { OWNER_EMAIL } from 'lib/firebase';
import { useRole, roleLabel } from 'lib/roleContext';
import {
  PageHeader, Modal, Field, ChipGroup, Empty, Spinner, useConfirm, toast,
} from 'components/ui/UI';

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

const EMPTY = { email: '', name: '', role: 'Viewer', emailAlerts: true };
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
  const openEdit = (u) => { setForm({ email: u.email, name: u.name || '', role: roleLabel(u.role), emailAlerts: u.emailAlerts !== false }); setModal({ edit: u }); };

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
    if (!email) { toast.error('Email is required.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error('Please enter a valid email address.'); return; }
    if (isOwner(email)) { toast.error('The owner already has full access.'); return; }
    const role = form.role === 'Manager' ? 'manager' : 'viewer';
    setSaving(true);
    try {
      if (modal === 'add') {
        if (users.some(u => (u.email || '').toLowerCase() === email)) {
          toast.error('That email is already on the list.'); setSaving(false); return;
        }
        await addAppUser({ email, name: form.name, role, emailAlerts: form.emailAlerts });
        toast.success(`"${form.name.trim() || email}" can now sign in.`);
      } else {
        await updateAppUser(email, { name: form.name.trim() || email, role, emailAlerts: form.emailAlerts });
        toast.success('User updated.');
      }
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
      { confirmLabel: '🗑 Remove' }
    );
    if (!ok) return;
    try { await removeAppUser(u.email); toast.success('Access removed.'); }
    catch (e) { toast.error(e.message || 'Could not remove user.'); }
  };

  if (!isAdmin) return null;

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="Manage who can sign in and what they can do"
        action={<button className="btn btn-primary" onClick={openAdd} style={{ height: 36 }}>+ Add User</button>}
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
      ) : users.length === 0 ? (
        <Empty icon="👥" message="No users yet." action={<button className="btn btn-primary" onClick={openAdd}>+ Add User</button>} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}></th>
                  <th title="Name">Name</th>
                  <th title="Email">Email</th>
                  <th title="Role">Role</th>
                  <th title="Access">Access</th>
                  <th style={{ width: 80, textAlign: 'center' }} title="Receive email alerts">Alerts</th>
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
                          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>🔒</span>
                        ) : (
                          <div className="action-btns" style={{ display: 'flex', gap: 4 }}>
                            <button style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, border: 'none', borderRadius: 6, cursor: 'pointer', background: 'rgba(201,168,76,0.15)', color: 'var(--gold)' }}
                              title="Edit" onClick={() => openEdit(u)}>✏️</button>
                            <button style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, border: 'none', borderRadius: 6, cursor: 'pointer', background: 'rgba(248,113,113,0.15)', color: 'var(--red)' }}
                              title="Remove" onClick={() => remove(u)}>🗑</button>
                          </div>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{u.name || '—'}</td>
                      <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{u.email}</td>
                      <td>
                        <span style={{ display: 'inline-block', background: c.bg, color: c.text, borderRadius: 6, fontSize: 11, fontWeight: 600, padding: '3px 9px' }}>
                          {roleLabel(u.role)}
                        </span>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>{ROLE_DESC[u.role] || ''}</div>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: u.active === false ? 'var(--red)' : '#4ADE80' }}>
                          {u.active === false ? 'Disabled' : 'Active'}
                        </span>
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
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>}
        >
          <Field label="Email" required hint="Whoever signs in with Google using this address gets the access below.">
            <input value={form.email} disabled={modal !== 'add'}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="name@example.com" style={modal !== 'add' ? { opacity: 0.6 } : undefined} />
          </Field>
          <Field label="Name">
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Display name" />
          </Field>
          <Field label="Role">
            <ChipGroup options={ROLE_OPTIONS} value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              {form.role === 'Manager' ? ROLE_DESC.manager : ROLE_DESC.viewer}
            </div>
          </Field>
          <Field label="Email Alerts">
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '6px 0' }}>
              <input type="checkbox" checked={form.emailAlerts}
                onChange={e => setForm(f => ({ ...f, emailAlerts: e.target.checked }))}
                style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--gold)' }} />
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                Receive email notifications when an alert is due
              </span>
            </label>
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
