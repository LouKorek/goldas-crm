// The touches of one contact: each time the agency reached this person (a
// WhatsApp message Lou sent from Golda's draft, a call, a meeting), newest
// first, and a small form to add one by hand. Stored on the contact as
// `touches` (packages/domain/src/schemas.ts touchSchema); Golda adds the
// WhatsApp ones after Lou confirms they went out (lib/golda-outreach.js).
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { touchesOf, lastTouch, playerName, israelDate } from '@goldas/domain';
import { listenCollection, updateDoc_, currentUserMeta, PATHS } from 'lib/db';
import { DateInput, ChipGroup, toast } from 'components/ui/UI';
import { t, locale } from 'lib/i18n';

const CHANNELS = ['call', 'meeting', 'whatsapp', 'email', 'other'];
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', call: 'Phone call', meeting: 'Meeting', email: 'Email', other: 'Other' };
export const channelLabel = (c) => t(CHANNEL_LABEL[c] || 'Other');

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit' });
};

/** The one-line summary for a row: "24/11/26 · WhatsApp", or null with no touches. */
export function lastTouchLine(contact) {
  const last = lastTouch(contact);
  return last ? `${shortDate(last.at)} · ${channelLabel(last.channel)}` : null;
}

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default function ContactTouches({ contact, canEdit }) {
  const [players, setPlayers] = useState([]);
  const today = israelDate(new Date());
  const [form, setForm] = useState({ date: today, channel: 'call', playerId: '', note: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => listenCollection(PATHS.PLAYERS, setPlayers), []);

  const names = useMemo(() => Object.fromEntries(players.map((p) => [p.id, playerName(p)])), [players]);
  const list = touchesOf(contact);
  const sortedPlayers = useMemo(() => [...players].sort((a, b) => playerName(a).localeCompare(playerName(b), locale())), [players]);

  const add = async () => {
    const note = form.note.trim();
    if (!note) { toast.error(t('Write in one line what it was about.')); return; }
    // A touch dated today keeps the time of day; an earlier day is stamped at noon.
    const at = form.date && form.date !== today ? new Date(`${form.date}T12:00:00`).toISOString() : new Date().toISOString();
    const touch = { id: newId(), at, channel: form.channel || 'other', by: currentUserMeta().email, playerId: form.playerId, dealId: '', note: note.slice(0, 140) };
    setSaving(true);
    try {
      await updateDoc_(PATHS.CONTACTS, contact.id, { touches: [...(Array.isArray(contact.touches) ? contact.touches : []), touch] });
      setForm({ date: today, channel: form.channel, playerId: '', note: '' });
      toast.success(t('Touch added.'));
    } catch {
      toast.error(t('Could not save. Please try again.'));
    } finally { setSaving(false); }
  };

  return (
    <div>
      {canEdit && (
        <div className="card" style={{ padding: 12, marginBottom: 14, display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{t('Add a touch')}</div>
          <ChipGroup options={CHANNELS} value={form.channel} onChange={(v) => setForm((p) => ({ ...p, channel: v || 'other' }))} labels={CHANNELS.map(channelLabel)} required />
          <div className="form-grid-2">
            <DateInput value={form.date} onChange={(v) => setForm((p) => ({ ...p, date: v || today }))} />
            <select value={form.playerId} onChange={(e) => setForm((p) => ({ ...p, playerId: e.target.value }))}>
              <option value="">{t('About a player (optional)')}</option>
              {sortedPlayers.map((p) => <option key={p.id} value={p.id}>{playerName(p)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={form.note} maxLength={140} onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder={t('What it was about, in one line')} style={{ flex: 1, minWidth: 0 }} />
            <button type="button" className="btn btn-primary" onClick={add} disabled={saving} style={{ flexShrink: 0 }}>{t('Add')}</button>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '8px 2px' }}>
          {t('No touches yet. When Golda drafts a message and you confirm it went out, it is recorded here.')}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 0 }}>
          {list.map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 2px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span className="ltr" style={{ fontSize: 12, color: 'var(--text-2)', minWidth: 62 }}>{shortDate(x.at)}</span>
              <span className="badge">{channelLabel(x.channel)}</span>
              {x.playerId && (names[x.playerId]
                ? <Link to={`/players/${x.playerId}`} style={{ fontSize: 13, fontWeight: 600, color: 'var(--gold)' }}>{names[x.playerId]}</Link>
                : <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{t('a player')}</span>)}
              <span style={{ fontSize: 13, color: 'var(--text-1)', flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>{x.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
