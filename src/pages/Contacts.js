import React, { useState, useEffect } from 'react';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { CONTACT_ROLES, COUNTRIES, formatPhone } from 'lib/constants';
import { Modal, Field, ChipGroup, SearchInput, PageHeader, Empty, useConfirm,
         PhoneActions, RowActions, ExportMenu, toast } from 'components/ui/UI';
import { ClubLogoOrAvatar, U19 } from './Requirements';
import { useRole } from 'lib/roleContext';

const EMPTY = { clubName: '', clubIsYouth: false, leagueMode: 'select', leagueCountry: '', leagueTier: '', leagueManual: '', league: '', contactName: '', contactRole: '', contactPhone: '' };

export default function Contacts() {
  const [items, setItems]   = useState([]);
  const [search, setSearch] = useState('');
  const [youthScope, setYouthScope] = useState('');  // '' | 'Youth' | 'Senior'
  const [modal, setModal]   = useState(null);   // 'add' | { edit }
  const [form, setForm]     = useState(EMPTY);
  const { confirm, dialog } = useConfirm();
  const { canEdit } = useRole();

  useEffect(() => listenCollection(PATHS.CONTACTS, setItems, 'clubName'), []);

  const f = (k) => form[k];
  const s = (k) => (v) => setForm(p => ({ ...p, [k]: v }));

  const league = form.leagueMode === 'manual'
    ? form.leagueManual
    : (form.leagueCountry && form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ', '')}` : '');

  const openAdd  = () => { setForm({ ...EMPTY }); setModal('add'); };
  const openEdit = (c) => { setForm({ ...EMPTY, ...c }); setModal({ edit: c }); };
  const openDup  = (c) => { const rest = { ...c }; delete rest.id; setForm({ ...EMPTY, ...rest }); setModal('add'); };

  const save = async () => {
    if (!form.clubName.trim() && !form.contactName.trim()) {
      toast.error('Add at least a club or a contact name.');
      return;
    }
    const data = { ...form, league };
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
  const filtered = items.filter(c => {
    if (term && !`${c.clubName || ''} ${c.contactName || ''} ${c.contactRole || ''}`.toLowerCase().includes(term)) return false;
    if (youthScope === 'Youth'  && !c.clubIsYouth) return false;
    if (youthScope === 'Senior' &&  c.clubIsYouth) return false;
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Contacts"
        subtitle={`${items.length} contact${items.length !== 1 ? 's' : ''}`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{height:36}}>+ Add Contact</button>}
            <ExportMenu
              filename="Contacts"
              title="Contacts"
              subtitle={term ? `search: "${term}"` : ''}
              columns={[
                { key: 'clubName',       label: '🔰',   pdfLabel: 'Club',
                  format: (v, r) => v ? `${v}${r.clubIsYouth ? ' (U19)' : ''}${r.league ? `  ·  ${r.league}` : ''}` : '' },
                { key: 'contactName',    label: '👤',   pdfLabel: 'Contact' },
                { key: 'contactRole',    label: 'Role', pdfLabel: 'Role' },
                { key: 'contactPhone',   label: '📞',   pdfLabel: 'Phone' },
              ]}
              rows={filtered}
            />
          </div>
        }
      />

      <div className="filter-bar" style={{ marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', maxWidth: 360 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search club, name, role..." />
        </div>
        <select value={youthScope} onChange={e => setYouthScope(e.target.value)} style={{ width: 'auto', minWidth: 170, height: 36, flexShrink: 0 }}>
          <option value="">🌱 Group: All</option>
          <option value="Youth">Youth</option>
          <option value="Senior">Senior</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <Empty
          icon="📇"
          message={items.length === 0 ? 'No contacts yet — add your first one.' : 'No matching contacts.'}
          action={canEdit && items.length === 0 ? <button className="btn btn-primary" onClick={openAdd}>+ Add Contact</button> : null}
        />
      ) : (
        <>
        <div className="mobile-cards">
          {filtered.map(c => (
            <div key={c.id} className="m-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ClubLogoOrAvatar name={c.clubName} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.clubName || '—'}</span>
                    {c.clubIsYouth && <U19 />}
                  </div>
                  {c.league && <div className="m-sub">{c.league}</div>}
                </div>
                {canEdit && <RowActions onDelete={() => remove(c)} onEdit={() => openEdit(c)} onDuplicate={() => openDup(c)} />}
              </div>
              {(c.contactName || c.contactRole || c.contactPhone) && (
                <div className="m-meta" style={{ marginTop: 8 }}>
                  {c.contactName && <span>👤 {c.contactName}</span>}
                  {c.contactRole && <span className="m-sub">{c.contactRole}</span>}
                  {c.contactPhone && <span>{formatPhone(c.contactPhone)}</span>}
                  {c.contactPhone && <PhoneActions phone={c.contactPhone} />}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="card desktop-table" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 100, paddingRight: 20 }}></th>
                  <th style={{ width: '36%', textAlign: 'center' }}>Club</th>
                  <th style={{ width: '36%', textAlign: 'center' }}>Contact</th>
                  <th style={{ width: 210, textAlign: 'center' }}>Phone</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id}>
                    <td style={{ paddingRight: 20 }}>
                      {canEdit && <RowActions onDelete={() => remove(c)} onEdit={() => openEdit(c)} onDuplicate={() => openDup(c)} />}
                    </td>
                    <td style={{ textAlign: 'left', paddingLeft: 24 }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start' }}>
                        <ClubLogoOrAvatar name={c.clubName} size={26} />
                        <div style={{ textAlign: 'left' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.clubName || '—'}</span>
                            {c.clubIsYouth && <U19 />}
                          </div>
                          {c.league && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{c.league}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'left', paddingLeft: 24 }}>
                      {(c.contactName || c.contactRole) ? (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{c.contactName || '—'}</div>
                          {c.contactRole && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{c.contactRole}</div>}
                        </div>
                      ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {c.contactPhone ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
                          <span style={{ fontSize: 12 }}>{formatPhone(c.contactPhone)}</span>
                          <PhoneActions phone={c.contactPhone} />
                        </div>
                      ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
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
          <Field label="League">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button type="button" className={`chip${form.leagueMode === 'select' ? ' active' : ''}`} onClick={() => s('leagueMode')('select')}>By Country + Tier</button>
              <button type="button" className={`chip${form.leagueMode === 'manual' ? ' active' : ''}`} onClick={() => s('leagueMode')('manual')}>Manual</button>
            </div>
            {form.leagueMode === 'select' ? (
              <div className="form-grid-2">
                <select value={f('leagueCountry')} onChange={e => s('leagueCountry')(e.target.value)}>
                  <option value="">Country...</option>
                  {COUNTRIES.map(co => <option key={co}>{co}</option>)}
                </select>
                <ChipGroup options={['1st', '2nd', '3rd', '4th', '5th+']} value={f('leagueTier')} onChange={s('leagueTier')} />
              </div>
            ) : (
              <input value={f('leagueManual')} onChange={e => s('leagueManual')(e.target.value)} placeholder="e.g. Premier League" />
            )}
            {league && (
              <div className="form-hint">League: <strong>{league}</strong></div>
            )}
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
