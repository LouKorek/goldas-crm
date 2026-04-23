import React, { useState, useEffect } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { POSITIONS, CONTACT_ROLES, fmtDate } from 'lib/constants';
import { Modal, Field, ChipGroup, SortTh, SearchInput, FilterBar, PageHeader,
         Empty, Spinner, useConfirm, PhoneDisplay, NumberInput , ActionButtons } from 'components/ui/UI';
import { toast } from 'components/ui/UI';



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
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);
  const [form, setForm]       = useState(EMPTY);
  const [saving, setSaving]   = useState(false);
  const [search, setSearch]   = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort]       = useState({ field:'clubName', dir:'asc' });
  const { confirm, dialog }   = useConfirm();

  useEffect(() => {
    return listenCollection(PATHS.CLUB_REQUIREMENTS, (data) => {
      setItems(data); setLoading(false);
    }, 'clubName');
  }, []);

  const s = (k) => (v) => setForm(p => ({...p,[k]:v}));
  const f = (k) => form[k] ?? '';

  const league = form.leagueMode==='manual' ? form.leagueManual
    : (form.leagueCountry&&form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ','')}` : '');

  const openAdd  = () => { setForm({...EMPTY}); setModal('add'); };
  const openEdit = (p) => { setForm({...EMPTY,...p}); setModal({edit:p}); };
  const openDup  = (p) => { const {id:_, ...rest} = p; setForm({...EMPTY,...rest}); setModal('add'); };

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
        <Empty icon="📋" message={search?'No clubs match your search.':'No club requirements added yet.'}
          action={!search&&<button className="btn btn-primary" onClick={openAdd}>+ Add Requirement</button>} />
      ) : (
        <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Gender</th>
                  <SortTh label="Club"       field="clubName"          sort={sort} setSort={setSort} />
                  <th>League</th>
                  <th>Table Pos</th>
                  <th>Contact</th>
                  <th>Position Needed</th>
                  <th>Age Range</th>
                  <th>Max TF</th>
                  <th>Max Salary</th>
                  <th>Last Edited</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.map(p => (
                  <tr key={p.id}>
                    <td><span style={{fontSize:12,color:'var(--text-2)'}}>{p.gender||'—'}</span></td>
                    <td><span style={{fontWeight:500}}>{p.clubName}</span></td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>{p.league||'—'}</td>
                    <td style={{color:'var(--text-2)'}}>{p.tablePosition||'—'}</td>
                    <td>
                      {p.contactName && <div style={{fontWeight:500,fontSize:13}}>{p.contactName}</div>}
                      {p.contactRole && <div style={{fontSize:11,color:'var(--text-3)'}}>{p.contactRole}</div>}
                      {p.contactPhone && <PhoneDisplay phone={p.contactPhone} />}
                    </td>
                    <td>{p.requiredPosition||'—'}</td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.ageNotSpecified ? 'Not specified' : (p.ageMin&&p.ageMax ? `${p.ageMin}–${p.ageMax}` : p.ageMin||p.ageMax||'—')}
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.transferFee && p.transferFee!=='Not specified' ? `€${Number(p.transferFee).toLocaleString()}` : (p.transferFee||'—')}
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.salary && p.salary!=='Not specified' ? `€${Number(p.salary).toLocaleString()}/mo` : (p.salary||'—')}
                    </td>
                    <td style={{fontSize:11,color:'var(--text-3)'}}>{p.lastEditedByName||'—'}</td>
                    <td>
                      <ActionButtons onEdit={()=>openEdit(p)} onDuplicate={()=>openDup(p)} onDelete={()=>del(p)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal
          title={modal==='add'?'Add Club Requirement':`Edit: ${form.clubName}`}
          onClose={()=>setModal(null)} wide
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
                  {['Israel','England','Spain','Germany','Italy','France','Portugal','Netherlands','Belgium','Turkey','Greece','Switzerland','Scotland','Russia','Ukraine','Serbia'].map(c=><option key={c}>{c}</option>)}
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
