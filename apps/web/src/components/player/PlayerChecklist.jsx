import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { playerCompleteness, calendarBlock, playerName } from '@goldas/domain';
import { listenSyncReport, scoreTone } from 'data/completeness';
import { useRole } from 'lib/roleContext';
import { t, getLang } from 'lib/i18n';
import { PlayerCard } from './PlayerCard';

// The player's file, on his page: the score and what is missing, most
// important first, each with the shortest way to fix it (his edit form, or
// Golda for the website card). A player added in the last 30 days sees it as
// onboarding ("קליטת שחקן"), everyone else as completeness ("שלמות התיק").
// The list itself is the shared definition in @goldas/domain; only represented
// players have one. A complete file is one quiet line.

// Why the match sync cannot bring his games, in words (the codes of app_meta/syncWarnings).
const SYNC_WHY = {
  'no-club': 'No club on record', 'no-source': 'No country and league on record', 'ifa-url-missing': 'No IFA link',
  'ifa-url-invalid': 'IFA link not readable', 'ifa-url-has-no-id': 'IFA link has no player id', 'ifa-club-not-found': 'Club not found in the IFA register',
  'ifa-team-not-matched': 'Squad not identified', 'no-fixtures-or-team-not-found': 'Nothing found',
};

const linkBtn = { background: 'none', border: 'none', color: 'var(--gold)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', padding: 0, flexShrink: 0 };

export default function PlayerChecklist({ p }) {
  const navigate = useNavigate();
  const { canEdit } = useRole();
  const [report, setReport] = useState(undefined);
  useEffect(() => listenSyncReport(setReport), []);
  const c = playerCompleteness(p, { syncReport: report || null });
  if (!c) return null;

  const he = getLang() === 'he';
  const name = playerName(p);
  const label = (i) => i.label[he ? 'he' : 'en'];
  const edit = () => navigate('/players', { state: { editId: p.id, back: true } });
  const ask = (prefill) => navigate('/golda', { state: { tab: 'chat', prefill } });
  const askSite = () => ask(he ? `תוסיפי את ${name} לאתר gold-as.com. התמונה שלו מצורפת.` : `Add ${name} to the website gold-as.com. His picture is attached.`);
  const title = c.onboarding ? t('Player onboarding') : t('File completeness');
  const fix = (i) => {
    if (i.fix === 'golda') return <button type="button" style={linkBtn} onClick={askSite}>{t('Ask Golda')}</button>;
    return canEdit ? <button type="button" style={linkBtn} onClick={edit}>{t('Fill in')}</button> : null;
  };

  // A full-width strip above the cards, so its height never stretches them.
  const strip = { marginBottom: 14 };
  const unknown = c.unknown.length > 0 ? `${t('Not known yet')}: ${c.unknown.map(label).join(', ')}` : '';

  // A complete file: one quiet line, no list.
  if (c.missing.length === 0) {
    const done = c.onboarding ? t('Onboarding done: everything is in the file.') : t('The file is complete.');
    return <PlayerCard title={title} style={strip} note={unknown ? `${done} ${unknown}` : done} />;
  }

  return (
    <PlayerCard title={title} style={strip}
      action={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, lineHeight: 1, color: scoreTone(c.score) }} aria-label={`${t('Score')} ${c.score}`}>{c.score}%</span>}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700, marginBottom: 4 }}>{t('Missing')} · {c.missing.length}</div>
      {/* As many columns as fit: a long list stays short on a wide screen. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', columnGap: 24 }}>
        {c.missing.map((i) => {
          const why = i.key === 'calendar' ? SYNC_WHY[calendarBlock(p, { syncReport: report })] : null;
          return (
            <div key={i.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--rule)', minWidth: 0 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{label(i)}{why && <span style={{ color: 'var(--text-3)', fontSize: 11 }}> · {t(why)}</span>}</span>
              {fix(i)}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>{t('In the file')}: {c.done.map(label).join(', ') || '—'}</div>
      {unknown && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>{unknown}</div>}
    </PlayerCard>
  );
}
