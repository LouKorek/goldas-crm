import React, { useState, useEffect } from 'react';
import { listenCollection, updateDoc_, PATHS } from 'lib/db';
import { calcAge, daysUntil, isBirthdaySoon, fmtDate } from 'lib/constants';
import { PageHeader, Modal, Field } from 'components/ui/UI';
import { toast } from 'components/ui/UI';

const DEFAULT_SETTINGS = {
  contractDays:   [7, 30, 60],
  reprDays:       [7, 30, 60],
  passportDays:   [30, 90, 180],
  birthdayDays:   [0, 3, 7],
};

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

  useEffect(() => {
    const u1 = listenCollection(PATHS.PLAYERS, setPlayers);
    const u2 = listenCollection(PATHS.MATCHES,  setMatches);
    // Load settings from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem('notif_settings') || 'null');
      if (saved) setSettings(saved);
    } catch(e) {}
    return () => { u1(); u2(); };
  }, []);

  const saveSettings = (s) => {
    setSettings(s);
    localStorage.setItem('notif_settings', JSON.stringify(s));
    setShowSettings(false);
    toast.success('Notification settings saved.');
  };

  const now = new Date();

  const makeAlerts = (players, dateField, daysSettings, makeCard) => {
    const alerts = [];
    players.forEach(p => {
      if (!p[dateField]) return;
      const d = daysUntil(p[dateField]);
      if (d === null) return;
      daysSettings.forEach(threshold => {
        if (d >= 0 && d <= threshold + 1) {
          const key = `${p.id}_${dateField}_${threshold}`;
          if (!alerts.find(a => a.key === key)) {
            alerts.push({ key, d, card: makeCard(p, d) });
          }
        }
      });
    });
    return alerts.sort((a,b) => a.d - b.d).map(a => a.card);
  };

  const contractAlerts = makeAlerts(players, 'contractEnd', settings.contractDays,
    (p,d) => ({
      id: p.id+'c'+d, icon:'📋', urgency: d<=7?'critical':d<=30?'warning':'info',
      title: `${p.fullName} — Contract expires in ${d===0?'today!':d+' days'}`,
      sub: `Expires: ${fmtDate(p.contractEnd)} · Club: ${p.currentClub||'—'}`,
    })
  );

  const reprAlerts = makeAlerts(players, 'reprEnd', settings.reprDays,
    (p,d) => ({
      id: p.id+'r'+d, icon:'🤝', urgency: d<=7?'critical':d<=30?'warning':'info',
      title: `${p.fullName} — Representation expires in ${d===0?'today!':d+' days'}`,
      sub: `Expires: ${fmtDate(p.reprEnd)}`,
    })
  );

  const passportAlerts = makeAlerts(players, 'passportExpiry', settings.passportDays,
    (p,d) => ({
      id: p.id+'p'+d, icon:'🛂', urgency: d<=30?'critical':d<=90?'warning':'info',
      title: `${p.fullName} — Passport expires in ${d===0?'today!':d+' days'}`,
      sub: `Expires: ${fmtDate(p.passportExpiry)}`,
    })
  );

  const birthdayAlerts = players
    .filter(p => isBirthdaySoon(p.dob, Math.max(...settings.birthdayDays, 7)))
    .map(p => {
      const age   = calcAge(p.dob);
      const birth = new Date(p.dob);
      const next  = new Date(now.getFullYear(), birth.getMonth(), birth.getDate());
      if (next < now) next.setFullYear(now.getFullYear()+1);
      const days = Math.ceil((next-now)/(1000*60*60*24));
      return { p, days, age: (age||0)+1 };
    })
    .filter(({ days }) => settings.birthdayDays.some(t => days <= t + 1))
    .sort((a,b) => a.days - b.days)
    .map(({ p, days, age }) => ({
      id: p.id+'b', icon: age===18?'⭐':'🎂',
      urgency: age===18?'gold': days===0?'critical':'info',
      title: `${p.fullName}${age===18?' — Turning 18! 🌟':''}`,
      sub: `Birthday ${days===0?'is today!':'in '+days+' days'} · Turning ${age}`,
      extra: `DOB: ${fmtDate(p.dob)}`,
    }));

  const upcomingMatches = matches
    .filter(m => new Date(m.date) >= now)
    .sort((a,b) => new Date(a.date)-new Date(b.date))
    .slice(0, 10);

  const total = contractAlerts.length + reprAlerts.length + passportAlerts.length + birthdayAlerts.length;

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
          <button className="btn btn-ghost" onClick={()=>setShowSettings(true)}>
            ⚙️ Alert Settings
          </button>
        }
      />

      {total===0 && upcomingMatches.length===0 ? (
        <div style={{textAlign:'center',padding:'64px 20px',color:'var(--text-3)'}}>
          <div style={{fontSize:48,marginBottom:16}}>✅</div>
          <p style={{fontSize:16}}>All clear — no active alerts!</p>
          <button className="btn btn-ghost" style={{marginTop:16}} onClick={()=>setShowSettings(true)}>
            Configure alert timing →
          </button>
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
