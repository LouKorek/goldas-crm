import React, { useState, useEffect } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { POSITIONS, FOOT_OPTIONS, NAT_TEAM_STATUS, PIPELINE_STATUS, PIPELINE_STATUS_COLORS,
         calcAge, fmtDate, isEuropean } from 'lib/constants';
import { Modal, Field, ChipGroup, CountrySelect, DateInput, SortTh, SearchInput,
         FilterBar, PageHeader, Empty, Spinner, useConfirm, StatusBadge,
         EUBadge, PhoneDisplay, NumberInput, LinkIcon , ActionButtons } from 'components/ui/UI';
import { toast } from 'components/ui/UI';

const CAT = { men:'Men', women:'Women', youth:'Youth', jewish:'Jewish' };
const CAT_EMOJI = { men:'🏃', women:'🏃‍♀️', youth:'🌱', jewish:'✡️' };
const CAT_COLOR = { men:'#4ADE80', women:'#F472B6', youth:'#60A5FA', jewish:'#A78BFA' };


const EMPTY = {
  status:'Not Contacted', playerName:'', profileLink:'', videoLink:'',
  agentName:'', agentPhone:'', nationalities:[], dob:'',
  primaryPosition:'', secondaryPositions:[], height:'', foot:'',
  currentClub:'', leagueCountry:'', leagueTier:'', leagueManual:'', leagueMode:'select',
  natTeamStatus:'', transferFee:'', salary:'', notes:'',
};

function PlayerCardModal({ player, onClose }) {
  const age    = calcAge(player.dob);
  const league = player.leagueMode==='manual' ? player.leagueManual
    : (player.leagueCountry&&player.leagueTier ? `${player.leagueCountry} ${player.leagueTier.replace('Tier ','')}` : '');
  const card = [
    `⚽ PLAYER PROFILE — GOLD A&S`,
    ``,
    `👤 ${player.playerName}`,
    `🌍 ${(player.nationalities||[]).join(' / ') || '—'}`,
    '📅 DOB: ' + fmtDate(player.dob) + (age ? ' (' + age + ' yrs)' : ''),
    '🏟 Club: ' + (player.currentClub||'Free Agent') + (league ? ' | ' + league : ''),
    '📍 Position: ' + (player.primaryPosition||'—') + (player.secondaryPositions?.length ? ' / ' + player.secondaryPositions.join(', ') : ''),
    `📏 Height: ${player.height||'—'}`,
    `👟 Foot: ${player.foot||'—'}`,
    player.profileLink ? `🔗 Profile: ${player.profileLink}` : '',
    player.videoLink   ? `🎬 Video: ${player.videoLink}` : '',
    ``,
    `📧 gold-as.com`,
  ].filter(l => l !== null && !(l===''&&false)).join('\n');

  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(card).then(() => { setCopied(true); setTimeout(()=>setCopied(false),2000); });
  };

  return (
    <Modal title="Player Card" onClose={onClose} footer={
      <button className="btn btn-primary" onClick={copy}>{copied?'✓ Copied!':'Copy Card'}</button>
    }>
      <pre style={{
        background:'var(--surface-3)', border:'1px solid var(--border)', borderRadius:8,
        color:'var(--text-1)', fontFamily:'monospace', fontSize:13, lineHeight:1.7,
        padding:16, whiteSpace:'pre-wrap', wordBreak:'break-word',
      }}>{card}</pre>
    </Modal>
  );
}


async function clearAllCategory(path) {
  if (!window.confirm('Delete ALL players in this category? This cannot be undone.')) return;
  const snap = await getDocs(collection(db, path));
  for (const d of snap.docs) await deleteDoc(d.ref);
  window.location.reload();
}
export default function Pipeline({ category }) {
  const path     = PATHS[`PIPELINE_${category.toUpperCase()}`];
  const label    = CAT[category];
  const color    = CAT_COLOR[category];

  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY);
  const [cardFor, setCardFor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [sort, setSort]     = useState({ field:'primaryPosition', dir:'asc' });
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    setLoading(true);
    return listenCollection(path, (data) => {
      setItems(data); setLoading(false);
    }, 'playerName');
  }, [path]);

  const s = (k) => (v) => { setForm(p => ({...p,[k]:v})); setIsDirty(true); };
  const f = (k) => form[k] ?? '';

  const league = form.leagueMode==='manual' ? form.leagueManual
    : (form.leagueCountry&&form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ','')}` : '');

  const openAdd  = () => { setForm({...EMPTY}); setModal('add'); setIsDirty(false); };
  const openEdit = (p) => { setForm({...EMPTY,...p}); setModal({edit:p}); setIsDirty(false); };
  const openDup  = (p) => { const {id:_, ...rest} = p; setForm({...EMPTY,...rest}); setModal('add'); setIsDirty(false); };

  const validate = () => {
    if (!form.playerName.trim()) return 'Player name is required.';
    const existing = items.filter(p => modal?.edit?.id !== p.id);
    if (existing.some(p => p.playerName.trim().toLowerCase() === form.playerName.trim().toLowerCase() && p.dob === form.dob && p.primaryPosition === form.primaryPosition))
      return 'An identical player already exists. Please change at least one detail.';
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const data = {...form, league};
      if (modal==='add') {
        await addDoc_(path, data);
        toast.success(`"${form.playerName}" added!`);
      } else {
        await updateDoc_(path, modal.edit.id, data);
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
    const ok = await confirm(`Delete "${p.playerName}"?`);
    if (!ok) return;
    await deleteDoc_(path, p.id);
    toast.success('Deleted.');
  };

  // Sort order: Position → Name
  let data = items.filter(p => {
    if (search && !`${p.playerName} ${p.currentClub} ${p.primaryPosition} ${p.agentName}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.status && p.status !== filters.status) return false;
    if (filters.position && p.primaryPosition !== filters.position) return false;
    return true;
  });
  data = data.sort((a,b) => {
    const av = a[sort.field]||'', bv = b[sort.field]||'';
    return sort.dir==='asc' ? (av>bv?1:-1) : (av<bv?1:-1);
  });

  return (
    <div>
      <PageHeader
        title={label}
        subtitle={`${items.length} player${items.length!==1?'s':''} in this category`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <button className="btn btn-primary" onClick={openAdd} style={{height:36,background:color,color:'#0A1F12'}}>+ Add Player</button>
            <div style={{height:36,display:'flex',alignItems:'center'}}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
            <button className="btn btn-danger btn-sm" onClick={()=>clearAllCategory(path)}
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
            { key:'status', label:'Status', values:PIPELINE_STATUS },
            { key:'position', label:'Position', values:POSITIONS },
          ]} />
        </div>
      </PageHeader>

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',padding:60}}><Spinner size={36}/></div>
      ) : data.length === 0 ? (
        <Empty icon={CAT_EMOJI[category]} message={search||Object.values(filters).some(Boolean)?'No players match your search.':'No players in this category yet.'}
          action={!search&&!Object.values(filters).some(Boolean)&&<button className="btn btn-primary" onClick={openAdd} style={{background:color,color:'#0A1F12'}}>+ Add Player</button>} />
      ) : (
        <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortTh label="Status"   field="status"          sort={sort} setSort={setSort} />
                  <SortTh label="Name"     field="playerName"      sort={sort} setSort={setSort} />
                  <th>Links</th>
                  <SortTh label="Age"      field="dob"             sort={sort} setSort={setSort} />
                  <SortTh label="Position" field="primaryPosition" sort={sort} setSort={setSort} />
                  <th>Nationality</th>
                  <th>EU</th>
                  <th>Club / League</th>
                  <th>Agent</th>
                  <th>Transfer Fee</th>
                  <th>Salary</th>
                  <th>Nat. Team</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.map(p => (
                  <tr key={p.id}>
                    <td><StatusBadge status={p.status} colorMap={PIPELINE_STATUS_COLORS} /></td>
                    <td>
                      <span style={{fontWeight:500}}>{p.playerName}</span>
                      {p.height && <div style={{fontSize:11,color:'var(--text-3)'}}>{p.height}cm · {p.foot||'—'}</div>}
                    </td>
                    <td>
                      <div style={{display:'flex',gap:8}}>
                        <LinkIcon url={p.profileLink} emoji="🔗" label="Profile" />
                        <LinkIcon url={p.videoLink}   emoji="🎬" label="Video" />
                      </div>
                    </td>
                    <td style={{color:'var(--text-2)'}}>{calcAge(p.dob)??'—'}</td>
                    <td>
                      <span style={{fontWeight:500}}>{p.primaryPosition||'—'}</span>
                      {p.secondaryPositions?.length>0 && <div style={{fontSize:11,color:'var(--text-3)'}}>{Array.isArray(p.secondaryPositions)?p.secondaryPositions.join(', '):p.secondaryPositions}</div>}
                    </td>
                    <td style={{maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',color:'var(--text-2)'}}>
                      {(p.nationalities||[]).join(', ')||'—'}
                    </td>
                    <td><EUBadge is={isEuropean(p.nationalities)} /></td>
                    <td>
                      <div style={{fontWeight:500}}>{p.currentClub||'Free'}</div>
                      <div style={{fontSize:11,color:'var(--text-3)'}}>{p.league||''}</div>
                    </td>
                    <td>
                      <div style={{fontSize:13}}>{p.agentName||'—'}</div>
                      {p.agentPhone && <PhoneDisplay phone={p.agentPhone} />}
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.transferFee && p.transferFee!=='Not specified' ? `€${Number(p.transferFee).toLocaleString()}` : (p.transferFee||'—')}
                    </td>
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.salary && p.salary!=='Not specified' ? `€${Number(p.salary).toLocaleString()}/mo` : (p.salary||'—')}
                    </td>
                    <td style={{fontSize:12,color:'var(--text-3)'}}>{p.natTeamStatus||'—'}</td>
                    <td>
                      <div style={{display:'flex',gap:4}}>
                        <button className="btn btn-ghost btn-sm" onClick={()=>setCardFor(p)} title="Generate Card">📋</button>
                        <button className="btn btn-ghost btn-sm" onClick={()=>openEdit(p)}>Edit</button>
                        <button className="btn btn-ghost btn-sm" onClick={()=>openDup(p)} title="Duplicate">⊕</button>
                        <button className="btn btn-danger btn-sm" onClick={()=>del(p)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {modal && (
        <Modal
          title={modal==='add'?`Add — ${label}`:`Edit: ${form.playerName}`}
          onClose={()=>setModal(null)} wide isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}
              style={{background:color,color:'#0A1F12'}}>
              {saving?<><span className="spinner" style={{width:14,height:14}}/> Saving...</>:'Save Player'}
            </button>
          </>}
        >
          <div className="form-section-title">Status & Basic Info</div>
          <Field label="Status">
            <ChipGroup options={PIPELINE_STATUS} value={f('status')} onChange={s('status')} />
          </Field>
          <div className="form-grid-2">
            <Field label="Player Name" required>
              <input value={f('playerName')} onChange={e=>s('playerName')(e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Height (cm)">
              <input type="number" min={130} max={225} value={f('height')} onChange={e=>{ const v=parseInt(e.target.value); if(!e.target.value){s('height')(''); return;} if(v>=130&&v<=225) s('height')(String(v)); }} placeholder="130–225 cm" />
            </Field>
          </div>
          <div className="form-grid-2">
            <Field label="Profile Link">
              <input value={f('profileLink')} onChange={e=>s('profileLink')(e.target.value)} placeholder="Transfermarkt, Wyscout..." />
            </Field>
            <Field label="Video Link">
              <input value={f('videoLink')} onChange={e=>s('videoLink')(e.target.value)} placeholder="YouTube, highlights..." />
            </Field>
          </div>

          <hr className="divider" />
          <div className="form-section-title">Player Details</div>
          <div className="form-grid-3">
            <Field label="Date of Birth">
              <DateInput value={f('dob')} onChange={s('dob')} />
            </Field>
            <Field label="Primary Position">
              <select value={f('primaryPosition')} onChange={e=>s('primaryPosition')(e.target.value)}>
                <option value="">Select...</option>
                {POSITIONS.map(p=><option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Strong Foot">
              <ChipGroup options={FOOT_OPTIONS} value={f('foot')} onChange={s('foot')} />
            </Field>
          </div>
          <Field label="Secondary Positions">
            <ChipGroup options={POSITIONS} value={f('secondaryPositions')} onChange={s('secondaryPositions')} multi />
          </Field>
          <Field label="Nationalities">
            <CountrySelect value={f('nationalities')} onChange={s('nationalities')} />
          </Field>
          <Field label="National Team Status">
            <ChipGroup options={NAT_TEAM_STATUS} value={f('natTeamStatus')} onChange={s('natTeamStatus')} />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Club & League</div>
          <Field label="Current Club">
            <input value={f('currentClub')} onChange={e=>s('currentClub')(e.target.value)} placeholder="Club name or Free Agent" />
          </Field>
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

          <hr className="divider" />
          <div className="form-section-title">Agent & Transfer</div>
          <div className="form-grid-2">
            <Field label="Agent Name">
              <input value={f('agentName')} onChange={e=>s('agentName')(e.target.value)} placeholder="Agent name" />
            </Field>
            <Field label="Agent Phone">
              <input value={f('agentPhone')} onChange={e=>s('agentPhone')(e.target.value.replace(/[^0-9+]/g,''))} placeholder="+972..." />
            </Field>
          </div>
          <div className="form-grid-2">
            <Field label="Transfer Fee Demand (€)">
              <NumberInput value={f('transferFee')} onChange={s('transferFee')} placeholder="e.g. 500,000" allowNotSpecified />
            </Field>
            <Field label="Salary Demand (€/month)">
              <NumberInput value={f('salary')} onChange={s('salary')} placeholder="e.g. 8,000" allowNotSpecified />
            </Field>
          </div>
          <Field label="Notes">
            <textarea value={f('notes')} onChange={e=>s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} />
          </Field>
        </Modal>
      )}

      {/* Player Card Modal */}
      {cardFor && <PlayerCardModal player={cardFor} onClose={()=>setCardFor(null)} />}

      {dialog}
    </div>
  );
}
