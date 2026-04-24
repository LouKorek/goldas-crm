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
                      <option key="Afghanistan">Afghanistan</option>
                      <option key="Albania">Albania</option>
                      <option key="Algeria">Algeria</option>
                      <option key="Andorra">Andorra</option>
                      <option key="Angola">Angola</option>
                      <option key="Argentina">Argentina</option>
                      <option key="Armenia">Armenia</option>
                      <option key="Australia">Australia</option>
                      <option key="Austria">Austria</option>
                      <option key="Azerbaijan">Azerbaijan</option>
                      <option key="Bahrain">Bahrain</option>
                      <option key="Bangladesh">Bangladesh</option>
                      <option key="Belarus">Belarus</option>
                      <option key="Belgium">Belgium</option>
                      <option key="Bolivia">Bolivia</option>
                      <option key="Bosnia and Herzegovina">Bosnia and Herzegovina</option>
                      <option key="Brazil">Brazil</option>
                      <option key="Bulgaria">Bulgaria</option>
                      <option key="Burkina Faso">Burkina Faso</option>
                      <option key="Cameroon">Cameroon</option>
                      <option key="Canada">Canada</option>
                      <option key="Cape Verde">Cape Verde</option>
                      <option key="Chad">Chad</option>
                      <option key="Chile">Chile</option>
                      <option key="China">China</option>
                      <option key="Colombia">Colombia</option>
                      <option key="Congo">Congo</option>
                      <option key="Costa Rica">Costa Rica</option>
                      <option key="Croatia">Croatia</option>
                      <option key="Cuba">Cuba</option>
                      <option key="Cyprus">Cyprus</option>
                      <option key="Czech Republic">Czech Republic</option>
                      <option key="Denmark">Denmark</option>
                      <option key="DR Congo">DR Congo</option>
                      <option key="Ecuador">Ecuador</option>
                      <option key="Egypt">Egypt</option>
                      <option key="El Salvador">El Salvador</option>
                      <option key="England">England</option>
                      <option key="Equatorial Guinea">Equatorial Guinea</option>
                      <option key="Estonia">Estonia</option>
                      <option key="Ethiopia">Ethiopia</option>
                      <option key="Finland">Finland</option>
                      <option key="France">France</option>
                      <option key="Gabon">Gabon</option>
                      <option key="Gambia">Gambia</option>
                      <option key="Georgia">Georgia</option>
                      <option key="Germany">Germany</option>
                      <option key="Ghana">Ghana</option>
                      <option key="Greece">Greece</option>
                      <option key="Guatemala">Guatemala</option>
                      <option key="Guinea">Guinea</option>
                      <option key="Honduras">Honduras</option>
                      <option key="Hungary">Hungary</option>
                      <option key="Iceland">Iceland</option>
                      <option key="India">India</option>
                      <option key="Indonesia">Indonesia</option>
                      <option key="Iran">Iran</option>
                      <option key="Iraq">Iraq</option>
                      <option key="Ireland">Ireland</option>
                      <option key="Israel">Israel</option>
                      <option key="Italy">Italy</option>
                      <option key="Jamaica">Jamaica</option>
                      <option key="Japan">Japan</option>
                      <option key="Jordan">Jordan</option>
                      <option key="Kazakhstan">Kazakhstan</option>
                      <option key="Kenya">Kenya</option>
                      <option key="Kosovo">Kosovo</option>
                      <option key="Kuwait">Kuwait</option>
                      <option key="Latvia">Latvia</option>
                      <option key="Lebanon">Lebanon</option>
                      <option key="Libya">Libya</option>
                      <option key="Lithuania">Lithuania</option>
                      <option key="Luxembourg">Luxembourg</option>
                      <option key="Madagascar">Madagascar</option>
                      <option key="Malawi">Malawi</option>
                      <option key="Malaysia">Malaysia</option>
                      <option key="Mali">Mali</option>
                      <option key="Malta">Malta</option>
                      <option key="Mauritania">Mauritania</option>
                      <option key="Mauritius">Mauritius</option>
                      <option key="Mexico">Mexico</option>
                      <option key="Moldova">Moldova</option>
                      <option key="Montenegro">Montenegro</option>
                      <option key="Morocco">Morocco</option>
                      <option key="Mozambique">Mozambique</option>
                      <option key="Myanmar">Myanmar</option>
                      <option key="Namibia">Namibia</option>
                      <option key="Nepal">Nepal</option>
                      <option key="Netherlands">Netherlands</option>
                      <option key="New Zealand">New Zealand</option>
                      <option key="Nicaragua">Nicaragua</option>
                      <option key="Niger">Niger</option>
                      <option key="Nigeria">Nigeria</option>
                      <option key="North Korea">North Korea</option>
                      <option key="North Macedonia">North Macedonia</option>
                      <option key="Northern Ireland">Northern Ireland</option>
                      <option key="Norway">Norway</option>
                      <option key="Oman">Oman</option>
                      <option key="Pakistan">Pakistan</option>
                      <option key="Palestine">Palestine</option>
                      <option key="Panama">Panama</option>
                      <option key="Paraguay">Paraguay</option>
                      <option key="Peru">Peru</option>
                      <option key="Philippines">Philippines</option>
                      <option key="Poland">Poland</option>
                      <option key="Portugal">Portugal</option>
                      <option key="Qatar">Qatar</option>
                      <option key="Romania">Romania</option>
                      <option key="Russia">Russia</option>
                      <option key="Rwanda">Rwanda</option>
                      <option key="Saudi Arabia">Saudi Arabia</option>
                      <option key="Scotland">Scotland</option>
                      <option key="Senegal">Senegal</option>
                      <option key="Serbia">Serbia</option>
                      <option key="Sierra Leone">Sierra Leone</option>
                      <option key="Singapore">Singapore</option>
                      <option key="Slovakia">Slovakia</option>
                      <option key="Slovenia">Slovenia</option>
                      <option key="Somalia">Somalia</option>
                      <option key="South Africa">South Africa</option>
                      <option key="South Korea">South Korea</option>
                      <option key="South Sudan">South Sudan</option>
                      <option key="Spain">Spain</option>
                      <option key="Sri Lanka">Sri Lanka</option>
                      <option key="Sudan">Sudan</option>
                      <option key="Sweden">Sweden</option>
                      <option key="Switzerland">Switzerland</option>
                      <option key="Syria">Syria</option>
                      <option key="Tajikistan">Tajikistan</option>
                      <option key="Tanzania">Tanzania</option>
                      <option key="Thailand">Thailand</option>
                      <option key="Togo">Togo</option>
                      <option key="Trinidad and Tobago">Trinidad and Tobago</option>
                      <option key="Tunisia">Tunisia</option>
                      <option key="Turkey">Turkey</option>
                      <option key="Turkmenistan">Turkmenistan</option>
                      <option key="Uganda">Uganda</option>
                      <option key="Ukraine">Ukraine</option>
                      <option key="United Arab Emirates">United Arab Emirates</option>
                      <option key="United Kingdom">United Kingdom</option>
                      <option key="United States">United States</option>
                      <option key="Uruguay">Uruguay</option>
                      <option key="Uzbekistan">Uzbekistan</option>
                      <option key="Venezuela">Venezuela</option>
                      <option key="Vietnam">Vietnam</option>
                      <option key="Wales">Wales</option>
                      <option key="Yemen">Yemen</option>
                      <option key="Zambia">Zambia</option>
                      <option key="Zimbabwe">Zimbabwe</option>
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
