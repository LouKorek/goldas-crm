import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { listenCollection, updateDoc_, PATHS, resolveFileUrl } from 'lib/db';
import { listenPlayers } from 'data/players';
import { listenDeals } from 'data/deals';
import { listenInteractions, addInteraction } from 'data/interactions';
import { calcAge, fmtDate } from 'lib/constants';
import { daysAway } from 'lib/alerts';
import { useRole } from 'lib/roleContext';
import { t, tv, relDays, fmtDateTime, getLang } from 'lib/i18n';
import { playerName, flagEmoji, ISO2, STAGE_LABELS, CATEGORY_LABELS, AGE_GROUPS, resolveAgeGroup, ageGroupFor, isYouthAge, seasonLabel, seasonStartYear, DEAL_STAGE_LABELS } from '@goldas/domain';
import { PageHeader, FactLine, Skeleton, Empty, toast } from 'components/ui/UI';
import Icon from 'components/ui/Icons';

// One screen for a player: profile, contract and representation countdown,
// documents, matches, open deals, the interaction timeline, related tasks
// and the CV export in both languages.
const DaysLeft = ({ date, label }) => {
  if (!date) return null;
  const d = daysAway(date);
  const color = d < 0 ? 'var(--red)' : d <= 30 ? 'var(--red)' : d <= 90 ? 'var(--amber)' : 'var(--green-ok)';
  return (
    <div style={{ border: '1px solid var(--border)', borderTop: `2px solid ${color}`, padding: '10px 12px', background: 'var(--card)' }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color, lineHeight: 1.1, marginTop: 4 }}>{d < 0 ? `${-d}` : d}</div>
      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{d < 0 ? t('days overdue') : t('days')} · {fmtDate(date)}</div>
    </div>
  );
};

const Card = ({ title, children, action }) => (
  <section className="card card-body" style={{ padding: '14px 16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
      <div className="section-label" style={{ marginBottom: 0, flex: 1 }}>{title}</div>
      {action}
    </div>
    {children}
  </section>
);

// Youth age group: the cohort default (IFA rule, season from July 1) with a
// manual override kept per season, so last season's override is ignored.
function AgeGroupFact({ p, canEdit }) {
  const he = getLang() === 'he';
  if (!p.dob || !isYouthAge(p.dob)) return null;
  const g = resolveAgeGroup(p);
  const def = ageGroupFor(p.dob);
  const overridden = p.ageGroupOverride?.season === seasonStartYear();
  const set = async (id) => {
    await updateDoc_(PATHS.PLAYERS, p.id, { ageGroupOverride: id ? { id, season: seasonStartYear() } : null });
    toast.success(t('Age group updated.'));
  };
  return (
    <div className="fact-row" style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--rule)', alignItems: 'center' }}>
      <span className="fact-key" style={{ color: 'var(--text-3)', minWidth: 110 }}>{t('Age group')} {seasonLabel()}</span>
      {canEdit ? (
        <select className="fact-select" value={overridden ? p.ageGroupOverride.id : ''} onChange={(e) => set(e.target.value)}>
          {/* The cohort group is the blank (automatic) choice, so it is listed once. */}
          <option value="">{def ? def[he ? 'he' : 'en'] : t('by cohort')}</option>
          {AGE_GROUPS.filter((x) => x.id !== def?.id).map((x) => <option key={x.id} value={x.id}>{x[he ? 'he' : 'en']}</option>)}
        </select>
      ) : <span>{g ? g[he ? 'he' : 'en'] : '—'}</span>}
      {overridden && <span style={{ fontSize: 10.5, color: 'var(--amber)' }}>{t('manual override')}</span>}
    </div>
  );
}

const Fact = ({ k, v }) => (v ? <div style={{ display: 'flex', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--rule)' }}><span style={{ color: 'var(--text-3)', minWidth: 110 }}>{k}</span><span style={{ flex: 1 }}>{v}</span></div> : null);

export default function Player360() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { canEdit, email } = useRole();
  const [players, setPlayers] = useState(null);
  const [matches, setMatches] = useState([]);
  const [deals, setDeals] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [interactions, setInteractions] = useState([]);
  const [note, setNote] = useState('');
  const he = getLang() === 'he';

  useEffect(() => {
    const u = [
      listenPlayers({}, setPlayers),
      listenCollection(PATHS.MATCHES, (rows) => setMatches(rows.filter((m) => (m.linkedPlayers || []).includes(id)))),
      listenDeals({ playerId: id }, setDeals),
      listenCollection(PATHS.TASKS, (rows) => setTasks(rows.filter((x) => x.owner === email && (x.linkedPlayers || []).includes(id)))),
      listenInteractions({ playerId: id }, setInteractions),
    ];
    return () => u.forEach((f) => f());
  }, [id, email]);

  const p = useMemo(() => (players || []).find((x) => x.id === id), [players, id]);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = matches.filter((m) => m.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  const recent = matches.filter((m) => m.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const timeline = [...interactions].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  if (!players) return <Skeleton rows={8} />;
  if (!p) return <Empty message={t('Player not found.')} action={<Link className="btn btn-secondary" to="/players">{t('Back')}</Link>} />;

  const name = playerName(p);
  const stage = p.stage || 'represented';
  // The list this player belongs to — the fallback for "close" when the card
  // was opened directly (a shared link, a refresh), and the screen whose edit
  // form serves this card.
  const listPath = stage === 'represented' ? '/players' : `/pipeline/${p.category || 'men'}`;
  // Close returns to wherever the card was opened from — the home screen,
  // search, a deal, the candidates list — rather than to a fixed screen.
  // The very first entry of a session has no "back", so it falls back to the list.
  const close = () => {
    if (location.key !== 'default' && window.history.length > 1) navigate(-1);
    else navigate(listPath, { replace: true });
  };
  // Editing happens in the list's form; `back: true` tells that screen to
  // return here once the form closes (saved or cancelled), instead of
  // leaving the user stranded on a list they never opened.
  const edit = () => navigate(listPath, { state: { editId: id, back: true } });
  const openFile = async (ref) => {
    try { const url = await resolveFileUrl(ref); if (url) window.open(url, '_blank'); else toast.error(t('File unavailable.')); }
    catch { toast.error(t('Could not open file.')); }
  };
  const canShare = (() => { try { return !!navigator.canShare?.({ files: [new File([new Blob()], 'x.pdf', { type: 'application/pdf' })] }); } catch { return false; } })();
  const cv = async (lang, share = false) => {
    try { const { exportPlayerCv } = await import('lib/playerCv'); await exportPlayerCv({ ...p, playerName: name }, p.category || 'men', { share, lang }); }
    catch (e) { console.error(e); toast.error(t('Could not build the PDF.')); }
  };
  const saveNote = async () => {
    if (!note.trim()) return;
    await addInteraction({ kind: 'note', playerId: id, text: note.trim(), by: email });
    setNote(''); toast.success(t('Note added.'));
  };
  const docs = [['contractFiles', t('Contract'), p?.contractEnd], ['passportFiles', t('Passport'), p?.passportExpiry], ['reprFiles', t('Representation Agreement'), p?.reprEnd]];

  return (
    <div>
      <PageHeader
        title={name}
        subtitle={<FactLine items={[STAGE_LABELS[stage]?.[he ? 'he' : 'en'], CATEGORY_LABELS[p.category]?.[he ? 'he' : 'en'], tv(p.primaryPosition), p.currentClub || tv(p.contractStatus), p.dob ? `${calcAge(p.dob)} ${t('yrs')}` : null]} />}
        action={<>
          <button className="btn btn-secondary" onClick={() => cv('he')} title={t('CV (Hebrew)')}><Icon name="clipboard" size={12} /><span className="btn-text">{t('CV (Hebrew)')}</span><span className="btn-text-sm">עב</span></button>
          <button className="btn btn-secondary" onClick={() => cv('en')} title={t('CV (English)')}><Icon name="clipboard" size={12} /><span className="btn-text">{t('CV (English)')}</span><span className="btn-text-sm">EN</span></button>
          {canShare && <button className="btn btn-ghost" onClick={() => cv(he ? 'he' : 'en', true)} title={t('Share PDF')}><Icon name="external" size={12} /><span className="btn-text">{t('Share PDF')}</span></button>}
          {canEdit && <button className="btn btn-primary" onClick={edit}><Icon name="edit" size={12} /><span className="btn-text">{t('Edit player')}</span></button>}
          <button className="btn btn-ghost" onClick={close} title={t('Close')} aria-label={t('Close')}><Icon name="close" size={12} /><span className="btn-text">{t('Close')}</span></button>
        </>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <DaysLeft date={p.contractStatus !== 'Free' ? p.contractEnd : ''} label={t('Contract ends')} />
        <DaysLeft date={p.reprEnd} label={t('Representation ends')} />
        <DaysLeft date={p.passportExpiry} label={t('Passport expires')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <Card title={t('Profile')}>
          <Fact k={t('Nationalities')} v={(p.nationalities || []).map((n) => `${flagEmoji(ISO2[n]) || ''} ${n}`).join(', ')} />
          <Fact k={t('Date of Birth')} v={p.dob ? `${fmtDate(p.dob)} (${calcAge(p.dob)})` : ''} />
          <AgeGroupFact p={p} canEdit={canEdit} />
          <Fact k={t('Position')} v={[tv(p.primaryPosition), ...(p.secondaryPositions || []).map(tv)].filter(Boolean).join(', ')} />
          <Fact k={t('Foot')} v={tv(p.foot)} />
          <Fact k={t('Height (cm)')} v={p.height} />
          <Fact k={t('National Team Status')} v={[tv(p.natTeamStatus), p.natTeamCountry].filter(Boolean).join(' · ')} />
          <Fact k={t('Agent')} v={[p.agentName, p.agentPhone].filter(Boolean).join(' · ')} />
          <Fact k={t('Profile Link')} v={p.profileLink ? <a href={p.profileLink} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>{t('Open ↗')}</a> : ''} />
          <Fact k={t('Video Link')} v={p.videoLink ? <a href={p.videoLink} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>{t('Open ↗')}</a> : ''} />
          <Fact k={t('Notes')} v={p.notes} />
        </Card>

        <Card title={t('Club & Contract')}>
          <Fact k={t('Contract Status')} v={tv(p.contractStatus)} />
          <Fact k={t('Current Club')} v={p.currentClub ? <>{p.currentClub}{p.currentClubIsYouth ? ` · ${t('Youth Team')}` : ''}</> : ''} />
          <Fact k={t('League')} v={p.league} />
          <Fact k={t('Loan From')} v={p.loanFrom} />
          <Fact k={t('Contract Start')} v={fmtDate(p.contractStart) !== '—' ? fmtDate(p.contractStart) : ''} />
          <Fact k={t('Contract End')} v={p.contractEnd ? `${fmtDate(p.contractEnd)} · ${relDays(daysAway(p.contractEnd))}` : ''} />
          <Fact k={t('Repr. Start')} v={p.reprStart ? fmtDate(p.reprStart) : ''} />
          <Fact k={t('Repr. End')} v={p.reprEnd ? `${fmtDate(p.reprEnd)} · ${relDays(daysAway(p.reprEnd))}` : ''} />
          <Fact k={t('Passport Number')} v={p.passportNumber} />
          <Fact k={t('Passport Expiry')} v={p.passportExpiry ? fmtDate(p.passportExpiry) : ''} />
          <Fact k={t('IFA Player Profile')} v={p.ifaTeamUrl ? <a href={p.ifaTeamUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>{t('Open ↗')}</a> : ''} />
        </Card>

        <Card title={t('Documents')} action={docs.some(([k]) => (p[k] || []).length) ? (
          <button type="button" onClick={() => navigate('/golda', { state: { tab: 'chat', prefill: he ? `קראי את המסמכים של ${playerName(p)} ובדקי אם תאריכי החוזה, הדרכון והייצוג במערכת תואמים למה שכתוב בהם.` : `Read ${playerName(p)}'s documents and check whether the contract, passport and representation dates in the CRM match them.` } })}
            style={{ background: 'none', border: 'none', color: 'var(--gold)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>{t('Ask Golda')}</button>
        ) : null}>
          {docs.every(([k]) => !(p[k] || []).length) ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{t('No documents uploaded yet.')}</p> : docs.map(([k, label, expires]) => (p[k] || []).map((f, i) => {
            const exp = f.expiresAt || expires;
            const d = exp ? daysAway(exp) : null;
            return (
              <button key={k + i} onClick={() => openFile(f)} style={{ display: 'flex', gap: 10, width: '100%', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--rule)', background: 'none', border: 'none', borderBottomStyle: 'solid', color: 'var(--text-1)', cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', fontSize: 13 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--gold)', minWidth: 60 }}>{label}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                {exp && <span style={{ fontSize: 10.5, color: d < 0 ? 'var(--red)' : d <= 30 ? 'var(--amber)' : 'var(--text-3)' }}>{d < 0 ? t('expired') : t('valid until')} {fmtDate(exp)}</span>}
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{f.uploadedAt ? fmtDate(f.uploadedAt) : ''}</span>
              </button>
            );
          }))}
        </Card>

        <Card title={t('Matches')} action={<Link to="/matches" style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>{t('View all')}</Link>}>
          {upcoming.length + recent.length === 0 ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{t('No matches scheduled.')}</p> : (
            <>
              {upcoming.length > 0 && <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700, marginBottom: 4 }}>{t('Upcoming matches')}</div>}
              {upcoming.map((m) => <div key={m.id} style={{ fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--rule)' }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gold)', marginInlineEnd: 8 }}>{fmtDate(m.date)}{m.time ? ` ${m.time}` : ''}</span>{m.homeTeam} – {m.awayTeam}</div>)}
              {recent.length > 0 && <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700, margin: '10px 0 4px' }}>{t('Recent matches')}</div>}
              {recent.map((m) => <div key={m.id} style={{ fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--rule)', color: 'var(--text-2)' }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', marginInlineEnd: 8 }}>{fmtDate(m.date)}</span>{m.homeTeam} – {m.awayTeam}{m.homeScore !== undefined && m.homeScore !== '' && m.homeScore !== null ? ` · ${m.homeScore}:${m.awayScore}` : ''}</div>)}
            </>
          )}
        </Card>

        <Card title={t('Open deals')}>
          {deals.filter((d) => !d.closedAt).length === 0 ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>—</p> : deals.filter((d) => !d.closedAt).map((d) => (
            <div key={d.id} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
              <span style={{ flex: 1 }}>{d.clubName}</span>
              <Link to={`/market/deals?deal=${d.id}`} className="badge" style={{ background: 'var(--gold-dim)', color: 'var(--gold)', textDecoration: 'none' }}>{he ? DEAL_STAGE_LABELS[d.stage] || d.stage : d.stage}</Link>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{d.enteredStageAt ? relDays(daysAway(d.enteredStageAt.slice(0, 10))) : ''}</span>
            </div>
          ))}
        </Card>

        <Card title={t('Related tasks')} action={<Link to="/tasks" style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>{t('View all')}</Link>}>
          {tasks.length === 0 ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>—</p> : tasks.map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--rule)', opacity: x.done ? 0.5 : 1 }}>
              <span style={{ flex: 1, textDecoration: x.done ? 'line-through' : 'none' }}>{x.title}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{x.dueDate ? fmtDate(x.dueDate) : ''}</span>
            </div>
          ))}
        </Card>

        <Card title={t('Timeline')}>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Write a note…')} onKeyDown={(e) => { if (e.key === 'Enter') saveNote(); }} style={{ flex: 1 }} />
              <button className="btn btn-secondary" onClick={saveNote}>{t('Add note')}</button>
            </div>
          )}
          {timeline.length === 0 ? <p style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{t('No interactions yet.')}</p> : timeline.slice(0, 30).map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--rule)', fontSize: 13 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', minWidth: 92, paddingTop: 2 }}>{fmtDateTime(x.at)}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--gold)', minWidth: 56, paddingTop: 3 }}>{t(x.kind)}</span>
              <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{x.text}{x.by ? <span style={{ color: 'var(--text-3)', fontSize: 11 }}> · {x.by.split('@')[0]}</span> : null}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
