import React, { useState, useEffect } from 'react';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { CONTACT_ROLES } from 'lib/constants';
import { Modal, Field, SearchInput, PageHeader, Empty, useConfirm,
         PhoneDisplay, toast } from 'components/ui/UI';
import { ClubLogoOrAvatar } from './Requirements';

const EMPTY = { clubName: '', clubIsYouth: false, contactName: '', contactRole: '', contactPhone: '' };

// A single square action icon (delete / edit / duplicate), shown in a row.
function IconBtn({ icon, title, color, bg, bgHover, onClick }) {
  return (
    <button title={title} onClick={onClick}
      style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
               fontSize: 13, border: 'none', borderRadius: 7, cursor: 'pointer', background: bg, color,
               transition: 'background 0.15s, transform 0.12s', flexShrink: 0 }}
      onMouseEnter={e => { e.currentTarget.style.background = bgHover; e.currentTarget.style.transform = 'scale(1.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = bg; e.currentTarget.style.transform = ''; }}
    >{icon}</button>
  );
}

const YouthBadge = () => (
  <span style={{ background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)',
                 borderRadius: 4, color: '#4ADE80', fontSize: 9, fontWeight: 700, padding: '1px 6px', whiteSpace: 'nowrap' }}>🌱 Youth</span>
);

export default function Contacts() {
  const [items, setItems]   = useState([]);
  const [search, setSearch] = useState('');
  const [modal, setModal]   = useState(null);   // 'add' | { edit }
  const [form, setForm]     = useState(EMPTY);
  const { confirm, dialog } = useConfirm();

  useEffect(() => listenCollection(PATHS.CONTACTS, setItems, 'clubName'), []);

  const f = (k) => form[k];
  const s = (k) => (v) => setForm(p => ({ ...p, [k]: v }));

  const openAdd  = () => { setForm({ ...EMPTY }); setModal('add'); };
  const openEdit = (c) => { setForm({ ...EMPTY, ...c }); setModal({ edit: c }); };
  const openDup  = (c) => { const rest = { ...c }; delete rest.id; setForm({ ...EMPTY, ...rest }); setModal('add'); };

  const save = async () => {
    if (!form.clubName.trim() && !form.contactName.trim()) {
      toast.error('Add at least a club or a contact name.');
      return;
    }
    const data = { ...form };
    try {
      if (modal === 'add') {
        await addDoc_(PATHS.CONTACTS, data);
        toast.success('Contact added.');
      } else {
        await updateDoc_(PATHS.CONTACTS, modal.edit.id, data);
        toast.success('Contact updated.');
      }
      setModal(null);
    } catch (e) {
      toast.error('Could not save. Please try again.');
    }
  };

  const remove = async (c) => {
    const ok = await confirm(`Delete contact "${c.contactName || c.clubName}"?`, { title: 'Delete contact' });
    if (!ok) return;
    try {
      await deleteDoc_(PATHS.CONTACTS, c.id);
      toast.success('Contact deleted.');
    } catch (e) {
      toast.error('Could not delete. Please try again.');
    }
  };

  const term = search.trim().toLowerCase();
  const filtered = items.filter(c =>
    !term || `${c.clubName || ''} ${c.contactName || ''} ${c.contactRole || ''}`.toLowerCase().includes(term)
  );

  return (
    <div>
      <PageHeader
        title="Contacts"
        subtitle={`${items.length} contact${items.length !== 1 ? 's' : ''}`}
        action={<button className="btn btn-primary" onClick={openAdd}>+ Add Contact</button>}
      />

      <div style={{ marginBottom: 14, maxWidth: 360 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search club, name, role..." />
      </div>

      {filtered.length === 0 ? (
        <Empty
          icon="📇"
          message={items.length === 0 ? 'No contacts yet — add your first one.' : 'No matching contacts.'}
          action={items.length === 0 ? <button className="btn btn-primary" onClick={openAdd}>+ Add Contact</button> : null}
        />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 104 }}>Actions</th>
                  <th>Club</th>
                  <th>Contact</th>
                  <th>Role</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <IconBtn icon="🗑" title="Delete"    color="var(--red)"  bg="rgba(248,113,113,0.15)" bgHover="rgba(248,113,113,0.3)" onClick={() => remove(c)} />
                        <IconBtn icon="✏️" title="Edit"      color="var(--gold)" bg="rgba(201,168,76,0.15)"  bgHover="rgba(201,168,76,0.3)"  onClick={() => openEdit(c)} />
                        <IconBtn icon="⧉" title="Duplicate" color="#A78BFA"     bg="rgba(167,139,250,0.15)" bgHover="rgba(167,139,250,0.3)" onClick={() => openDup(c)} />
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <ClubLogoOrAvatar name={c.clubName} size={26} />
                        <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{c.clubName || '—'}</span>
                        {c.clubIsYouth && <YouthBadge />}
                      </div>
                    </td>
                    <td><span style={{ whiteSpace: 'nowrap' }}>{c.contactName || '—'}</span></td>
                    <td><span style={{ color: 'var(--text-2)', fontSize: 12 }}>{c.contactRole || '—'}</span></td>
                    <td><PhoneDisplay phone={c.contactPhone} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Contact' : `Edit: ${form.contactName || form.clubName || 'Contact'}`}
          onClose={() => setModal(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}
        >
          <Field label="Club Name">
            <input value={f('clubName')} onChange={e => s('clubName')(e.target.value)} placeholder="Club name" />
            <button type="button" className={`chip${form.clubIsYouth ? ' active' : ''}`}
              onClick={() => s('clubIsYouth')(!form.clubIsYouth)}
              style={{ fontSize: 11, padding: '4px 10px', marginTop: 6 }}>🌱 Youth Team</button>
          </Field>
          <Field label="Contact Name">
            <input value={f('contactName')} onChange={e => s('contactName')(e.target.value)} placeholder="Full name" />
          </Field>
          <Field label="Role">
            <select value={f('contactRole')} onChange={e => s('contactRole')(e.target.value)}>
              <option value="">Select role...</option>
              {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Phone" hint="With country code, e.g. +972...">
            <input value={f('contactPhone')} onChange={e => s('contactPhone')(e.target.value.replace(/[^0-9+]/g, ''))} placeholder="+972..." />
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
