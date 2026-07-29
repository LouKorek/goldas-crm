import React, { useState, useEffect, useMemo } from 'react';
import { listenCollection, PATHS } from 'lib/db';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { calcAge, fmtDate } from 'lib/constants';
import { loadSettings, computeAlerts } from 'lib/alerts';
import { PageHeader } from 'components/ui/UI';
import { Link } from 'react-router-dom';
import { useRole } from 'lib/roleContext';

function KPI({ label, value, color, bg, to, onClick }) {
  const interactive = !!(to || onClick);
  const inner = (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderTop: `2px solid ${color || 'var(--gold-dk)'}`,
      borderRadius: 0,
      padding: '14px 16px 16px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      height: 112,
      cursor: interactive ? 'pointer' : 'default',
      transition: 'background 0.11s linear, border-color 0.11s linear',
      position: 'relative',
    }}
    onMouseEnter={e => {
      if (!interactive) return;
      e.currentTarget.style.background = 'var(--card-hover)';
      e.currentTarget.style.borderTopColor = color || 'var(--gold)';
    }}
    onMouseLeave={e => {
      e.currentTarget.style.background = 'var(--card)';
      e.currentTarget.style.borderTopColor = color || 'var(--gold-dk)';
    }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 34, fontWeight: 500, lineHeight: 1,
        letterSpacing: '-0.03em',
        color: color || 'var(--text-1)',
        fontVariantNumeric: 'tabular-nums',
      }}>{value ?? 0}</div>
      <div style={{
        color: 'var(--text-3)',
        fontSize: 9.5, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.14em',
      }}>{label}</div>
    </div>
  );
  if (to)      return <Link to={to} style={{ textDecoration: 'none' }}>{inner}</Link>;
  if (onClick) return <div onClick={onClick} style={{ cursor: 'pointer' }}>{inner}</div>;
  return inner;
}

// Drill-down panel shown in place of the KPI grid when an aggregate card is
// clicked. Shows per-category counts (Men / Women / Youth / Jewish) for the
// filter relevant to that KPI, with a back button and per-row navigation that
// pre-applies the matching status filter via a ?status=... URL param.
function DrillDown({ kind, pipeByCat, onBack }) {
  const config = {
    transfer:  { title: 'Transfer Candidates', color: '#A78BFA', bg: 'rgba(167,139,250,0.08)', filter: () => true,                              statusParam: '' },
    mandates:  { title: 'Active Mandates',     color: '#4ADE80', bg: 'rgba(74,222,128,0.08)',  filter: (p) => p.status === 'Mandate Received', statusParam: 'Mandate Received' },
    contracts: { title: 'Contracts Signed',    color: '#C9A84C', bg: 'rgba(201,168,76,0.10)',  filter: (p) => p.status === 'Contract Signed', statusParam: 'Contract Signed' },
  }[kind];
  if (!config) return null;
  const cats = [
    { key: 'men',    label: 'Men',    emoji: '🏃',   color: '#4ADE80' },
    { key: 'women',  label: 'Women',  emoji: '🏃‍♀️', color: '#F472B6' },
    { key: 'youth',  label: 'Youth',  emoji: '🌱',   color: '#60A5FA' },
    { key: 'jewish', label: 'Jewish', emoji: '✡️',  color: '#A78BFA' },
  ];
  const counts = cats.map(c => ({ ...c, count: (pipeByCat[c.key] || []).filter(config.filter).length }));
  const total = counts.reduce((s, c) => s + c.count, 0);

  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border)',
      borderTop: `2px solid ${config.color}`,
      borderRadius: 0,
      padding: '14px 18px 18px',
      marginBottom: 20,
      position: 'relative',
      animation: 'dd-in 0.18s cubic-bezier(0.2,0,0,1)',
    }}>
      <style>{`@keyframes dd-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, position: 'relative' }}>
        <button onClick={onBack}
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--border)',
            color: 'var(--text-1)',
            borderRadius: 0,
            padding: '6px 12px',
            fontSize: 12, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
        >← Back</button>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 14, fontWeight: 600, color: 'var(--text-1)',
          letterSpacing: '0.12em', textTransform: 'uppercase',
        }}>{config.title}</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 9.5, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
          Total <strong style={{ color: 'var(--text-1)', marginLeft: 6, fontSize: 14, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{total}</strong>
        </div>
      </div>

      <div className="drill-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, position: 'relative' }}>
        {counts.map(c => {
          const url = `/pipeline/${c.key}` + (config.statusParam ? `?status=${encodeURIComponent(config.statusParam)}` : '');
          return (
            <Link key={c.key} to={url}
              style={{
                textDecoration: 'none',
                background: 'var(--card)',
                border: '1px solid var(--border)',
                borderLeft: `2px solid ${c.color}`,
                borderRadius: 0,
                padding: '12px 14px 14px',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                minHeight: 84,
                transition: 'background 0.11s linear',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--card-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--card)'; }}
            >
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 28, fontWeight: 500, color: c.color, lineHeight: 1,
                letterSpacing: '-0.03em',
              }}>{c.count}</div>
              <div style={{
                fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.14em', color: 'var(--text-3)', marginTop: 10,
              }}>{c.label}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}


async function clearAllData() {
  if (!window.confirm('⚠️ DELETE ALL DATA? This cannot be undone.')) return;
  if (!window.confirm('Are you absolutely sure? ALL players, requirements, and matches will be deleted.')) return;
  const paths = Object.values({
    PLAYERS:'players', PIPELINE_MEN:'pipeline_men', PIPELINE_WOMEN:'pipeline_women',
    PIPELINE_YOUTH:'pipeline_youth', PIPELINE_JEWISH:'pipeline_jewish',
    CLUB_REQUIREMENTS:'club_requirements', MATCHES:'matches'
  });
  for (const path of paths) {
    const snap = await getDocs(collection(db, path));
    for (const d of snap.docs) await deleteDoc(d.ref);
  }
  window.location.reload();
}

export default function Dashboard() {
  const [players, setPlayers]     = useState([]);
  const [req, setReq]             = useState([]);
  const [matches, setMatches]     = useState([]);
  const [pipeByCat, setPipeByCat] = useState({ men: [], women: [], youth: [], jewish: [] });
  const [settings, setSettings]   = useState(null);
  const [drillDown, setDrillDown] = useState(null); // null | 'transfer' | 'mandates' | 'contracts'

  useEffect(() => {
    const u1 = listenCollection(PATHS.PLAYERS,          setPlayers,  'createdAt');
    const u2 = listenCollection(PATHS.CLUB_REQUIREMENTS,setReq,      'createdAt');
    const u3 = listenCollection(PATHS.MATCHES,          setMatches,  'date');
    loadSettings().then(setSettings);   // same settings the Notifications page + email script use
    const cats = ['men','women','youth','jewish'];
    const unsubs = cats.map(c =>
      listenCollection(PATHS[`PIPELINE_${c.toUpperCase()}`], (d) => {
        setPipeByCat(prev => ({ ...prev, [c]: d }));
      }, 'createdAt')
    );
    return () => { u1(); u2(); u3(); unsubs.forEach(u=>u()); };
  }, []);

  const pipeAll = useMemo(() => Object.values(pipeByCat).flat(), [pipeByCat]);

  const { name } = useRole();
  const now    = new Date();

  // Alerts — shared engine, identical to the Notifications page and email script.
  const alerts = computeAlerts(players, matches, settings, now);
  const contractAlerts = alerts.contract;
  const reprAlerts     = alerts.repr;
  const passportAlerts = alerts.passport;
  const birthdays      = alerts.birthday;
  const upcomingMatches = alerts.matches.slice(0, 5);

  const mandates  = pipeAll.filter(p => p.status === 'Mandate Received').length;
  const contracts = pipeAll.filter(p => p.status === 'Contract Signed').length;

  const alertCount = alerts.total;

  return (
    <div>
      <PageHeader
        title={`Good day, ${name?.split(' ')[0] || 'Agent'}`}
        subtitle="Gold A&S Football Agency — Management Dashboard"
      />

      {/* KPI row — or drill-down view if an aggregate KPI was clicked */}
      {drillDown ? (
        <DrillDown kind={drillDown} pipeByCat={pipeByCat} onBack={() => setDrillDown(null)} />
      ) : (
        <div className='kpi-grid' style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:12,marginBottom:20}}>
          <KPI label="Represented Players" color="#4ADE80"  value={players.length}  to="/players" />
          <KPI label="Club Requirements"   color="#60A5FA"  value={req.length}      to="/requirements" />
          <KPI label="Transfer Candidates" color="#A78BFA" value={pipeAll.length}  onClick={() => setDrillDown('transfer')} />
          <KPI label="Active Mandates"     color="#4ADE80"  value={mandates}        onClick={() => setDrillDown('mandates')} />
          <KPI label="Contracts Signed"    color="#C9A84C"   value={contracts}       onClick={() => setDrillDown('contracts')} />
          <KPI label="Alerts"              color={alertCount>0?'var(--red)':'#6E9870'} value={alertCount} to="/notifications" />
        </div>
      )}

      <div className='dashboard-panels' style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,width:'100%'}}>

        {/* Alerts panel */}
        <div className="card card-body">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <div className="section-label" style={{marginBottom:0}}>Active Alerts</div>
            {alertCount>0&&<Link to="/notifications" style={{fontSize:9.5,fontWeight:700,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--gold)',textDecoration:'none'}}>View all</Link>}
          </div>
          {alertCount === 0 ? (
            <p style={{color:'var(--text-3)',fontSize:12,letterSpacing:'0.06em',textTransform:'uppercase'}}>No active alerts</p>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {contractAlerts.map(a => (
                <div key={a.id+'c'} className={`alert-row ${a.days<=7?'urgent':'warning'}`}>
                  <span style={{fontFamily:'var(--font-mono)',fontSize:9,fontWeight:700,letterSpacing:'0.06em',color:'var(--text-mute)',flexShrink:0,width:24}}>CON</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>Contract expires in {a.days} day{a.days!==1?'s':''} ({fmtDate(a.player.contractEnd)})</div>
                  </div>
                </div>
              ))}
              {reprAlerts.map(a => (
                <div key={a.id+'r'} className={`alert-row ${a.days<=7?'urgent':'warning'}`}>
                  <span style={{fontFamily:'var(--font-mono)',fontSize:9,fontWeight:700,letterSpacing:'0.06em',color:'var(--text-mute)',flexShrink:0,width:24}}>REP</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>Representation expires in {a.days} day{a.days!==1?'s':''} ({fmtDate(a.player.reprEnd)})</div>
                  </div>
                </div>
              ))}
              {passportAlerts.map(a => (
                <div key={a.id+'p'} className={`alert-row ${a.days<=30?'urgent':'warning'}`}>
                  <span style={{fontFamily:'var(--font-mono)',fontSize:9,fontWeight:700,letterSpacing:'0.06em',color:'var(--text-mute)',flexShrink:0,width:24}}>PAS</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>Passport expires in {a.days} day{a.days!==1?'s':''} ({fmtDate(a.player.passportExpiry)})</div>
                  </div>
                </div>
              ))}
              {birthdays.map(a => (
                <div key={a.id+'b'} className="alert-row" style={a.turning18?{borderLeftColor:'var(--gold)',borderLeftWidth:3}:{}}>
                  <span style={{fontFamily:'var(--font-mono)',fontSize:9,fontWeight:700,letterSpacing:'0.06em',color:a.turning18?'var(--gold)':'var(--text-mute)',flexShrink:0,width:24}}>{a.turning18?'18':'DOB'}</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName} {a.turning18?'— Turning 18!':''}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>{a.days===0?'Birthday is today!':`Birthday in ${a.days} day${a.days!==1?'s':''}`} · Turning {a.age}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming matches */}
        <div className="card card-body">
          <div className="section-label" style={{marginBottom:14}}>Upcoming Matches</div>
          {upcomingMatches.length === 0 ? (
            <p style={{color:'var(--text-3)',fontSize:12,letterSpacing:'0.06em',textTransform:'uppercase'}}>No upcoming matches</p>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {upcomingMatches.map(m => (
                <div key={m.id} className="alert-row">
                  <span style={{fontFamily:'var(--font-mono)',fontSize:9,fontWeight:700,letterSpacing:'0.06em',color:'var(--text-mute)',flexShrink:0,width:24}}>FIX</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{m.homeTeam} vs {m.awayTeam}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>{fmtDate(m.date)} · {m.time} · {m.stadium}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{marginTop:12}}>
            <Link to="/matches" className="btn btn-ghost btn-sm" style={{textDecoration:'none'}}>View all matches →</Link>
          </div>
        </div>

        {/* Pipeline breakdown */}
        <div className="card card-body">
          <div className="section-label" style={{marginBottom:14}}>📊 Transfer Breakdown</div>
          {['Not Contacted','Waiting Response','Initial Talks','Mandate Received','Offered to Club','Negotiation','Draft Signed','Contract Signed','Not Relevant'].map(s => {
            const cnt = pipeAll.filter(p=>p.status===s).length;
            if (!cnt && !['Mandate Received','Contract Signed'].includes(s)) return null;
            return (
              <div key={s} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:'1px solid var(--border)'}}>
                <span style={{fontSize:12,color:'var(--text-2)'}}>{s}</span>
                <span style={{fontSize:13,fontWeight:500,color:cnt>0?'var(--text-1)':'var(--text-3)'}}>{cnt}</span>
              </div>
            );
          })}
        </div>

        {/* Recently added */}
        <div className="card card-body">
          <div className="section-label" style={{marginBottom:14}}>🤝 Recently Added Players</div>
          {players.slice(0,6).map(p => (
            <div key={p.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid var(--border)'}}>
              <div>
                <div style={{fontSize:13,fontWeight:500}}>{p.fullName}</div>
                <div style={{fontSize:11,color:'var(--text-3)'}}>{p.primaryPosition} · {p.currentClub||'Free'}</div>
              </div>
              <div style={{fontSize:11,color:'var(--text-3)'}}>{calcAge(p.dob)} yrs</div>
            </div>
          ))}
          {players.length === 0 && <p style={{color:'var(--text-3)',fontSize:13}}>No players added yet.</p>}
        </div>
      </div>
      <div style={{marginTop:48,paddingTop:16,borderTop:'1px solid var(--border)',textAlign:'center'}}>
        <button onClick={clearAllData}
          style={{background:'transparent',border:'none',color:'var(--text-3)',fontSize:11,cursor:'pointer',opacity:0.4}}
          onMouseEnter={e=>e.target.style.opacity='1'}
          onMouseLeave={e=>e.target.style.opacity='0.4'}>
          ⚠ Clear all data
        </button>
      </div>
    </div>
  );
}
