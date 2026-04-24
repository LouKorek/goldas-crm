import React, { useState, useEffect, useRef } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { TIME_SLOTS, fmtDate } from 'lib/constants';
import { Modal, Field, DateInput, PageHeader, Empty, Spinner, useConfirm, SearchInput , ActionButtons } from 'components/ui/UI';
import { toast } from 'components/ui/UI';



// ── Searchable multi-select for linked players ────────────────────
function LinkedPlayersSelect({ players, value = [], onChange }) {
  const [q, setQ] = React.useState('');
  const filtered = q
    ? players.filter(p => p.fullName.toLowerCase().includes(q.toLowerCase()) || (p.primaryPosition||'').toLowerCase().includes(q.toLowerCase()))
    : players;
  const toggle = (id) => {
    onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  };
  const selected = players.filter(p => value.includes(p.id));
  return (
    <div>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Type to search players..."
        style={{marginBottom:6}}
      />
      {selected.length > 0 && (
        <div style={{display:'flex',flexWrap:'wrap',gap:5,marginBottom:8}}>
          {selected.map(p => (
            <span key={p.id} style={{
              background:'var(--gold-dim)',border:'1px solid var(--gold)',
              borderRadius:6,padding:'3px 8px',fontSize:12,color:'var(--gold)',
              display:'flex',alignItems:'center',gap:5
            }}>
              {p.fullName}
              <button type="button" onClick={() => toggle(p.id)}
                style={{background:'none',border:'none',color:'var(--gold)',cursor:'pointer',padding:0,fontSize:14,lineHeight:1}}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{border:'1px solid var(--border)',borderRadius:8,maxHeight:160,overflowY:'auto',background:'var(--input-bg)'}}>
        {filtered.length === 0
          ? <div style={{padding:'10px 12px',color:'var(--text-3)',fontSize:12}}>No players found.</div>
          : filtered.map(p => {
            const sel = value.includes(p.id);
            return (
              <div key={p.id} onClick={() => toggle(p.id)}
                style={{padding:'8px 12px',cursor:'pointer',display:'flex',gap:10,alignItems:'center',
                  background:sel?'var(--gold-dim)':'transparent',transition:'background 0.12s'}}>
                <input type="checkbox" readOnly checked={sel}
                  style={{accentColor:'var(--gold)',width:14,height:14,pointerEvents:'none'}} />
                <span style={{color:sel?'var(--gold)':'var(--text-2)',fontSize:13,flex:1}}>{p.fullName}</span>
                <span style={{color:'var(--text-3)',fontSize:11}}>{p.primaryPosition||''}</span>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

const EMPTY = {
  date:'', time:'', homeTeam:'', awayTeam:'',
  stadiumName:'', stadiumPlaceId:'', stadiumMapsUrl:'', notes:'', linkedPlayers:[],
};

// Google Maps Places Autocomplete for stadium
function StadiumInput({ value, onSelect }) {
  const [q, setQ]         = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen]   = useState(false);
  const [loading, setLoading] = useState(false);
  const ref               = useRef();
  const timerRef          = useRef();

  useEffect(() => { setQ(value || ''); }, [value]);

  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const search = (text) => {
    setQ(text);
    if (!text.trim()) { setResults([]); setOpen(false); return; }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        // Use Google Maps Places API via fetch
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text)}&types=stadium|establishment&key=MAPS_API_KEY`
        );
        // Since we can't use server-side API key here, use a workaround:
        // Open a Google Maps search URL when clicked
        setResults([{ description: text, isManual: true }]);
        setOpen(true);
      } catch(e) {
        setResults([{ description: text, isManual: true }]);
        setOpen(true);
      }
      setLoading(false);
    }, 400);
  };

  const select = (r) => {
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(r.description)}`;
    onSelect({ name: r.description, mapsUrl, placeId: r.place_id || '' });
    setQ(r.description);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{position:'relative'}}>
      <input
        value={q}
        onChange={e => search(e.target.value)}
        onFocus={() => q && setOpen(true)}
        placeholder="Type stadium name..."
      />
      {open && results.length > 0 && (
        <div style={{
          position:'absolute',top:'100%',left:0,right:0,zIndex:50,
          background:'var(--surface-2)',border:'1px solid var(--border-2)',
          borderRadius:'var(--radius-md)',boxShadow:'var(--shadow-md)',marginTop:2,
        }}>
          {results.map((r,i) => (
            <div key={i}
              onMouseDown={() => select(r)}
              style={{
                padding:'10px 12px',cursor:'pointer',fontSize:13,
                color:'var(--text-2)',display:'flex',alignItems:'center',gap:8,
                transition:'background 0.12s',
              }}
              onMouseEnter={e=>e.currentTarget.style.background='var(--gold-dim)'}
              onMouseLeave={e=>e.currentTarget.style.background=''}
            >
              <span>📍</span>
              <div>
                <div style={{color:'var(--text-1)'}}>{r.description}</div>
                <div style={{fontSize:11,color:'var(--text-3)'}}>
                  {r.isManual ? 'Search on Google Maps' : r.structured_formatting?.secondary_text || ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


async function clearAll_matches() {
  if (!window.confirm('Delete ALL matches? This cannot be undone.')) return;
  const snap = await getDocs(collection(db, 'matches'));
  for (const d of snap.docs) await deleteDoc(d.ref);
  window.location.reload();
}
export default function Matches() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);
  const [form, setForm]       = useState(EMPTY);
  const [saving, setSaving]   = useState(false);
  const [search, setSearch]   = useState('');
  const { confirm, dialog }   = useConfirm();

  const [allPlayers, setAllPlayers] = useState([]);
  useEffect(() => {
    listenCollection(PATHS.PLAYERS, setAllPlayers);
  }, []);
  useEffect(() => {
    return listenCollection(PATHS.MATCHES, (data) => {
      setItems(data.sort((a,b) => (a.date||'') > (b.date||'') ? 1 : -1));
      setLoading(false);
    });
  }, []);

  const s = (k) => (v) => { setForm(p => ({...p,[k]:v})); setIsDirty(true); };
  const f = (k) => form[k] ?? '';

  const openAdd  = () => { setForm({...EMPTY}); setModal('add'); setIsDirty(false); };
  const openEdit = (p) => { setForm({...EMPTY,...p}); setModal({edit:p}); setIsDirty(false); };

  const save = async () => {
    if (!form.homeTeam || !form.awayTeam) { toast.error('Home and away teams are required.'); return; }
    if (!form.date) { toast.error('Date is required.'); return; }
    if (!form.linkedPlayers || form.linkedPlayers.length === 0) { toast.error('Please link at least one represented player.'); return; }
    setSaving(true);
    try {
      if (modal==='add') {
        await addDoc_(PATHS.MATCHES, form);
        toast.success('Match added!');
      } else {
        await updateDoc_(PATHS.MATCHES, modal.edit.id, form);
        toast.success('Match updated.');
      }
      setModal(null);
    } catch(e) {
      toast.error(e.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const del = async (p) => {
    const ok = await confirm(`Delete match "${p.homeTeam} vs ${p.awayTeam}"?`);
    if (!ok) return;
    await deleteDoc_(PATHS.MATCHES, p.id);
    toast.success('Deleted.');
  };

  const now  = new Date();
  const data = items.filter(m => {
    if (!search) return true;
    return `${m.homeTeam} ${m.awayTeam} ${m.stadiumName}`.toLowerCase().includes(search.toLowerCase());
  });
  const upcoming = data.filter(m => !m.date || new Date(m.date) >= now);
  const past     = data.filter(m => m.date && new Date(m.date) < now);

  const MatchCard = ({ m }) => (
    <div className="card card-body" style={{marginBottom:10,transition:'all 0.18s'}}
      onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--border-2)';e.currentTarget.style.transform='translateX(2px)';}}
      onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.transform='';}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap'}}>
        <div>
          <div style={{fontWeight:600,fontSize:15,marginBottom:5}}>
            <span style={{color:'var(--text-1)'}}>{m.homeTeam}</span>
            <span style={{color:'var(--text-3)',fontWeight:400,margin:'0 10px'}}>vs</span>
            <span style={{color:'var(--text-1)'}}>{m.awayTeam}</span>
          </div>
          <div style={{fontSize:12,color:'var(--text-2)',display:'flex',gap:16,flexWrap:'wrap',alignItems:'center'}}>
            <span>🗓 {fmtDate(m.date)}{m.time ? ' · ' + m.time : ''}</span>
            {m.stadiumName && (
              <span style={{display:'flex',alignItems:'center',gap:4}}>
                🏟
                {m.stadiumMapsUrl ? (
                  <a href={m.stadiumMapsUrl} target="_blank" rel="noopener noreferrer"
                    style={{color:'var(--gold)',textDecoration:'none'}}
                    onMouseEnter={e=>e.target.style.textDecoration='underline'}
                    onMouseLeave={e=>e.target.style.textDecoration='none'}>
                    {m.stadiumName} ↗
                  </a>
                ) : m.stadiumName}
              </span>
            )}
          </div>
          {m.notes && <div style={{fontSize:12,color:'var(--text-3)',marginTop:5}}>{m.notes}</div>}
        </div>
        <ActionButtons onEdit={()=>openEdit(m)} onDelete={()=>del(m)} />
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Matches"
        subtitle={`${items.length} match${items.length!==1?'es':''} total`}
        action={
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <button className="btn btn-primary" onClick={openAdd} style={{height:36}}>+ Add Match</button>
            <div style={{height:36,display:'flex',alignItems:'center'}}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
            </div>
            <button className="btn btn-danger btn-sm" onClick={clearAll_matches}
              style={{height:36,opacity:0.45,whiteSpace:'nowrap'}} title="Clear all"
              onMouseEnter={e=>e.currentTarget.style.opacity='1'}
              onMouseLeave={e=>e.currentTarget.style.opacity='0.45'}>
              🗑 Clear All
            </button>
          </div>
        }
      >
        <div style={{marginTop:14,height:38}} />
      </PageHeader>

      {loading ? (
        <div style={{display:'flex',justifyContent:'center',padding:60}}><Spinner size={36}/></div>
      ) : items.length===0 ? (
        <Empty icon="🏟" message="No matches scheduled."
          action={!search&&<button className="btn btn-primary" onClick={openAdd}>+ Add Match</button>} />
      ) : (
        <>
          {upcoming.length > 0 && (
            <div style={{marginBottom:28}}>
              <div className="section-label" style={{marginBottom:12}}>Upcoming ({upcoming.length})</div>
              {upcoming.map(m => <MatchCard key={m.id} m={m} />)}
            </div>
          )}
          {past.length > 0 && (
            <div>
              <div className="section-label" style={{marginBottom:12,color:'var(--text-3)'}}>Past ({past.length})</div>
              <div style={{opacity:0.65}}>
                {[...past].reverse().slice(0,10).map(m => <MatchCard key={m.id} m={m} />)}
              </div>
            </div>
          )}
        </>
      )}

      {modal && (
        <Modal
          title={modal==='add' ? 'Add Match' : 'Edit Match'}
          onClose={()=>setModal(null)} isDirty={isDirty}
          footer={<>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="spinner" style={{width:14,height:14}}/> Saving...</> : 'Save Match'}
            </button>
          </>}
        >
          <div className="form-grid-2">
            <Field label="Date" required>
              <DateInput value={f('date')} onChange={s('date')} />
            </Field>
            <Field label="Time">
              <select value={f('time')} onChange={e=>s('time')(e.target.value)}>
                <option value="">Select time...</option>
                {TIME_SLOTS.map(t=><option key={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <div className="form-grid-2">
            <Field label="Home Team" required>
              <input value={f('homeTeam')} onChange={e=>s('homeTeam')(e.target.value)} placeholder="Home team name" />
            </Field>
            <Field label="Away Team" required>
              <input value={f('awayTeam')} onChange={e=>s('awayTeam')(e.target.value)} placeholder="Away team name" />
            </Field>
          </div>
          <Field label="Stadium" hint="Type to search — clicking the result creates a navigable link">
            <StadiumInput
              value={f('stadiumName')}
              onSelect={({ name, mapsUrl, placeId }) => {
                s('stadiumName')(name);
                s('stadiumMapsUrl')(mapsUrl);
                s('stadiumPlaceId')(placeId);
              }}
            />
            {form.stadiumMapsUrl && (
              <div style={{marginTop:4,fontSize:11,color:'var(--text-3)'}}>
                ✓ Will link to Google Maps
                <a href={form.stadiumMapsUrl} target="_blank" rel="noopener noreferrer"
                  style={{color:'var(--gold)',marginLeft:8,textDecoration:'none'}}>Preview ↗</a>
              </div>
            )}
          </Field>
          <Field label="Linked Players" required hint="Required — type to search">
            <LinkedPlayersSelect
              players={allPlayers}
              value={f('linkedPlayers')||[]}
              onChange={s('linkedPlayers')}
            />
          </Field>
          <Field label="Notes">
            <textarea value={f('notes')} onChange={e=>s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} />
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
