import React, { useState, useEffect } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { POSITIONS, CONTACT_ROLES, COUNTRIES, fmtDate } from 'lib/constants';
import { Modal, Field, ChipGroup, SortTh, SearchInput, FilterBar, PageHeader,
         Empty, Spinner, useConfirm, PhoneDisplay, NumberInput, ActionButtons } from 'components/ui/UI';
import { toast } from 'components/ui/UI';

// ── Club avatar (initials + hashed color) ────────────────────────
function ClubAvatar({ name, size=28 }) {
  const words = (name||'?').trim().split(/\s+/);
  const initials = words.length >= 2
    ? (words[0][0] + words[words.length-1][0]).toUpperCase()
    : (name||'?').slice(0,2).toUpperCase();
  const hue = (name||'').split('').reduce((h,c) => (h*31 + c.charCodeAt(0)) & 0xFFFF, 0) % 360;
  return (
    <div style={{
      width:size, height:size, borderRadius:6, flexShrink:0,
      background:`hsl(${hue},45%,22%)`,
      border:`1px solid hsl(${hue},50%,35%)`,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:size<=28?9:11, fontWeight:800,
      color:`hsl(${hue},70%,80%)`,
      letterSpacing:'0.04em', userSelect:'none',
    }}>{initials}</div>
  );
}

// ── Requirement view card ────────────────────────────────────────
function RequirementView({ req, onClose }) {
  const Row = ({label, value}) => value && value !== '—' ? (
    <div style={{display:'flex',gap:12,padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
      <div style={{width:160,flexShrink:0,color:'var(--text-3)',fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</div>
      <div style={{color:'var(--text-1)',fontSize:13}}>{value}</div>
    </div>
  ) : null;

  const feeDisplay = req.transferFee && req.transferFee!=='Not specified'
    ? `€${Number(req.transferFee).toLocaleString()}`
    : (req.transferFee||'—');
  const salDisplay = req.salary && req.salary!=='Not specified'
    ? `€${Number(req.salary).toLocaleString()}/mo`
    : (req.salary||'—');
  const ageDisplay = req.ageNotSpecified ? 'Not specified'
    : (req.ageMin&&req.ageMax ? `${req.ageMin}–${req.ageMax}` : req.ageMin||req.ageMax||'—');

  return (
    <Modal title={req.clubName} onClose={onClose} wide viewOnly>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:20}}>
        <ClubAvatar name={req.clubName} size={44} />
        <div>
          <div style={{fontWeight:600,fontSize:15,color:'var(--text-1)'}}>{req.clubName}</div>
          <div style={{fontSize:12,color:'var(--text-3)'}}>{req.league||'League not set'}{req.tablePosition ? ` · #${req.tablePosition} in table` : ''}</div>
        </div>
        {req.gender && (
          <span className="badge" style={{marginLeft:'auto',background:'var(--surface-3)',color:'var(--text-2)'}}>{req.gender}</span>
        )}
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
        <div>
          <div className="form-section-title">Club</div>
          <Row label="League"        value={req.league} />
          <Row label="Table Pos."    value={req.tablePosition ? `#${req.tablePosition}` : null} />

          <div className="form-section-title" style={{marginTop:16}}>Contact</div>
          <Row label="Name"   value={req.contactName} />
          <Row label="Role"   value={req.contactRole} />
          {req.contactPhone && (
            <div style={{display:'flex',gap:12,padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
              <div style={{width:160,flexShrink:0,color:'var(--text-3)',fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>Phone</div>
              <PhoneDisplay phone={req.contactPhone} />
            </div>
          )}
        </div>

        <div>
          <div className="form-section-title">Profile Needed</div>
          <Row label="Position"     value={req.requiredPosition} />
          <Row label="Age Range"    value={ageDisplay} />
          <Row label="Max Transfer" value={feeDisplay} />
          <Row label="Max Salary"   value={salDisplay} />
        </div>
      </div>

      {req.notes && (
        <div style={{marginTop:16}}>
          <div className="form-section-title">Notes</div>
          <p style={{color:'var(--text-2)',fontSize:13,lineHeight:1.7}}>{req.notes}</p>
        </div>
      )}
      {req.lastEditedByName && (
        <div style={{marginTop:12,fontSize:11,color:'var(--text-3)'}}>Last edited by {req.lastEditedByName}</div>
      )}
    </Modal>
  );
}

const EMPTY = {
  gender:'', leagueMode:'select', leagueCountry:'', leagueTier:'', leagueManual:'',
  clubName:'', tablePosition:'', contactName:'', contactRole:'', contactPhone:'',
  requiredPosition:'', ageMin:'', ageMax:'', ageNotSpecified:false,
  transferFee:'', salary:'', notes:'',
};

async function clearAll_clubrequirements() {
  if (!window.confirm('Delete ALL requirements? This cannot be undone.')) return;
  const snap = await getDocs(collection(db, 'club_requirements'));
  for (const d of snap.docs) await deleteDoc(d.ref);
  window.location.reload();
}

export default function Requirements() {
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(null);
  const [viewReq, setViewReq]   = useState(null);
  const [form, setForm]         = useState(EMPTY);
  const [saving, setSaving]     = useState(false);
  const [isDirty, setIsDirty]   = useState(false);
  const [search, setSearch]     = useState('');
  const [filters, setFilters]   = useState({});
  const [sort, setSort]         = useState({ field:'clubName', dir:'asc' });
  const { confirm, dialog }     = useConfirm();

  useEffect(() => {
    return listenCollection(PATHS.CLUB_REQUIREMENTS, (data) => {
      setItems(data); setLoading(false);
    }, 'clubName');
  }, []);

  const s = (k) => (v) => { setForm(p => ({...p,[k]:v})); setIsDirty(true); };
  const f = (k) => form[k] ?? '';

  const league = form.leagueMode==='manual' ? form.leagueManual
    : (form.leagueCountry&&form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ','')}` : '');

  const openAdd  = () => { setForm({...EMPTY}); setModal('add'); setIsDirty(false); };
  const openEdit = (p) => { setForm({...EMPTY,...p}); setModal({edit:p}); setIsDirty(false); };
  const openDup  = (p) => { const {id:_, ...rest} = p; setForm({...EMPTY,...rest}); setModal('add'); setIsDirty(false); };

  const validate = () => {
    if (!form.clubName.trim())    return 'Club name is required.';
    if (!form.gender)             return 'Gender is required.';
    const existing = items.filter(p => modal?.edit?.id !== p.id);
    if (existing.some(p => p.clubName.trim().toLowerCase()===form.clubName.trim().toLowerCase() && p.gender===form.gender && p.requiredPosition===form.requiredPosition && p.leagueCountry===form.leagueCountry))
      return 'An identical requirement already exists. Please change at least one detail.';
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const data = {...form, league};
      if (modal==='add') {
        await addDoc_(PATHS.CLUB_REQUIREMENTS, data);
        toast.success(`Requirement for "${form.clubName}" added!`);
      } else {
        await updateDoc_(PATHS.CLUB_REQUIREMENTS, modal.edit.id, data);
        toast.success('Updated.');
      }
      setModal(null);
    } catch(e) {
      toast.error(e.message || "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const del = async (p) => {
    const ok = await confirm(`Delete requirement for "${p.clubName}"?`);
    if (!ok) return;
    await deleteDoc_(PATHS.CLUB_REQUIREMENTS, p.id);
    toast.success('Deleted.');
  };

  let data = items.filter(p => {
    if (search && !`${p.clubName} ${p.contactName} ${p.league}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.gender && p.gender !== filters.gender) return false;
    if (filters.position && p.requiredPosition !== filters.position) return false;
    return true;
  });
  data = data.sort((a,b) => {
    const av = a[sort.field]||'', bv = b[sort.field]||'';
    return sort.dir==='asc' ? (av>bv?1:-1) : (av<bv?1:-1);
  });

  return (
    <div>
      <PageHeader
        title="Club Requirements"
        subtitle={`${items.length} active requirement${items.length!==1?'s':''}`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <button className="btn btn-primary" onClick={openAdd} style={{height:36}}>+ Add Requirement</button>
            <div style={{height:36,display:'flex',alignItems:'center'}}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
            <button className="btn btn-danger btn-sm" onClick={clearAll_clubrequirements}
              style={{height:36,opacity:0.45,whiteSpace:'nowrap'}} title="Clear all"
              onMouseEnter={e=>e.currentTarget.style.opacity='1'}
              onMouseLeave={e=>e.currentTarget.style.opacity='0.45'}>
              🗑 Clear All
            </button>
          </div>
        }
      >
        <div style={{marginTop:14}}>
          <FilterBar filters={filters} setFilters={setFilters} options={[
            { key:'gender', label:'Gender', values:['Men','Women'] },
            { key:'position', label:'Position', values:POSITIONS },
          ]} />
        </div>
      </PageHeader>

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',padding:60}}><Spinner size={36}/></div>
      ) : data.length === 0 ? (
        <Empty icon="📋" message={search||Object.values(filters).some(Boolean)?'No club requirements match your search.':'No club requirements added yet.'}
          action={!search&&!Object.values(filters).some(Boolean)&&<button className="btn btn-primary" onClick={openAdd}>+ Add Requirement</button>} />
      ) : (
        <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>G</th>
                  <SortTh label="🔰 Club" field="clubName" sort={sort} setSort={setSort} />
                  <th>🌍 League</th>
                  <th>#</th>
                  <th>👤 Contact</th>
                  <th>📍 Pos</th>
                  <th>🗓️ Age</th>
                  <th>💰 TF</th>
                  <th>💵 Salary</th>
                  <th>✏️</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.map(p => (
                  <tr key={p.id} onClick={()=>setViewReq(p)} style={{cursor:'pointer'}}>
                    <td onClick={e=>e.stopPropagation()}>
                      <span style={{fontSize:11,color:'var(--text-2)',fontWeight:500}}>{p.gender?p.gender.charAt(0):'—'}</span>
                    </td>
                    <td onClick={e=>e.stopPropagation()} style={{cursor:'default'}}>
                      <div style={{display:'flex',alignItems:'center',gap:7}}>
                        <ClubAvatar name={p.clubName} />
                        <span style={{fontWeight:500}}>{p.clubName}</span>
                      </div>
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>{p.league||'—'}</td>
                    <td style={{color:'var(--text-2)',fontSize:12,textAlign:'center'}}>{p.tablePosition||'—'}</td>
                    <td>
                      {p.contactName ? (
                        <div>
                          <div style={{fontSize:12,fontWeight:500,whiteSpace:'nowrap'}}>{p.contactName}</div>
                          <div style={{fontSize:10,color:'var(--text-3)'}}>{p.contactRole||''}</div>
                          {p.contactPhone && (
                            <div style={{display:'flex',gap:4,marginTop:2}}>
                              <a href={`tel:${p.contactPhone}`} onClick={e=>e.stopPropagation()}
                                style={{fontSize:12,textDecoration:'none'}} title={p.contactPhone}>📞</a>
                              <a href={`https://wa.me/${p.contactPhone.replace(/[^0-9]/g,'')}`}
                                target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}
                                style={{fontSize:12,textDecoration:'none'}} title="WhatsApp">💬</a>
                            </div>
                          )}
                        </div>
                      ) : <span style={{color:'var(--text-3)'}}>—</span>}
                    </td>
                    <td style={{fontWeight:500,textAlign:'center'}}>{p.requiredPosition||'—'}</td>
                    <td style={{color:'var(--text-2)',fontSize:12,textAlign:'center'}}>
                      {p.ageNotSpecified ? '—' : (p.ageMin&&p.ageMax ? `${p.ageMin}–${p.ageMax}` : p.ageMin||p.ageMax||'—')}
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.transferFee && p.transferFee!=='Not specified' ? `€${Number(p.transferFee).toLocaleString()}` : (p.transferFee==='Not specified'?'—':p.transferFee||'—')}
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.salary && p.salary!=='Not specified' ? `€${Number(p.salary).toLocaleString()}/mo` : (p.salary==='Not specified'?'—':p.salary||'—')}
                    </td>
                    <td style={{fontSize:11,color:'var(--text-3)',whiteSpace:'nowrap'}}>{p.lastEditedByName||'—'}</td>
                    <td onClick={e=>e.stopPropagation()}>
                      <ActionButtons
                        onView={()=>setViewReq(p)}
                        onEdit={()=>openEdit(p)}
                        onDuplicate={()=>openDup(p)}
                        onDelete={()=>del(p)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* View modal */}
      {viewReq && <RequirementView req={viewReq} onClose={()=>setViewReq(null)} />}

      {/* Add/Edit modal */}
      {modal && (
        <Modal
          title={modal==='add'?'Add Club Requirement':`Edit: ${form.clubName}`}
          onClose={()=>setModal(null)} wide isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving?<><span className="spinner" style={{width:14,height:14}}/> Saving...</>:'Save Requirement'}
            </button>
          </>}
        >
          <div className="form-section-title">Club Information</div>
          <div className="form-grid-2">
            <Field label="Gender" required>
              <ChipGroup options={['Men','Women']} value={f('gender')} onChange={s('gender')} />
            </Field>
            <Field label="Club Name" required>
              <input value={f('clubName')} onChange={e=>s('clubName')(e.target.value)} placeholder="Club name" />
            </Field>
          </div>
          <Field label="League">
            <div style={{display:'flex',gap:8,marginBottom:8}}>
              <button type="button" className={`chip${form.leagueMode==='select'?' active':''}`} onClick={()=>s('leagueMode')('select')}>By Country + Tier</button>
              <button type="button" className={`chip${form.leagueMode==='manual'?' active':''}`} onClick={()=>s('leagueMode')('manual')}>Manual</button>
            </div>
            {form.leagueMode==='select' ? (
              <div className="form-grid-2">
                <select value={f('leagueCountry')} onChange={e=>s('leagueCountry')(e.target.value)}>
                  <option value="">Country...</option>
                  {COUNTRIES.map(c=><option key={c}>{c}</option>)}
                </select>
                <ChipGroup options={['1st','2nd','3rd','4th','5th+']} value={f('leagueTier')} onChange={s('leagueTier')} />
              </div>
            ) : (
              <input value={f('leagueManual')} onChange={e=>s('leagueManual')(e.target.value)} placeholder="e.g. Premier League" />
            )}
            {league && <div className="form-hint">League: <strong>{league}</strong></div>}
          </Field>
          <Field label="Current Table Position">
            <input type="number" min={1} max={45} value={f('tablePosition')} onChange={e=>{ const v=parseInt(e.target.value); if(!e.target.value){s('tablePosition')(''); return;} if(v>=1&&v<=45) s('tablePosition')(String(v)); }} placeholder="1–45" style={{maxWidth:120}} />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Contact</div>
          <div className="form-grid-2">
            <Field label="Contact Name">
              <input value={f('contactName')} onChange={e=>s('contactName')(e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Contact Role">
              <select value={f('contactRole')} onChange={e=>s('contactRole')(e.target.value)}>
                <option value="">Select role...</option>
                {CONTACT_ROLES.map(r=><option key={r}>{r}</option>)}
                <option value="Other">Other</option>
              </select>
            </Field>
          </div>
          <Field label="Contact Phone">
            <input value={f('contactPhone')} onChange={e=>s('contactPhone')(e.target.value.replace(/[^0-9+]/g,''))} placeholder="+972..." />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Profile Required</div>
          <Field label="Required Position">
            <select value={f('requiredPosition')} onChange={e=>s('requiredPosition')(e.target.value)}>
              <option value="">Select...</option>
              {POSITIONS.map(p=><option key={p}>{p}</option>)}
            </select>
          </Field>
          <div className="form-grid-2">
            <Field label="Min Age">
              <input type="number" min={14} max={48} value={form.ageNotSpecified?'':f('ageMin')} onChange={e=>s('ageMin')(e.target.value)} disabled={form.ageNotSpecified} placeholder="Min" />
            </Field>
            <Field label="Max Age">
              <input type="number" min={14} max={48} value={form.ageNotSpecified?'':f('ageMax')} onChange={e=>s('ageMax')(e.target.value)} disabled={form.ageNotSpecified} placeholder="Max" />
            </Field>
          </div>
          <div style={{marginBottom:14}}>
            <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13,color:'var(--text-2)'}}>
              <input type="checkbox" checked={!!form.ageNotSpecified} onChange={e=>s('ageNotSpecified')(e.target.checked)} style={{accentColor:'var(--gold)'}} />
              Age: Not specified
            </label>
          </div>
          <div className="form-grid-2">
            <Field label="Max Transfer Fee (€)">
              <NumberInput value={f('transferFee')} onChange={s('transferFee')} placeholder="e.g. 500,000" allowNotSpecified />
            </Field>
            <Field label="Max Salary (€/month)">
              <NumberInput value={f('salary')} onChange={s('salary')} placeholder="e.g. 8,000" allowNotSpecified />
            </Field>
          </div>
          <Field label="Notes">
            <textarea value={f('notes')} onChange={e=>s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} />
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
