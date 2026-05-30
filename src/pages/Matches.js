import React, { useState, useEffect, useRef } from 'react';
import { collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, PATHS } from 'lib/db';
import { TIME_SLOTS, fmtDate } from 'lib/constants';
import { Modal, Field, DateInput, PageHeader, Empty, Spinner, useConfirm, SearchInput, ActionButtons, ChipGroup } from 'components/ui/UI';
import { toast } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';

// ── Google Maps loader (loads once) ──────────────────────────────
let _mapsPromise = null;
function loadGoogleMaps() {
  if (window.google?.maps?.places) return Promise.resolve(true);
  if (_mapsPromise) return _mapsPromise;
  const key = process.env.REACT_APP_GOOGLE_MAPS_KEY;
  if (!key || key === 'YOUR_GOOGLE_MAPS_API_KEY_HERE') return Promise.resolve(false);
  _mapsPromise = new Promise((resolve) => {
    const cb = '__gmInit' + Date.now();
    window[cb] = () => { resolve(true); delete window[cb]; };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=${cb}`;
    s.onerror = () => { _mapsPromise = null; resolve(false); };
    document.head.appendChild(s);
  });
  return _mapsPromise;
}

// ── Team logo (TheSportsDB, free, no key) ────────────────────────
const _logoCache = {};
async function fetchTeamLogo(name) {
  const k = name.trim().toLowerCase();
  if (k in _logoCache) return _logoCache[k];
  try {
    const r = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(name.trim())}`
    );
    const d = await r.json();
    _logoCache[k] = d?.teams?.[0]?.strTeamBadge || null;
  } catch {
    _logoCache[k] = null;
  }
  return _logoCache[k];
}

function TeamLogo({ name, size = 24 }) {
  const [url, setUrl] = useState(() => {
    const k = (name || '').trim().toLowerCase();
    return k in _logoCache ? _logoCache[k] : undefined;
  });
  useEffect(() => {
    if (!name || name.trim().length < 2) { setUrl(null); return; }
    const k = name.trim().toLowerCase();
    if (k in _logoCache) { setUrl(_logoCache[k]); return; }
    setUrl(undefined);
    const t = setTimeout(async () => {
      const logo = await fetchTeamLogo(name);
      setUrl(logo);
    }, 900);
    return () => clearTimeout(t);
  }, [name]);
  if (!url) return null;
  return (
    <img src={url} alt={name} title={name}
      style={{ width: size, height: size, objectFit: 'contain', borderRadius: 3, flexShrink: 0 }}
      onError={e => { e.currentTarget.style.display = 'none'; }} />
  );
}

// ── Stadium autocomplete (Google Places or simple fallback) ──────
function StadiumInput({ value, onSelect }) {
  const [q, setQ]         = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen]   = useState(false);
  const [ready, setReady] = useState(false);
  const ref               = useRef();
  const serviceRef        = useRef(null);
  const timerRef          = useRef();

  useEffect(() => {
    loadGoogleMaps().then(ok => {
      if (ok) {
        serviceRef.current = new window.google.maps.places.AutocompleteService();
        setReady(true);
      }
    });
  }, []);

  useEffect(() => { setQ(value || ''); }, [value]);

  useEffect(() => {
    const h = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const search = text => {
    setQ(text);
    clearTimeout(timerRef.current);
    if (!text.trim()) { setResults([]); setOpen(false); return; }

    timerRef.current = setTimeout(() => {
      if (serviceRef.current) {
        serviceRef.current.getPlacePredictions(
          { input: text, types: ['establishment', 'stadium'] },
          (predictions, status) => {
            if (status === 'OK' && predictions?.length) {
              setResults(predictions.map(p => ({
                description: p.description,
                placeId: p.place_id,
                main: p.structured_formatting?.main_text || p.description,
                secondary: p.structured_formatting?.secondary_text || '',
              })));
              setOpen(true);
            } else {
              setResults([{ description: text, placeId: '', main: text, secondary: 'Search on Google Maps', isManual: true }]);
              setOpen(true);
            }
          }
        );
      } else {
        // No API key — just build a search URL
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(text)}`;
        onSelect({ name: text, mapsUrl, placeId: '' });
      }
    }, 350);
  };

  const select = r => {
    const mapsUrl = r.placeId
      ? `https://www.google.com/maps/place/?q=place_id:${r.placeId}`
      : `https://www.google.com/maps/search/${encodeURIComponent(r.description)}`;
    onSelect({ name: r.description, mapsUrl, placeId: r.placeId || '' });
    setQ(r.description);
    setOpen(false);
    setResults([]);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input value={q} onChange={e => search(e.target.value)}
        onFocus={() => q && results.length && setOpen(true)}
        placeholder={ready ? 'Type stadium or venue — Google Maps suggestions…' : 'Type stadium name…'} />
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: 'var(--surface-2)', border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', marginTop: 2,
        }}>
          {results.map((r, i) => (
            <div key={i} onMouseDown={() => select(r)}
              style={{ padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 10, transition: 'background 0.12s' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--gold-dim)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}>
              <span style={{ fontSize: 14, marginTop: 1 }}>📍</span>
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 500 }}>{r.main}</div>
                {r.secondary && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{r.secondary}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Youth badge ──────────────────────────────────────────────────
function YouthBadge({ small }) {
  return (
    <span style={{
      background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.3)',
      borderRadius: 4, color: '#4ADE80', fontSize: small ? 9 : 11,
      fontWeight: 700, padding: small ? '1px 5px' : '2px 7px',
      letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0,
    }}>U19</span>
  );
}

// ── Searchable multi-select for linked players ───────────────────
function LinkedPlayersSelect({ players, value = [], onChange }) {
  const [q, setQ] = React.useState('');
  const filtered  = q
    ? players.filter(p => p.fullName.toLowerCase().includes(q.toLowerCase()) || (p.primaryPosition || '').toLowerCase().includes(q.toLowerCase()))
    : players;
  const toggle   = id => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  const selected = players.filter(p => value.includes(p.id));
  return (
    <div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Type to search players…" style={{ marginBottom: 6 }} />
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {selected.map(p => (
            <span key={p.id} style={{ background: 'var(--gold-dim)', border: '1px solid var(--gold)', borderRadius: 6, padding: '3px 8px', fontSize: 12, color: 'var(--gold)', display: 'flex', alignItems: 'center', gap: 5 }}>
              {p.fullName}
              <button type="button" onClick={() => toggle(p.id)} style={{ background: 'none', border: 'none', color: 'var(--gold)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 160, overflowY: 'auto', background: 'var(--input-bg)' }}>
        {filtered.length === 0
          ? <div style={{ padding: '10px 12px', color: 'var(--text-3)', fontSize: 12 }}>No players found.</div>
          : filtered.map(p => {
            const sel = value.includes(p.id);
            return (
              <div key={p.id} onClick={() => toggle(p.id)}
                style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center', background: sel ? 'var(--gold-dim)' : 'transparent', transition: 'background 0.12s' }}>
                <input type="checkbox" readOnly checked={sel} style={{ accentColor: 'var(--gold)', width: 14, height: 14, pointerEvents: 'none' }} />
                <span style={{ color: sel ? 'var(--gold)' : 'var(--text-2)', fontSize: 13, flex: 1 }}>{p.fullName}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{p.primaryPosition || ''}</span>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

const EMPTY = {
  date: '', time: '', homeTeam: '', homeTeamIsYouth: false, awayTeam: '', awayTeamIsYouth: false,
  stadiumName: '', stadiumPlaceId: '', stadiumMapsUrl: '', notes: '', linkedPlayers: [],
  source: 'manual', sourceMatchId: '', sourceTeamId: '', season: '',
};

// ── Source badge for the match card ──────────────────────────────
const SOURCE_BADGE = {
  manual:    { label: 'Manual',           icon: '✋', color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.04)' },
  ifa:       { label: 'Auto · IFA',       icon: '🤖', color: '#60A5FA', bg: 'rgba(96,165,250,0.10)' },
  '365':     { label: 'Auto · 365',       icon: '🤖', color: '#C9A84C', bg: 'rgba(201,168,76,0.12)' },
  sofascore: { label: 'Auto · SofaScore', icon: '🤖', color: '#A78BFA', bg: 'rgba(167,139,250,0.10)' },
};
function SourceBadge({ source }) {
  const c = SOURCE_BADGE[source || 'manual'] || SOURCE_BADGE.manual;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: c.bg, color: c.color,
      border: `1px solid ${c.color}55`,
      borderRadius: 4, padding: '2px 7px',
      fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 11 }}>{c.icon}</span> {c.label}
    </span>
  );
}

// ── View modes + range helpers ───────────────────────────────────
const VIEW_OPTIONS = ['Schedule', 'Day', '3 Day', 'Week', 'Month'];
const startOfDay  = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays     = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }; // Sunday-start
const startOfMonth = (d) => { const x = startOfDay(d); x.setDate(1); return x; };

// Returns [start, endExclusive] for the active view, or null for "Schedule".
function getRange(view, anchor) {
  const a = startOfDay(anchor);
  if (view === 'Day')   return [a, addDays(a, 1)];
  if (view === '3 Day') return [a, addDays(a, 3)];
  if (view === 'Week')  { const s = startOfWeek(a); return [s, addDays(s, 7)]; }
  if (view === 'Month') { const s = startOfMonth(a); return [s, new Date(s.getFullYear(), s.getMonth() + 1, 1)]; }
  return null;
}
function getRangeLabel(view, anchor) {
  const r = getRange(view, anchor);
  if (!r) return '';
  const [s, e] = r;
  const end = addDays(e, -1);
  if (view === 'Day')   return s.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  if (view === 'Month') return s.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const sameYr = s.getFullYear() === end.getFullYear();
  return `${s.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${end.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: sameYr ? undefined : 'numeric' })}`;
}

// ── Players multi-select filter (search + checkbox list inside a popover) ──
function PlayersFilter({ allPlayers, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ]       = useState('');
  const ref             = useRef();

  useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const filtered = q
    ? allPlayers.filter(p => (p.fullName || '').toLowerCase().includes(q.toLowerCase()))
    : allPlayers;
  const toggle = (id) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  const clear  = () => onChange([]);
  const selectedCount = value.length;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{
          height: 36, padding: '0 12px', borderRadius: 8,
          background: selectedCount ? 'var(--gold-dim)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${selectedCount ? 'var(--gold)' : 'var(--border)'}`,
          color: selectedCount ? 'var(--gold)' : 'var(--text-2)',
          fontSize: 13, fontWeight: 500, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
        }}>
        👤 {selectedCount ? `Players (${selectedCount})` : 'All Players'} <span style={{ opacity: 0.6, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          width: 280, zIndex: 60,
          background: 'var(--surface-2)',
          border: '1px solid var(--border-2)',
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          padding: 10,
        }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players…" autoFocus
            style={{ width: '100%', marginBottom: 8 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {selectedCount ? `${selectedCount} selected` : 'None selected'}
            </div>
            {selectedCount > 0 && (
              <button type="button" onClick={clear}
                style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>
                Clear all
              </button>
            )}
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--input-bg)' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: '10px 12px', color: 'var(--text-3)', fontSize: 12 }}>No players found.</div>
            ) : filtered.map(p => {
              const sel = value.includes(p.id);
              return (
                <div key={p.id} onClick={() => toggle(p.id)}
                  style={{ padding: '7px 10px', cursor: 'pointer', display: 'flex', gap: 9, alignItems: 'center', background: sel ? 'var(--gold-dim)' : 'transparent' }}>
                  <input type="checkbox" readOnly checked={sel} style={{ accentColor: 'var(--gold)', width: 14, height: 14, pointerEvents: 'none' }} />
                  <span style={{ color: sel ? 'var(--gold)' : 'var(--text-2)', fontSize: 13, flex: 1 }}>{p.fullName}</span>
                  {p.primaryPosition && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{p.primaryPosition}</span>}
                </div>
              );
            })}
          </div>
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
  const [isDirty, setIsDirty] = useState(false);
  const [search, setSearch]   = useState('');
  const [view, setView]       = useState('Schedule');         // Schedule | Day | 3 Day | Week | Month
  const [anchorDate, setAnchorDate] = useState(new Date());   // pivot date for range views
  const [playerFilter, setPlayerFilter] = useState([]);       // selected represented player IDs
  const { confirm, dialog }   = useConfirm();
  const { canEdit, isAdmin }  = useRole();
  const [syncing, setSyncing] = useState(false);

  // Admin-only: trigger the Netlify sync function for all represented players.
  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const { getAuth } = await import('firebase/auth');
      const user = getAuth().currentUser;
      if (!user) { toast.error('Not signed in.'); return; }
      const token = await user.getIdToken();
      // Background function: Netlify returns 202 immediately, the actual work
      // continues for up to 15 minutes. We don't get the final stats inline —
      // we tell the user we kicked it off and the matches will refresh on
      // their own via the Firestore listener as the function writes them.
      const res = await fetch('/.netlify/functions/sync-matches-background', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      });
      if (res.status === 202 || res.ok) {
        toast.success('Sync started — matches will appear here as they\'re fetched (≈1–2 min).');
        // Soft "still working" indicator for ~90 s, then drop it. The real
        // result is whatever shows up in the matches list via the live
        // Firestore listener.
        setTimeout(() => setSyncing(false), 90000);
        return;
      }
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Sync failed (${res.status})`);
    } catch (e) {
      toast.error(e.message || 'Sync failed.');
      setSyncing(false);
      return;
    }
    // Note: in the happy path we DO NOT reach here — the 90s timeout above
    // owns clearing the syncing flag. This avoids a flicker where the button
    // re-enables before the user sees fresh data appear.
  };

  const [allPlayers, setAllPlayers] = useState([]);
  useEffect(() => { return listenCollection(PATHS.PLAYERS, setAllPlayers); }, []);
  useEffect(() => {
    return listenCollection(PATHS.MATCHES, data => {
      setItems(data.sort((a, b) => (a.date || '') > (b.date || '') ? 1 : -1));
      setLoading(false);
    });
  }, []);

  const s = k => v => { setForm(p => ({ ...p, [k]: v })); setIsDirty(true); };
  const f = k => form[k] ?? '';

  const openAdd  = () => { setForm({ ...EMPTY }); setModal('add'); setIsDirty(false); };
  const openEdit = p  => { setForm({ ...EMPTY, ...p }); setModal({ edit: p }); setIsDirty(false); };

  const save = async () => {
    if (!form.homeTeam || !form.awayTeam) { toast.error('Home and away teams are required.'); return; }
    if (!form.date) { toast.error('Date is required.'); return; }
    if (!form.linkedPlayers?.length) { toast.error('Please link at least one represented player.'); return; }
    setSaving(true);
    try {
      if (modal === 'add') { await addDoc_(PATHS.MATCHES, form); toast.success('Match added!'); }
      else { await updateDoc_(PATHS.MATCHES, modal.edit.id, form); toast.success('Match updated.'); }
      setModal(null);
    } catch (e) { toast.error(e.message || 'Save failed.'); }
    finally { setSaving(false); }
  };

  const del = async p => {
    const ok = await confirm(`Delete match "${p.homeTeam} vs ${p.awayTeam}"?`);
    if (!ok) return;
    await deleteDoc_(PATHS.MATCHES, p.id);
    toast.success('Deleted.');
  };

  const now = new Date();

  // Apply search + player filter to all matches first.
  const baseFiltered = items.filter(m => {
    if (search && !`${m.homeTeam} ${m.awayTeam} ${m.stadiumName}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (playerFilter.length) {
      const linked = m.linkedPlayers || [];
      if (!linked.some(id => playerFilter.includes(id))) return false;
    }
    return true;
  });

  // Schedule view splits into upcoming / past; range views filter by date window.
  const range = getRange(view, anchorDate);
  const upcoming = range ? [] : baseFiltered.filter(m => !m.date || new Date(m.date) >= now);
  const past     = range ? [] : baseFiltered.filter(m => m.date && new Date(m.date) < now);
  const inRange  = range
    ? baseFiltered.filter(m => {
        if (!m.date) return false;
        const d = new Date(m.date);
        return d >= range[0] && d < range[1];
      }).sort((a, b) => {
        const dc = (a.date || '').localeCompare(b.date || '');
        if (dc !== 0) return dc;
        return (a.time || '').localeCompare(b.time || '');
      })
    : [];

  // Group range matches by day for display.
  const groupedByDay = (() => {
    if (!range) return [];
    const map = {};
    inRange.forEach(m => { (map[m.date] = map[m.date] || []).push(m); });
    return Object.keys(map).sort().map(date => ({ date, items: map[date] }));
  })();

  const stepDays = { Day: 1, '3 Day': 3, Week: 7 };
  const stepAnchor = (dir) => {
    if (view === 'Month') setAnchorDate(d => new Date(d.getFullYear(), d.getMonth() + dir, 1));
    else if (stepDays[view]) setAnchorDate(d => addDays(d, stepDays[view] * dir));
  };
  const goToday = () => setAnchorDate(new Date());

  const MatchCard = ({ m }) => {
    const linkedNames = allPlayers.filter(p => (m.linkedPlayers || []).includes(p.id)).map(p => p.fullName);
    return (
      <div className="card card-body" style={{ marginBottom: 10, transition: 'all 0.18s' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-2)'; e.currentTarget.style.transform = 'translateX(2px)'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = ''; }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Teams row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
              <TeamLogo name={m.homeTeam} size={22} />
              <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-1)' }}>{m.homeTeam}</span>
              {m.homeTeamIsYouth && <YouthBadge small />}
              <span style={{ color: 'var(--text-3)', fontWeight: 400, margin: '0 6px' }}>vs</span>
              <TeamLogo name={m.awayTeam} size={22} />
              <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text-1)' }}>{m.awayTeam}</span>
              {m.awayTeamIsYouth && <YouthBadge small />}
            </div>

            {/* Date / stadium */}
            <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <SourceBadge source={m.source} />
              <span>🗓 {fmtDate(m.date)}{m.time ? ' · ' + m.time : ''}</span>
              {m.stadiumName && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  🏟
                  {m.stadiumMapsUrl
                    ? <a href={m.stadiumMapsUrl} target="_blank" rel="noopener noreferrer"
                        style={{ color: 'var(--gold)', textDecoration: 'none' }}
                        onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                        onMouseLeave={e => e.target.style.textDecoration = 'none'}>
                        {m.stadiumName} ↗
                      </a>
                    : m.stadiumName}
                </span>
              )}
            </div>

            {/* Linked players */}
            {linkedNames.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>🤝</span>
                {linkedNames.map((n, i) => (
                  <span key={i} style={{ background: 'var(--gold-dim)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 4, padding: '1px 7px', color: 'var(--gold)', fontSize: 11 }}>{n}</span>
                ))}
              </div>
            )}

            {m.notes && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 5 }}>{m.notes}</div>}
          </div>
          {canEdit && <ActionButtons onEdit={() => openEdit(m)} onDelete={() => del(m)} />}
        </div>
      </div>
    );
  };

  // Style for the prev / today / next buttons in the date navigator.
  const navBtnStyle = () => ({
    width: 30, height: 30, borderRadius: 8,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--border)',
    color: 'var(--text-1)', fontSize: 16,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  });

  // ── Youth toggle helper ──────────────────────────────────────────
  const YouthToggle = ({ field }) => (
    <button type="button"
      className={`chip${form[field] ? ' active' : ''}`}
      onClick={() => s(field)(!form[field])}
      style={{ fontSize: 11, padding: '4px 10px', alignSelf: 'center', marginTop: 4 }}>
      🌱 Youth
    </button>
  );

  return (
    <div>
        <PageHeader
          title="Matches"
          subtitle={`${items.length} match${items.length !== 1 ? 'es' : ''} total`}
          action={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{ height: 36 }}>+ Add Match</button>}
              {isAdmin && (
                <button className="btn btn-ghost btn-sm" onClick={syncNow} disabled={syncing}
                  style={{ height: 36, whiteSpace: 'nowrap' }}
                  title="Pull match fixtures from IFA / 365 / SofaScore for every represented player">
                  {syncing ? '🔄 Syncing…' : '🔄 Sync Now'}
                </button>
              )}
              <div style={{ height: 36, display: 'flex', alignItems: 'center' }}>
                <SearchInput value={search} onChange={setSearch} placeholder="Search..." />
              </div>
              {canEdit && <button className="btn btn-danger btn-sm" onClick={clearAll_matches}
                style={{ height: 36, opacity: 0.45, whiteSpace: 'nowrap' }} title="Clear all"
                onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                onMouseLeave={e => e.currentTarget.style.opacity = '0.45'}>
                🗑 Clear All
              </button>}
            </div>
          }
        />

        {/* Controls bar: view toggle, date navigator (range views only), player filter */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          marginBottom: 18, padding: '10px 12px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid var(--border)',
          borderRadius: 10,
        }}>
          <ChipGroup options={VIEW_OPTIONS} value={view} onChange={setView} required />

          {view !== 'Schedule' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
              <button type="button" onClick={() => stepAnchor(-1)} title="Previous"
                style={navBtnStyle()}>‹</button>
              <span style={{
                // Fixed width so the layout stays identical across Day / 3 Day /
                // Week / Month — only the text inside changes. Kept compact so
                // the player filter can sit on the same row on mobile.
                width: 115,
                textAlign: 'center',
                fontSize: 13, color: 'var(--text-2)', fontWeight: 500,
                letterSpacing: '0.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>{getRangeLabel(view, anchorDate)}</span>
              <button type="button" onClick={() => stepAnchor(1)} title="Next"
                style={navBtnStyle()}>›</button>
              <button type="button" onClick={goToday} title="Jump to the current period"
                style={{ ...navBtnStyle(), width: 'auto', padding: '0 12px', fontSize: 12, marginLeft: 4 }}>
                Today
              </button>
            </div>
          )}

          {/* Players filter sits right next to the range navigator (or right
              next to the view chips in Schedule mode) so on mobile both
              controls fit on the same row instead of wrapping. */}
          <PlayersFilter allPlayers={allPlayers} value={playerFilter} onChange={setPlayerFilter} />
        </div>

      {/* Scrollable match-list area. The header + controls bar above stay
          static; only this container scrolls. max-height uses dvh so the
          mobile address bar collapse doesn't change the layout, and the
          calc keeps roughly the right offset for both desktop and mobile
          (mobile main padding-top adds the top-bar height, so this is a
          slight over-cut on mobile that the user simply scrolls through). */}
      <div className="matches-scroll" style={{
        maxHeight: 'calc(100dvh - 240px)',
        overflowY: 'auto',
        overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain',
        paddingRight: 4,
        marginRight: -4,
      }}>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
      ) : items.length === 0 ? (
        <Empty icon="🏟" message="No matches scheduled."
          action={canEdit && !search && <button className="btn btn-primary" onClick={openAdd}>+ Add Match</button>} />
      ) : range ? (
        // ── Range view (Day / 3 Day / Week / Month) ──
        groupedByDay.length === 0 ? (
          <Empty icon="📅" message={`No matches in this ${view.toLowerCase()}.`} />
        ) : (
          groupedByDay.map(g => (
            <div key={g.date} style={{ marginBottom: 22 }}>
              <div className="section-label" style={{ marginBottom: 10 }}>
                {new Date(g.date).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })}
                <span style={{ color: 'var(--text-3)', marginLeft: 8, fontWeight: 400 }}>
                  ({g.items.length} match{g.items.length !== 1 ? 'es' : ''})
                </span>
              </div>
              {g.items.map(m => <MatchCard key={m.id} m={m} />)}
            </div>
          ))
        )
      ) : (
        // ── Schedule view: upcoming + past ──
        <>
          {upcoming.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div className="section-label" style={{ marginBottom: 12 }}>Upcoming ({upcoming.length})</div>
              {upcoming.map(m => <MatchCard key={m.id} m={m} />)}
            </div>
          )}
          {past.length > 0 && (
            <div>
              <div className="section-label" style={{ marginBottom: 12, color: 'var(--text-3)' }}>Past ({past.length})</div>
              <div style={{ opacity: 0.65 }}>
                {/* Show ALL past matches (newest first). Previous version capped at
                    10 which made the total count seem wrong vs the visible list. */}
                {[...past].reverse().map(m => <MatchCard key={m.id} m={m} />)}
              </div>
            </div>
          )}
          {upcoming.length === 0 && past.length === 0 && (
            <Empty icon="🔍" message="No matches match your filters." />
          )}
        </>
      )}
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Match' : 'Edit Match'}
          onClose={() => setModal(null)} isDirty={isDirty} onSave={save}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : 'Save Match'}
            </button>
          </>}
        >
          <div className="form-grid-2">
            <Field label="Date" required><DateInput value={f('date')} onChange={s('date')} /></Field>
            <Field label="Time">
              <select value={f('time')} onChange={e => s('time')(e.target.value)}>
                <option value="">Select time...</option>
                {TIME_SLOTS.map(t => <option key={t}>{t}</option>)}
              </select>
            </Field>
          </div>

          <div className="form-grid-2">
            <Field label="Home Team" required>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <TeamLogo name={form.homeTeam} size={24} />
                <input value={f('homeTeam')} onChange={e => s('homeTeam')(e.target.value)} placeholder="Home team name" style={{ flex: 1 }} />
              </div>
              <YouthToggle field="homeTeamIsYouth" />
            </Field>
            <Field label="Away Team" required>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <TeamLogo name={form.awayTeam} size={24} />
                <input value={f('awayTeam')} onChange={e => s('awayTeam')(e.target.value)} placeholder="Away team name" style={{ flex: 1 }} />
              </div>
              <YouthToggle field="awayTeamIsYouth" />
            </Field>
          </div>

          <Field label="Stadium / Venue" hint="Type to search — Google Maps suggestions appear automatically">
            <StadiumInput
              value={f('stadiumName')}
              onSelect={({ name, mapsUrl, placeId }) => {
                s('stadiumName')(name);
                s('stadiumMapsUrl')(mapsUrl);
                s('stadiumPlaceId')(placeId);
              }}
            />
            {form.stadiumMapsUrl && (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-3)' }}>
                ✓ Linked to Google Maps —
                <a href={form.stadiumMapsUrl} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--gold)', marginLeft: 6, textDecoration: 'none' }}>Preview ↗</a>
              </div>
            )}
          </Field>

          <Field label="Linked Players" required hint="Required — type to search">
            <LinkedPlayersSelect players={allPlayers} value={f('linkedPlayers') || []} onChange={s('linkedPlayers')} />
          </Field>

          <Field label="Notes">
            <textarea value={f('notes')} onChange={e => s('notes')(e.target.value)} placeholder="Additional notes..." rows={3} />
          </Field>
        </Modal>
      )}

      {dialog}
    </div>
  );
}
