import React, { useState, useEffect } from 'react';
import { listenCollection, PATHS } from 'lib/db';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { calcAge, daysUntil, isBirthdaySoon, fmtDate } from 'lib/constants';
import { PageHeader } from 'components/ui/UI';
import { Link } from 'react-router-dom';
import { auth, USERS } from 'lib/firebase';

function KPI({ label, value, color, bg, to }) {
  const inner = (
    <div style={{
      background: bg || 'var(--card)',
      border: `1.5px solid ${color || 'var(--border)'}`,
      borderRadius: 16,
      padding: '0 16px 18px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-end',
      aspectRatio: '1 / 1',
      cursor: to ? 'pointer' : 'default',
      transition: 'all 0.2s',
      position: 'relative',
      overflow: 'hidden',
    }}
    onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-4px)';e.currentTarget.style.boxShadow=`0 8px 24px ${color||'rgba(201,168,76,0.2)'}44`;}}
    onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}
    >
      <div style={{
        fontFamily: 'Cormorant Garamond, serif',
        fontSize: 52, fontWeight: 700, lineHeight: 1,
        color: color || 'var(--gold)',
        textAlign: 'center',
        position: 'absolute',
        top: '30%', left: '50%',
        transform: 'translate(-50%, -50%)',
      }}>{value ?? 0}</div>
      <div style={{
        color: color || 'var(--text-3)',
        fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        textAlign: 'center', opacity: 0.8,
      }}>{label}</div>
    </div>
  );
  return to ? <Link to={to} style={{textDecoration:'none'}}>{inner}</Link> : inner;
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
  const [pipeAll, setPipeAll]     = useState([]);

  useEffect(() => {
    const u1 = listenCollection(PATHS.PLAYERS,          setPlayers,  'createdAt');
    const u2 = listenCollection(PATHS.CLUB_REQUIREMENTS,setReq,      'createdAt');
    const u3 = listenCollection(PATHS.MATCHES,          setMatches,  'date');
    let allPipe = {};
    const cats = ['men','women','youth','jewish'];
    const unsubs = cats.map(c =>
      listenCollection(PATHS[`PIPELINE_${c.toUpperCase()}`], (d) => {
        allPipe[c] = d;
        setPipeAll(Object.values(allPipe).flat());
      }, 'createdAt')
    );
    return () => { u1(); u2(); u3(); unsubs.forEach(u=>u()); };
  }, []);

  const user   = auth.currentUser;
  const info   = USERS[user?.email] || {};
  const now    = new Date();

  // Alerts
  const contractAlerts = players.filter(p => {
    if (!p.contractEndDate) return false;
    const d = daysUntil(p.contractEndDate);
    return d !== null && d >= 0 && d <= 60;
  });

  const reprAlerts = players.filter(p => {
    if (!p.reprEndDate) return false;
    const d = daysUntil(p.reprEndDate);
    return d !== null && d >= 0 && d <= 60;
  });

  const birthdays = players.filter(p => isBirthdaySoon(p.dob, 14));

  const upcomingMatches = matches
    .filter(m => new Date(m.date) >= now)
    .sort((a,b) => new Date(a.date)-new Date(b.date))
    .slice(0,5);

  const mandates  = pipeAll.filter(p => p.status === 'Mandate Received').length;
  const contracts = pipeAll.filter(p => p.status === 'Contract Signed').length;

  const alertCount = contractAlerts.length + reprAlerts.length + birthdays.length;

  return (
    <div>
      <PageHeader
        title={`Good day, ${info.name?.split(' ')[0] || 'Agent'}`}
        subtitle="Gold A&S Football Agency — Management Dashboard"
      />

      {/* KPI row */}
      <div className='kpi-grid' style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:12,marginBottom:20}}>
        <KPI label="Represented Players" color="#4ADE80" bg="rgba(74,222,128,0.08)"  value={players.length}  to="/players" />
        <KPI label="Club Requirements"   color="#60A5FA" bg="rgba(96,165,250,0.08)"  value={req.length}      to="/requirements" />
        <KPI label="Transfer Candidates" color="#A78BFA" bg="rgba(167,139,250,0.08)" value={pipeAll.length} />
        <KPI label="Active Mandates"     color="#4ADE80" bg="rgba(74,222,128,0.08)"  value={mandates} />
        <KPI label="Contracts Signed"    color="#C9A84C" bg="rgba(201,168,76,0.1)"   value={contracts} />
        <KPI label="Alerts"              color={alertCount>0?'var(--red)':'#6E9870'} bg={alertCount>0?'rgba(248,113,113,0.08)':'rgba(110,152,112,0.06)'} value={alertCount} to="/notifications" />
      </div>

      <div className='dashboard-panels' style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,width:'100%'}}>

        {/* Alerts panel */}
        <div className="card card-body">
          <div className="section-label" style={{marginBottom:14}}>🔔 Active Alerts</div>
          {alertCount === 0 ? (
            <p style={{color:'var(--text-3)',fontSize:13}}>No active alerts — all clear!</p>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {contractAlerts.map(p => {
                const d = daysUntil(p.contractEndDate);
                return (
                  <div key={p.id} className={`alert-row ${d<=7?'urgent':'warning'}`}>
                    <span style={{fontSize:16}}>📋</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:500}}>{p.fullName}</div>
                      <div style={{fontSize:11,color:'var(--text-3)'}}>Contract expires in {d} day{d!==1?'s':''} ({fmtDate(p.contractEndDate)})</div>
                    </div>
                  </div>
                );
              })}
              {reprAlerts.map(p => {
                const d = daysUntil(p.reprEndDate);
                return (
                  <div key={p.id+'r'} className={`alert-row ${d<=7?'urgent':'warning'}`}>
                    <span style={{fontSize:16}}>🤝</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:500}}>{p.fullName}</div>
                      <div style={{fontSize:11,color:'var(--text-3)'}}>Representation expires in {d} day{d!==1?'s':''}</div>
                    </div>
                  </div>
                );
              })}
              {birthdays.map(p => {
                const age = calcAge(p.dob);
                const turning18 = age === 17;
                return (
                  <div key={p.id+'b'} className="alert-row" style={turning18?{borderLeftColor:'var(--gold)',borderLeftWidth:3}:{}}>
                    <span style={{fontSize:16}}>{turning18?'⭐':'🎂'}</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:500}}>{p.fullName} {turning18?'— Turning 18!':''}</div>
                      <div style={{fontSize:11,color:'var(--text-3)'}}>Birthday in {daysUntil(p.dob?.replace(/^\d{4}/,new Date().getFullYear()))} days · Turning {(age||0)+1}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Upcoming matches */}
        <div className="card card-body">
          <div className="section-label" style={{marginBottom:14}}>🗓 Upcoming Matches</div>
          {upcomingMatches.length === 0 ? (
            <p style={{color:'var(--text-3)',fontSize:13}}>No upcoming matches scheduled.</p>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {upcomingMatches.map(m => (
                <div key={m.id} className="alert-row">
                  <span style={{fontSize:16}}>⚽</span>
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
          <div className="section-label" style={{marginBottom:14}}>👤 Recently Added Players</div>
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
