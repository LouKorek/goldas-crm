import React, { useState, useEffect } from 'react';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, uploadFile, PATHS } from 'lib/db';
import { POSITIONS, FOOT_OPTIONS, NAT_TEAM_STATUS, CONTRACT_STATUS, POSITION_ORDER,
         calcAge, fmtDate, daysUntil, isEuropean } from 'lib/constants';
import { Modal, Field, ChipGroup, CountrySelect, DateInput, FileUpload,
         SortTh, SearchInput, FilterBar, PageHeader, Empty, Spinner,
         useConfirm, EUBadge } from 'components/ui/UI';
import { toast } from 'components/ui/UI';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';

// ── Country code map ──────────────────────────────────────────────
const CC = {'Afghanistan':'AFG','Albania':'ALB','Algeria':'ALG','Argentina':'ARG','Armenia':'ARM','Australia':'AUS','Austria':'AUT','Azerbaijan':'AZE','Bahrain':'BHR','Belgium':'BEL','Bolivia':'BOL','Bosnia and Herzegovina':'BIH','Brazil':'BRA','Bulgaria':'BUL','Cameroon':'CMR','Canada':'CAN','Chile':'CHI','China':'CHN','Colombia':'COL','Congo':'CGO','Costa Rica':'CRC','Croatia':'CRO','Cyprus':'CYP','Czech Republic':'CZE','Denmark':'DEN','DR Congo':'COD','Ecuador':'ECU','Egypt':'EGY','El Salvador':'SLV','England':'ENG','Estonia':'EST','Ethiopia':'ETH','Finland':'FIN','France':'FRA','Gabon':'GAB','Georgia':'GEO','Germany':'GER','Ghana':'GHA','Greece':'GRE','Guatemala':'GUA','Honduras':'HON','Hungary':'HUN','Iceland':'ISL','India':'IND','Indonesia':'IDN','Iran':'IRN','Iraq':'IRQ','Ireland':'IRL','Israel':'ISR','Italy':'ITA','Jamaica':'JAM','Japan':'JPN','Jordan':'JOR','Kazakhstan':'KAZ','Kenya':'KEN','Kosovo':'XKX','Kuwait':'KUW','Latvia':'LAT','Lebanon':'LIB','Libya':'LBA','Lithuania':'LTU','Luxembourg':'LUX','Malaysia':'MAS','Mali':'MLI','Malta':'MLT','Mexico':'MEX','Moldova':'MDA','Morocco':'MAR','Netherlands':'NED','New Zealand':'NZL','Nigeria':'NGR','North Macedonia':'MKD','Northern Ireland':'NIR','Norway':'NOR','Oman':'OMA','Pakistan':'PAK','Palestine':'PLE','Panama':'PAN','Paraguay':'PAR','Peru':'PER','Philippines':'PHI','Poland':'POL','Portugal':'POR','Qatar':'QAT','Romania':'ROU','Russia':'RUS','Rwanda':'RWA','Saudi Arabia':'KSA','Scotland':'SCO','Senegal':'SEN','Serbia':'SRB','Slovakia':'SVK','Slovenia':'SVN','South Africa':'RSA','South Korea':'KOR','Spain':'ESP','Sri Lanka':'SRI','Sudan':'SDN','Sweden':'SWE','Switzerland':'SUI','Syria':'SYR','Tanzania':'TAN','Thailand':'THA','Tunisia':'TUN','Turkey':'TUR','Uganda':'UGA','Ukraine':'UKR','United Arab Emirates':'UAE','United Kingdom':'GBR','United States':'USA','Uruguay':'URU','Uzbekistan':'UZB','Venezuela':'VEN','Vietnam':'VIE','Wales':'WAL','Zimbabwe':'ZIM'};
const cc = (n) => CC[n] || (n||'').slice(0,3).toUpperCase();

function NatFlags({ nats=[] }) {
  if (!nats.length) return <span style={{color:'var(--text-3)'}}>—</span>;
  return (
    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
      {nats.filter(Boolean).map(n=>(
        <span key={n} title={n} style={{background:'var(--surface-3)',borderRadius:4,padding:'2px 5px',fontSize:10,fontWeight:700,color:'var(--text-2)',border:'1px solid var(--border)',letterSpacing:'0.03em',cursor:'default'}}>{cc(n)}</span>
      ))}
    </div>
  );
}

// ── Document viewer ───────────────────────────────────────────────
function DocViewer({ files, title, onClose }) {
  const [idx, setIdx] = useState(0);
  const file = files?.[idx];
  return (
    <Modal title={title} onClose={onClose} wide viewOnly>
      {!files?.length ? (
        <p style={{color:'var(--text-3)'}}>No documents uploaded yet.</p>
      ) : (
        <>
          {files.length > 1 && (
            <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
              {files.map((f,i)=>(
                <button key={i} className={`chip${i===idx?' active':''}`} onClick={()=>setIdx(i)}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
          {file && (
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <div style={{fontSize:12,color:'var(--text-3)'}}>{file.name} · {new Date(file.uploadedAt).toLocaleDateString('en-GB')} · {file.uploadedBy}</div>
                <a href={file.url} download={file.name} className="btn btn-primary btn-sm">⬇ Download</a>
              </div>
              {file.type?.startsWith('image/') ? (
                <img src={file.url} alt={file.name} style={{width:'100%',borderRadius:8,border:'1px solid var(--border)'}} />
              ) : (
                <iframe src={file.url} style={{width:'100%',height:480,borderRadius:8,border:'1px solid var(--border)'}} title={file.name} />
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ── Player profile view ───────────────────────────────────────────
function PlayerView({ player, onClose }) {
  const [docModal, setDocModal] = useState(null);
  const age  = calcAge(player.dob);
  const isEU = isEuropean(player.nationalities||[]);
  const Row = ({label,value}) => value && value!=='—' ? (
    <div style={{display:'flex',gap:12,padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
      <div style={{width:170,flexShrink:0,color:'var(--text-3)',fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</div>
      <div style={{color:'var(--text-1)',fontSize:13}}>{value}</div>
    </div>
  ) : null;
  return (
    <Modal title={player.fullName} onClose={onClose} wide viewOnly>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
        <div>
          <div className="form-section-title">Personal</div>
          <Row label="Full Name"     value={player.fullName} />
          <Row label="Gender"        value={player.gender} />
          <Row label="Date of Birth" value={player.dob?`${fmtDate(player.dob)} (${age} yrs)`:null} />
          <Row label="Nationalities" value={(player.nationalities||[]).join(', ')} />
          <Row label="EU Status"     value={isEU?'🇪🇺 European':'Non-EU'} />
          <Row label="Position"      value={player.primaryPosition} />
          <Row label="Secondary"     value={(player.secondaryPositions||[]).join(', ')} />
          <Row label="Foot"          value={player.foot} />
          <Row label="Nat. Team"     value={player.natTeamStatus} />
          {player.profileLink && <Row label="Profile Link" value={<a href={player.profileLink.startsWith('http')?player.profileLink:'https://'+player.profileLink} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>Open ↗</a>} />}
          {player.videoLink   && <Row label="Video Link"   value={<a href={player.videoLink.startsWith('http')?player.videoLink:'https://'+player.videoLink} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>Open ↗</a>} />}
        </div>
        <div>
          <div className="form-section-title">Club & Contract</div>
          <Row label="Contract Status" value={player.contractStatus} />
          <Row label="Club"            value={player.contractStatus==='Free'?'Free Agent':player.currentClub} />
          {player.contractStatus==='Loan' && <Row label="Loan From" value={player.loanFrom} />}
          <Row label="League"          value={player.league} />
          <Row label="Contract Start"  value={fmtDate(player.contractStart)} />
          <Row label="Contract End"    value={fmtDate(player.contractEnd)} />
          {player.contractStatus==='Loan' && <Row label="Parent Contract End" value={fmtDate(player.loanParentEnd)} />}
          <div className="form-section-title" style={{marginTop:16}}>Representation</div>
          <Row label="Repr. Start"  value={fmtDate(player.reprStart)} />
          <Row label="Repr. End"    value={fmtDate(player.reprEnd)} />
          <div className="form-section-title" style={{marginTop:16}}>🪪 Passport</div>
          <Row label="Passport No." value={player.passportNumber} />
          <Row label="Expiry"       value={fmtDate(player.passportExpiry)} />
        </div>
      </div>
      {player.notes && (
        <div style={{marginTop:16}}>
          <div className="form-section-title">Notes</div>
          <p style={{color:'var(--text-2)',fontSize:13,lineHeight:1.7}}>{player.notes}</p>
        </div>
      )}
      {/* Last edit info */}
      {player.lastEditedByName && (
        <div style={{marginTop:12,fontSize:11,color:'var(--text-3)'}}>
          Last edited by {player.lastEditedByName}
        </div>
      )}
      <div style={{marginTop:20,paddingTop:14,borderTop:'1px solid var(--border)'}}>
        <div className="form-section-title" style={{marginBottom:10}}>Document History</div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          {[
            {label:'📋 Contract',        files:player.contractFiles},
            {label:'🤝 Repr. Agreement', files:player.reprFiles},
            {label:'🪪 Passport',        files:player.passportFiles},
          ].map(({label,files})=>(
            <button key={label} className="btn btn-secondary btn-sm"
              onClick={()=>setDocModal({files:files||[],title:label})}>
              {label} <span style={{opacity:.5,fontSize:10}}>({(files||[]).length})</span>
            </button>
          ))}
        </div>
      </div>
      {docModal && <DocViewer files={docModal.files} title={docModal.title} onClose={()=>setDocModal(null)} />}
    </Modal>
  );
}

async function clearAllPlayers() {
  if (!window.confirm('Delete ALL represented players? This cannot be undone.')) return;
  const snap = await getDocs(collection(db, 'players'));
  for (const d of snap.docs) await deleteDoc(d.ref);
  window.location.reload();
}

const EMPTY_PLAYER = {
  gender:'', fullName:'', nationalities:[], contractStatus:'Under Contract',
  currentClub:'', loanFrom:'', leagueMode:'select', leagueCountry:'', leagueTier:'',
  leagueManual:'', contractStart:'', contractEnd:'', loanParentEnd:'',
  primaryPosition:'', secondaryPositions:[], foot:'', natTeamStatus:'',
  dob:'', passportNumber:'', passportExpiry:'', reprStart:'', reprEnd:'',
  notes:'', contractFiles:[], passportFiles:[], reprFiles:[],
  profileLink:'', videoLink:'',
};

export default function Players() {
  const [players, setPlayers]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [modal, setModal]           = useState(null);
  const [viewPlayer, setViewPlayer] = useState(null);
  const [form, setForm]             = useState(EMPTY_PLAYER);
  const [saving, setSaving]         = useState(false);
  const [isDirty, setIsDirty]       = useState(false);
  const [search, setSearch]         = useState('');
  const [filters, setFilters]       = useState({});
  const [sort, setSort]             = useState({field:'fullName',dir:'asc'});
  const { confirm, dialog }         = useConfirm();

  useEffect(() => {
    return listenCollection(PATHS.PLAYERS, (data) => { setPlayers(data); setLoading(false); });
  }, []);

  const s = (k) => (v) => { setForm(p=>({...p,[k]:v})); setIsDirty(true); };
  const f = (k) => form[k] ?? '';

  const age    = calcAge(f('dob'));
  const isEU   = isEuropean(form.nationalities);
  const isFree = form.contractStatus === 'Free';
  const isLoan = form.contractStatus === 'Loan';
  const league = form.leagueMode==='manual' ? form.leagueManual
    : (form.leagueCountry&&form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ','')}` : '');

  const openAdd  = () => { setForm({...EMPTY_PLAYER}); setModal('add'); setIsDirty(false); };
  const openEdit = (p) => { setForm({...EMPTY_PLAYER,...p}); setModal({edit:p}); setIsDirty(false); };

  const validate = () => {
    if (!form.fullName.trim()) return 'Player name is required.';
    if (!form.gender)          return 'Gender is required.';
    const existing = players.filter(p=>modal?.edit?.id!==p.id);
    if (existing.some(p=>p.fullName.trim().toLowerCase()===form.fullName.trim().toLowerCase()&&p.gender===form.gender&&p.dob===form.dob))
      return 'An identical player already exists.';
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const data = {...form, league};
      if (modal==='add') { await addDoc_(PATHS.PLAYERS,data); toast.success(`"${form.fullName}" added!`); }
      else { await updateDoc_(PATHS.PLAYERS,modal.edit.id,data); toast.success('Player updated.'); }
      setModal(null);
    } catch(e) { toast.error(e.message||'Save failed.'); }
    finally { setSaving(false); }
  };

  const del = async (p,e) => {
    e.stopPropagation();
    const ok = await confirm(`Delete "${p.fullName}"?`);
    if (!ok) return;
    try { await deleteDoc_(PATHS.PLAYERS,p.id); toast.success('Deleted.'); }
    catch(e) { toast.error(e.message||'Delete failed.'); }
  };

  const handleFileUpload = async (field, file, name, mode) => {
    try {
      const fileData = await uploadFile(file,`players/${field}`,name);
      const current  = Array.isArray(form[field])?form[field]:[];
      const updated  = mode==='replace'?[fileData]:[...current,fileData];
      setForm(p=>({...p,[field]:updated}));
      if (modal?.edit?.id) await updateDoc_(PATHS.PLAYERS,modal.edit.id,{[field]:updated});
      toast.success('File uploaded.');
    } catch(e) { toast.error(e.message||'Upload failed.'); }
  };

  let data = players.filter(p=>{
    if (search&&!`${p.fullName} ${p.currentClub} ${p.primaryPosition}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.gender&&p.gender!==filters.gender) return false;
    if (filters.position&&p.primaryPosition!==filters.position) return false;
    if (filters.contractStatus&&p.contractStatus!==filters.contractStatus) return false;
    return true;
  }).sort((a,b)=>{
    let av,bv;
    if (sort.field==='primaryPosition') {
      av = POSITION_ORDER[a.primaryPosition]??99;
      bv = POSITION_ORDER[b.primaryPosition]??99;
      return sort.dir==='asc'?(av-bv):(bv-av);
    }
    if (['dob','contractEnd','reprEnd','passportExpiry'].includes(sort.field)) {
      av = a[sort.field]||'9999';
      bv = b[sort.field]||'9999';
    } else {
      av = a[sort.field]||'';
      bv = b[sort.field]||'';
    }
    return sort.dir==='asc'?(av>bv?1:-1):(av<bv?1:-1);
  });

  const alertColor = (days) => days===null?'var(--text-2)':days<=30?'var(--red)':days<=60?'var(--amber)':'var(--text-2)';

  return (
    <div>
      <PageHeader
        title="Represented Players"
        subtitle={`${players.length} player${players.length!==1?'s':''} under representation`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <button className="btn btn-primary" onClick={openAdd} style={{height:36}}>+ Add Player</button>
            <div style={{height:36,display:'flex',alignItems:'center'}}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
            <button className="btn btn-danger btn-sm" onClick={clearAllPlayers}
              style={{height:36,opacity:0.45,whiteSpace:'nowrap'}}
              onMouseEnter={e=>e.currentTarget.style.opacity='1'}
              onMouseLeave={e=>e.currentTarget.style.opacity='0.45'}>
              🗑 Clear All
            </button>
          </div>
        }
      >
        <div style={{marginTop:14}}>
          <FilterBar filters={filters} setFilters={setFilters} options={[
            {key:'gender',label:'Gender',values:['Men','Women']},
            {key:'position',label:'Position',values:POSITIONS},
            {key:'contractStatus',label:'Contract',values:CONTRACT_STATUS},
          ]} />
        </div>
      </PageHeader>

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',padding:60}}><Spinner size={36}/></div>
      ) : data.length===0 ? (
        <Empty icon="🤝" message={search||Object.values(filters).some(Boolean)?'No players match.':'No players yet.'}
          action={!search&&<button className="btn btn-primary" onClick={openAdd}>+ Add Player</button>} />
      ) : (
        <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{width:70}}>Actions</th>
                  <SortTh label="🏃‍♂️" field="fullName" sort={sort} setSort={setSort} />
                  <SortTh label='G' field='gender' sort={sort} setSort={setSort} />
                  <SortTh label='🗓️' field='dob' sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>🌎</th>
                  <SortTh label='📍' field='primaryPosition' sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>Sec 📍</th>
                  <SortTh label='🦵' field='foot' sort={sort} setSort={setSort} />
                  <th>🔰</th>
                  <SortTh label='📑' field='contractStatus' sort={sort} setSort={setSort} />
                  <SortTh label='End 📑' field='contractEnd' sort={sort} setSort={setSort} />
                  <SortTh label='End 🤝' field='reprEnd' sort={sort} setSort={setSort} />
                  <SortTh label='End 🪪' field='passportExpiry' sort={sort} setSort={setSort} />
                  <SortTh label='🏟️' field='natTeamStatus' sort={sort} setSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {data.map(p=>{
                  const contractDays = daysUntil(p.contractEnd);
                  const reprDays     = daysUntil(p.reprEnd);
                  const passportDays = daysUntil(p.passportExpiry);
                  const pAge         = calcAge(p.dob);
                  const pIsEU        = isEuropean(p.nationalities||[]);
                  const footShort    = p.foot==='Right'?'R':p.foot==='Left'?'L':p.foot==='Both'?'RL':'—';
                  const genderShort  = p.gender==='Men'?'M':p.gender==='Women'?'W':'—';
                  const dobDisplay   = p.dob?`${p.dob.split('-').reverse().join('/')} (${pAge})`:'—';
                  return (
                    <tr key={p.id}
                      onClick={()=>setViewPlayer(p)}
                      style={{cursor:'pointer'}}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(201,168,76,0.05)'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}
                    >
                      {/* Actions cell - click stops propagation */}
                      <td onClick={e=>e.stopPropagation()}>
                        <div style={{display:'flex',gap:3,flexWrap:'wrap',width:66}}>
                          <button style={{width:26,height:26,padding:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,border:'none',borderRadius:6,cursor:'pointer',background:'rgba(248,113,113,0.15)',color:'var(--red)',transition:'all 0.15s'}}
                            title="Delete" onClick={(e)=>del(p,e)}>🗑</button>
                          <button style={{width:26,height:26,padding:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,border:'none',borderRadius:6,cursor:'pointer',background:'rgba(201,168,76,0.15)',color:'var(--gold)',transition:'all 0.15s'}}
                            title="Edit" onClick={(e)=>{e.stopPropagation();openEdit(p);}}>✏️</button>
                          {p.profileLink&&(
                            <a href={p.profileLink.startsWith('http')?p.profileLink:'https://'+p.profileLink}
                              target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}
                              style={{width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(96,165,250,0.15)',borderRadius:6,fontSize:13,textDecoration:'none'}}
                              title="Profile">🧑‍💼</a>
                          )}
                          {p.videoLink&&(
                            <a href={p.videoLink.startsWith('http')?p.videoLink:'https://'+p.videoLink}
                              target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}
                              style={{width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(74,222,128,0.15)',borderRadius:6,fontSize:13,textDecoration:'none'}}
                              title="Video">📹</a>
                          )}
                        </div>
                      </td>
                      <td style={{fontWeight:600}}>{p.fullName}</td>
                      <td style={{textAlign:'center',color:'var(--text-2)'}}>{genderShort}</td>
                      <td style={{fontSize:11,color:'var(--text-2)'}}>{dobDisplay}</td>
                      <td>
                        <NatFlags nats={p.nationalities} />
                        <div style={{marginTop:3}}>
                          <span className="badge" style={{background:pIsEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',color:pIsEU?'var(--blue)':'var(--red)',fontSize:10}}>
                            {pIsEU?'EU':'Non-EU'}
                          </span>
                        </div>
                      </td>
                      <td style={{fontWeight:500,textAlign:'center'}}>{p.primaryPosition||'—'}</td>
                      <td style={{fontSize:11,color:'var(--text-3)',textAlign:'center'}}>{Array.isArray(p.secondaryPositions)&&p.secondaryPositions.length>0?p.secondaryPositions.join(', '):'—'}</td>
                      <td style={{fontWeight:500,fontSize:11,textAlign:'center'}}>{footShort}</td>
                      <td>
                        <div style={{fontWeight:500}}>{p.contractStatus==='Free'?'Free Agent':(p.currentClub||'—')}</div>
                        <div style={{fontSize:10,color:'var(--text-3)'}}>{p.league||''}</div>
                      </td>
                      <td style={{textAlign:'center'}}>
                        <span className="badge" style={{background:p.contractStatus==='Free'?'var(--amber-bg)':p.contractStatus==='Under Contract'?'var(--green-bg)':'var(--blue-bg)',color:p.contractStatus==='Free'?'var(--amber)':p.contractStatus==='Under Contract'?'var(--green-ok)':'var(--blue)',fontSize:10}}>
                          {p.contractStatus||'—'}
                        </span>
                      </td>
                      <td style={{color:alertColor(contractDays),fontSize:11}}>{p.contractEnd?fmtDate(p.contractEnd):'—'}</td>
                      <td style={{color:alertColor(reprDays),fontSize:11}}>{p.reprEnd?fmtDate(p.reprEnd):'—'}</td>
                      <td style={{color:alertColor(passportDays),fontSize:11}}>{p.passportExpiry?fmtDate(p.passportExpiry):'—'}</td>
                      <td style={{fontSize:11,color:'var(--text-3)'}}>{p.natTeamStatus||'—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {modal && (
        <Modal title={modal==='add'?'Add Represented Player':`Edit: ${form.fullName}`}
          onClose={()=>setModal(null)} wide isDirty={isDirty}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving?<><span className="spinner" style={{width:14,height:14}}/> Saving...</>:'Save Player'}
            </button>
          </>}
        >
          <div className="form-section-title">Basic Information</div>
          <div className="form-grid-2">
            <Field label="Full Name" required><input value={f('fullName')} onChange={e=>s('fullName')(e.target.value)} placeholder="Full name" /></Field>
            <Field label="Gender" required><ChipGroup options={['Men','Women']} value={f('gender')} onChange={s('gender')} /></Field>
          </div>
          <div className="form-grid-3">
            <Field label="Date of Birth">
              <DateInput value={f('dob')} onChange={s('dob')} />
              {age!==null&&<div className="form-hint">Age: {age}</div>}
            </Field>
            <Field label="Primary Position">
              <select value={f('primaryPosition')} onChange={e=>s('primaryPosition')(e.target.value)}>
                <option value="">Select...</option>
                {POSITIONS.map(p=><option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Strong Foot"><ChipGroup options={FOOT_OPTIONS} value={f('foot')} onChange={s('foot')} /></Field>
          </div>
          <Field label="Secondary Positions"><ChipGroup options={POSITIONS} value={f('secondaryPositions')} onChange={s('secondaryPositions')} multi /></Field>
          <Field label="Nationalities">
            <CountrySelect value={f('nationalities')} onChange={s('nationalities')} />
            <div style={{marginTop:6,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
              <span className="badge" style={{background:isEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',color:isEU?'var(--blue)':'var(--red)'}}>{isEU?'🇪🇺 EU Player':'Non-EU'}</span>
            </div>
          </Field>
          <Field label="National Team Status"><ChipGroup options={NAT_TEAM_STATUS} value={f('natTeamStatus')} onChange={s('natTeamStatus')} /></Field>

          <hr className="divider" />
          <div className="form-section-title">Club & Contract</div>
          <Field label="Contract Status"><ChipGroup options={CONTRACT_STATUS} value={f('contractStatus')} onChange={s('contractStatus')} /></Field>
          {!isFree&&(<>
            <div className="form-grid-2">
              <Field label="Current Club"><input value={f('currentClub')} onChange={e=>s('currentClub')(e.target.value)} placeholder="Club name" /></Field>
              {isLoan&&<Field label="Loan From"><input value={f('loanFrom')} onChange={e=>s('loanFrom')(e.target.value)} placeholder="Parent club" /></Field>}
            </div>
            <Field label="League">
              <div style={{display:'flex',gap:8,marginBottom:8}}>
                <button type="button" className={`chip${form.leagueMode==='select'?' active':''}`} onClick={()=>s('leagueMode')('select')}>By Country + Tier</button>
                <button type="button" className={`chip${form.leagueMode==='manual'?' active':''}`} onClick={()=>s('leagueMode')('manual')}>Manual</button>
              </div>
              {form.leagueMode==='select'?(
                <div className="form-grid-2">
                  <select value={f('leagueCountry')} onChange={e=>s('leagueCountry')(e.target.value)}>
                    <option value="">Country...</option>
                    {['Israel','England','Spain','Germany','Italy','France','Portugal','Netherlands','Belgium','Turkey','Greece','Switzerland','Scotland','Russia','Ukraine','Serbia','Croatia','Czech Republic','Poland','Romania','Bulgaria','Argentina','Brazil','USA','Mexico','Saudi Arabia','Qatar','UAE','Australia'].map(c=><option key={c}>{c}</option>)}
                  </select>
                  <ChipGroup options={['1st','2nd','3rd','4th','5th+']} value={f('leagueTier')} onChange={s('leagueTier')} />
                </div>
              ):(
                <input value={f('leagueManual')} onChange={e=>s('leagueManual')(e.target.value)} placeholder="e.g. Premier League" />
              )}
              {league&&<div className="form-hint">League: <strong>{league}</strong></div>}
            </Field>
            <div className="form-grid-2">
              <Field label="Contract Start"><DateInput value={f('contractStart')} onChange={s('contractStart')} /></Field>
              <Field label="Contract End"><DateInput value={f('contractEnd')} onChange={s('contractEnd')} /></Field>
            </div>
            {isLoan&&<Field label="Parent Club Contract End"><DateInput value={f('loanParentEnd')} onChange={s('loanParentEnd')} /></Field>}
            <Field label="Contract File"><FileUpload label="contract" onUpload={(file,name,mode)=>handleFileUpload('contractFiles',file,name,mode)} history={form.contractFiles||[]} /></Field>
          </>)}

          <hr className="divider" />
          <div className="form-section-title">🪪 Passport</div>
          <div className="form-grid-2">
            <Field label="Passport Number"><input value={f('passportNumber')} onChange={e=>s('passportNumber')(e.target.value)} placeholder="Passport number" /></Field>
            <Field label="Passport Expiry"><DateInput value={f('passportExpiry')} onChange={s('passportExpiry')} /></Field>
          </div>
          <Field label="Passport File"><FileUpload label="passport" onUpload={(file,name,mode)=>handleFileUpload('passportFiles',file,name,mode)} history={form.passportFiles||[]} /></Field>

          <hr className="divider" />
          <div className="form-section-title">Representation Agreement</div>
          <div className="form-grid-2">
            <Field label="Repr. Start"><DateInput value={f('reprStart')} onChange={s('reprStart')} /></Field>
            <Field label="Repr. End"><DateInput value={f('reprEnd')} onChange={s('reprEnd')} /></Field>
          </div>
          <Field label="Repr. Agreement File"><FileUpload label="agreement" onUpload={(file,name,mode)=>handleFileUpload('reprFiles',file,name,mode)} history={form.reprFiles||[]} /></Field>

          <hr className="divider" />
          <div className="form-grid-2">
            <Field label="Profile Link" hint="Transfermarkt, Wyscout..."><input value={f('profileLink')} onChange={e=>s('profileLink')(e.target.value)} placeholder="https://..." /></Field>
            <Field label="Video Link" hint="YouTube, highlights..."><input value={f('videoLink')} onChange={e=>s('videoLink')(e.target.value)} placeholder="https://..." /></Field>
          </div>
          <Field label="Notes"><textarea value={f('notes')} onChange={e=>s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} /></Field>
        </Modal>
      )}

      {viewPlayer&&<PlayerView player={viewPlayer} onClose={()=>setViewPlayer(null)} />}
      {dialog}
    </div>
  );
}
