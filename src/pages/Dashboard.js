import React, { useState, useEffect } from 'react';
import { listenCollection, PATHS } from 'lib/db';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { calcAge, fmtDate } from 'lib/constants';
import { loadSettings, computeAlerts } from 'lib/alerts';
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
      transition: 'transform 0.22s cubic-bezier(0.16,1,0.3,1), box-shadow 0.22s, border-color 0.22s',
      position: 'relative',
      overflow: 'hidden',
    }}
    onMouseEnter={e => {
      e.currentTarget.style.transform = 'translateY(-4px)';
      e.currentTarget.style.boxShadow = `0 12px 32px ${color || 'rgba(201,168,76,0.25)'}55, 0 0 0 1px ${color || 'rgba(201,168,76,0.35)'} inset`;
    }}
    onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
    >
      {/* Subtle radial glow */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: `radial-gradient(circle at 50% 18%, ${color || 'rgba(201,168,76,0.4)'}22 0%, transparent 55%)`,
      }} />
      <div style={{
        fontFamily: 'Cormorant Garamond, serif',
        fontSize: 52, fontWeight: 700, lineHeight: 1,
        color: color || 'var(--gold)',
        textAlign: 'center',
        position: 'absolute',
        top: '30%', left: '50%',
        transform: 'translate(-50%, -50%)',
        textShadow: `0 0 22px ${color || 'rgba(201,168,76,0.4)'}33`,
      }}>{value ?? 0}</div>
      <div style={{
        color: color || 'var(--text-3)',
        fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        textAlign: 'center', opacity: 0.85,
        position: 'relative', zIndex: 1,
      }}>{label}</div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{inner}</Link> : inner;
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
  const [settings, setSettings]   = useState(null);

  useEffect(() => {
    const u1 = listenCollection(PATHS.PLAYERS,          setPlayers,  'createdAt');
    const u2 = listenCollection(PATHS.CLUB_REQUIREMENTS,setReq,      'createdAt');
    const u3 = listenCollection(PATHS.MATCHES,          setMatches,  'date');
    loadSettings().then(setSettings);   // same settings the Notifications page + email script use
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
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
            <div className="section-label" style={{marginBottom:0}}>🔔 Active Alerts</div>
            {alertCount>0&&<Link to="/notifications" style={{fontSize:11,color:'var(--gold)',textDecoration:'none',opacity:0.8}}>View all →</Link>}
          </div>
          {alertCount === 0 ? (
            <p style={{color:'var(--text-3)',fontSize:13}}>No active alerts — all clear! ✅</p>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {contractAlerts.map(a => (
                <div key={a.id+'c'} className={`alert-row ${a.days<=7?'urgent':'warning'}`}>
                  <span style={{fontSize:16}}>📋</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>Contract expires in {a.days} day{a.days!==1?'s':''} ({fmtDate(a.player.contractEnd)})</div>
                  </div>
                </div>
              ))}
              {reprAlerts.map(a => (
                <div key={a.id+'r'} className={`alert-row ${a.days<=7?'urgent':'warning'}`}>
                  <span style={{fontSize:16}}>🤝</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>Representation expires in {a.days} day{a.days!==1?'s':''} ({fmtDate(a.player.reprEnd)})</div>
                  </div>
                </div>
              ))}
              {passportAlerts.map(a => (
                <div key={a.id+'p'} className={`alert-row ${a.days<=30?'urgent':'warning'}`}>
                  <span style={{fontSize:16}}>🛂</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:500}}>{a.player.fullName}</div>
                    <div style={{fontSize:11,color:'var(--text-3)'}}>Passport expires in {a.days} day{a.days!==1?'s':''} ({fmtDate(a.player.passportExpiry)})</div>
                  </div>
                </div>
              ))}
              {birthdays.map(a => (
                <div key={a.id+'b'} className="alert-row" style={a.turning18?{borderLeftColor:'var(--gold)',borderLeftWidth:3}:{}}>
                  <span style={{fontSize:16}}>{a.turning18?'⭐':'🎂'}</span>
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
