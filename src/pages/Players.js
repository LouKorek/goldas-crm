import React, { useState, useEffect } from 'react';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, uploadFile, PATHS } from 'lib/db';
import { collection, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { POSITIONS, FOOT_OPTIONS, NAT_TEAM_STATUS, CONTRACT_STATUS,
         calcAge, fmtDate, daysUntil, isEuropean, EU_COUNTRIES } from 'lib/constants';
import { Modal, Field, ChipGroup, CountrySelect, DateInput, FileUpload,
         SortTh, SearchInput, FilterBar, PageHeader, Empty, Spinner,
         useConfirm, PhoneDisplay, EUBadge, ActionButtons } from 'components/ui/UI';
import { toast } from 'components/ui/UI';

// ── Country code helper ───────────────────────────────────────────
const COUNTRY_CODES = {
  'Afghanistan':'AFG','Albania':'ALB','Algeria':'ALG','Argentina':'ARG',
  'Armenia':'ARM','Australia':'AUS','Austria':'AUT','Azerbaijan':'AZE',
  'Bahrain':'BHR','Belgium':'BEL','Bolivia':'BOL','Bosnia and Herzegovina':'BIH',
  'Brazil':'BRA','Bulgaria':'BUL','Cameroon':'CMR','Canada':'CAN',
  'Chile':'CHI','China':'CHN','Colombia':'COL','Croatia':'CRO',
  'Cyprus':'CYP','Czech Republic':'CZE','Denmark':'DEN','DR Congo':'COD',
  'Ecuador':'ECU','Egypt':'EGY','El Salvador':'SLV','England':'ENG',
  'Estonia':'EST','Ethiopia':'ETH','Finland':'FIN','France':'FRA',
  'Georgia':'GEO','Germany':'GER','Ghana':'GHA','Greece':'GRE',
  'Guatemala':'GUA','Honduras':'HON','Hungary':'HUN','Iceland':'ISL',
  'India':'IND','Indonesia':'IDN','Iran':'IRN','Iraq':'IRQ',
  'Ireland':'IRL','Israel':'ISR','Italy':'ITA','Jamaica':'JAM',
  'Japan':'JPN','Jordan':'JOR','Kazakhstan':'KAZ','Kenya':'KEN',
  'Kosovo':'XKX','Kuwait':'KUW','Latvia':'LAT','Lebanon':'LIB',
  'Libya':'LBA','Lithuania':'LTU','Luxembourg':'LUX','Malaysia':'MAS',
  'Mali':'MLI','Malta':'MLT','Mexico':'MEX','Moldova':'MDA',
  'Morocco':'MAR','Netherlands':'NED','New Zealand':'NZL','Nigeria':'NGR',
  'North Macedonia':'MKD','Northern Ireland':'NIR','Norway':'NOR',
  'Oman':'OMA','Pakistan':'PAK','Palestine':'PLE','Panama':'PAN',
  'Paraguay':'PAR','Peru':'PER','Philippines':'PHI','Poland':'POL',
  'Portugal':'POR','Qatar':'QAT','Romania':'ROU','Russia':'RUS',
  'Rwanda':'RWA','Saudi Arabia':'KSA','Scotland':'SCO','Senegal':'SEN',
  'Serbia':'SRB','Slovakia':'SVK','Slovenia':'SVN','South Africa':'RSA',
  'South Korea':'KOR','Spain':'ESP','Sri Lanka':'SRI','Sudan':'SDN',
  'Sweden':'SWE','Switzerland':'SUI','Syria':'SYR','Tanzania':'TAN',
  'Thailand':'THA','Tunisia':'TUN','Turkey':'TUR','Uganda':'UGA',
  'Ukraine':'UKR','United Arab Emirates':'UAE','United Kingdom':'GBR',
  'United States':'USA','Uruguay':'URU','Uzbekistan':'UZB',
  'Venezuela':'VEN','Vietnam':'VIE','Wales':'WAL','Zimbabwe':'ZIM',
};

const countryCode = (name) => COUNTRY_CODES[name] || name?.slice(0,3).toUpperCase() || '???';

function NatFlags({ nationalities = [] }) {
  if (!nationalities.length) return <span style={{color:'var(--text-3)'}}>—</span>;
  return (
    <div style={{display:'flex',gap:5,alignItems:'center',flexWrap:'wrap'}}>
      {nationalities.filter(Boolean).map(n => (
        <span key={n} title={n} style={{
          background:'var(--surface-3)',borderRadius:4,padding:'2px 5px',
          fontSize:10,fontWeight:700,color:'var(--text-2)',cursor:'default',
          border:'1px solid var(--border)',letterSpacing:'0.03em',
        }}>{countryCode(n)}</span>
      ))}
    </div>
  );
}

// ── Document viewer modal ─────────────────────────────────────────
function DocViewer({ files, title, onClose }) {
  const [idx, setIdx] = useState(0);
  const file = files?.[idx];
  return (
    <Modal title={title} onClose={onClose} wide>
      {!files?.length ? (
        <p style={{color:'var(--text-3)'}}>No documents uploaded yet.</p>
      ) : (
        <>
          {files.length > 1 && (
            <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
              {files.map((f,i) => (
                <button key={i} className={`chip${i===idx?' active':''}`} onClick={()=>setIdx(i)}>
                  {f.name} <span style={{opacity:.6,fontSize:10}}>{new Date(f.uploadedAt).toLocaleDateString('en-GB')}</span>
                </button>
              ))}
            </div>
          )}
          {file && (
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <div style={{fontSize:12,color:'var(--text-3)'}}>
                  {file.name} · Uploaded {new Date(file.uploadedAt).toLocaleDateString('en-GB')} by {file.uploadedBy}
                </div>
                <a href={file.url} download={file.name} className="btn btn-primary btn-sm">⬇ Download</a>
              </div>
              {file.type?.startsWith('image/') ? (
                <img src={file.url} alt={file.name} style={{width:'100%',borderRadius:8,border:'1px solid var(--border)'}} />
              ) : file.type === 'application/pdf' || file.url?.startsWith('data:application/pdf') ? (
                <iframe src={file.url} style={{width:'100%',height:500,borderRadius:8,border:'1px solid var(--border)'}} title={file.name} />
              ) : (
                <div style={{padding:32,textAlign:'center',color:'var(--text-3)',background:'var(--surface-3)',borderRadius:8}}>
                  <div style={{fontSize:32,marginBottom:8}}>📄</div>
                  <p>Preview not available for this file type.</p>
                  <a href={file.url} download={file.name} className="btn btn-primary" style={{marginTop:12}}>⬇ Download</a>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ── Player profile view modal ─────────────────────────────────────
function PlayerView({ player, onClose }) {
  const [docModal, setDocModal] = useState(null); // {files,title}
  const age = calcAge(player.dob);
  const isEU = isEuropean(player.nationalities||[]);

  const Row = ({label, value}) => value && value !== '-' ? (
    <div style={{display:'flex',gap:16,padding:'8px 0',borderBottom:'1px solid var(--border)'}}>
      <div style={{width:180,flexShrink:0,color:'var(--text-3)',fontSize:12,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</div>
      <div style={{color:'var(--text-1)',fontSize:13}}>{value}</div>
    </div>
  ) : null;

  return (
    <Modal title={player.fullName} onClose={onClose} wide viewOnly>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
        <div>
          <div className="form-section-title">Personal</div>
          <Row label="Full Name" value={player.fullName} />
          <Row label="Gender" value={player.gender} />
          <Row label="Date of Birth" value={player.dob ? `${fmtDate(player.dob)} (${age} yrs)` : null} />
          <Row label="Nationalities" value={(player.nationalities||[]).join(', ')} />
          <Row label="EU Status" value={isEU ? '🇪🇺 European' : 'Non-EU'} />
          <Row label="Position" value={player.primaryPosition} />
          <Row label="Secondary" value={(player.secondaryPositions||[]).join(', ')} />
          <Row label="Foot" value={player.foot} />
          <Row label="National Team" value={player.natTeamStatus} />
        </div>
        <div>
          <div className="form-section-title">Club & Contract</div>
          <Row label="Contract Status" value={player.contractStatus} />
          <Row label="Club" value={player.isFree ? 'Free Agent' : player.currentClub} />
          {player.contractStatus === 'Loan' && <Row label="Loan From" value={player.loanFrom} />}
          <Row label="League" value={player.league} />
          <Row label="Contract Start" value={fmtDate(player.contractStart)} />
          <Row label="Contract End" value={fmtDate(player.contractEnd)} />
          {player.contractStatus === 'Loan' && <Row label="Parent Contract End" value={fmtDate(player.loanParentEnd)} />}
          <div className="form-section-title" style={{marginTop:16}}>Representation</div>
          <Row label="Repr. Start" value={fmtDate(player.reprStart)} />
          <Row label="Repr. End" value={fmtDate(player.reprEnd)} />
          <div className="form-section-title" style={{marginTop:16}}>Passport</div>
          <Row label="Passport No." value={player.passportNumber} />
          <Row label="Passport Expiry" value={fmtDate(player.passportExpiry)} />
        </div>
      </div>
      {player.notes && (
        <div style={{marginTop:16}}>
          <div className="form-section-title">Notes</div>
          <p style={{color:'var(--text-2)',fontSize:13,lineHeight:1.7}}>{player.notes}</p>
        </div>
      )}
      <div style={{marginTop:24,paddingTop:16,borderTop:'1px solid var(--border)'}}>
        <div className="form-section-title" style={{marginBottom:12}}>Document History</div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          {[
            {label:'📋 Contract', files: player.contractFiles},
            {label:'🤝 Repr. Agreement', files: player.reprFiles},
            {label:'🛂 Passport', files: player.passportFiles},
          ].map(({label,files}) => (
            <button key={label} className="btn btn-secondary"
              onClick={()=>setDocModal({files:files||[],title:label})}>
              {label} <span style={{opacity:.6,fontSize:11}}>({(files||[]).length})</span>
            </button>
          ))}
        </div>
      </div>
      {docModal && <DocViewer files={docModal.files} title={docModal.title} onClose={()=>setDocModal(null)} />}
    </Modal>
  );
}


const EMPTY_PLAYER = {
  gender:'', fullName:'', nationalities:[], contractStatus:'Under Contract',
  currentClub:'', loanFrom:'', leagueMode:'select', leagueCountry:'', leagueTier:'',
  leagueManual:'', contractStart:'', contractEnd:'', loanParentEnd:'',
  primaryPosition:'', secondaryPositions:[], foot:'', natTeamStatus:'',
  dob:'', passportNumber:'', passportExpiry:'', reprStart:'', reprEnd:'',
  notes:'', contractFiles:[], passportFiles:[], reprFiles:[], profileLink:'', videoLink:'',
};


async function clearAllPlayers() {
  if (!window.confirm('Delete ALL represented players? This cannot be undone.')) return;
  const snap = await getDocs(collection(db, 'players'));
  for (const d of snap.docs) await deleteDoc(d.ref);
  window.location.reload();
}
export default function Players() {
  const [players, setPlayers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(null);
  const [viewPlayer, setViewPlayer] = useState(null);
  const [docModal, setDocModal] = useState(null);
  const [form, setForm]         = useState(EMPTY_PLAYER);
  const [saving, setSaving]     = useState(false);
  const [search, setSearch]     = useState('');
  const [filters, setFilters]   = useState({});
  const [sort, setSort]         = useState({field:'fullName',dir:'asc'});
  const { confirm, dialog }     = useConfirm();

  useEffect(() => {
    return listenCollection(PATHS.PLAYERS, (data) => {
      setPlayers(data);
      setLoading(false);
    });
  }, []);

  const s = (k) => (v) => setForm(p => ({...p,[k]:v}));
  const f = (k) => form[k] ?? '';

  const age    = calcAge(f('dob'));
  const isEU   = isEuropean(form.nationalities);
  const isFree = form.contractStatus === 'Free';
  const isLoan = form.contractStatus === 'Loan';
  const league = form.leagueMode === 'manual'
    ? form.leagueManual
    : (form.leagueCountry && form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ','')}` : '');

  const openAdd  = () => { setForm({...EMPTY_PLAYER}); setModal('add'); };
  const openEdit = (p) => { setForm({...EMPTY_PLAYER,...p}); setModal({edit:p}); };
  const openDup  = (p) => { const {id:_,...rest}=p; setForm({...EMPTY_PLAYER,...rest}); setModal('add'); };

  const validate = () => {
    if (!form.fullName.trim()) return 'Player name is required.';
    if (!form.gender)          return 'Gender is required.';
    const existing = players.filter(p => modal?.edit?.id !== p.id);
    if (existing.some(p =>
      p.fullName.trim().toLowerCase() === form.fullName.trim().toLowerCase() &&
      p.gender === form.gender && p.dob === form.dob
    )) return 'An identical player already exists.';
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const data = {...form, league};
      if (modal === 'add') {
        await addDoc_(PATHS.PLAYERS, data);
        toast.success(`"${form.fullName}" added!`);
      } else {
        await updateDoc_(PATHS.PLAYERS, modal.edit.id, data);
        toast.success('Player updated.');
      }
      setModal(null);
    } catch(e) { toast.error(e.message||'Save failed.'); }
    finally { setSaving(false); }
  };

  const del = async (p) => {
    const ok = await confirm(`Delete "${p.fullName}"? This cannot be undone.`);
    if (!ok) return;
    try {
      if (!p.id) { toast.error('Cannot delete: missing document ID.'); return; }
      await deleteDoc_(PATHS.PLAYERS, p.id);
      toast.success('Deleted.');
    } catch(e) {
      console.error('Delete failed:', p.id, e);
      toast.error('Delete failed: ' + (e.message||'Unknown error'));
    }
  };

  const handleFileUpload = async (field, file, name, mode) => {
    try {
      const fileData = await uploadFile(file, `players/${field}`, name);
      const current  = Array.isArray(form[field]) ? form[field] : [];
      const updated  = mode === 'replace' ? [fileData] : [...current, fileData];
      setForm(p => ({...p,[field]:updated}));
      // If editing, save immediately
      if (modal?.edit?.id) {
        await updateDoc_(PATHS.PLAYERS, modal.edit.id, {[field]: updated});
      }
      toast.success('File uploaded.');
    } catch(e) { toast.error(e.message||'Upload failed.'); }
  };

  let data = players.filter(p => {
    if (search && !`${p.fullName} ${p.currentClub} ${p.primaryPosition}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.gender && p.gender !== filters.gender) return false;
    if (filters.position && p.primaryPosition !== filters.position) return false;
    if (filters.contractStatus && p.contractStatus !== filters.contractStatus) return false;
    return true;
  }).sort((a,b) => {
    let av = a[sort.field]||'', bv = b[sort.field]||'';
    if (sort.field==='dob') { av=a.dob||''; bv=b.dob||''; }
    return sort.dir==='asc' ? (av>bv?1:-1) : (av<bv?1:-1);
  });

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
            {key:'gender',label:'Gender',values:['Men','Women']},
            {key:'position',label:'Position',values:POSITIONS},
            {key:'contractStatus',label:'Contract',values:CONTRACT_STATUS},
          ]} />
        </div>
      </PageHeader>

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',padding:60}}><Spinner size={36}/></div>
      ) : data.length === 0 ? (
        <Empty icon="🤝" message={search||Object.values(filters).some(Boolean)?'No players match.':'No players yet.'}
          action={!search&&<button className="btn btn-primary" onClick={openAdd}>+ Add Player</button>} />
      ) : (
        <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap">
            <table className="data-table" style={{borderCollapse:"collapse"}}>
              <thead>
                <tr>
                  <th style={{width:60,textAlign:'center'}}></th>
                  <SortTh label="🏃‍♂️" field="fullName" sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>G</th>
                  <th style={{textAlign:'center'}}>🗓️</th>
                  <th style={{textAlign:'center'}}>🌎</th>
                  <th style={{textAlign:'center'}}>📍</th>
                  <th style={{textAlign:'center'}}>Sec 📍</th>
                  <th style={{textAlign:'center'}}>🦵</th>
                  <th>🔰</th>
                  <th style={{textAlign:'center'}}>📑</th>
                  <th style={{textAlign:'center'}}>End 📑</th>
                  <th style={{textAlign:'center'}}>End 🤝</th>
                  <th style={{textAlign:'center'}}>End 🪪</th>
                  <th style={{textAlign:'center'}}>🏟️</th>
                </tr>
              </thead>
              <tbody>
                {data.map(p => {
                  const contractDays = daysUntil(p.contractEnd);
                  const reprDays     = daysUntil(p.reprEnd);
                  const passportDays = daysUntil(p.passportExpiry);
                  const pAge         = calcAge(p.dob);
                  const pIsEU        = isEuropean(p.nationalities||[]);
                  const dobDisplay   = p.dob
                    ? `${p.dob.split('-').reverse().join('/')} (${pAge})`
                    : '—';
                  const footShort = p.foot==='Right'?'R':p.foot==='Left'?'L':p.foot==='Both'?'RL':'—';
                  const genderShort = p.gender==='Men'?'M':p.gender==='Women'?'W':'—';

                  const alertColor = (days) =>
                    days===null ? 'var(--text-2)' :
                    days<=30 ? 'var(--red)' :
                    days<=60 ? 'var(--amber)' : 'var(--text-2)';

                  return (
                    <tr key={p.id}>
                      <td>
                        <ActionButtons onView={()=>setViewPlayer(p)} onEdit={()=>openEdit(p)} onDuplicate={()=>openDup(p)} onDelete={()=>del(p)} />
                      </td>
                      <td style={{fontWeight:600}}>
                        <div>{p.fullName}</div>
                        {(p.profileLink || p.videoLink) && (
                          <div style={{display:'flex',gap:6,marginTop:3}}>
                            {p.profileLink && (
                              <a href={p.profileLink.startsWith('http')?p.profileLink:'https://'+p.profileLink}
                                target="_blank" rel="noopener noreferrer"
                                title="Player Profile" style={{fontSize:16,textDecoration:'none',lineHeight:1}}>🧑‍💼</a>
                            )}
                            {p.videoLink && (
                              <a href={p.videoLink.startsWith('http')?p.videoLink:'https://'+p.videoLink}
                                target="_blank" rel="noopener noreferrer"
                                title="Video" style={{fontSize:16,textDecoration:'none',lineHeight:1}}>📹</a>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{color:'var(--text-2)',fontSize:12}}>{genderShort}</td>
                      <td style={{fontSize:12,color:'var(--text-2)',whiteSpace:'nowrap'}}>{dobDisplay}</td>
                      <td>
                        <NatFlags nationalities={p.nationalities} />
                        <div style={{marginTop:3}}>
                          <span className="badge" style={{
                            background: pIsEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',
                            color: pIsEU?'var(--blue)':'var(--red)',
                            fontSize:10,
                          }}>{pIsEU?'EU':'Non-EU'}</span>
                        </div>
                      </td>
                      <td style={{fontWeight:500}}>{p.primaryPosition||'—'}</td>
                      <td style={{fontSize:12,color:'var(--text-3)'}}>
                        {Array.isArray(p.secondaryPositions)&&p.secondaryPositions.length>0
                          ? p.secondaryPositions.join(', ') : '—'}
                      </td>
                      <td style={{fontWeight:500,fontSize:12}}>{footShort}</td>
                      <td>
                        <div style={{fontWeight:500}}>{p.isFree?'Free Agent':(p.currentClub||'—')}</div>
                        <div style={{fontSize:11,color:'var(--text-3)'}}>{p.league||''}</div>
                      </td>
                      <td>
                        <span className="badge" style={{
                          background: p.contractStatus==='Free'?'var(--amber-bg)':p.contractStatus==='Under Contract'?'var(--green-bg)':'var(--blue-bg)',
                          color: p.contractStatus==='Free'?'var(--amber)':p.contractStatus==='Under Contract'?'var(--green-ok)':'var(--blue)',
                          fontSize:11,
                        }}>{p.contractStatus||'—'}</span>
                      </td>
                      <td>
                        <div style={{color:alertColor(contractDays),fontSize:12}}>
                          {p.contractEnd ? fmtDate(p.contractEnd) : '—'}
                        </div>
                        {(p.contractFiles||[]).length>0 && (
                          <button onClick={()=>setDocModal({files:p.contractFiles,title:'Contract'})}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:14,padding:0,marginTop:2}}
                            title="View contract">👁</button>
                        )}
                      </td>
                      <td>
                        <div style={{color:alertColor(reprDays),fontSize:12}}>
                          {p.reprEnd ? fmtDate(p.reprEnd) : '—'}
                        </div>
                        {(p.reprFiles||[]).length>0 && (
                          <button onClick={()=>setDocModal({files:p.reprFiles,title:'Representation Agreement'})}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:14,padding:0,marginTop:2}}
                            title="View agreement">👁</button>
                        )}
                      </td>
                      <td>
                        <div style={{color:alertColor(passportDays),fontSize:12}}>
                          {p.passportExpiry ? fmtDate(p.passportExpiry) : '—'}
                        </div>
                        {(p.passportFiles||[]).length>0 && (
                          <button onClick={()=>setDocModal({files:p.passportFiles,title:'Passport'})}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:14,padding:0,marginTop:2}}
                            title="View passport">👁</button>
                        )}
                      </td>
                      <td style={{fontSize:12,color:'var(--text-3)'}}>{p.natTeamStatus||'—'}</td>
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
        <Modal
          title={modal==='add'?'Add Represented Player':`Edit: ${form.fullName}`}
          onClose={()=>setModal(null)} wide
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving?<><span className="spinner" style={{width:14,height:14}}/> Saving...</>:'Save Player'}
            </button>
          </>}
        >
          <div className="form-section-title">Basic Information</div>
          <div className="form-grid-2">
            <Field label="Full Name" required>
              <input value={f('fullName')} onChange={e=>s('fullName')(e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Gender" required>
              <ChipGroup options={['Men','Women']} value={f('gender')} onChange={s('gender')} />
            </Field>
          </div>
          <div className="form-grid-3">
            <Field label="Date of Birth">
              <DateInput value={f('dob')} onChange={s('dob')} />
              {age!==null && <div className="form-hint">Age: {age}</div>}
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
            <div style={{marginTop:6,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
              <span className="badge" style={{background:isEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',color:isEU?'var(--blue)':'var(--red)'}}>
                {isEU?'🇪🇺 EU Player':'Non-EU'}
              </span>
              {(form.nationalities||[]).length>0&&<span style={{fontSize:11,color:'var(--text-3)'}}>{form.nationalities.join(', ')}</span>}
            </div>
          </Field>
          <Field label="National Team Status">
            <ChipGroup options={NAT_TEAM_STATUS} value={f('natTeamStatus')} onChange={s('natTeamStatus')} />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Club & Contract</div>
          <Field label="Contract Status">
            <ChipGroup options={CONTRACT_STATUS} value={f('contractStatus')} onChange={s('contractStatus')} />
          </Field>
          {!isFree && (
            <>
              <div className="form-grid-2">
                <Field label="Current Club">
                  <input value={f('currentClub')} onChange={e=>s('currentClub')(e.target.value)} placeholder="Club name" />
                </Field>
                {isLoan && (
                  <Field label="Loan From">
                    <input value={f('loanFrom')} onChange={e=>s('loanFrom')(e.target.value)} placeholder="Parent club" />
                  </Field>
                )}
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
              <div className="form-grid-2">
                <Field label="Contract Start"><DateInput value={f('contractStart')} onChange={s('contractStart')} /></Field>
                <Field label="Contract End"><DateInput value={f('contractEnd')} onChange={s('contractEnd')} /></Field>
              </div>
              {isLoan && <Field label="Parent Club Contract End"><DateInput value={f('loanParentEnd')} onChange={s('loanParentEnd')} /></Field>}
              <Field label="Contract File">
                <FileUpload label="contract" onUpload={(file,name,mode)=>handleFileUpload('contractFiles',file,name,mode)} history={form.contractFiles||[]} />
              </Field>
            </>
          )}

          <hr className="divider" />
          <div className="form-section-title">Passport</div>
          <div className="form-grid-2">
            <Field label="Passport Number">
              <input value={f('passportNumber')} onChange={e=>s('passportNumber')(e.target.value)} placeholder="Passport number" />
            </Field>
            <Field label="Passport Expiry">
              <DateInput value={f('passportExpiry')} onChange={s('passportExpiry')} />
            </Field>
          </div>
          <Field label="Passport File">
            <FileUpload label="passport" onUpload={(file,name,mode)=>handleFileUpload('passportFiles',file,name,mode)} history={form.passportFiles||[]} />
          </Field>

          <hr className="divider" />
          <div className="form-section-title">Representation Agreement</div>
          <div className="form-grid-2">
            <Field label="Repr. Start"><DateInput value={f('reprStart')} onChange={s('reprStart')} /></Field>
            <Field label="Repr. End"><DateInput value={f('reprEnd')} onChange={s('reprEnd')} /></Field>
          </div>
          <Field label="Representation Agreement File">
            <FileUpload label="agreement" onUpload={(file,name,mode)=>handleFileUpload('reprFiles',file,name,mode)} history={form.reprFiles||[]} />
          </Field>

          <hr className="divider" />
          <div className="form-grid-2">
            <Field label="Profile Link" hint="Transfermarkt, Wyscout...">
              <input value={f('profileLink')} onChange={e=>s('profileLink')(e.target.value)} placeholder="https://..." />
            </Field>
            <Field label="Video Link" hint="YouTube, highlights...">
              <input value={f('videoLink')} onChange={e=>s('videoLink')(e.target.value)} placeholder="https://..." />
            </Field>
          </div>
          <Field label="Notes">
            <textarea value={f('notes')} onChange={e=>s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} />
          </Field>
        </Modal>
      )}

      {viewPlayer && <PlayerView player={viewPlayer} onClose={()=>setViewPlayer(null)} />}
      {docModal && <DocViewer files={docModal.files} title={docModal.title} onClose={()=>setDocModal(null)} />}
      {dialog}
    </div>
  );
}
