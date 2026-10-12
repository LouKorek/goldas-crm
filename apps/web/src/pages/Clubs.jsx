import React, { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { listenCollection, addDoc_, updateDoc_, deleteDoc_, restoreDoc_, PATHS } from 'lib/db';
import { listenClubs, saveClubLogo } from 'data/clubs';
import { listenPlayers } from 'data/players';
import { listenDeals } from 'data/deals';
import { clubKey, playerName, DEAL_STAGE_LABELS, isYouthName } from '@goldas/domain';
import { PageHeader, Empty, Spinner, SearchInput, Modal, Field, RowActions, useConfirm, toast } from 'components/ui/UI';
import { ClubLogoOrAvatar } from 'pages/Requirements';
import Icon from 'components/ui/Icons';
import { useRole } from 'lib/roleContext';
import { fmtDate, calcAge } from 'lib/constants';
import { t } from 'lib/i18n';

const EMPTY = { name: '', country: 'Israel', leagueTier: '', website: '', notes: '', logoUrl: '' };

// Everything in the CRM that mentions a club, grouped by the club's key.
function useClubWorld() {
  const [clubs, setClubs] = useState([]);
  const [players, setPlayers] = useState([]);
  const [reqs, setReqs] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [matches, setMatches] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const u = [
      listenClubs((d) => { setClubs(d); setLoading(false); }),
      listenPlayers({}, setPlayers),
      listenCollection(PATHS.CLUB_REQUIREMENTS, setReqs),
      listenCollection(PATHS.CONTACTS, setContacts),
      listenCollection(PATHS.MATCHES, setMatches),
      listenDeals({}, setDeals),
    ];
    return () => u.forEach((f) => f());
  }, []);
  const byKey = useMemo(() => {
    const m = {};
    const add = (name, kind, item) => { const k = clubKey(name); if (!k) return; (m[k] = m[k] || { players: [], candidates: [], reqs: [], contacts: [], matches: [], deals: [] })[kind].push(item); };
    players.forEach((p) => {
      const st = p.stage || 'represented';
      if (st === 'represented') add(p.currentClub, 'players', p);
      else { add(p.currentClub, 'candidates', p); (p.linkedClubs || []).forEach((c) => add(c.clubName, 'candidates', { ...p, _linked: true })); }
    });
    reqs.forEach((r) => add(r.clubName, 'reqs', r));
    contacts.forEach((c) => add(c.clubName, 'contacts', c));
    matches.forEach((mt) => { add(mt.homeTeam, 'matches', mt); add(mt.awayTeam, 'matches', mt); });
    deals.forEach((d) => add(d.clubName, 'deals', d));
    return m;
  }, [players, reqs, contacts, matches, deals]);
  return { clubs, byKey, loading };
}

const Count = ({ n, label }) => (
  <span style={{ fontSize: 11, color: n ? 'var(--text-2)' : 'var(--text-mute)', whiteSpace: 'nowrap' }}>
    <b style={{ color: n ? 'var(--gold)' : 'inherit' }}>{n}</b> {label}
  </span>
);

export default function Clubs() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { clubs, byKey, loading } = useClubWorld();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog } = useConfirm();
  const { canEdit } = useRole();

  const rows = useMemo(() => clubs
    .map((c) => ({ ...c, world: byKey[c.key] || { players: [], candidates: [], reqs: [], contacts: [], matches: [], deals: [] } }))
    .filter((c) => !search || `${c.name} ${(c.aliases || []).join(' ')}`.toLowerCase().includes(search.toLowerCase())),
  [clubs, byKey, search]);

  const openAdd = () => { setForm({ ...EMPTY }); setModal('add'); };
  const openEdit = (c) => { setForm({ ...EMPTY, ...c }); setModal({ edit: c }); };
  const save = async () => {
    const name = form.name.trim();
    if (!name) { toast.error(t("Club name is required.")); return; }
    const key = clubKey(name);
    const dup = clubs.find((c) => c.key === key && c.id !== modal?.edit?.id);
    if (dup) { toast.error(`"${dup.name}" is already this club.`); return; }
    setSaving(true);
    try {
      const data = { name, key, country: form.country, leagueTier: form.leagueTier, website: form.website, notes: form.notes, logoUrl: form.logoUrl };
      if (modal === 'add') { await addDoc_(PATHS.CLUBS, { ...data, aliases: [] }); toast.success(`"${name}" added.`); }
      else { await updateDoc_(PATHS.CLUBS, modal.edit.id, data); toast.success(t("Club updated.")); }
      setModal(null);
    } catch (e) { toast.error(e.message || 'Save failed.'); }
    finally { setSaving(false); }
  };
  const del = async (c) => {
    if (!(await confirm(`Move "${c.name}" to the recycle bin? Records that mention it keep their text.`))) return;
    try { await deleteDoc_(PATHS.CLUBS, c.id); toast.success(t("Moved to the recycle bin."), { undo: () => restoreDoc_(PATHS.CLUBS, c.id) }); } catch (e) { toast.error(e.message); }
  };

  if (id) {
    const club = clubs.find((c) => c.id === id);
    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>;
    if (!club) return <Empty message={t("Club not found.")} action={<Link className="btn btn-secondary" to="/clubs">{t("All clubs")}</Link>} />;
    return <ClubDetail club={club} world={byKey[club.key] || {}} canEdit={canEdit} onEdit={() => openEdit(club)} modal={modal} setModal={setModal} form={form} setForm={setForm} save={save} saving={saving} dialog={dialog} />;
  }

  return (
    <div>
      <PageHeader title={t("Clubs")} subtitle={`${clubs.length} clubs · players, candidates, requirements and contacts in one place`}
        action={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canEdit && <button className="btn btn-primary" onClick={openAdd} style={{ height: 36 }}><Icon name="plus" size={12} /><span className="btn-text">{t("Add Club")}</span></button>}
          <div style={{ height: 36, display: 'flex', alignItems: 'center' }}><SearchInput value={search} onChange={setSearch} placeholder={t("Search clubs...")} /></div>
        </div>} />
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={36} /></div>
        : rows.length === 0 ? <Empty message={clubs.length ? 'No club matches the search.' : 'No clubs yet. They are created automatically from your records after the data migration, or add one here.'} />
        : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th style={{ width: 70 }}></th><th>{t("Club")}</th><th>{t("Represented")}</th><th>{t("Candidates")}</th><th>{t("Requirements")}</th><th>{t("Contacts")}</th><th>{t("Matches")}</th><th>{t("Deals")}</th></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/clubs/${c.id}`)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <RowActions onEdit={canEdit ? () => openEdit(c) : undefined} onDelete={canEdit ? () => del(c) : undefined} onView={() => navigate(`/clubs/${c.id}`)} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <ClubLogoOrAvatar name={c.name} size={30} src={c.logoUrl} onResolved={(u) => saveClubLogo(c, u)} />
                          <div>
                            <div style={{ fontWeight: 600 }}>{c.name}</div>
                            {(c.aliases || []).length > 0 && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{c.aliases.slice(0, 3).join(' · ')}{c.aliases.length > 3 ? ` +${c.aliases.length - 3}` : ''}</div>}
                          </div>
                        </div>
                      </td>
                      <td><Count n={c.world.players.length} label="" /></td>
                      <td><Count n={c.world.candidates.length} label="" /></td>
                      <td><Count n={c.world.reqs.length} label="" /></td>
                      <td><Count n={c.world.contacts.length} label="" /></td>
                      <td><Count n={c.world.matches.length} label="" /></td>
                      <td><Count n={c.world.deals.filter((d) => !d.closedAt).length} label="" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      {modal && <ClubModal modal={modal} setModal={setModal} form={form} setForm={setForm} save={save} saving={saving} />}
      {dialog}
    </div>
  );
}

function ClubModal({ modal, setModal, form, setForm, save, saving }) {
  const s = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal title={modal === 'add' ? 'Add Club' : `Edit: ${form.name}`} onClose={() => setModal(null)}
      footer={<><button className="btn btn-ghost" onClick={() => setModal(null)}>{t("Cancel")}</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button></>}>
      <Field label={t("Club name")} required><input value={form.name} onChange={s('name')} placeholder={t("Hapoel Tel Aviv")} /></Field>
      <Field label={t("Country")}><input value={form.country} onChange={s('country')} /></Field>
      <Field label={t("League tier")}><input value={form.leagueTier} onChange={s('leagueTier')} placeholder={t("Tier 1")} /></Field>
      <Field label={t("Website")}><input value={form.website} onChange={s('website')} placeholder="https://" /></Field>
      <Field label={t("Logo URL")} hint={t("Found automatically when empty.")}><input value={form.logoUrl} onChange={s('logoUrl')} placeholder="https://..." /></Field>
      <Field label={t("Notes")}><textarea value={form.notes} onChange={s('notes')} rows={3} /></Field>
    </Modal>
  );
}

function Section({ title, count, children }) {
  return (
    <div className="card" style={{ padding: 16, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{title}</div>
        <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>{count}</span>
      </div>
      {count === 0 ? <div style={{ fontSize: 12, color: 'var(--text-mute)' }}>—</div> : children}
    </div>
  );
}

function ClubDetail({ club, world, canEdit, onEdit, modal, setModal, form, setForm, save, saving, dialog }) {
  const w = { players: [], candidates: [], reqs: [], contacts: [], matches: [], deals: [], ...world };
  const openDeals = w.deals.filter((d) => !d.closedAt);
  const upcoming = w.matches.filter((m) => m.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
  return (
    <div>
      <PageHeader
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}><ClubLogoOrAvatar name={club.name} size={40} src={club.logoUrl} onResolved={(u) => saveClubLogo(club, u)} />{club.name}</span>}
        subtitle={[club.country, club.leagueTier, isYouthName(club.name) ? 'Youth' : ''].filter(Boolean).join(' · ') || 'Club'}
        action={<div style={{ display: 'flex', gap: 8 }}>
          <Link to="/clubs" className="btn btn-secondary" style={{ height: 36, textDecoration: 'none' }}>{t("All clubs")}</Link>
          {canEdit && <button className="btn btn-primary" onClick={onEdit} style={{ height: 36 }}><Icon name="edit" size={12} /><span className="btn-text">{t("Edit")}</span></button>}
        </div>} />
      {(club.aliases || []).length > 0 && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: -6 }}>{t("Also written as:")} {club.aliases.join(' · ')}</div>}
      {club.notes && <div className="card" style={{ padding: 12, marginTop: 12, fontSize: 13, whiteSpace: 'pre-wrap' }}>{club.notes}</div>}

      <Section title={t("Represented players")} count={w.players.length}>
        {w.players.map((p) => <Row key={p.id} to="/players" main={playerName(p)} sub={[p.primaryPosition, calcAge(p.dob) ? `${calcAge(p.dob)}y` : '', p.contractEnd ? `contract to ${fmtDate(p.contractEnd)}` : ''].filter(Boolean).join(' · ')} />)}
      </Section>
      <Section title={t("Candidates")} count={w.candidates.length}>
        {w.candidates.map((p, i) => <Row key={p.id + i} to={`/pipeline/${p.category || 'men'}`} main={playerName(p)} sub={[p._linked ? 'linked' : 'plays here', p.status].filter(Boolean).join(' · ')} />)}
      </Section>
      <Section title={t("Open deals")} count={openDeals.length}>
        {openDeals.map((d) => <Row key={d.id} to={`/pipeline/${d.category || 'men'}`} main={d.playerName} sub={`${DEAL_STAGE_LABELS[d.stage] || d.stage} · since ${fmtDate((d.enteredStageAt || '').slice(0, 10))}`} />)}
      </Section>
      <Section title={t("Requirements")} count={w.reqs.length}>
        {w.reqs.map((r) => <Row key={r.id} to="/requirements" main={r.requiredPosition || 'Position?'} sub={[r.gender, r.ageMin || r.ageMax ? `${r.ageMin || '?'}–${r.ageMax || '?'}` : '', r.salary].filter(Boolean).join(' · ')} />)}
      </Section>
      <Section title={t("Contacts")} count={w.contacts.length}>
        {w.contacts.map((c) => <Row key={c.id} to="/contacts" main={c.contactName} sub={[c.contactRole, c.contactPhone].filter(Boolean).join(' · ')} />)}
      </Section>
      <Section title={t("Upcoming matches")} count={upcoming.length}>
        {upcoming.map((m) => <Row key={m.id} to="/matches" main={`${m.homeTeam} – ${m.awayTeam}`} sub={`${fmtDate(m.date)} ${m.time || ''}`} />)}
      </Section>
      {modal && <ClubModal modal={modal} setModal={setModal} form={form} setForm={setForm} save={save} saving={saving} />}
      {dialog}
    </div>
  );
}

const Row = ({ to, main, sub }) => (
  <Link to={to} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)', textDecoration: 'none', color: 'inherit' }}>
    <span style={{ fontWeight: 500, fontSize: 13 }}>{main}</span>
    <span style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'end' }}>{sub}</span>
  </Link>
);
