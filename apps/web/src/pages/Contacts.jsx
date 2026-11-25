import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, restoreDoc_, PATHS } from 'lib/db';
import { CONTACT_ROLES, COUNTRIES, formatPhone } from 'lib/constants';
import { Modal, Field, ChipGroup, SearchInput, PageHeader, Empty, useConfirm,
         PhoneActions, RowActions, ActionBtn, ExportMenu, toast } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { ClubLogoOrAvatar, U19 } from './Requirements';
import { useRole } from 'lib/roleContext';
import { t } from 'lib/i18n';
import ContactTouches, { lastTouchLine } from 'components/ContactTouches';
import ContactNetwork from 'components/contacts/ContactNetwork';
import { normalizeEmail } from '@goldas/domain';
import RecordMail from 'components/mail/RecordMail';

const EMPTY = { clubName: '', clubIsYouth: false, leagueMode: 'select', leagueCountry: '', leagueTier: '', leagueManual: '', league: '', contactName: '', contactRole: '', contactPhone: '', contactEmail: '' };

export default function Contacts() {
  const [items, setItems]   = useState([]);
  const [search, setSearch] = useState('');
  const [youthScope, setYouthScope] = useState('');  // '' | 'Youth' | 'Senior'
  const [modal, setModal]   = useState(null);   // 'add' | { edit }
  const [touchesOf, setTouchesOf] = useState(null);   // the id of the contact whose touches are open
  const [touchDirty, setTouchDirty] = useState(false);  // a note typed in the touches window and not added yet
  const [form, setForm]     = useState(EMPTY);
  const [isDirty, setIsDirty] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { canEdit } = useRole();
  // The list or the relationship map (?view=map), one destination.
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'map' ? 'map' : 'list';
  const setView = (v) => { const p = new URLSearchParams(); if (v === 'map') p.set('view', 'map'); setParams(p, { replace: true }); };

  useEffect(() => listenCollection(PATHS.CONTACTS, setItems, 'clubName'), []);

  const f = (k) => form[k];
  const s = (k) => (v) => { setForm(p => ({ ...p, [k]: v })); setIsDirty(true); };

  const league = form.leagueMode === 'manual'
    ? form.leagueManual
    : (form.leagueCountry && form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ', '')}` : '');

  const openAdd  = () => { setForm({ ...EMPTY }); setIsDirty(false); setModal('add'); };
  const openEdit = (c) => { setForm({ ...EMPTY, ...c }); setIsDirty(false); setModal({ edit: c }); };
  // A copy keeps the club, not the person: the e-mail address belongs to one contact.
  const openDup  = (c) => { const rest = { ...c }; delete rest.id; setForm({ ...EMPTY, ...rest, contactEmail: '' }); setIsDirty(false); setModal('add'); };

  const save = async () => {
    if (!form.clubName.trim() && !form.contactName.trim()) {
      toast.error(t("Add at least a club or a contact name."));
      return;
    }
    // The address links the contact's mail (lib/mail-store.js), so it is kept in one form and on one contact.
    const emailRaw = String(form.contactEmail || '').trim();
    const contactEmail = emailRaw ? normalizeEmail(emailRaw) : '';
    if (emailRaw && !contactEmail) { toast.error(t('That does not look like an e-mail address.')); return; }
    const same = contactEmail && items.find((c) => normalizeEmail(c.contactEmail) === contactEmail && c.id !== modal?.edit?.id);
    if (same) { toast.error(t('"{name}" already has this e-mail address.', { name: same.contactName || same.clubName })); return; }
    const data = { ...form, contactEmail, league };
    try {
      if (modal === 'add') {
        await addDoc_(PATHS.CONTACTS, data);
        toast.success(t("Contact added."));
      } else {
        await updateDoc_(PATHS.CONTACTS, modal.edit.id, data);
        toast.success(t("Contact updated."));
      }
      setModal(null);
    } catch (e) {
      toast.error(t("Could not save. Please try again."));
    }
  };

  const remove = async (c) => {
    const ok = await confirm(`Delete contact "${c.contactName || c.clubName}"?`, { title: t("Delete contact") });
    if (!ok) return;
    try {
      await deleteDoc_(PATHS.CONTACTS, c.id);
      toast.success(t("Contact deleted."), { undo: () => restoreDoc_(PATHS.CONTACTS, c.id) });
    } catch (e) {
      toast.error(t("Could not delete. Please try again."));
    }
  };

  // The touches window follows the live record, so a touch added there shows at once.
  const touchContact = touchesOf ? items.find((c) => c.id === touchesOf) : null;
  // The last touch under the contact, opening the whole list (read-only for a viewer).
  const TouchChip = ({ c }) => {
    const line = lastTouchLine(c);
    if (!line) return null;
    return (
      <button type="button" className="tap-text" onClick={() => setTouchesOf(c.id)} title={t('Touches')}
        style={{ background: 'none', border: 0, padding: 0, marginTop: 3, fontSize: 11, color: 'var(--text-2)',
          cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, textAlign: 'start' }}>
        {`${t('Last touch')}: ${line}`}
      </button>
    );
  };
  const touchAction = (c) => <ActionBtn icon="clock" tone="blue" title={t('Touches')} onClick={() => setTouchesOf(c.id)} />;

  const term = search.trim().toLowerCase();
  const filtered = items.filter(c => {
    if (term && !`${c.clubName || ''} ${c.contactName || ''} ${c.contactRole || ''}`.toLowerCase().includes(term)) return false;
    if (youthScope === 'Youth'  && !c.clubIsYouth) return false;
    if (youthScope === 'Senior' &&  c.clubIsYouth) return false;
    return true;
  });

  return (
    <div className="table-page">
      <PageHeader
        title={t("Contacts")}
        subtitle={`${items.length} ${items.length === 1 ? t('contact') : t('contacts')}`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{height:36}}><Icon name="plus" size={12} /><span className="btn-text">{t("Add Contact")}</span></button>}
            {view === 'list' && <ExportMenu
              filename="Contacts"
              title={t("Contacts")}
              subtitle={term ? `search: "${term}"` : ''}
              columns={[
                { key: 'clubName',       label: '🔰',   pdfLabel: 'Club',
                  format: (v, r) => v ? `${v}${r.clubIsYouth ? ' (U19)' : ''}${r.league ? `  ·  ${r.league}` : ''}` : '' },
                { key: 'contactName',    label: '👤',   pdfLabel: 'Contact' },
                { key: 'contactRole',    label: t("Role"), pdfLabel: 'Role' },
                { key: 'contactPhone',   label: '📞',   pdfLabel: 'Phone' },
              ]}
              rows={filtered}
            />}
          </div>
        }
      >

      <div className="filter-bar" style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="group" aria-label={t('View')} style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button type="button" className={`chip${view === 'list' ? ' active' : ''}`} aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('List')}</button>
          <button type="button" className={`chip${view === 'map' ? ' active' : ''}`} aria-pressed={view === 'map'} onClick={() => setView('map')}>{t('Relationship map')}</button>
        </div>
        <div style={{ flex: '1 1 240px', maxWidth: 360 }}>
          <SearchInput value={search} onChange={setSearch} placeholder={t("Search club, name, role...")} />
        </div>
        {view === 'list' && <select value={youthScope} onChange={e => setYouthScope(e.target.value)} style={{ width: 'auto', minWidth: 170, height: 38, padding: '0 10px', flexShrink: 0 }}>
          <option value="">{t("Group: All")}</option>
          <option value="Youth">{t("Youth")}</option>
          <option value="Senior">{t("Senior")}</option>
        </select>}
      </div>
      </PageHeader>

      {view === 'map' ? (
        <ContactNetwork contacts={items} search={search} onEdit={openEdit} params={params} setParams={setParams} />
      ) : filtered.length === 0 ? (
        <Empty
          message={items.length === 0 ? t('No contacts yet. Add the first one.') : t('No matching contacts.')}
          action={canEdit && items.length === 0 ? <button className="btn btn-primary" onClick={openAdd}>{t("+ Add Contact")}</button> : null}
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
                {canEdit && <RowActions onDelete={() => remove(c)} onEdit={() => openEdit(c)} onDuplicate={() => openDup(c)}>{touchAction(c)}</RowActions>}
              </div>
              {(c.contactName || c.contactRole || c.contactPhone) && (
                <div className="m-meta" style={{ marginTop: 8 }}>
                  {c.contactName && <span>{c.contactName}</span>}
                  {c.contactRole && <span className="m-sub">{c.contactRole}</span>}
                  {c.contactPhone && <span className="ltr">{formatPhone(c.contactPhone)}</span>}
                  {c.contactPhone && <PhoneActions phone={c.contactPhone} />}
                </div>
              )}
              <TouchChip c={c} />
            </div>
          ))}
        </div>
        <div className="card desktop-table" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 100, paddingInlineEnd: 20 }}></th>
                  <th style={{ width: '36%', textAlign: 'center' }}>{t("Club")}</th>
                  <th style={{ width: '36%', textAlign: 'center' }}>{t("Contact")}</th>
                  <th style={{ width: 210, textAlign: 'center' }}>{t("Phone")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id}>
                    <td style={{ paddingInlineEnd: 20 }}>
                      {canEdit && <RowActions onDelete={() => remove(c)} onEdit={() => openEdit(c)} onDuplicate={() => openDup(c)}>{touchAction(c)}</RowActions>}
                    </td>
                    <td style={{ textAlign: 'start', paddingInlineStart: 24 }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start' }}>
                        <ClubLogoOrAvatar name={c.clubName} size={26} />
                        <div style={{ textAlign: 'start' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.clubName || '—'}</span>
                            {c.clubIsYouth && <U19 />}
                          </div>
                          {c.league && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{c.league}</div>}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'start', paddingInlineStart: 24 }}>
                      {(c.contactName || c.contactRole) ? (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{c.contactName || '—'}</div>
                          {c.contactRole && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{c.contactRole}</div>}
                          <TouchChip c={c} />
                        </div>
                      ) : <><span style={{ color: 'var(--text-3)' }}>—</span><div><TouchChip c={c} /></div></>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {c.contactPhone ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
                          <span className="ltr" style={{ fontSize: 12 }}>{formatPhone(c.contactPhone)}</span>
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
          title={modal === 'add' ? t('Add Contact') : `${t('Edit')}: ${form.contactName || form.clubName || t('Contact')}`}
          onClose={() => setModal(null)} isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>{t("Cancel")}</button>
            <button className="btn btn-primary" onClick={save}>{t("Save")}</button>
          </>}
        >
          <Field label={t("Club Name")}>
            <input value={f('clubName')} onChange={e => s('clubName')(e.target.value)} placeholder={t("Club name")} />
            <button type="button" className={`chip${form.clubIsYouth ? ' active' : ''}`}
              onClick={() => s('clubIsYouth')(!form.clubIsYouth)}
              style={{ fontSize: 11, padding: '4px 10px', marginTop: 6 }}>{t("Youth Team")}</button>
          </Field>
          <Field label={t("League")}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button type="button" className={`chip${form.leagueMode === 'select' ? ' active' : ''}`} onClick={() => s('leagueMode')('select')}>{t("By Country + Tier")}</button>
              <button type="button" className={`chip${form.leagueMode === 'manual' ? ' active' : ''}`} onClick={() => s('leagueMode')('manual')}>{t("Manual")}</button>
            </div>
            {form.leagueMode === 'select' ? (
              <div className="form-grid-2">
                <select value={f('leagueCountry')} onChange={e => s('leagueCountry')(e.target.value)}>
                  <option value="">{t("Country...")}</option>
                  {COUNTRIES.map(co => <option key={co}>{co}</option>)}
                </select>
                <ChipGroup options={['1st', '2nd', '3rd', '4th', '5th+']} value={f('leagueTier')} onChange={s('leagueTier')} />
              </div>
            ) : (
              <input value={f('leagueManual')} onChange={e => s('leagueManual')(e.target.value)} placeholder={t("e.g. Premier League")} />
            )}
            {league && (
              <div className="form-hint">{t("League:")} <strong>{league}</strong></div>
            )}
          </Field>
          <Field label={t("Contact Name")}>
            <input value={f('contactName')} onChange={e => s('contactName')(e.target.value)} placeholder={t("Full name")} />
          </Field>
          <Field label={t("Role")}>
            <select value={f('contactRole')} onChange={e => s('contactRole')(e.target.value)}>
              <option value="">{t("Select role...")}</option>
              {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label={t("Phone")} hint={t("With country code, e.g. +972...")}>
            <input value={f('contactPhone')} onChange={e => s('contactPhone')(e.target.value.replace(/[^0-9+]/g, ''))} placeholder="+972..." />
          </Field>
          <Field label={t('E-mail address')} hint={t('The CRM shows the agency\'s mail with this address on the contact and its club.')}>
            <input type="email" value={f('contactEmail') || ''} onChange={e => s('contactEmail')(e.target.value)} placeholder="name@club.com" dir="ltr" autoComplete="off" />
          </Field>
          {modal.edit && <RecordMail kind="contact" id={modal.edit.id} />}
        </Modal>
      )}

      {touchContact && (
        <Modal title={`${t('Touches')}: ${touchContact.contactName || touchContact.clubName || ''}`} onClose={() => { setTouchesOf(null); setTouchDirty(false); }} viewOnly={!canEdit} isDirty={touchDirty}>
          <ContactTouches contact={touchContact} canEdit={canEdit} onDirty={setTouchDirty} />
        </Modal>
      )}

      {dialog}
    </div>
  );
}
