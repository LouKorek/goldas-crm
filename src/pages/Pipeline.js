import React, { useState, useEffect } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { POSITIONS, FOOT_OPTIONS, NAT_TEAM_STATUS, PIPELINE_STATUS, PIPELINE_STATUS_COLORS,
         COUNTRIES, calcAge, fmtDate, isEuropean, formatPhone } from 'lib/constants';
import { Modal, Field, ChipGroup, CountrySelect, DateInput, SortTh, SearchInput,
         FilterBar, PageHeader, Empty, Spinner, useConfirm,
         PhoneActions, NumberInput } from 'components/ui/UI';
import { toast } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';

// ── Nationality flags (matches the Represented screen) ────────────
const CC = {'Afghanistan':'AFG','Albania':'ALB','Algeria':'ALG','Argentina':'ARG','Armenia':'ARM','Australia':'AUS','Austria':'AUT','Azerbaijan':'AZE','Bahrain':'BHR','Belgium':'BEL','Bolivia':'BOL','Bosnia and Herzegovina':'BIH','Brazil':'BRA','Bulgaria':'BUL','Cameroon':'CMR','Canada':'CAN','Chile':'CHI','China':'CHN','Colombia':'COL','Congo':'CGO','Costa Rica':'CRC','Croatia':'CRO','Cyprus':'CYP','Czech Republic':'CZE','Denmark':'DEN','DR Congo':'COD','Ecuador':'ECU','Egypt':'EGY','El Salvador':'SLV','England':'ENG','Estonia':'EST','Ethiopia':'ETH','Finland':'FIN','France':'FRA','Gabon':'GAB','Georgia':'GEO','Germany':'GER','Ghana':'GHA','Greece':'GRE','Guatemala':'GUA','Honduras':'HON','Hungary':'HUN','Iceland':'ISL','India':'IND','Indonesia':'IDN','Iran':'IRN','Iraq':'IRQ','Ireland':'IRL','Israel':'ISR','Italy':'ITA','Jamaica':'JAM','Japan':'JPN','Jordan':'JOR','Kazakhstan':'KAZ','Kenya':'KEN','Kosovo':'XKX','Kuwait':'KUW','Latvia':'LAT','Lebanon':'LIB','Libya':'LBA','Lithuania':'LTU','Luxembourg':'LUX','Malaysia':'MAS','Mali':'MLI','Malta':'MLT','Mexico':'MEX','Moldova':'MDA','Morocco':'MAR','Netherlands':'NED','New Zealand':'NZL','Nigeria':'NGR','North Macedonia':'MKD','Northern Ireland':'NIR','Norway':'NOR','Oman':'OMA','Pakistan':'PAK','Palestine':'PLE','Panama':'PAN','Paraguay':'PAR','Peru':'PER','Philippines':'PHI','Poland':'POL','Portugal':'POR','Qatar':'QAT','Romania':'ROU','Russia':'RUS','Rwanda':'RWA','Saudi Arabia':'KSA','Scotland':'SCO','Senegal':'SEN','Serbia':'SRB','Slovakia':'SVK','Slovenia':'SVN','South Africa':'RSA','South Korea':'KOR','Spain':'ESP','Sri Lanka':'SRI','Sudan':'SDN','Sweden':'SWE','Switzerland':'SUI','Syria':'SYR','Tanzania':'TAN','Thailand':'THA','Tunisia':'TUN','Turkey':'TUR','Uganda':'UGA','Ukraine':'UKR','United Arab Emirates':'UAE','United Kingdom':'GBR','United States':'USA','Uruguay':'URU','Uzbekistan':'UZB','Venezuela':'VEN','Vietnam':'VIE','Wales':'WAL','Zimbabwe':'ZIM'};
const cc = (n) => CC[n] || (n||'').slice(0,3).toUpperCase();

function NatFlags({ nats=[] }) {
  if (!nats.length) return <span style={{color:'var(--text-3)'}}>—</span>;
  return (
    <div style={{display:'flex',gap:4,flexWrap:'wrap',width:76}}>
      {nats.filter(Boolean).map(n=>(
        <span key={n} title={n} style={{background:'var(--surface-3)',borderRadius:4,padding:'2px 5px',fontSize:10,fontWeight:700,color:'var(--text-2)',border:'1px solid var(--border)',letterSpacing:'0.03em',cursor:'default'}}>{cc(n)}</span>
      ))}
    </div>
  );
}

const CAT = { men:'Men', women:'Women', youth:'Youth', jewish:'Jewish' };
const CAT_EMOJI = { men:'🏃', women:'🏃‍♀️', youth:'🌱', jewish:'✡️' };
const CAT_COLOR = { men:'#4ADE80', women:'#F472B6', youth:'#60A5FA', jewish:'#A78BFA' };


const EMPTY = {
  status:'Not Contacted', playerName:'', profileLink:'', videoLink:'',
  agentName:'', agentPhone:'', nationalities:[], dob:'',
  primaryPosition:'', secondaryPositions:[], height:'', foot:'',
  currentClub:'', currentClubIsYouth:false, leagueCountry:'', leagueTier:'',
  leagueManual:'', leagueMode:'select',
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
  const { canEdit } = useRole();

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

  const validate = () => {
    if (!form.playerName.trim()) return 'Player name is required.';
    if (form.height) {
      const h = parseInt(form.height, 10);
      if (isNaN(h) || h < 130 || h > 225) return 'Height must be between 130 and 225 cm.';
    }
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
            {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{height:36,background:color,color:'#0A1F12'}}>+ Add Player</button>}
            <div style={{height:36,display:'flex',alignItems:'center'}}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
            {canEdit && <button className="btn btn-danger btn-sm" onClick={()=>clearAllCategory(path)}
              style={{height:36,opacity:0.45,whiteSpace:'nowrap'}} title="Clear all"
              onMouseEnter={e=>e.currentTarget.style.opacity='1'}
              onMouseLeave={e=>e.currentTarget.style.opacity='0.45'}>
              🗑 Clear All
            </button>}
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
          action={canEdit&&!search&&!Object.values(filters).some(Boolean)&&<button className="btn btn-primary" onClick={openAdd} style={{background:color,color:'#0A1F12'}}>+ Add Player</button>} />
      ) : (
        <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{width:66}}></th>
                  <SortTh label="🏃‍♂️" field="playerName"      sort={sort} setSort={setSort} />
                  <SortTh label="🗓️"  field="dob"             sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>🌎</th>
                  <SortTh label="📍"  field="primaryPosition" sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>📌</th>
                  <SortTh label="🦵"  field="foot"            sort={sort} setSort={setSort} />
                  <th>🔰</th>
                  <SortTh label="🚦"  field="status"          sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>👤</th>
                  <th style={{textAlign:'center'}}>💰</th>
                  <th style={{textAlign:'center'}}>💵</th>
                  <SortTh label="🏟️"  field="natTeamStatus"   sort={sort} setSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {data.map(p => {
                  const pIsEU       = isEuropean(p.nationalities||[]);
                  const footShort   = p.foot==='Right'?'R':p.foot==='Left'?'L':p.foot==='Both'?'RL':'—';
                  const dobDisplay  = p.dob?`${fmtDate(p.dob)} (${calcAge(p.dob)})`:'—';
                  return (
                  <tr key={p.id}
                    onClick={()=>setCardFor(p)}
                    style={{cursor:'pointer'}}
                    onMouseEnter={e=>e.currentTarget.style.background='rgba(201,168,76,0.05)'}
                    onMouseLeave={e=>e.currentTarget.style.background=''}
                  >
                    {/* Actions — icons arranged 2-over-2; row click opens the player card */}
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{display:'flex',gap:3,flexWrap:'wrap',width:55}}>
                        {canEdit&&(<button style={{width:26,height:26,padding:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,border:'none',borderRadius:6,cursor:'pointer',background:'rgba(248,113,113,0.15)',color:'var(--red)'}}
                          title="Delete" onClick={()=>del(p)}>🗑</button>)}
                        {canEdit&&(<button style={{width:26,height:26,padding:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,border:'none',borderRadius:6,cursor:'pointer',background:'rgba(201,168,76,0.15)',color:'var(--gold)'}}
                          title="Edit" onClick={()=>openEdit(p)}>✏️</button>)}
                        {p.profileLink&&(
                          <a href={p.profileLink.startsWith('http')?p.profileLink:'https://'+p.profileLink}
                            target="_blank" rel="noopener noreferrer"
                            style={{width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(96,165,250,0.15)',borderRadius:6,fontSize:13,textDecoration:'none'}}
                            title="Profile">🧑‍💼</a>
                        )}
                        {p.videoLink&&(
                          <a href={p.videoLink.startsWith('http')?p.videoLink:'https://'+p.videoLink}
                            target="_blank" rel="noopener noreferrer"
                            style={{width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(74,222,128,0.15)',borderRadius:6,fontSize:13,textDecoration:'none'}}
                            title="Video">📹</a>
                        )}
                      </div>
                    </td>
                    {/* Name */}
                    <td>
                      <span style={{fontWeight:600}}>{p.playerName}</span>
                      {p.height && <div style={{fontSize:11,color:'var(--text-3)'}}>{p.height}cm</div>}
                    </td>
                    {/* DOB + age */}
                    <td style={{fontSize:11,color:'var(--text-2)'}}>{dobDisplay}</td>
                    {/* Nationalities + EU */}
                    <td>
                      <NatFlags nats={p.nationalities} />
                      <div style={{marginTop:3}}>
                        <span className="badge" style={{background:pIsEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',color:pIsEU?'var(--blue)':'var(--red)',fontSize:10}}>
                          {pIsEU?'EU':'Non-EU'}
                        </span>
                      </div>
                    </td>
                    {/* Primary position */}
                    <td style={{fontWeight:500,textAlign:'center'}}>{p.primaryPosition||'—'}</td>
                    {/* Secondary positions */}
                    <td style={{fontSize:11,color:'var(--text-3)',textAlign:'center'}}>{Array.isArray(p.secondaryPositions)&&p.secondaryPositions.length>0?p.secondaryPositions.join(', '):'—'}</td>
                    {/* Foot */}
                    <td style={{fontWeight:500,fontSize:11,textAlign:'center'}}>{footShort}</td>
                    {/* Club */}
                    <td>
                      <div style={{display:'flex',alignItems:'center',gap:5}}>
                        <span style={{fontWeight:500}}>{p.currentClub||'Free'}</span>
                        {p.currentClubIsYouth&&<span style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.3)',borderRadius:4,color:'#4ADE80',fontSize:9,fontWeight:700,padding:'1px 5px'}}>U19</span>}
                      </div>
                      <div style={{fontSize:11,color:'var(--text-3)',display:'flex',alignItems:'center',gap:4}}>
                        {p.league||''}
                        {p.currentClubIsYouth&&<span style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.3)',borderRadius:3,color:'#4ADE80',fontSize:8,fontWeight:700,padding:'0 4px'}}>U19</span>}
                      </div>
                    </td>
                    {/* Status — wraps to two lines to keep the column narrow */}
                    <td>
                      {p.status && (() => {
                        const c = PIPELINE_STATUS_COLORS[p.status] || { bg:'var(--surface-3)', text:'var(--text-2)' };
                        return (
                          <span style={{display:'inline-block',background:c.bg,color:c.text,borderRadius:6,fontSize:10,fontWeight:600,lineHeight:1.2,padding:'3px 7px',whiteSpace:'normal',textAlign:'center',maxWidth:72}}>
                            {p.status}
                          </span>
                        );
                      })()}
                    </td>
                    {/* Agent — compact: name, small number, small action icons (matches the name column size) */}
                    <td>
                      <div style={{fontWeight:500,fontSize:13,whiteSpace:'nowrap'}}>{p.agentName||'—'}</div>
                      {p.agentPhone && (<>
                        <div style={{fontSize:11,color:'var(--text-3)',whiteSpace:'nowrap',marginTop:2}}>{formatPhone(p.agentPhone)}</div>
                        <div style={{marginTop:3}}><PhoneActions phone={p.agentPhone} /></div>
                      </>)}
                    </td>
                    {/* Transfer fee */}
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.transferFee && p.transferFee!=='Not specified' ? `€${Number(p.transferFee).toLocaleString()}` : (p.transferFee||'—')}
                    </td>
                    {/* Salary */}
                    <td style={{color:'var(--text-2)',fontSize:12}}>
                      {p.salary && p.salary!=='Not specified' ? `€${Number(p.salary).toLocaleString()}/mo` : (p.salary||'—')}
                    </td>
                    {/* National team */}
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
              <input type="number" min={130} max={225} value={f('height')} onChange={e=>s('height')(e.target.value.replace(/[^0-9]/g,'').slice(0,3))} placeholder="130–225 cm" />
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
            <button type="button" className={`chip${form.currentClubIsYouth?' active':''}`}
              onClick={()=>s('currentClubIsYouth')(!form.currentClubIsYouth)}
              style={{fontSize:11,padding:'4px 10px',marginTop:6}}>🌱 Youth Team</button>
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
                  {COUNTRIES.map(c=><option key={c}>{c}</option>)}
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
