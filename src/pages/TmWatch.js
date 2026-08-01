import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, updateDoc_, addDoc_, PATHS } from 'lib/db';
import { fmtDate } from 'lib/constants';
import { PageHeader, ChipGroup, SearchInput, Empty, Spinner, toast, ScraperCredits } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { useRole } from 'lib/roleContext';

// Sub-screen of the Jewish pipeline: Transfermarkt candidates with a Jewish /
// Israeli connection playing outside Israel, produced daily by the
// tm-watch-background Netlify function.

// Country name (as Transfermarkt writes it) → ISO alpha-2 for emoji flags.
const ISO2 = {
  // Europe
  'Albania':'AL','Andorra':'AD','Armenia':'AM','Austria':'AT','Azerbaijan':'AZ','Belarus':'BY',
  'Belgium':'BE','Bosnia-Herzegovina':'BA','Bulgaria':'BG','Croatia':'HR','Cyprus':'CY',
  'Czech Republic':'CZ','Denmark':'DK','England':'GB-ENG','Estonia':'EE','Faroe Islands':'FO',
  'Finland':'FI','France':'FR','Georgia':'GE','Germany':'DE','Gibraltar':'GI','Greece':'GR',
  'Greenland':'GL','Guernsey':'GG','Hungary':'HU','Iceland':'IS','Ireland':'IE','Isle of Man':'IM',
  'Israel':'IL','Italy':'IT','Jersey':'JE','Kosovo':'XK','Latvia':'LV','Liechtenstein':'LI',
  'Lithuania':'LT','Luxembourg':'LU','Malta':'MT','Moldova':'MD','Monaco':'MC','Montenegro':'ME',
  'Netherlands':'NL','North Macedonia':'MK','Macedonia':'MK','Northern Ireland':'GB-NIR','Norway':'NO',
  'Poland':'PL','Portugal':'PT','Romania':'RO','Russia':'RU','San Marino':'SM','Scotland':'GB-SCT',
  'Serbia':'RS','Slovakia':'SK','Slovenia':'SI','Spain':'ES','Sweden':'SE','Switzerland':'CH',
  'Türkiye':'TR','Turkey':'TR','Ukraine':'UA','United Kingdom':'GB','Wales':'GB-WLS','Vatican':'VA',
  // Americas
  'Anguilla':'AI','Antigua and Barbuda':'AG','Argentina':'AR','Aruba':'AW','Bahamas':'BS',
  'Barbados':'BB','Belize':'BZ','Bermuda':'BM','Bolivia':'BO','Bonaire':'BQ','Brazil':'BR',
  'British Virgin Islands':'VG','Canada':'CA','Cayman Islands':'KY','Chile':'CL','Colombia':'CO',
  'Costa Rica':'CR','Cuba':'CU','Curacao':'CW','Dominica':'DM','Dominican Republic':'DO',
  'Ecuador':'EC','El Salvador':'SV','Falkland Islands':'FK','French Guiana':'GF','Grenada':'GD',
  'Guadeloupe':'GP','Guatemala':'GT','Guyana':'GY','Haiti':'HT','Honduras':'HN','Jamaica':'JM',
  'Martinique':'MQ','Mexico':'MX','Montserrat':'MS','Netherlands Antilles':'CW','Nicaragua':'NI',
  'Panama':'PA','Paraguay':'PY','Peru':'PE','Puerto Rico':'PR','Saint-Martin':'MF','Sint Maarten':'SX',
  'St. Kitts & Nevis':'KN','St. Lucia':'LC','St. Vincent & Grenadinen':'VC','Suriname':'SR',
  'Trinidad and Tobago':'TT','Turks- and Caicosinseln':'TC','United States':'US','USA':'US',
  'Uruguay':'UY','Venezuela':'VE','American Virgin Islands':'VI',
  // Africa
  'Algeria':'DZ','Angola':'AO','Benin':'BJ','Botswana':'BW','Burkina Faso':'BF','Burundi':'BI',
  'Cameroon':'CM','Cape Verde':'CV','Central African Republic':'CF','Chad':'TD','Comoros':'KM',
  'Congo':'CG',"People's republic of the Congo":'CG','DR Congo':'CD','Zaire':'CD',
  "Cote d'Ivoire":'CI','Djibouti':'DJ','Egypt':'EG','Equatorial Guinea':'GQ','Eritrea':'ER',
  'Eswatini':'SZ','Swaziland':'SZ','Ethiopia':'ET','Gabon':'GA','Ghana':'GH','Guinea':'GN',
  'Guinea-Bissau':'GW','Kenya':'KE','Lesotho':'LS','Liberia':'LR','Libya':'LY','Madagascar':'MG',
  'Malawi':'MW','Mali':'ML','Mauritania':'MR','Mauritius':'MU','Mayotte':'YT','Morocco':'MA',
  'Mozambique':'MZ','Namibia':'NA','Niger':'NE','Nigeria':'NG','Réunion':'RE','Rwanda':'RW',
  'Sao Tome and Principe':'ST','Senegal':'SN','Seychelles':'SC','Sierra Leone':'SL','Somalia':'SO',
  'South Africa':'ZA','Southern Sudan':'SS','Sudan':'SD','Tanzania':'TZ','The Gambia':'GM',
  'Togo':'TG','Tunisia':'TN','Uganda':'UG','Western Sahara':'EH','Zambia':'ZM','Zanzibar':'TZ',
  'Zimbabwe':'ZW',
  // Asia & Middle East
  'Afghanistan':'AF','Bahrain':'BH','Bangladesh':'BD','Bhutan':'BT','Brunei Darussalam':'BN',
  'Cambodia':'KH','China':'CN','Chinese Taipei':'TW','Hongkong':'HK','India':'IN','Indonesia':'ID',
  'Iran':'IR','Iraq':'IQ','Japan':'JP','Jordan':'JO','Kazakhstan':'KZ','Korea, North':'KP',
  'Korea, South':'KR','South Korea':'KR','Kuwait':'KW','Kyrgyzstan':'KG','Laos':'LA','Lebanon':'LB',
  'Macao':'MO','Malaysia':'MY','Maldives':'MV','Mongolia':'MN','Myanmar':'MM','Nepal':'NP',
  'Oman':'OM','Pakistan':'PK','Palestine':'PS','Philippines':'PH','Qatar':'QA','Saudi Arabia':'SA',
  'Singapore':'SG','Sri Lanka':'LK','Syria':'SY','Tajikistan':'TJ','Thailand':'TH','Timor-Leste':'TL',
  'Turkmenistan':'TM','United Arab Emirates':'AE','Uzbekistan':'UZ','Vietnam':'VN','Yemen':'YE',
  // Oceania
  'American Samoa':'AS','Australia':'AU','Cookinseln':'CK','Fiji':'FJ',
  'Federated States of Micronesia':'FM','Guam':'GU','Kiribati':'KI','Marshall Islands':'MH',
  'Nauru':'NR','New Caledonia':'NC','New Zealand':'NZ','Niue':'NU','Northern Mariana Islands':'MP',
  'Palau':'PW','Papua New Guinea':'PG','Samoa':'WS','Solomon Islands':'SB','Tahiti':'PF','Tonga':'TO',
  'Tuvalu':'TV','Vanuatu':'VU',
};
// Windows ships no country-flag emoji glyphs at all, so flags are rendered
// as tiny images (flagcdn serves every ISO code incl. gb-eng / xk) with a
// text-chip fallback for anything unmapped.
function Flag({ country, size = 15 }) {
  const code = ISO2[(country || '').trim()];
  if (code) {
    return (
      <img
        src={`https://flagcdn.com/w20/${code.toLowerCase()}.png`}
        srcSet={`https://flagcdn.com/w40/${code.toLowerCase()}.png 2x`}
        alt={country} title={country}
        style={{ width: size + 5, height: 'auto', borderRadius: 0, flexShrink: 0, boxShadow: '0 0 0 1px rgba(255,255,255,0.08)', verticalAlign: 'middle' }}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
    );
  }
  if (!country) return null;
  return <span title={country} style={{ fontSize: 9.5, fontWeight: 700, background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 0, padding: '1px 4px', color: 'var(--text-2)' }}>{country.slice(0, 3).toUpperCase()}</span>;
}
const TIER_LABEL = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3', 4: 'Tier 4', 5: 'Tier 5', 6: 'Tier 6' };
// Inline Israel flag image — flag EMOJI renders as plain letters on Windows.
const IL = () => (
  <img src="https://flagcdn.com/w20/il.png" alt="Israel"
    style={{ width: 14, height: 'auto', borderRadius: 0, verticalAlign: '-2px' }} />
);

const TIER_BADGE = {
  0: { label: <><IL /> Citizenship</>, bg: 'rgba(107,174,245,0.14)', fg: 'var(--blue)',  border: 'rgba(107,174,245,0.4)' },
  1: { label: 'Strong name',  bg: 'rgba(212,176,98,0.14)',  fg: 'var(--gold)',  border: 'rgba(212,176,98,0.4)' },
  2: { label: 'Possible',     bg: 'rgba(177,156,245,0.12)', fg: 'var(--purple)', border: 'rgba(177,156,245,0.35)' },
};
const TABS = ['New', 'All', 'Starred', 'Dismissed'];

function tsToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  return new Date(ts);
}

export default function TmWatch() {
  const { canEdit, isAdmin } = useRole();
  const [items, setItems]   = useState([]);
  const [meta, setMeta]     = useState(null);
  const [tab, setTab]       = useState('New');
  const [tierFilter, setTierFilter] = useState('');
  const [histFilter, setHistFilter] = useState('');
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);

  useEffect(() => listenCollection(PATHS.TM_WATCH, setItems), []);
  useEffect(() => onSnapshot(doc(db, 'app_meta', 'tmWatch'),
    s => setMeta(s.exists() ? s.data() : null), () => setMeta(null)), []);

  // A crashed run can leave running=true forever — treat the flag as stale
  // after 20 minutes so the Scan button never stays locked.
  const runStarted = tsToDate(meta?.runStartedAt)?.getTime() || 0;
  const running = !!meta?.running && (Date.now() - runStarted) < 20 * 60 * 1000;

  // List + faceted chip counts, computed together. Every chip shows how
  // many players selecting it would yield, respecting the other filters.
  const { filtered, tabCounts, tierCounts, histCounts } = useMemo(() => {
    const term = search.trim().toLowerCase();
    const passTab  = (p, t) => t === 'New' ? p.status === 'new'
      : t === 'Starred' ? !!p.starred
      : t === 'Dismissed' ? p.status === 'dismissed'
      : p.status !== 'dismissed';
    const passTier = (p, v) => v === '' || String(p.tier) === v;
    const passHist = (p, v) => v === '' || p.israelHistory === v;
    const passText = (p) => !term || `${p.name} ${p.club} ${p.clubCountry}`.toLowerCase().includes(term);
    const select = (t, v, h) => items.filter(p => passTab(p, t) && passTier(p, v) && passHist(p, h) && passText(p));

    const list = select(tab, tierFilter, histFilter).sort((a, b) =>
      (a.tier ?? 2) - (b.tier ?? 2) ||
      (tsToDate(b.firstSeen)?.getTime() || 0) - (tsToDate(a.firstSeen)?.getTime() || 0));

    return {
      filtered: list,
      tabCounts:  Object.fromEntries(TABS.map(t => [t, select(t, tierFilter, histFilter).length])),
      tierCounts: Object.fromEntries(['', '0', '1', '2'].map(v => [v, select(tab, v, histFilter).length])),
      histCounts: Object.fromEntries(['', 'never', 'played'].map(h => [h, select(tab, tierFilter, h).length])),
    };
  }, [items, tab, tierFilter, histFilter, search]);

  const newCount = items.filter(p => p.status === 'new').length;

  const setStatus = async (p, status) => {
    try { await updateDoc_(PATHS.TM_WATCH, p.id, { status }); }
    catch (e) { toast.error(e.message); }
  };
  const toggleStar = async (p) => {
    try { await updateDoc_(PATHS.TM_WATCH, p.id, { starred: !p.starred }); }
    catch (e) { toast.error(e.message); }
  };
  const addToPipeline = async (p) => {
    try {
      await addDoc_(PATHS.PIPELINE_JEWISH, {
        playerName: p.name,
        currentClub: p.club || '',
        league: p.clubCountry ? `${p.clubCountry}${p.league ? ' · ' + p.league : ''}` : (p.league || ''),
        nationalities: p.citizenships || [],
        status: 'Not Contacted',
        profileLink: p.tmUrl || '',
        notes: `From TM Watch — ${p.matchedOn || ''}`,
      });
      await updateDoc_(PATHS.TM_WATCH, p.id, { addedToPipeline: true, status: p.status === 'new' ? 'seen' : p.status });
      toast.success(`${p.name} added to the Jewish pipeline.`);
    } catch (e) { toast.error(e.message); }
  };
  const markAllSeen = async () => {
    const news = items.filter(p => p.status === 'new');
    if (!news.length) return;
    try {
      await Promise.all(news.map(p => updateDoc_(PATHS.TM_WATCH, p.id, { status: 'seen' })));
      toast.success(`${news.length} candidates marked as seen.`);
    } catch (e) { toast.error(e.message); }
  };
  const scanNow = async () => {
    setScanning(true);
    try {
      await fetch('/.netlify/functions/tm-watch-background', { method: 'POST' });
      toast.success('Scan started — new candidates will appear here within a few minutes.');
    } catch (e) { toast.error('Could not start scan.'); }
    setScanning(false);
  };

  const lastRun = tsToDate(meta?.lastRunAt);

  return (
    <div>
      <PageHeader
        title="TM Watch"
        subtitle={`Transfermarkt scouting — Jewish & Israeli connections abroad · ${items.length} tracked${newCount ? ` · ${newCount} new` : ''}`}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Link to="/pipeline/jewish" className="btn btn-ghost btn-sm" style={{ height: 36, textDecoration: 'none' }}><Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} /><span className="btn-text">Jewish</span></Link>
            {isAdmin && (
              <button className="btn btn-secondary btn-sm" style={{ height: 36 }}
                onClick={scanNow} disabled={scanning || running}>
                {running ? <><Spinner size={12} /><span className="btn-text">Scanning…</span></> : <><Icon name="refresh" size={12} /><span className="btn-text">Scan now</span></>}
              </button>
            )}
            {canEdit && newCount > 0 && (
              <button className="btn btn-ghost btn-sm" style={{ height: 36 }} onClick={markAllSeen}
                title="Mark every NEW candidate as seen">
                <Icon name="tasks" size={12} /><span className="btn-text">Mark all seen ({newCount})</span>
              </button>
            )}
            <div style={{ height: 36, display: 'flex', alignItems: 'center' }}>
              <SearchInput value={search} onChange={setSearch} placeholder="Search name, club..." />
            </div>
          </div>
        }
      >
        <div className="filter-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <ChipGroup options={TABS} labels={TABS.map(t => `${t} (${tabCounts[t]})`)} value={tab} onChange={setTab} required />
          <span className="filter-div" style={{ width: 1, height: 20, background: 'var(--border-2)', flexShrink: 0 }} />
          <ChipGroup
            options={['', '0', '1', '2']}
            labels={[`All types (${tierCounts['']})`, <><IL /> Citizenship ({tierCounts['0']})</>, `Strong name (${tierCounts['1']})`, `Possible (${tierCounts['2']})`]}
            value={tierFilter} onChange={(v) => setTierFilter(v ?? '')} required
          />
          <span className="filter-div" style={{ width: 1, height: 20, background: 'var(--border-2)', flexShrink: 0 }} />
          <ChipGroup
            options={['', 'never', 'played']}
            labels={[`Any history (${histCounts['']})`, `Never in Israel (${histCounts['never']})`, <><IL /> Played in Israel ({histCounts['played']})</>]}
            value={histFilter} onChange={(v) => setHistFilter(v ?? '')} required
          />
        </div>
        {meta && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
            {lastRun ? <>Last scan: {fmtDate(lastRun.toISOString().slice(0, 10))} {lastRun.toTimeString().slice(0, 5)}</> : 'No scan has run yet'}
            {meta.lastRunNew != null && <> · {meta.lastRunNew} new last run</>}
            {items.length > 0 && <> · career history checked: {items.filter(p => p.israelHistory).length}/{items.length}</>}
            {' '}· <ScraperCredits />
            {/* Shown only while the most recent run is actually failing —
                the collector clears this the moment a run succeeds. */}
            {meta.lastError && <span style={{ color: 'var(--red)' }}> · Error: {String(meta.lastError).slice(0, 120)}</span>}
          </div>
        )}
      </PageHeader>

      {items.length === 0 ? (
        <Empty message="No candidates yet — the first daily scan will populate this screen."
          action={isAdmin ? <button className="btn btn-primary" onClick={scanNow} disabled={scanning || running}>{running ? 'Scanning…' : 'Run first scan'}</button> : null} />
      ) : filtered.length === 0 ? (
        <Empty message={`Nothing in "${tab}"${tierFilter !== '' ? ' with this match type' : ''}.`} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(p => {
            const badge = TIER_BADGE[p.tier] || TIER_BADGE[2];
            return (
              <div key={p.id} className="card card-body" style={{
                padding: '12px 16px',
                borderLeft: `3px solid ${badge.fg}`,
                opacity: p.status === 'dismissed' ? 0.55 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <a href={p.tmUrl} target="_blank" rel="noopener noreferrer"
                        style={{ fontWeight: 600, fontSize: 14.5, color: 'var(--text-1)', textDecoration: 'none' }}>
                        {p.name} <span style={{ color: 'var(--gold)', fontSize: 12 }}>↗</span>
                      </a>
                      {p.age && <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{p.age}</span>}
                      {p.position && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{p.position}</span>}
                      <span title={`${p.matchedOn || ''}${p.firstSeen ? ` · first seen ${fmtDate(tsToDate(p.firstSeen).toISOString().slice(0, 10))}` : ''}`} style={{
                        background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
                        borderRadius: 0, padding: '2px 9px', fontSize: 10, fontWeight: 600, cursor: 'default',
                      }}>{badge.label}</span>
                      {p.status === 'new' && <span style={{ background: 'var(--green-bg)', color: 'var(--green-ok)', borderRadius: 0, padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>NEW</span>}
                      {p.israelHistory === 'never' && <span title="Career history has no Israeli club — youth or senior" style={{ background: 'rgba(93,214,138,0.12)', color: 'var(--green-ok)', border: '1px solid rgba(93,214,138,0.35)', borderRadius: 0, padding: '2px 9px', fontSize: 10, fontWeight: 600, cursor: 'default' }}>Never in Israel</span>}
                      {p.israelHistory === 'played' && <span title={`Israeli football history: ${(p.israelClubs || []).join(', ') || '—'}`} style={{ background: 'var(--surface-3)', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 0, padding: '2px 9px', fontSize: 10, cursor: 'default' }}><IL /> Played in IL</span>}
                      {p.addedToPipeline && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>in pipeline</span>}
                      {p.activeAbroad === false && <span style={{ fontSize: 10, color: 'var(--amber)' }}>no longer abroad</span>}
                    </div>
                    <div className="m-meta" style={{ marginTop: 8, fontSize: 12 }}>
                      {(p.citizenships || []).length > 0 && (
                        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                          {(p.citizenships || []).map(c => <Flag key={c} country={c} size={15} />)}
                        </span>
                      )}
                      {p.club && <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>{p.club}</span>}
                      {(p.league || p.clubCountry) && (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <Flag country={p.clubCountry} />
                          {p.league || p.clubCountry}
                          {p.leagueTier != null && <span className="m-sub">({TIER_LABEL[p.leagueTier] || `Tier ${p.leagueTier}`})</span>}
                        </span>
                      )}
                      {p.marketValue && <span>{p.marketValue}</span>}
                      {p.contractUntil && <span>{p.contractUntil}</span>}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="action-btns" style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'center' }}>
                      <button title={p.starred ? 'Unstar' : 'Star'} onClick={() => toggleStar(p)}
                        style={{ width: 30, height: 30, border: 'none', borderRadius: 0, cursor: 'pointer', background: p.starred ? 'rgba(212,176,98,0.25)' : 'rgba(255,255,255,0.05)', color: 'var(--gold)', fontSize: 14 }}>
                        {p.starred ? '★' : '☆'}
                      </button>
                      {!p.addedToPipeline && p.status !== 'dismissed' && (
                        <button title="Add to Jewish pipeline" onClick={() => addToPipeline(p)}
                          style={{ width: 30, height: 30, border: 'none', borderRadius: 0, cursor: 'pointer', background: 'rgba(93,214,138,0.15)', color: 'var(--green-ok)', fontSize: 15 }}>＋</button>
                      )}
                      {p.status === 'new' && (
                        <button title="Mark seen" onClick={() => setStatus(p, 'seen')}
                          style={{ width: 30, height: 30, border: 'none', borderRadius: 0, cursor: 'pointer', background: 'rgba(107,174,245,0.15)', color: 'var(--blue)', fontSize: 14 }}>✓</button>
                      )}
                      {p.status !== 'dismissed' ? (
                        <button title="Not relevant" onClick={() => setStatus(p, 'dismissed')}
                          style={{ width: 30, height: 30, border: 'none', borderRadius: 0, cursor: 'pointer', background: 'rgba(240,114,110,0.14)', color: 'var(--red)', fontSize: 14 }}>⊘</button>
                      ) : (
                        <button title="Restore" onClick={() => setStatus(p, 'seen')}
                          style={{ width: 30, height: 30, border: 'none', borderRadius: 0, cursor: 'pointer', background: 'rgba(93,214,138,0.15)', color: 'var(--green-ok)', fontSize: 14 }}>↩</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
