// The touches of one contact: each time the agency reached this person (a
// WhatsApp message Lou sent from Golda's draft, a call, a meeting), newest
// first, and a small form to add one by hand. Stored on the contact as
// `touches` (packages/domain/src/schemas.ts touchSchema); Golda adds the
// WhatsApp ones after Lou confirms they went out (lib/golda-outreach.js).
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { touchesOf, lastTouch, playerName, israelDate } from '@goldas/domain';
import { listenCollection, updateDoc_, currentUserMeta, PATHS } from 'lib/db';
import { DateInput, ChipGroup, Field, toast } from 'components/ui/UI';
import { fmtDate } from 'lib/constants';
import { t, locale } from 'lib/i18n';

const CHANNELS = ['call', 'meeting', 'whatsapp', 'email', 'other'];
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', call: 'Phone call', meeting: 'Meeting', email: 'Email', other: 'Other' };
export const channelLabel = (c) => t(CHANNEL_LABEL[c] || 'Other');

// The app's one short date (24/11/26), the same as every other list.
const shortDate = (iso) => (iso && !Number.isNaN(new Date(iso).getTime()) ? fmtDate(iso) : '');

/** The one-line summary for a row: "24/11/26 · WhatsApp", or null with no touches. */
export function lastTouchLine(contact) {
  const last = lastTouch(contact);
  return last ? `${shortDate(last.at)} · ${channelLabel(last.channel)}` : null;
}

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** onDirty(bool): tells the window that a note was typed and not added yet, so closing asks first. */
export default function ContactTouches({ contact, canEdit, onDirty }) {
  const [players, setPlayers] = useState([]);
  const today = israelDate(new Date());
  const [form, setForm] = useState({ date: today, channel: 'call', playerId: '', note: '' });
  const [saving, setSaving] = useState(false);
  const [noteError, setNoteError] = useState('');
  useEffect(() => listenCollection(PATHS.PLAYERS, setPlayers), []);
  const dirty = !!form.note.trim();
  useEffect(() => { if (onDirty) onDirty(dirty); }, [dirty, onDirty]);

  const names = useMemo(() => Object.fromEntries(players.map((p) => [p.id, playerName(p)])), [players]);
  const list = touchesOf(contact);
  const sortedPlayers = useMemo(() => [...players].sort((a, b) => playerName(a).localeCompare(playerName(b), locale())), [players]);

  const add = async () => {
    const note = form.note.trim();
    if (!note) { setNoteError(t('Write in one line what it was about.')); return; }
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
          <Field label={t('How we reached them')}>
            <ChipGroup options={CHANNELS} value={form.channel} onChange={(v) => setForm((p) => ({ ...p, channel: v || 'other' }))} labels={CHANNELS.map(channelLabel)} required />
          </Field>
          <div className="form-grid-2">
            <Field label={t('Date')}>
              <DateInput value={form.date} onChange={(v) => setForm((p) => ({ ...p, date: v || today }))} />
            </Field>
            <Field label={t('About a player (optional)')}>
              <select value={form.playerId} onChange={(e) => setForm((p) => ({ ...p, playerId: e.target.value }))}>
                <option value="">{t('No player')}</option>
                {sortedPlayers.map((p) => <option key={p.id} value={p.id}>{playerName(p)}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t('What it was about, in one line')} error={noteError} required>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={form.note} maxLength={140} aria-invalid={!!noteError} onChange={(e) => { setNoteError(''); setForm((p) => ({ ...p, note: e.target.value })); }}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }} style={{ flex: 1, minWidth: 0 }} />
              <button type="button" className="btn btn-primary" onClick={add} disabled={saving} style={{ flexShrink: 0 }}>{t('Add')}</button>
            </div>
          </Field>
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
