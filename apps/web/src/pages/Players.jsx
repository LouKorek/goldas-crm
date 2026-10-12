import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { deleteDoc_, restoreDoc_, uploadFile, resolveFileUrl, renameFile, PATHS } from 'lib/db';
import { listenPlayers, addPlayer, updatePlayer } from 'data/players';
import { POSITIONS, FOOT_OPTIONS, NAT_TEAM_STATUS, natTeamStatusOf, CONTRACT_STATUS, POSITION_ORDER,
         COUNTRIES, calcAge, fmtDate, daysUntil, isEuropean } from 'lib/constants';
import { Modal, Field, ChipGroup, CountrySelect, DateInput, FileUpload,
         SortTh, SearchInput, FilterBar, PageHeader, Empty, Spinner,
         ExportMenu, useConfirm, RowActions } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { toast } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';
import { t } from 'lib/i18n';

// ── Country code map ──────────────────────────────────────────────
const CC = {'Afghanistan':'AFG','Albania':'ALB','Algeria':'ALG','Argentina':'ARG','Armenia':'ARM','Australia':'AUS','Austria':'AUT','Azerbaijan':'AZE','Bahrain':'BHR','Belgium':'BEL','Bolivia':'BOL','Bosnia and Herzegovina':'BIH','Brazil':'BRA','Bulgaria':'BUL','Cameroon':'CMR','Canada':'CAN','Chile':'CHI','China':'CHN','Colombia':'COL','Congo':'CGO','Costa Rica':'CRC','Croatia':'CRO','Cyprus':'CYP','Czech Republic':'CZE','Denmark':'DEN','DR Congo':'COD','Ecuador':'ECU','Egypt':'EGY','El Salvador':'SLV','England':'ENG','Estonia':'EST','Ethiopia':'ETH','Finland':'FIN','France':'FRA','Gabon':'GAB','Georgia':'GEO','Germany':'GER','Ghana':'GHA','Greece':'GRE','Guatemala':'GUA','Honduras':'HON','Hungary':'HUN','Iceland':'ISL','India':'IND','Indonesia':'IDN','Iran':'IRN','Iraq':'IRQ','Ireland':'IRL','Israel':'ISR','Italy':'ITA','Ivory Coast':'CIV','Jamaica':'JAM','Japan':'JPN','Jordan':'JOR','Kazakhstan':'KAZ','Kenya':'KEN','Kosovo':'XKX','Kuwait':'KUW','Latvia':'LAT','Lebanon':'LIB','Libya':'LBA','Lithuania':'LTU','Luxembourg':'LUX','Malaysia':'MAS','Mali':'MLI','Malta':'MLT','Mexico':'MEX','Moldova':'MDA','Morocco':'MAR','Netherlands':'NED','New Zealand':'NZL','Nigeria':'NGR','North Macedonia':'MKD','Northern Ireland':'NIR','Norway':'NOR','Oman':'OMA','Pakistan':'PAK','Palestine':'PLE','Panama':'PAN','Paraguay':'PAR','Peru':'PER','Philippines':'PHI','Poland':'POL','Portugal':'POR','Qatar':'QAT','Romania':'ROU','Russia':'RUS','Rwanda':'RWA','Saudi Arabia':'KSA','Scotland':'SCO','Senegal':'SEN','Serbia':'SRB','Slovakia':'SVK','Slovenia':'SVN','South Africa':'RSA','South Korea':'KOR','Spain':'ESP','Sri Lanka':'SRI','Sudan':'SDN','Sweden':'SWE','Switzerland':'SUI','Syria':'SYR','Tanzania':'TAN','Thailand':'THA','Tunisia':'TUN','Turkey':'TUR','Uganda':'UGA','Ukraine':'UKR','United Arab Emirates':'UAE','United Kingdom':'GBR','United States':'USA','Uruguay':'URU','Uzbekistan':'UZB','Venezuela':'VEN','Vietnam':'VIE','Wales':'WAL','Zimbabwe':'ZIM'};
const cc = (n) => CC[n] || (n||'').slice(0,3).toUpperCase();

function NatFlags({ nats=[] }) {
  if (!nats.length) return <span style={{color:'var(--text-3)'}}>—</span>;
  return (
    <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
      {nats.filter(Boolean).map(n=>(
        <span key={n} title={n} style={{background:'var(--surface-3)',borderRadius: 0,padding:'2px 5px',fontSize:10,fontWeight:700,color:'var(--text-2)',border:'1px solid var(--border)',letterSpacing:'0.03em',cursor:'default'}}>{cc(n)}</span>
      ))}
    </div>
  );
}

// ── Resolved IFA squad ────────────────────────────────────────────
// A football.org.il profile page names the player's squad but never gives its
// id, so the sync matches it by name once and caches the result. This makes
// that result visible: which squad it settled on, in which league, when — with
// a link to check it and a button to pin it so no lookup ever runs again.
function IfaResolution({ ifa, onPin }) {
  if (!ifa?.teamId) return null;
  const teamUrl = `https://www.football.org.il/team-details/team-games/?team_id=${ifa.teamId}`;
  const line = [ifa.teamName, ifa.ageGroup, ifa.league].filter(Boolean).join('  ·  ');
  const when = ifa.resolvedAt ? new Date(ifa.resolvedAt) : null;
  return (
    <div className="form-hint" style={{
      marginTop: 8, padding: '8px 10px', background: 'var(--surface-3)',
      border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ color: 'var(--text-2)' }}>
        {t("Matched to")} <strong style={{ color: 'var(--text-1)' }}>{line || `team ${ifa.teamId}`}</strong>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={teamUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)' }}>
          {t("Open its fixture list ↗")}
        </a>
        <button type="button" onClick={() => onPin(teamUrl)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--gold)', font: 'inherit' }}>
          {t("Wrong squad? Pin this exact team")}
        </button>
        {when && <span style={{ color: 'var(--text-3)' }}>{t("checked")} {fmtDate(when.toISOString().slice(0, 10))}</span>}
      </div>
    </div>
  );
}

// ── Document viewer ───────────────────────────────────────────────
function DocViewer({ files, title, onClose, onRename }) {
  const [idx, setIdx] = useState(0);
  const [renaming, setRenaming] = useState(null);   // draft name while editing
  const file = files?.[idx];
  const [url, setUrl] = useState(null);
  const [loadingFile, setLoadingFile] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    setUrl(null);
    if (!file) return;
    setLoadingFile(true);
    resolveFileUrl(file)
      .then(async (dataUrl) => {
        if (!dataUrl) throw new Error('unavailable');
        // Convert to a Blob URL — Chrome blocks navigating/embedding raw data: URLs.
        const blob = await (await fetch(dataUrl)).blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => { if (!cancelled) toast.error(t("Could not load this file.")); })
      .finally(() => { if (!cancelled) setLoadingFile(false); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file]);
  const saveName = async () => {
    const name = (renaming || '').trim();
    if (!name) return;
    try { await onRename(idx, name); setRenaming(null); toast.success(t("File renamed.")); }
    catch (e) { toast.error(e.message || 'Rename failed.'); }
  };
  return (
    <Modal title={title} onClose={onClose} wide viewOnly>
      {!files?.length ? (
        <p style={{color:'var(--text-3)'}}>{t("No documents uploaded yet.")}</p>
      ) : (
        <>
          {files.length > 1 && (
            <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
              {files.map((f,i)=>(
                <button key={i} className={`chip${i===idx?' active':''}`} onClick={()=>{ setIdx(i); setRenaming(null); }}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
          {file && (
            <div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                {renaming !== null ? (
                  <div style={{display:'flex',gap:6,flex:1,marginInlineEnd:8}}>
                    <input autoFocus value={renaming} onChange={e=>setRenaming(e.target.value)}
                      onKeyDown={e=>{ if (e.key==='Enter') saveName(); if (e.key==='Escape') setRenaming(null); }} />
                    <button className="btn btn-primary btn-sm" disabled={!renaming.trim()} onClick={saveName}>{t("Save")}</button>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setRenaming(null)}>{t("Cancel")}</button>
                  </div>
                ) : (
                  <div style={{fontSize:12,color:'var(--text-3)'}}>{file.name} · {new Date(file.uploadedAt).toLocaleDateString('en-GB')} · {file.uploadedBy}</div>
                )}
                <div style={{display:'flex',gap:6}}>
                  {onRename && renaming === null && <button className="btn btn-secondary btn-sm" onClick={()=>setRenaming(file.name||'')}>{t("✎ Rename")}</button>}
                  {url && <a href={url} download={file.name} className="btn btn-primary btn-sm">{t("⬇ Download")}</a>}
                </div>
              </div>
              {loadingFile || !url ? (
                <div style={{padding:40,textAlign:'center',color:'var(--text-3)'}}>{loadingFile ? 'Loading file…' : 'File unavailable.'}</div>
              ) : file.type?.startsWith('image/') ? (
                <img src={url} alt={file.name} style={{width:'100%',borderRadius: 0,border:'1px solid var(--border)'}} />
              ) : (
                <iframe src={url} style={{width:'100%',height:480,borderRadius: 0,border:'1px solid var(--border)'}} title={file.name} />
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
  const { canEdit, isAdmin } = useRole();
  const renameDoc = async (index, name) => {
    const updated = await renameFile(PATHS.PLAYERS, player.id, docModal.field, docModal.files, index, name);
    setDocModal(m => ({ ...m, files: updated }));
  };
  const age  = calcAge(player.dob);
  const isEU = isEuropean(player.nationalities||[]);
  const Row = ({label,value}) => value && value!=='—' ? (
    <div style={{display:'flex',gap:12,padding:'7px 0',borderBottom:'1px solid var(--border)'}}>
      <div className="view-row-label" style={{width:170,flexShrink:0,color:'var(--text-3)',fontSize:11,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</div>
      <div style={{color:'var(--text-1)',fontSize:13}}>{value}</div>
    </div>
  ) : null;
  return (
    <Modal title={player.fullName} onClose={onClose} wide viewOnly>
      <div className="view-grid-2">
        <div>
          <div className="form-section-title">{t("Personal")}</div>
          <Row label={t("Full Name")}     value={player.fullName} />
          <Row label={t("Gender")}        value={player.gender} />
          <Row label={t("Date of Birth")} value={player.dob?`${fmtDate(player.dob)} (${age} yrs)`:null} />
          <Row label={t("Nationalities")} value={(player.nationalities||[]).join(', ')} />
          <Row label={t("EU Status")}     value={isEU?'🇪🇺 European':'Non-EU'} />
          <Row label={t("Position")}      value={player.primaryPosition} />
          <Row label={t("Secondary")}     value={(player.secondaryPositions||[]).join(', ')} />
          <Row label={t("Foot")}          value={player.foot} />
          <Row label={t("Nat. Team")}     value={natTeamStatusOf(player.natTeamStatus)} />
          <Row label={t("IFA Squad")}     value={player.autoFetch?.ifa?.teamId
            ? <a href={`https://www.football.org.il/team-details/team-games/?team_id=${player.autoFetch.ifa.teamId}`}
                target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>
                {[player.autoFetch.ifa.teamName, player.autoFetch.ifa.ageGroup].filter(Boolean).join(' · ') || `team ${player.autoFetch.ifa.teamId}`} ↗
              </a>
            : null} />
          {player.profileLink && <Row label={t("Profile Link")} value={<a href={player.profileLink.startsWith('http')?player.profileLink:'https://'+player.profileLink} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>{t("Open ↗")}</a>} />}
          {player.videoLink   && <Row label={t("Video Link")}   value={<a href={player.videoLink.startsWith('http')?player.videoLink:'https://'+player.videoLink} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>{t("Open ↗")}</a>} />}
        </div>
        <div>
          <div className="form-section-title">{t("Club & Contract")}</div>
          <Row label={t("Contract Status")} value={player.contractStatus} />
          <Row label={t("Club")}            value={player.contractStatus==='Free'?'Free Agent':(player.currentClub ? `${player.currentClub}${player.currentClubIsYouth?' 🌱':'' }` : null)} />
          {player.contractStatus==='Loan' && <Row label={t("Loan From")} value={player.loanFrom} />}
          <Row label={t("League")}          value={player.league} />
          <Row label={t("Contract Start")}  value={fmtDate(player.contractStart)} />
          <Row label={t("Contract End")}    value={fmtDate(player.contractEnd)} />
          {player.contractStatus==='Loan' && <Row label={t("Parent Contract End")} value={fmtDate(player.loanParentEnd)} />}
          <div className="form-section-title" style={{marginTop:16}}>{t("Representation")}</div>
          <Row label={t("Repr. Start")}  value={fmtDate(player.reprStart)} />
          <Row label={t("Repr. End")}    value={fmtDate(player.reprEnd)} />
          <div className="form-section-title" style={{marginTop:16}}>{t("Passport")}</div>
          <Row label={t("Passport No.")} value={player.passportNumber} />
          <Row label={t("Expiry")}       value={fmtDate(player.passportExpiry)} />
        </div>
      </div>
      {player.notes && (
        <div style={{marginTop:16}}>
          <div className="form-section-title">{t("Notes")}</div>
          <p style={{color:'var(--text-2)',fontSize:13,lineHeight:1.7}}>{player.notes}</p>
        </div>
      )}
      {/* Last edit info */}
      {player.lastEditedByName && (
        <div style={{marginTop:12,fontSize:11,color:'var(--text-3)'}}>
          {t("Last edited by")} {player.lastEditedByName}
        </div>
      )}
      <div style={{marginTop:20,paddingTop:14,borderTop:'1px solid var(--border)'}}>
        <div className="form-section-title" style={{marginBottom:10}}>{t("Document History")}</div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          {[
            {label:t("📋 Contract"),        field:'contractFiles', files:player.contractFiles},
            {label:t("Repr. Agreement"), field:'reprFiles',     files:player.reprFiles},
            {label:t("Passport"),        field:'passportFiles', files:player.passportFiles},
          ].map(({label,field,files})=>(
            <button key={label} className="btn btn-secondary btn-sm"
              onClick={()=>setDocModal({files:files||[],title:label,field})}>
              {label} <span style={{opacity:.5,fontSize:10}}>({(files||[]).length})</span>
            </button>
          ))}
        </div>
      </div>
      {docModal && <DocViewer files={docModal.files} title={docModal.title} onClose={()=>setDocModal(null)} onRename={canEdit && player.id ? renameDoc : null} />}
    </Modal>
  );
}

const EMPTY_PLAYER = {
  gender:'', fullName:'', nationalities:[], contractStatus:'Under Contract',
  currentClub:'', currentClubIsYouth:false, loanFrom:'', leagueMode:'select',
  leagueCountry:'', leagueTier:'', leagueManual:'', contractStart:'', contractEnd:'',
  loanParentEnd:'', primaryPosition:'', secondaryPositions:[], foot:'', natTeamStatus:'',
  dob:'', passportNumber:'', passportExpiry:'', reprStart:'', reprEnd:'',
  notes:'', contractFiles:[], passportFiles:[], reprFiles:[],
  profileLink:'', videoLink:'',
  // For IFA-routed players (Israeli women / youth / lower leagues): paste the
  // football.org.il team page URL (e.g. team-details/?season_id=27&team_id=4032).
  // The sync function fetches that page and pulls the team's fixtures.
  ifaTeamUrl:'',
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
  const { canEdit, isAdmin }        = useRole();

  useEffect(() => {
    return listenPlayers({ stage: 'represented' }, (data) => { setPlayers(data); setLoading(false); });
  }, []);

  const s = (k) => (v) => { setForm(p=>({...p,[k]:v})); setIsDirty(true); };
  const f = (k) => form[k] ?? '';

  const age    = calcAge(f('dob'));
  const isEU   = isEuropean(form.nationalities);
  const isFree = form.contractStatus === 'Free';
  const isLoan = form.contractStatus === 'Loan';

  // Custom setter for contractStatus: when the status actually changes, wipe
  // all the dependent club/contract/league fields. Without this, toggling
  // Free → Under Contract re-shows the previous club's data that was still
  // sitting in form state (just hidden behind the {!isFree} guard).
  const setContractStatus = (newStatus) => {
    if (newStatus === form.contractStatus) return;
    setForm(prev => ({
      ...prev,
      contractStatus: newStatus,
      currentClub: '',
      currentClubIsYouth: false,
      loanFrom: '',
      contractStart: '',
      contractEnd: '',
      loanParentEnd: '',
      leagueMode: 'select',
      leagueCountry: '',
      leagueTier: '',
      leagueManual: '',
      ifaTeamUrl: '',
    }));
  };
  const league = form.leagueMode==='manual' ? form.leagueManual
    : (form.leagueCountry&&form.leagueTier ? `${form.leagueCountry} ${form.leagueTier.replace('Tier ','')}` : '');

  const openAdd  = () => { setForm({...EMPTY_PLAYER}); setModal('add'); setIsDirty(false); };
  // Legacy 'None' is dropped on the way into the form, so simply
  // re-saving a player clears it for good.
  const openEdit = (p) => { setForm({...EMPTY_PLAYER,...p,natTeamStatus:natTeamStatusOf(p.natTeamStatus)}); setModal({edit:p}); setIsDirty(false); };

  // Arrivals from search / Player 360 carry an intent in the router state:
  // { add: true } opens the form, { editId } opens that player for editing.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const st = location.state;
    if (!st || !canEdit) return;
    if (st.add) { openAdd(); navigate(location.pathname, { replace: true, state: null }); }
    else if (st.editId && players.length) {
      const p = players.find((x) => x.id === st.editId);
      if (p) { openEdit(p); navigate(location.pathname, { replace: true, state: null }); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, players.length]);

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
      // A free agent has no club contract — clear stale club/contract fields so
      // old data (e.g. an expiring contract date) can't linger and trigger alerts.
      if (isFree) {
        data.currentClub = '';
        data.currentClubIsYouth = false;
        data.loanFrom = '';
        data.contractStart = '';
        data.contractEnd = '';
        data.loanParentEnd = '';
        data.league = '';
        data.leagueCountry = '';
        data.leagueTier = '';
        data.leagueManual = '';
      }
      if (modal==='add') { await addPlayer(data, { stage: 'represented' }); toast.success(`"${form.fullName}" added!`); }
      else { await updatePlayer(modal.edit.id, data, modal.edit); toast.success(t("Player updated.")); }
      setModal(null);
    } catch(e) { toast.error(e.message||'Save failed.'); }
    finally { setSaving(false); }
  };

  const del = async (p,e) => {
    e.stopPropagation();
    const ok = await confirm(`Delete "${p.fullName}"?`);
    if (!ok) return;
    try { await deleteDoc_(PATHS.PLAYERS,p.id); toast.success(t("Deleted."), { undo: () => restoreDoc_(PATHS.PLAYERS, p.id) }); }
    catch(e) { toast.error(e.message||'Delete failed.'); }
  };

  const handleFileUpload = async (field, file, name, mode) => {
    try {
      const fileData = await uploadFile(file,`players/${field}`,name);
      const current  = Array.isArray(form[field])?form[field]:[];
      const updated  = mode==='replace'?[fileData]:[...current,fileData];
      setForm(p=>({...p,[field]:updated}));
      if (modal?.edit?.id) await updatePlayer(modal.edit.id,{[field]:updated});
      toast.success(t("File uploaded."));
    } catch(e) { toast.error(e.message||'Upload failed.'); }
  };

  let data = players.filter(p=>{
    if (search&&!`${p.fullName} ${p.currentClub} ${p.primaryPosition}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.gender&&p.gender!==filters.gender) return false;
    if (filters.position&&p.primaryPosition!==filters.position) return false;
    if (filters.contractStatus&&p.contractStatus!==filters.contractStatus) return false;
    if (filters.youthScope === 'Youth'  && !p.currentClubIsYouth) return false;
    if (filters.youthScope === 'Senior' &&  p.currentClubIsYouth) return false;
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
        title={t("Represented Players")}
        subtitle={`${players.length} player${players.length!==1?'s':''} under representation`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{height:36}}><Icon name="plus" size={12} /><span className="btn-text">{t("Add Player")}</span></button>}
            <ExportMenu
              filename="Represented Players"
              title={t("Represented Players")}
              subtitle={[
                search && `search: "${search}"`,
                filters.gender && `gender: ${filters.gender}`,
                filters.position && `position: ${filters.position}`,
                filters.contractStatus && `contract: ${filters.contractStatus}`,
              ].filter(Boolean).join('  ·  ')}
              columns={[
                { key: 'fullName',         label: '🏃‍♂️',   pdfLabel: 'Player' },
                { key: 'gender',           label: 'G',       pdfLabel: 'G' },
                { key: 'dob',              label: '🗓️',     pdfLabel: 'DOB' },
                { key: 'nationalities',    label: '🌎',     pdfLabel: 'Nationalities' },
                { key: 'primaryPosition',  label: '📍',     pdfLabel: 'Position' },
                { key: 'secondaryPositions', label: t("Sec 📍"), pdfLabel: 'Secondary',
                  format: (v) => Array.isArray(v) ? v.join(', ') : (v || '') },
                { key: 'foot',             label: '🦵',     pdfLabel: 'Foot' },
                { key: 'currentClub',      label: '🔰',     pdfLabel: 'Club',
                  format: (v, r) => r.contractStatus === 'Free'
                    ? 'Free Agent'
                    : (v ? `${v}${r.currentClubIsYouth ? ' (U19)' : ''}${r.league ? `  ·  ${r.league}` : ''}` : '') },
                { key: 'contractStatus',   label: '📑',     pdfLabel: 'Contract' },
                { key: 'contractEnd',      label: t("End 📑"), pdfLabel: 'Contract End' },
                { key: 'reprEnd',          label: t("End 🤝"), pdfLabel: 'Repr. End' },
                { key: 'passportExpiry',   label: t("End 🪪"), pdfLabel: 'Passport Exp' },
                { key: 'natTeamStatus',    label: '🏟️',     pdfLabel: 'National Team',
                  format: (v) => natTeamStatusOf(v) },
                { key: 'profileLink',      label: '🧑‍💼',   pdfLabel: 'Profile',
                  format: (v) => v ? { text: t("Profile"), url: v.startsWith('http') ? v : 'https://' + v } : '' },
                { key: 'videoLink',        label: '📹',     pdfLabel: 'Video',
                  format: (v) => v ? { text: t("Video"),   url: v.startsWith('http') ? v : 'https://' + v } : '' },
              ]}
              rows={data}
            />
            <div style={{height:36,display:'flex',alignItems:'center'}}>
              <SearchInput value={search} onChange={setSearch} placeholder={t("Search...")} />
            </div>
          </div>
        }
      >
        <div style={{marginTop:14}}>
          <FilterBar filters={filters} setFilters={setFilters} options={[
            {key:'gender',label:t("Gender"),values:['Men','Women']},
            {key:'position',label:t("Position"),values:POSITIONS},
            {key:'contractStatus',label:t("Contract"),values:CONTRACT_STATUS},
            {key:'youthScope',label:t("Group"),values:['Youth','Senior']},
          ]} />
        </div>
      </PageHeader>

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',padding:60}}><Spinner size={36}/></div>
      ) : data.length===0 ? (
        <Empty
          message={search||Object.values(filters).some(Boolean)?'No represented players match your search.':'No players yet.'}
          action={canEdit&&!search&&!Object.values(filters).some(Boolean)&&<button className="btn btn-primary" onClick={openAdd}><Icon name="plus" size={12} /><span className="btn-text">{t("Add Player")}</span></button>} />
      ) : (
        <>
        <div className="mobile-cards">
          {data.map(p=>{
            const contractDays=daysUntil(p.contractEnd);
            const reprDays=daysUntil(p.reprEnd);
            const passportDays=daysUntil(p.passportExpiry);
            const pAge=calcAge(p.dob);
            const pIsEU=isEuropean(p.nationalities||[]);
            return (
              <div key={p.id} className="m-card" onClick={()=>setViewPlayer(p)}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <Link to={`/players/${p.id}`} style={{fontWeight:600,fontSize:14.5,flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'inherit',textDecoration:'none'}}>{p.fullName}</Link>
                  <span className="badge" style={{background:pIsEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',color:pIsEU?'var(--blue)':'var(--red)',fontSize:9.5,flexShrink:0}}>{pIsEU?'EU':'Non-EU'}</span>
                </div>
                <div className="m-meta" style={{marginTop:5}}>
                  {p.primaryPosition&&<span style={{color:'var(--gold)',fontWeight:600}}>{p.primaryPosition}</span>}
                  {Array.isArray(p.secondaryPositions)&&p.secondaryPositions.length>0&&<span className="m-sub">({p.secondaryPositions.join(', ')})</span>}
                  {p.dob&&<span>{fmtDate(p.dob)} ({pAge})</span>}
                  {p.foot&&<span>{p.foot}</span>}
                </div>
                <div className="m-meta" style={{marginTop:5}}>
                  <span style={{fontWeight:500,color:'var(--text-1)'}}>{p.contractStatus==='Free'?'Free Agent':(p.currentClub||'—')}</span>
                  {p.currentClubIsYouth&&<span style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.3)',borderRadius: 0,color:'#4ADE80',fontSize:9,fontWeight:700,padding:'1px 5px'}}>U19</span>}
                  {p.league&&<span className="m-sub">{p.league}</span>}
                  <span className="badge" style={{background:p.contractStatus==='Free'?'var(--amber-bg)':p.contractStatus==='Under Contract'?'var(--green-bg)':'var(--blue-bg)',color:p.contractStatus==='Free'?'var(--amber)':p.contractStatus==='Under Contract'?'var(--green-ok)':'var(--blue)',fontSize:9.5}}>{p.contractStatus||'—'}</span>
                </div>
                {(p.contractEnd||p.reprEnd||p.passportExpiry||natTeamStatusOf(p.natTeamStatus))&&(
                  <div className="m-meta" style={{marginTop:5,fontSize:11}}>
                    {p.contractEnd&&<span style={{color:alertColor(contractDays)}}>{fmtDate(p.contractEnd)}</span>}
                    {p.reprEnd&&<span style={{color:alertColor(reprDays)}}>{fmtDate(p.reprEnd)}</span>}
                    {p.passportExpiry&&<span style={{color:alertColor(passportDays)}}>{fmtDate(p.passportExpiry)}</span>}
                    {natTeamStatusOf(p.natTeamStatus)&&<span className="m-sub">{natTeamStatusOf(p.natTeamStatus)}</span>}
                  </div>
                )}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,marginTop:9}}>
                  <NatFlags nats={p.nationalities} />
                  <span onClick={e=>e.stopPropagation()}>
                    <RowActions
                      onEdit={canEdit?()=>openEdit(p):undefined}
                      onDelete={canEdit?(e)=>del(p,e):undefined}
                      profileUrl={p.profileLink}
                      videoUrl={p.videoLink}
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="card desktop-table" style={{padding:0}}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{width:70}}>{t("Actions")}</th>
                  <SortTh label={t("Name")} field="fullName" sort={sort} setSort={setSort} />
                  <SortTh label='G' field='gender' sort={sort} setSort={setSort} />
                  <SortTh label={t("Born")} field='dob' sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>{t("Nat")}</th>
                  <SortTh label={t("Pos")} field='primaryPosition' sort={sort} setSort={setSort} />
                  <th style={{textAlign:'center'}}>{t("2nd")}</th>
                  <SortTh label={t("Foot")} field='foot' sort={sort} setSort={setSort} />
                  <th>{t("Club")}</th>
                  <SortTh label={t("Contract")} field='contractStatus' sort={sort} setSort={setSort} />
                  <SortTh label={t("Con. End")} field='contractEnd' sort={sort} setSort={setSort} />
                  <SortTh label={t("Rep. End")} field='reprEnd' sort={sort} setSort={setSort} />
                  <SortTh label={t("Passport")} field='passportExpiry' sort={sort} setSort={setSort} />
                  <SortTh label='NT' field='natTeamStatus' sort={sort} setSort={setSort} />
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
                  const dobDisplay   = p.dob?`${fmtDate(p.dob)} (${pAge})`:'—';
                  return (
                    <tr key={p.id}
                      onClick={()=>setViewPlayer(p)}
                      style={{cursor:'pointer'}}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(201,168,76,0.05)'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}
                    >
                      {/* Actions cell - click stops propagation */}
                      <td onClick={e=>e.stopPropagation()}>
                        <RowActions
                          onEdit={canEdit?()=>openEdit(p):undefined}
                          onDelete={canEdit?(e)=>del(p,e):undefined}
                          profileUrl={p.profileLink}
                          videoUrl={p.videoLink}
                        />
                      </td>
                      <td style={{fontWeight:600}}><Link to={`/players/${p.id}`} style={{color:'inherit',textDecoration:'none'}}>{p.fullName}</Link></td>
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
                        <div style={{display:'flex',alignItems:'center',gap:5}}>
                          <span style={{fontWeight:500}}>{p.contractStatus==='Free'?'Free Agent':(p.currentClub||'—')}</span>
                          {p.currentClubIsYouth&&<span style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.3)',borderRadius: 0,color:'#4ADE80',fontSize:9,fontWeight:700,padding:'1px 5px'}}>U19</span>}
                        </div>
                        <div style={{fontSize:10,color:'var(--text-3)',display:'flex',alignItems:'center',gap:4}}>
                          {p.league||''}
                          {p.currentClubIsYouth&&<span style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.3)',borderRadius: 0,color:'#4ADE80',fontSize:8,fontWeight:700,padding:'0 4px'}}>U19</span>}
                        </div>
                      </td>
                      <td style={{textAlign:'center'}}>
                        <span className="badge" style={{background:p.contractStatus==='Free'?'var(--amber-bg)':p.contractStatus==='Under Contract'?'var(--green-bg)':'var(--blue-bg)',color:p.contractStatus==='Free'?'var(--amber)':p.contractStatus==='Under Contract'?'var(--green-ok)':'var(--blue)',fontSize:10}}>
                          {p.contractStatus||'—'}
                        </span>
                      </td>
                      <td style={{color:alertColor(contractDays),fontSize:11}}>{p.contractEnd?fmtDate(p.contractEnd):'—'}</td>
                      <td style={{color:alertColor(reprDays),fontSize:11}}>{p.reprEnd?fmtDate(p.reprEnd):'—'}</td>
                      <td style={{color:alertColor(passportDays),fontSize:11}}>{p.passportExpiry?fmtDate(p.passportExpiry):'—'}</td>
                      <td style={{fontSize:11,color:'var(--text-3)'}}>{natTeamStatusOf(p.natTeamStatus)||'—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {/* Add/Edit Modal */}
      {modal && (
        <Modal title={modal==='add'?'Add Represented Player':`Edit: ${form.fullName}`}
          onClose={()=>setModal(null)} wide isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>{t("Cancel")}</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving?<><span className="spinner" style={{width:14,height:14}}/> {t("Saving...")}</>:'Save Player'}
            </button>
          </>}
        >
          <div className="form-section-title">{t("Basic Information")}</div>
          <div className="form-grid-2">
            <Field label={t("Full Name")} required><input value={f('fullName')} onChange={e=>s('fullName')(e.target.value)} placeholder={t("Full name")} /></Field>
            <Field label={t("Gender")} required><ChipGroup options={['Men','Women']} value={f('gender')} onChange={s('gender')} /></Field>
          </div>
          <div className="form-grid-3">
            <Field label={t("Date of Birth")}>
              <DateInput value={f('dob')} onChange={s('dob')} />
              {age!==null&&<div className="form-hint">{t("Age:")} {age}</div>}
            </Field>
            <Field label={t("Primary Position")}>
              <select value={f('primaryPosition')} onChange={e=>s('primaryPosition')(e.target.value)}>
                <option value="">{t("Select...")}</option>
                {POSITIONS.map(p=><option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label={t("Strong Foot")}><ChipGroup options={FOOT_OPTIONS} value={f('foot')} onChange={s('foot')} /></Field>
          </div>
          <Field label={t("Secondary Positions")}><ChipGroup options={POSITIONS} value={f('secondaryPositions')} onChange={s('secondaryPositions')} multi /></Field>
          <Field label={t("Nationalities")}>
            <CountrySelect value={f('nationalities')} onChange={s('nationalities')} />
            <div style={{marginTop:6,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
              <span className="badge" style={{background:isEU?'rgba(96,165,250,0.15)':'rgba(248,113,113,0.12)',color:isEU?'var(--blue)':'var(--red)'}}>{isEU?'🇪🇺 EU Player':'Non-EU'}</span>
            </div>
          </Field>
          <Field label={t("National Team Status")}><ChipGroup options={NAT_TEAM_STATUS} value={f('natTeamStatus')} onChange={s('natTeamStatus')} /></Field>

          <hr className="divider" />
          <div className="form-section-title">{t("Club & Contract")}</div>
          <Field label={t("Contract Status")}><ChipGroup options={CONTRACT_STATUS} value={f('contractStatus')} onChange={setContractStatus} /></Field>
          {!isFree&&(<>
            <div className="form-grid-2">
              <Field label={t("Current Club")}>
                <input value={f('currentClub')} onChange={e=>s('currentClub')(e.target.value)} placeholder={t("Club name")} />
                <button type="button" className={`chip${form.currentClubIsYouth?' active':''}`}
                  onClick={()=>s('currentClubIsYouth')(!form.currentClubIsYouth)}
                  style={{fontSize:11,padding:'4px 10px',marginTop:6}}>{t("Youth Team")}</button>
              </Field>
              {isLoan&&<Field label={t("Loan From")}><input value={f('loanFrom')} onChange={e=>s('loanFrom')(e.target.value)} placeholder={t("Parent club")} /></Field>}
            </div>
            <Field label={t("League")}>
              <div style={{display:'flex',gap:8,marginBottom:8}}>
                <button type="button" className={`chip${form.leagueMode==='select'?' active':''}`} onClick={()=>s('leagueMode')('select')}>{t("By Country + Tier")}</button>
                <button type="button" className={`chip${form.leagueMode==='manual'?' active':''}`} onClick={()=>s('leagueMode')('manual')}>{t("Manual")}</button>
              </div>
              {form.leagueMode==='select'?(
                <div className="form-grid-2">
                  <select value={f('leagueCountry')} onChange={e=>s('leagueCountry')(e.target.value)}>
                    <option value="">{t("Country...")}</option>
                    {COUNTRIES.map(c=><option key={c}>{c}</option>)}
                  </select>
                  <ChipGroup options={['1st','2nd','3rd','4th','5th+']} value={f('leagueTier')} onChange={s('leagueTier')} />
                </div>
              ):(
                <input value={f('leagueManual')} onChange={e=>s('leagueManual')(e.target.value)} placeholder={t("e.g. Premier League")} />
              )}
              {league&&<div className="form-hint">{t("League:")} <strong>{league}</strong></div>}
            </Field>
            <Field label={t("IFA Player Profile")} hint={t("Optional — his football.org.il profile page. Paste it once and leave it: the season in the link is ignored, so it never needs replacing, and it follows him to a new club or age group by itself. Drives match auto-sync for Israeli youth / women / lower leagues.")}>
              <input value={f('ifaTeamUrl')} onChange={e=>s('ifaTeamUrl')(e.target.value)}
                placeholder="https://www.football.org.il/players/player/?player_id=..." />
              {/* Team links from before this field expected a profile still
                  sync fine, but they track the club rather than the player. */}
              {/team_id=/.test(f('ifaTeamUrl')) && (
                <div className="form-hint" style={{ color: 'var(--amber)' }}>
                  {t("This is a team link. It works, but it stays with the club — swap it for his profile page and it will follow him if he moves.")}
                </div>
              )}
              {/* The profile page carries no team id, so the sync has to find
                  the squad by name once. Showing what it landed on turns that
                  from a silent guess into something you can check and correct. */}
              <IfaResolution ifa={form.autoFetch?.ifa}
                onPin={(url) => { s('ifaTeamUrl')(url); toast.success(t("Pinned to this team — no lookup from now on.")); }} />
            </Field>
            <div className="form-grid-2">
              <Field label={t("Contract Start")}><DateInput value={f('contractStart')} onChange={s('contractStart')} /></Field>
              <Field label={t("Contract End")}><DateInput value={f('contractEnd')} onChange={s('contractEnd')} /></Field>
            </div>
            {isLoan&&<Field label={t("Parent Club Contract End")}><DateInput value={f('loanParentEnd')} onChange={s('loanParentEnd')} /></Field>}
            <Field label={t("Contract File")}><FileUpload label={t("contract")} onUpload={(file,name,mode)=>handleFileUpload('contractFiles',file,name,mode)} history={form.contractFiles||[]} /></Field>
          </>)}

          <hr className="divider" />
          <div className="form-section-title">{t("Passport")}</div>
          <div className="form-grid-2">
            <Field label={t("Passport Number")}><input value={f('passportNumber')} onChange={e=>s('passportNumber')(e.target.value)} placeholder={t("Passport number")} /></Field>
            <Field label={t("Passport Expiry")}><DateInput value={f('passportExpiry')} onChange={s('passportExpiry')} /></Field>
          </div>
          <Field label={t("Passport File")}><FileUpload label={t("passport")} onUpload={(file,name,mode)=>handleFileUpload('passportFiles',file,name,mode)} history={form.passportFiles||[]} /></Field>

          <hr className="divider" />
          <div className="form-section-title">{t("Representation Agreement")}</div>
          <div className="form-grid-2">
            <Field label={t("Repr. Start")}><DateInput value={f('reprStart')} onChange={s('reprStart')} /></Field>
            <Field label={t("Repr. End")}><DateInput value={f('reprEnd')} onChange={s('reprEnd')} /></Field>
          </div>
          <Field label={t("Repr. Agreement File")}><FileUpload label={t("agreement")} onUpload={(file,name,mode)=>handleFileUpload('reprFiles',file,name,mode)} history={form.reprFiles||[]} /></Field>

          <hr className="divider" />
          <div className="form-grid-2">
            <Field label={t("Profile Link")} hint={t("Transfermarkt, Wyscout...")}><input value={f('profileLink')} onChange={e=>s('profileLink')(e.target.value)} placeholder="https://..." /></Field>
            <Field label={t("Video Link")} hint={t("YouTube, highlights...")}><input value={f('videoLink')} onChange={e=>s('videoLink')(e.target.value)} placeholder="https://..." /></Field>
          </div>
          <Field label={t("Notes")}><textarea value={f('notes')} onChange={e=>s('notes')(e.target.value)} placeholder={t("Additional notes...")} rows={3} /></Field>
        </Modal>
      )}

      {viewPlayer&&<PlayerView player={viewPlayer} onClose={()=>setViewPlayer(null)} />}
      {dialog}
    </div>
  );
}
