import React, { useState, useEffect } from 'react';
import { listenCollection, PATHS } from 'lib/db';
import { fmtDate } from 'lib/constants';
import { DEFAULT_SETTINGS, loadSettings, persistSettings, computeAlerts } from 'lib/alerts';
import { PageHeader, Modal } from 'components/ui/UI';
import { toast } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';

const ALL_OPTIONS = [0, 3, 7, 14, 30, 60, 90, 180];

function AlertCard({ icon, title, sub, urgency, extra }) {
  const colors = {
    critical: { border:'var(--red)',   bg:'rgba(248,113,113,0.06)' },
    warning:  { border:'var(--amber)', bg:'rgba(251,191,36,0.06)'  },
    info:     { border:'var(--blue)',  bg:'rgba(96,165,250,0.06)'  },
    gold:     { border:'var(--gold)',  bg:'var(--gold-dim)'        },
  };
  const c = colors[urgency] || colors.info;
  return (
    <div style={{
      background:c.bg, border:`1px solid ${c.border}`, borderLeft:`3px solid ${c.border}`,
      borderRadius:10, padding:'12px 16px', display:'flex', gap:12, alignItems:'flex-start',
      transition:'transform 0.15s',
    }}
    onMouseEnter={e=>e.currentTarget.style.transform='translateX(3px)'}
    onMouseLeave={e=>e.currentTarget.style.transform=''}>
      <span style={{fontSize:20,flexShrink:0}}>{icon}</span>
      <div style={{flex:1}}>
        <div style={{fontWeight:500,fontSize:14,color:'var(--text-1)'}}>{title}</div>
        {sub   && <div style={{fontSize:12,color:'var(--text-2)',marginTop:2}}>{sub}</div>}
        {extra && <div style={{fontSize:11,color:'var(--text-3)',marginTop:2}}>{extra}</div>}
      </div>
    </div>
  );
}

function SettingsModal({ settings, onSave, onClose }) {
  const [s, setS] = useState(settings);
  const toggle = (key, val) => {
    setS(prev => ({
      ...prev,
      [key]: prev[key].includes(val)
        ? prev[key].filter(v => v !== val)
        : [...prev[key], val].sort((a,b)=>a-b)
    }));
  };
  const label = (d) => d === 0 ? 'Same day' : `${d} days before`;

  return (
    <Modal title="Notification Settings" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={() => onSave(s)}>Save Settings</button>
    </>}>
      <p style={{color:'var(--text-2)',fontSize:13,marginBottom:20}}>
        Choose when to receive alerts for each category. Multiple values = multiple alerts.
      </p>

      {[
        { key:'contractDays',   label:'Contract Expiry' },
        { key:'reprDays',       label:'Representation Expiry' },
        { key:'passportDays',   label:'Passport Expiry' },
        { key:'birthdayDays',   label:'Player Birthdays' },
      ].map(({ key, label: lbl }) => (
        <div key={key} style={{marginBottom:20}}>
          <div className="form-label">{lbl}</div>
          <div className="chip-group">
            {ALL_OPTIONS.map(d => (
              <button key={d} type="button"
                className={`chip${s[key]?.includes(d)?' active':''}`}
                onClick={() => toggle(key, d)}>
                {label(d)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

export default function Notifications() {
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const { canEdit } = useRole();

  useEffect(() => {
    const u1 = listenCollection(PATHS.PLAYERS, setPlayers);
    const u2 = listenCollection(PATHS.MATCHES,  setMatches);
    loadSettings().then(setSettings);   // Firestore source of truth (shared with email script)
    return () => { u1(); u2(); };
  }, []);

  const saveSettings = (s) => {
    setSettings(s);
    persistSettings(s);            // localStorage + Firestore (read by the email script)
    setShowSettings(false);
    toast.success('Notification settings saved.');
  };

  const now = new Date();

  // Single shared engine — identical to the Dashboard and the email script.
  const alerts = computeAlerts(players, matches, settings, now);

  const contractAlerts = alerts.contract.map(a => ({
    id: a.id+'c', icon:'📋', urgency: a.urgency,
    title: `${a.player.fullName} — Contract expires in ${a.days===0?'today!':a.days+' days'}`,
    sub: `Expires: ${fmtDate(a.player.contractEnd)} · Club: ${a.player.currentClub||'—'}`,
  }));

  const reprAlerts = alerts.repr.map(a => ({
    id: a.id+'r', icon:'🤝', urgency: a.urgency,
    title: `${a.player.fullName} — Representation expires in ${a.days===0?'today!':a.days+' days'}`,
    sub: `Expires: ${fmtDate(a.player.reprEnd)}`,
  }));

  const passportAlerts = alerts.passport.map(a => ({
    id: a.id+'p', icon:'🛂', urgency: a.urgency,
    title: `${a.player.fullName} — Passport expires in ${a.days===0?'today!':a.days+' days'}`,
    sub: `Expires: ${fmtDate(a.player.passportExpiry)}`,
  }));

  const birthdayAlerts = alerts.birthday.map(a => ({
    id: a.id+'b', icon: a.turning18?'⭐':'🎂', urgency: a.urgency,
    title: `${a.player.fullName}${a.turning18?' — Turning 18! 🌟':''}`,
    sub: `Birthday ${a.days===0?'is today!':'in '+a.days+' days'} · Turning ${a.age}`,
    extra: `DOB: ${fmtDate(a.player.dob)}`,
  }));

  const upcomingMatches = alerts.matches.slice(0, 10);
  const total = alerts.total;

  const Section = ({ title, items, icon }) => {
    if (!items.length) return null;
    return (
      <div>
        <div className="section-label" style={{marginBottom:12}}>{icon} {title} ({items.length})</div>
        <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {items.map(a => <AlertCard key={a.id} {...a} />)}
        </div>
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle={`${total} active alert${total!==1?'s':''}`}
        action={
          canEdit ? (
            <button className="btn btn-ghost" onClick={()=>setShowSettings(true)}>
              ⚙️ Alert Settings
            </button>
          ) : null
        }
      />

      {total===0 && upcomingMatches.length===0 ? (
        <div style={{textAlign:'center',padding:'64px 20px',color:'var(--text-3)'}}>
          <div style={{fontSize:48,marginBottom:16}}>✅</div>
          <p style={{fontSize:16}}>All clear — no active alerts!</p>
          {canEdit && (
            <button className="btn btn-ghost" style={{marginTop:16}} onClick={()=>setShowSettings(true)}>
              Configure alert timing →
            </button>
          )}
        </div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:28}}>
          <Section title="Contract Expiry"       items={contractAlerts}  icon="📋" />
          <Section title="Representation Expiry" items={reprAlerts}       icon="🤝" />
          <Section title="Passport Expiry"       items={passportAlerts}  icon="🛂" />
          <Section title="Upcoming Birthdays"    items={birthdayAlerts}  icon="🎂" />

          {upcomingMatches.length > 0 && (
            <div>
              <div className="section-label" style={{marginBottom:12}}>🏟 Upcoming Matches ({upcomingMatches.length})</div>
              <div style={{display:'flex',flexDirection:'column',gap:8}}>
                {upcomingMatches.map(m => {
                  const days = Math.ceil((new Date(m.date)-now)/(1000*60*60*24));
                  return (
                    <AlertCard key={m.id} icon="⚽"
                      title={`${m.homeTeam} vs ${m.awayTeam}`}
                      sub={`${fmtDate(m.date)}${m.time?' · '+m.time:''} · ${days===0?'Today!':days+' day'+( days!==1?'s':'')}`}
                      extra={m.stadiumName ? `📍 ${m.stadiumName}` : undefined}
                      urgency={days===0?'critical':days<=3?'warning':'info'}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={()=>setShowSettings(false)}
        />
      )}
    </div>
  );
}
