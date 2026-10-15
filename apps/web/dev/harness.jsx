// Mobile layout harness: the real shell CSS and UI components with sample
// content, no Firebase. Served by the Vite dev server only (not built).
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../src/index.css';
import { PageHeader, ChipGroup, SearchInput, FilterBar, SortTh, ExportMenu } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
import { SnapshotView } from 'pages/Snapshot';
import { decodeState, encodeState } from '@goldas/domain';

const Layout = ({ children }) => (
  <div className="layout-root" style={{ display: 'flex', minHeight: '100vh' }}>
    <div className="mobile-topbar" style={{ display: 'none', position: 'fixed', top: 0, insetInlineStart: 0, insetInlineEnd: 0, height: 'var(--topbar-h)', background: 'var(--surface-1)', borderBottom: '1px solid var(--border-2)', alignItems: 'center', padding: '0 12px', zIndex: 50 }}>GOLD A&S</div>
    <main className="main-content" style={{ flex: 1, padding: '18px 20px', minHeight: '100vh' }}>{children}</main>
    <nav className="bottom-nav">{['בית','שחקנים','שוק','גולדה','עוד'].map((l) => <a key={l} className="bottom-nav-item" href="#"><span className="icon"><Icon name="players" size={17} /></span><span>{l}</span></a>)}</nav>
  </div>
);

function Calendar() {
  const [view, setView] = useState('week');
  const [search, setSearch] = useState('');
  return (
    <div>
      <PageHeader title="יומן" subtitle="12 משחקים · 37 אימונים"
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary" style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">הוסף אימון</span></button>
          <button className="btn btn-secondary" style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">הוסף משחק</span></button>
          <button className="btn btn-ghost btn-sm" style={{ height: 36 }}><Icon name="refresh" size={12} /><span className="btn-text">סנכרן</span></button>
          <ExportMenu filename="x" title="x" columns={[{ key: 'a', label: 'a' }]} rows={[{ a: 1 }]} />
          <div style={{ height: 36, display: 'flex', alignItems: 'center' }}><SearchInput value={search} onChange={setSearch} placeholder="חיפוש..." /></div>
        </div>}>
        <div className="filter-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12, padding: '10px 12px', background: 'var(--surface-1)', border: '1px solid var(--border)' }}>
          <ChipGroup options={['list', 'week', 'month']} labels={['רשימה', 'שבוע', 'חודש']} value={view} onChange={setView} required />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm">‹</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, minWidth: 130, textAlign: 'center' }}>11/10/26 – 17/10/26</span>
            <button type="button" className="btn btn-ghost btn-sm">›</button>
            <button type="button" className="btn btn-ghost btn-sm">היום</button>
          </div>
          <ChipGroup options={['all', 'match', 'training']} labels={['הכל', 'משחקים', 'אימונים']} value="all" onChange={() => {}} required />
          <ChipGroup options={['all', 'youth', 'senior']} labels={['כולם', 'נוער בלבד', 'בוגרים בלבד']} value="all" onChange={() => {}} required />
          <select style={{ width: 'auto', height: 36, fontSize: 12 }}><option>כל השחקנים</option></select>
          <span style={{ fontSize: 11, color: 'var(--red)' }}>■ 1,019/1,000 · מתאפס 30/10/26</span>
        </div>
      </PageHeader>
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="card card-body" style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600 }}>הפ' מרמורק רחובות "צו פיוס" – עירוני מודיעין "צו פיוס"</div>
          <div className="m-meta"><span>31/10/26</span><span>20:45</span><span>אצטדיון רחובות</span></div>
        </div>
      ))}
    </div>
  );
}

function TmWatch() {
  const [tab, setTab] = useState('All');
  return (
    <div>
      <PageHeader title="מעקב Transfermarkt" subtitle={`סקאוטינג Transfermarkt: קשר יהודי או ישראלי בחו"ל · 727 במעקב`}
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <a className="btn btn-ghost btn-sm" style={{ height: 36 }}><Icon name="chevron" size={12} /><span className="btn-text">יהודים</span></a>
          <button className="btn btn-secondary btn-sm" style={{ height: 36 }}><Icon name="refresh" size={12} /><span className="btn-text">סרוק עכשיו</span></button>
          <div style={{ height: 36, display: 'flex', alignItems: 'center' }}><SearchInput value="" onChange={() => {}} placeholder="חיפוש לפי שם, מועדון..." /></div>
        </div>}>
        <div className="filter-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <ChipGroup options={['New', 'All', 'Starred', 'Dismissed']} labels={['חדשים (0)', 'הכל (665)', 'מסומנים (3)', 'נדחו (62)']} value={tab} onChange={setTab} required />
          <span className="filter-div" style={{ width: 1, height: 20, background: 'var(--border-2)' }} />
          <ChipGroup options={['', '0', '1', '2']} labels={['כל הסוגים (665)', 'אזרחות (152)', 'שם חזק (338)', 'אפשרי (175)']} value="" onChange={() => {}} required />
          <ChipGroup options={['', 'never', 'played']} labels={['כל ההיסטוריה (665)', 'מעולם לא בישראל (528)', 'שיחק בישראל (137)']} value="" onChange={() => {}} required />
        </div>
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>סריקה אחרונה: 13/10/26 07:30 · 0 חדשים בריצה האחרונה</div>
      </PageHeader>
      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="card card-body" style={{ marginBottom: 8 }}>Raz Haim Yehezkel · 21 · Central Midfield · CSU Bakersfield Roadrunners · United States</div>)}
    </div>
  );
}

function Player() {
  return (
    <div>
      <PageHeader title="OMRI SHALOM TAKALA" subtitle="מיוצג · נוער · CB · SC Ashdod · 15 שנים"
        action={<>
          <button className="btn btn-secondary"><Icon name="clipboard" size={12} /><span className="btn-text">קו״ח (עברית)</span><span className="btn-text-sm">עב</span></button>
          <button className="btn btn-secondary"><Icon name="clipboard" size={12} /><span className="btn-text">קו״ח (אנגלית)</span><span className="btn-text-sm">EN</span></button>
          <button className="btn btn-ghost"><Icon name="external" size={12} /><span className="btn-text">שיתוף PDF</span></button>
          <button className="btn btn-primary"><Icon name="edit" size={12} /><span className="btn-text">עריכת שחקן</span></button>
        </>} />
      <div className="card card-body">
        <div className="fact-row" style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--rule)', alignItems: 'center' }}>
          <span className="fact-key" style={{ color: 'var(--text-3)', minWidth: 110 }}>תאריך לידה</span><span>13.03.2011 (15)</span>
        </div>
        <div className="fact-row" style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--rule)', alignItems: 'center' }}>
          <span className="fact-key" style={{ color: 'var(--text-3)', minWidth: 110 }}>קבוצת גיל 2026/27</span>
          <select className="fact-select" defaultValue="">
            <option value="">נערים א'</option><option value="noar">נוער</option><option value="nearim-b">נערים ב'</option><option value="nearim-c">נערים ג'</option>
          </select>
        </div>
        <div className="fact-row" style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--rule)', alignItems: 'center' }}>
          <span className="fact-key" style={{ color: 'var(--text-3)', minWidth: 110 }}>עמדה</span><span>CB, DM</span>
        </div>
      </div>
    </div>
  );
}

function Players() {
  const [filters, setFilters] = useState({});
  return (
    <div>
      <PageHeader title="שחקנים" subtitle="18 שחקנים מיוצגים"
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary" style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">הוסף שחקן</span></button>
          <ExportMenu filename="x" title="x" columns={[{ key: 'a', label: 'a' }]} rows={[{ a: 1 }]} />
          <div style={{ height: 36, display: 'flex', alignItems: 'center' }}><SearchInput value="" onChange={() => {}} /></div>
        </div>}>
        <div style={{ marginTop: 12 }}>
          <FilterBar filters={filters} setFilters={setFilters} options={[{ key: 'club', label: 'מועדון', values: ['a'] }, { key: 'pos', label: 'עמדה', values: ['a'] }, { key: 'gender', label: 'מגדר', values: ['a'] }, { key: 'contract', label: 'חוזה', values: ['a'] }]} />
        </div>
      </PageHeader>
      <div className="card"><div className="table-wrap"><table className="data-table"><thead><tr><th>שם</th><th>אימייל</th><th>תפקיד</th><th></th></tr></thead><tbody>
        {['Lou Korek', 'Aviram Hasan', 'Dan Ringel'].map((n) => <tr key={n}><td>{n}</td><td>someone.long.address@gmail.com</td><td>מנהל</td><td><button className="btn btn-secondary btn-sm">ערוך</button></td></tr>)}
      </tbody></table></div></div>
      <div className="card" style={{ marginTop: 14 }}><div className="table-wrap"><table className="data-table"><thead><tr>{['שם','מועדון','עמדה','גיל','חוזה','ייצוג','מדינה','פעולות'].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
        <tr>{['Omri Shalom Takala','SC Ashdod','CB','15','2027','2028','Israel','…'].map((c, i) => <td key={i}>{c}</td>)}</tr>
      </tbody></table></div></div>
    </div>
  );
}


// Snapshot with sample data through the real engine; the drill state is the
// page's own query string, like the app.
const CLUBS = ['מכבי חיפה', 'הפועל תל אביב', 'מ.ס. אשדוד', 'בית"ר ירושלים', 'מכבי פתח תקווה', 'הפועל חדרה', 'Valencia CF'];
const POS = ['GK', 'CB', 'RB', 'LB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST'];
const SAMPLE = (() => {
  const players = Array.from({ length: 64 }, (_, i) => ({
    id: `p${i}`, name: `שחקן ${i + 1}`, stage: i % 9 === 0 ? 'in_process' : i % 13 === 0 ? 'tracking' : 'represented',
    category: i % 4 === 0 ? 'men' : i % 11 === 0 ? 'women' : 'youth', dob: `${2004 + (i % 9)}-0${1 + (i % 9)}-1${i % 9}`,
    primaryPosition: POS[i % POS.length], currentClub: CLUBS[i % CLUBS.length], leagueCountry: i % 7 === 6 ? 'Spain' : 'Israel',
    contractStatus: i % 5 === 0 ? 'Free' : 'Under Contract', contractEnd: `${2026 + (i % 3)}-${i % 2 ? '06' : '12'}-30`,
    createdAt: `2026-${String(1 + (i % 10)).padStart(2, '0')}-10`, nationalities: i % 6 ? ['Israel'] : ['Israel', 'France'],
  }));
  const stages = ['Not Contacted', 'Waiting Response', 'Initial Talks', 'Mandate Received', 'Offered to Club', 'Negotiation', 'Draft Signed', 'Contract Signed'];
  const deals = Array.from({ length: 22 }, (_, i) => ({ id: `d${i}`, playerId: `p${i * 2}`, playerName: `שחקן ${i * 2 + 1}`, category: players[i * 2].category, clubName: CLUBS[(i + 2) % CLUBS.length], stage: stages[i % stages.length], commission: `${(i + 1) * 1500}`, transferFee: `${(i + 1) * 20}k`, enteredStageAt: `2026-0${1 + (i % 9)}-05`, createdAt: `2026-0${1 + (i % 9)}-01`, owner: i % 3 ? 'lou' : 'aviram' }));
  const matches = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, date: `2026-${String(8 + (i % 4)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`, time: '19:00', homeTeam: CLUBS[i % CLUBS.length], awayTeam: CLUBS[(i + 3) % CLUBS.length], linkedPlayers: [`p${i % 64}`], stadiumName: 'סמי עופר' }));
  const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: `משימה ${i + 1}`, owner: 'lou', dueDate: `2026-10-${String(5 + i * 3).padStart(2, '0')}`, done: i % 4 === 0 }));
  return { players, deals, matches, requirements: [{ id: 'r1', clubName: 'מכבי חיפה', requiredPosition: 'CB', country: 'Israel', status: 'open', validUntil: '2026-12-31', createdAt: '2026-09-01' }], tasks, trainings: [], interactions: [] };
})();
function Snapshot() {
  const [qs, setQs] = useState(location.search.replace(/^\?/, '').replace(/(^|&)(s|light)=[^&]*/g, ''));
  const state = decodeState(qs);
  return <SnapshotView data={SAMPLE} state={state} setState={(n) => setQs(encodeState(n))} lang="he" now={new Date('2026-10-15T09:00:00Z')} />;
}

const SCREENS = { calendar: Calendar, tm: TmWatch, player: Player, players: Players, snapshot: Snapshot };
const which = new URLSearchParams(location.search).get('s') || 'calendar';
const light = new URLSearchParams(location.search).get('light');
if (light) document.body.classList.add('light-mode');
const S = SCREENS[which];
createRoot(document.getElementById('root')).render(<MemoryRouter><Layout><S /></Layout></MemoryRouter>);
