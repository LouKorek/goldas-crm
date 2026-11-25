// The Contacts page's map view: the way to a club, who went cold, and the map
// itself, on the relationship engine (packages/domain/src/engines/network.ts).
// Reads what the Contacts page's readers may read; a deal shows as a link and a
// stage, never an amount. Editors add and remove the explicit "knows" links.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildNetwork, wayToClub, coldContacts, networkClubs, linksOf, cleanKnows, warmthOf, NET_LINK_LABELS, daysBetween } from '@goldas/domain';
import { listenCollection, updateDoc_, PATHS } from 'lib/db';
import { listenPlayers } from 'data/players';
import { listenMeetings } from 'data/meetings';
import { PhoneActions, toast, Empty } from 'components/ui/UI';
import { formatPhone, fmtDate } from 'lib/constants';
import Icon from 'components/ui/Icons';
import { t, getLang } from 'lib/i18n';
import { useRole } from 'lib/roleContext';
import NetworkMap, { WARMTH_COLOR } from './NetworkMap';

const COLD_CHOICES = [60, 90, 180, 365];
const SHOW_COLD = 12;
// The app's one short date (21/10/26), the same as every other list.
const fmt = (d) => (d ? fmtDate(d) : '');
const kindLabel = (kinds) => kinds.map((k) => NET_LINK_LABELS[k][getLang() === 'en' ? 'en' : 'he']).join(' · ');
const CHANNEL = { call: 'Call', whatsapp: 'WhatsApp', meeting: 'Meeting', email: 'Email', sms: 'SMS', requirement: 'Requirement', deal: 'Deal', touch: 'Touch' };
const channelLabel = (c) => t(CHANNEL[c] || c);
// A link that is a fact of a record (works at, plays at, a deal's own club), not a conversation: no date to show.
const isFact = (l) => l.kinds.every((k) => k === 'works_at' || k === 'plays_at' || k === 'represents') || (l.a.startsWith('d:') || l.b.startsWith('d:')) && !(l.a.startsWith('c:') || l.b.startsWith('c:'));
const ago = (date, today) => {
  if (!date) return t('No record');
  const d = daysBetween(date, today);
  if (d <= 0) return t('Today');
  return t('{n} days ago', { n: d });
};

function Dot({ warmth, size = 10 }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: WARMTH_COLOR[warmth], display: 'inline-block', flexShrink: 0 }} />;
}

/** "The way to a club": pick a club, see the chain of people with the last date on each link. */
function WayToClub({ net, club, setClub, onShow }) {
  const clubs = useMemo(() => networkClubs(net), [net]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(0);
  const paths = useMemo(() => (club ? wayToClub(net, club) : []), [net, club]);
  useEffect(() => { setOpen(0); }, [club]);
  useEffect(() => { onShow(paths[open] ? paths[open].steps : null); }, [paths, open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const term = q.trim().toLowerCase();
  const list = term ? clubs.filter((c) => c.name.toLowerCase().includes(term)).slice(0, 8) : [];
  const chosen = club && net.nodes.get(club);

  return (
    <section className="card" style={{ padding: 16 }} aria-labelledby="net-way">
      <h2 id="net-way" style={{ fontSize: 16, margin: 0 }}>{t('The way to a club')}</h2>
      <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '4px 0 10px' }}>{t('Who to call first, and through whom. Recent, warm links come before cold ones.')}</p>
      <div style={{ position: 'relative' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={chosen ? chosen.name : t('Type a club name')} aria-label={t('Club')} />
        {list.length > 0 && (
          <div className="card" style={{ position: 'absolute', zIndex: 5, insetInline: 0, top: '100%', marginTop: 4, padding: 4, boxShadow: 'var(--shadow-md)' }}>
            {list.map((c) => (
              <button key={c.id} type="button" className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => { setClub(c.id); setQ(''); }}>
                <span>{c.name}</span><span style={{ color: 'var(--text-3)', fontSize: 11 }}>{c.contacts ? t('{n} contacts', { n: c.contacts }) : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {chosen && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ fontSize: 14 }}>{chosen.name}</strong>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClub(null)}>{t('Clear')}</button>
          </div>
          {paths.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-2)' }}>{t('No way in yet: nobody there and nobody who knows someone there. Add a contact at the club, or a "knows" link on a contact.')}</p>}
          {paths.map((p, i) => (
            <div key={i} style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: i === open ? 'var(--surface-2)' : 'transparent' }}>
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={i === open} style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setOpen(i)}>
                <span>{i === 0 ? t('Best way') : t('Another way')}: {t('through {name}', { name: p.steps[1].node.name })}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{t('{n} steps', { n: p.steps.length - 1 })}</span>
              </button>
              {i === open && (
                <ol style={{ listStyle: 'none', margin: 0, padding: '4px 12px 12px' }}>
                  {p.steps.map((st, j) => (
                    <li key={st.node.id}>
                      {st.link && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingInlineStart: 4, margin: '2px 0', fontSize: 12, color: 'var(--text-2)' }}>
                          <span aria-hidden style={{ width: 2, height: 22, background: WARMTH_COLOR[st.warmth], marginInlineStart: 4 }} />
                          <Dot warmth={st.warmth} size={8} />
                          <span>{kindLabel(st.link.kinds)}</span>
                          {!isFact(st.link) && <span style={{ color: 'var(--text-3)' }}>{st.link.date ? fmt(st.link.date) : t('No record')}</span>}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="badge" style={{ minWidth: 22, justifyContent: 'center' }}>{j === 0 ? 'A&S' : j}</span>
                        <span style={{ fontWeight: j === 1 ? 700 : 500, fontSize: 14 }}>{j === 0 ? t('The agency') : st.node.name}</span>
                        {st.node.role && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{st.node.role}</span>}
                        {st.node.type === 'deal' && <span className="chip" style={{ fontSize: 10, padding: '1px 6px' }}>{t(st.node.stage)}</span>}
                        {st.node.type === 'contact' && st.node.phone && <span style={{ marginInlineStart: 'auto' }}><PhoneActions phone={st.node.phone} /></span>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
          {paths.length > 0 && <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => onShow(paths[open].steps, true)}>{t('Show on the map')}</button>}
        </div>
      )}
    </section>
  );
}

/** "Not spoken to for a long time": last date and channel, oldest first; no record apart. */
function ColdList({ net, onOpen }) {
  const [days, setDays] = useState(90);
  const [all, setAll] = useState(false);
  const [showNone, setShowNone] = useState(false);
  const { cold, noRecord, recent } = useMemo(() => coldContacts(net, days), [net, days]);
  const rows = all ? cold : cold.slice(0, SHOW_COLD);
  const clubName = (n) => (n.club && net.nodes.get(n.club) ? net.nodes.get(n.club).name : '');
  return (
    <section className="card" style={{ padding: 16 }} aria-labelledby="net-cold">
      <h2 id="net-cold" style={{ fontSize: 16, margin: 0 }}>{t('Not spoken to for a long time')}</h2>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 10px', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('More than')}</span>
        {COLD_CHOICES.map((d) => <button key={d} type="button" className={`chip${d === days ? ' active' : ''}`} onClick={() => setDays(d)}>{t('{n} days', { n: d })}</button>)}
      </div>
      {cold.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-2)' }}>{t('Everyone with a record was spoken to in this time.')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.node.id} style={{ borderTop: '1px solid var(--rule)' }}>
              <button type="button" className="net-row" onClick={() => onOpen(r.node.id)}>
                <Dot warmth={warmthOf(r.last.date, net.today)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.node.name}</span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>{[r.node.role, clubName(r.node)].filter(Boolean).join(' · ')}</span>
                </span>
                <span style={{ textAlign: 'end', fontSize: 12 }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{fmt(r.last.date)}</span>
                  <span style={{ display: 'block', color: 'var(--text-3)' }}>{channelLabel(r.last.channel)} · {ago(r.last.date, net.today)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cold.length > SHOW_COLD && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll(!all)}>{all ? t('Show fewer') : t('Show all {n}', { n: cold.length })}</button>}
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
        {t('{n} spoken to lately.', { n: recent })}{' '}
        {noRecord.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showNone} onClick={() => setShowNone(!showNone)}>{t('No record at all: {n}', { n: noRecord.length })}</button>
        )}
      </div>
      {showNone && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {noRecord.map((r) => <button key={r.node.id} type="button" className="chip" onClick={() => onOpen(r.node.id)}>{r.node.name}</button>)}
        </div>
      )}
    </section>
  );
}

/** One node's card: the contact's details, every link with its date, and the explicit links. */
function NodeCard({ net, id, contacts, onSelect, onEdit }) {
  const { canEdit, email } = useRole();
  const n = net.nodes.get(id);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('knows');
  const [busy, setBusy] = useState(false);
  if (!n) return null;
  const links = linksOf(net, id);
  const record = n.type === 'contact' ? contacts.find((c) => c.id === n.ref) : null;
  const last = n.type === 'contact' ? net.last.get(id) : null;
  const mine = record ? cleanKnows(record.knows, record.id) : [];
  const term = q.trim().toLowerCase();
  const pick = term ? contacts.filter((c) => c.id !== n.ref && (c.contactName || '').toLowerCase().includes(term)).slice(0, 6) : [];
  const save = async (next, msg) => {
    setBusy(true);
    try { await updateDoc_(PATHS.CONTACTS, record.id, { knows: next }); toast.success(msg); setQ(''); }
    catch (e) { toast.error(t('Could not save. Please try again.')); }
    finally { setBusy(false); }
  };
  const add = (c) => save([...mine.filter((k) => k.contactId !== c.id), { contactId: c.id, kind, note: '', at: new Date().toISOString(), by: email || '' }], t('Link saved.'));
  const remove = async (otherId) => {
    if (mine.some((k) => k.contactId === otherId)) return save(mine.filter((k) => k.contactId !== otherId), t('Link removed.'));
    // A link kept on the other contact.
    const o = contacts.find((c) => c.id === otherId);
    if (!o) return undefined;
    setBusy(true);
    try { await updateDoc_(PATHS.CONTACTS, o.id, { knows: cleanKnows(o.knows, o.id).filter((k) => k.contactId !== record.id) }); toast.success(t('Link removed.')); }
    catch (e) { toast.error(t('Could not save. Please try again.')); }
    finally { setBusy(false); }
    return undefined;
  };
  const explicit = links.filter((x) => x.node.type === 'contact' && x.link.kinds.some((k) => k === 'knows' || k === 'introduced'));
  const typeLabel = { contact: t('Contact'), club: t('Club'), deal: t('Deal'), player: t('Player'), agency: t('The agency') }[n.type];

  return (
    <section className="card" style={{ padding: 16 }} aria-label={n.name}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{typeLabel}</div>
          <h3 style={{ margin: '2px 0 0', fontSize: 16 }}>{n.type === 'agency' ? 'Gold A&S' : n.name}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{[n.role, n.club && net.nodes.get(n.club)?.name, n.type === 'deal' ? t(n.stage) : ''].filter(Boolean).join(' · ')}</div>
        </div>
        {record && canEdit && onEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(record)}>{t('Edit')}</button>}
        <button type="button" className="modal-close-btn" aria-label={t('Close')} onClick={() => onSelect(null)}><Icon name="close" size={13} /></button>
      </div>
      {record?.contactPhone && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <span className="ltr" style={{ fontSize: 13 }}>{formatPhone(record.contactPhone)}</span>
          <PhoneActions phone={record.contactPhone} />
        </div>
      )}
      {n.type === 'contact' && (
        <div style={{ marginTop: 8, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Dot warmth={warmthOf(last ? last.date : '', net.today)} />
          {last ? <span>{t('Last contact')}: <strong>{fmt(last.date)}</strong> · {channelLabel(last.channel)} · {ago(last.date, net.today)}</span> : <span>{t('No record of any contact yet.')}</span>}
        </div>
      )}
      <h4 style={{ fontSize: 13, margin: '14px 0 6px' }}>{t('Links')} ({links.length})</h4>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 260, overflowY: 'auto' }}>
        {links.map(({ link, node, warmth }) => (
          <li key={node.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--rule)', fontSize: 13 }}>
            <Dot warmth={isFact(link) ? 'none' : warmth} size={8} />
            <button type="button" className="net-link" onClick={() => onSelect(node.id)}>{node.type === 'agency' ? t('The agency') : node.name}</button>
            <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{kindLabel(link.kinds)}</span>
            <span style={{ marginInlineStart: 'auto', color: 'var(--text-3)', fontSize: 11 }}>{isFact(link) ? '' : fmt(link.date)}</span>
          </li>
        ))}
      </ul>
      {record && (
        <div style={{ marginTop: 14 }}>
          <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>{t('Knows')}</h4>
          {explicit.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0 }}>{t('No one yet.')}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {explicit.map(({ node, link }) => {
              const label = `${node.name}${link.kinds.includes('introduced') ? ` · ${t('introduction')}` : ''}`;
              // The whole chip takes the link off, like the chips of a meeting's people.
              return canEdit
                ? <button key={node.id} type="button" className="chip active" aria-label={t('Remove link to {name}', { name: node.name })} disabled={busy} onClick={() => remove(node.ref)}>{label} ✕</button>
                : <span key={node.id} className="chip active">{label}</span>;
            })}
          </div>
          {canEdit && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                <button type="button" className={`chip${kind === 'knows' ? ' active' : ''}`} onClick={() => setKind('knows')}>{t('{name} knows…', { name: n.name })}</button>
                <button type="button" className={`chip${kind === 'introduced' ? ' active' : ''}`} onClick={() => setKind('introduced')}>{t('{name} introduced us to…', { name: n.name })}</button>
              </div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Type a contact name')} aria-label={t('Add a link')} />
              {pick.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                  {pick.map((c) => <button key={c.id} type="button" className="btn btn-ghost btn-sm" disabled={busy} style={{ justifyContent: 'flex-start' }} onClick={() => add(c)}>{c.contactName}{c.clubName ? ` · ${c.clubName}` : ''}</button>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function ContactNetwork({ contacts, search = '', onEdit, params, setParams }) {
  const [clubs, setClubs] = useState([]);
  const [deals, setDeals] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [players, setPlayers] = useState([]);
  const [path, setPath] = useState(null);
  // Open on the node the address names (?contact= or ?node=), centred.
  const [focus, setFocus] = useState(() => params.get('node') || (params.get('contact') ? `c:${params.get('contact')}` : null));
  const mapRef = useRef(null);

  useEffect(() => {
    const u = [
      listenCollection(PATHS.CLUBS, setClubs),
      // Only what the map reads of a deal: its money never reaches the map.
      listenCollection(PATHS.DEALS, (rows) => setDeals(rows.map(({ id, playerId, playerName, clubId, clubName, stage, requirementId, enteredStageAt, closedAt, history, createdAt }) =>
        ({ id, playerId, playerName, clubId, clubName, stage, requirementId, enteredStageAt, closedAt, history: (history || []).map((h) => ({ at: h && h.at })), createdAt })))),
      listenCollection(PATHS.CLUB_REQUIREMENTS, setRequirements),
      listenMeetings(setMeetings),
      listenPlayers({}, setPlayers),
    ];
    return () => u.forEach((f) => typeof f === 'function' && f());
  }, []);

  const net = useMemo(() => buildNetwork({ contacts, clubs, deals, requirements, meetings, players }), [contacts, clubs, deals, requirements, meetings, players]);
  const club = params.get('club') || null;
  const contactParam = params.get('contact');
  const selected = params.get('node') || (contactParam ? `c:${contactParam}` : null);
  const set = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k === 'node') p.delete('contact'); setParams(p, { replace: true }); };
  const select = (id) => { set('node', id); if (id) setFocus(id); };
  const open = (id) => { select(id); setTimeout(() => mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); };

  const term = search.trim().toLowerCase();
  const highlight = useMemo(() => new Set(term ? [...net.nodes.values()].filter((n) => n.type === 'contact' && `${n.name} ${n.role || ''}`.toLowerCase().includes(term)).map((n) => n.id) : []), [net, term]);

  if (!contacts.length) return <Empty message={t('No contacts yet. Add the first one.')} />;

  return (
    <div className="net-view" style={{ display: 'grid', gap: 16 }}>
      <div className="net-lists" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))', alignItems: 'start' }}>
        <WayToClub net={net} club={club} setClub={(id) => set('club', id)}
          onShow={(steps, go) => { setPath(steps); if (go && steps) { setFocus(steps[steps.length - 1].node.id); mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }} />
        <ColdList net={net} onOpen={open} />
      </div>
      <div ref={mapRef} className={`net-map-row${selected ? ' net-map-row--card' : ''}`}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>{t('The map')}</h2>
          <NetworkMap net={net} selected={selected} onSelect={select} path={path} focus={focus} highlight={highlight} />
        </div>
        {selected && <NodeCard net={net} id={selected} contacts={contacts} onSelect={select} onEdit={onEdit} />}
      </div>
    </div>
  );
}
