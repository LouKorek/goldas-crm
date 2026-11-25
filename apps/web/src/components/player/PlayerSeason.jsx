import React, { useMemo, useState } from 'react';
import { playerMatchRows, seasonsOf, summarizeStats, currentSeason } from '@goldas/domain';
import { ChipGroup } from 'components/ui/UI';
import { fmtDate } from 'lib/constants';
import { t } from 'lib/i18n';

// The player's season, from the numbers recorded on his matches
// (matches/{id}.playerStats): totals, and one column per match with minutes
// as the bar, goals as filled dots, assists as rings and the rating under it.
// Identity is carried by shape, not colour, so it reads the same in both
// themes and for colour-blind readers. Same SVG conventions as lib/charts.
const FONT = 'Heebo, Arial, sans-serif';
const W = 400;
const H = 180;
const PAD = { l: 26, r: 6, t: 36, b: 36 };
const MAX_MARKS = 3; // dots above a bar; more shows a +
const FULL = 90;
const MAX_COLS = 24;

const Tile = ({ label, value }) => (
  <div style={{ border: '1px solid var(--border)', borderTop: '2px solid var(--gold)', padding: '8px 10px', background: 'var(--card)' }}>
    <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 700 }}>{label}</div>
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--text-1)', lineHeight: 1.1, marginTop: 4 }}>{value}</div>
  </div>
);

// A bar with rounded data-end, anchored to the baseline.
const barPath = (x, y, w, h) => {
  const r = Math.min(3, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
};

function SeasonChart({ rows }) {
  const cols = [...rows].reverse().slice(-MAX_COLS); // oldest → newest, left to right
  const top = Math.max(FULL, ...cols.map((r) => Number(r.stat.minutes) || 0));
  const plotH = H - PAD.t - PAD.b;
  const slot = (W - PAD.l - PAD.r) / Math.max(cols.length, 1);
  const bw = Math.max(6, Math.min(22, slot * 0.6));
  const y = (v) => PAD.t + plotH - (v / top) * plotH;
  const every = Math.ceil(cols.length / 6); // date labels: about six at most
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Minutes, goals and assists per match')} direction="ltr"
      style={{ fontFamily: FONT, color: 'var(--text-1)', maxWidth: W, display: 'block' }}>
      {[45, FULL].map((g) => (
        <g key={g}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--border)" strokeDasharray={g === FULL ? '' : '3 3'} />
          <text x={PAD.l - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill="var(--text-3)">{g}′</text>
        </g>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--text-3)" />
      {cols.map((r, i) => {
        const s = r.stat;
        const min = Math.max(0, Number(s.minutes) || 0);
        const cx = PAD.l + slot * i + slot / 2;
        const x = cx - bw / 2;
        const g = Math.max(0, Number(s.goals) || 0);
        const a = Math.max(0, Number(s.assists) || 0);
        const marks = [...Array(g).fill('g'), ...Array(a).fill('a')].slice(0, MAX_MARKS);
        const tip = [`${fmtDate(r.date)} · ${r.homeTeam} – ${r.awayTeam}`, `${min}′`, g ? `${g} ${t('goals')}` : '', a ? `${a} ${t('assists')}` : '', s.rating != null ? `${t('Rating')} ${s.rating}` : ''].filter(Boolean).join(' · ');
        return (
          <g key={r.matchId || i}>
            <title>{tip}</title>
            <rect x={cx - slot / 2} y={0} width={slot} height={H} fill="transparent" />
            {min > 0
              ? <path d={barPath(x, y(min), bw, y(0) - y(min))} fill="var(--gold)" />
              : <line x1={x} x2={x + bw} y1={y(0) - 1} y2={y(0) - 1} stroke="var(--text-3)" strokeWidth="2" />}
            {marks.map((k, j) => (
              <circle key={j} cx={cx} cy={y(min) - 7 - j * 8} r="3.5"
                fill={k === 'g' ? 'var(--text-1)' : 'var(--card)'} stroke="var(--text-1)" strokeWidth="1.5" />
            ))}
            {g + a > MAX_MARKS && <text x={cx} y={y(min) - 4 - marks.length * 8} textAnchor="middle" fontSize="9" fill="var(--text-2)">+</text>}
            <text x={cx} y={y(0) + 14} textAnchor="middle" fontSize="11" fill="var(--text-2)" style={{ fontFamily: 'var(--font-mono)' }}>{s.rating != null ? s.rating : ''}</text>
            {i % every === 0 && <text x={cx} y={y(0) + 30} textAnchor="middle" fontSize="10.5" fill="var(--text-3)">{r.date.slice(8, 10)}/{r.date.slice(5, 7)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

const Key = ({ children, mark }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{mark}{children}</span>
);

export default function PlayerSeason({ playerId, matches }) {
  const rows = useMemo(() => playerMatchRows(matches, playerId), [matches, playerId]);
  const seasons = useMemo(() => seasonsOf(rows), [rows]);
  const [picked, setPicked] = useState('');
  const season = seasons.includes(picked) ? picked : (seasons.includes(currentSeason()) ? currentSeason() : seasons[0]);
  const inSeason = useMemo(() => rows.filter((r) => r.season === season), [rows, season]);
  const sum = summarizeStats(inSeason);

  return (
    <section className="card card-body" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div className="section-label" style={{ marginBottom: 0, flex: 1 }}>{t('Season')}{season ? ` ${season}` : ''}</div>
        {seasons.length > 1 && <ChipGroup options={seasons} labels={seasons} value={season} onChange={setPicked} required />}
      </div>
      {!rows.length ? (
        <p style={{ color: 'var(--text-3)', fontSize: 12.5, margin: 0 }}>{t('No match data yet. Enter minutes, goals and a rating on the Matches page, or tell Golda after the game.')}</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(60px, 1fr))', gap: 8, marginBottom: 12 }}>
            <Tile label={t('Matches')} value={sum.apps} />
            <Tile label={t('Minutes')} value={sum.minutes} />
            <Tile label={t('Goals')} value={sum.goals} />
            <Tile label={t('Assists')} value={sum.assists} />
            <Tile label={t('Avg. rating')} value={sum.avgRating ?? '—'} />
          </div>
          <SeasonChart rows={inSeason} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, color: 'var(--text-2)', marginTop: 6 }}>
            <Key mark={<span style={{ width: 10, height: 10, background: 'var(--gold)', borderRadius: 2 }} />}>{t('Minutes')}</Key>
            <Key mark={<span style={{ width: 8, height: 8, background: 'var(--text-1)', borderRadius: '50%' }} />}>{t('Goal')}</Key>
            <Key mark={<span style={{ width: 8, height: 8, border: '1.5px solid var(--text-1)', borderRadius: '50%' }} />}>{t('Assist')}</Key>
            <Key mark={<span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>7</span>}>{t('Rating (1–10)')}</Key>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 11.5, color: 'var(--gold)', cursor: 'pointer' }}>{t('Match by match')}</summary>
            <div style={{ overflowX: 'auto', marginTop: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--text-3)', fontSize: 10.5, textAlign: 'start' }}>
                    {[t('Date'), t('Match'), t('Min.'), t('G'), t('A'), t('Rating')].map((h) => <th key={h} style={{ textAlign: 'start', fontWeight: 700, padding: '4px 0', paddingInlineEnd: 10, whiteSpace: 'nowrap' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {inSeason.map((r) => (
                    <tr key={r.matchId} style={{ borderTop: '1px solid var(--rule)' }} title={r.stat.note || ''}>
                      <td style={{ padding: '5px 0', paddingInlineEnd: 10, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                      <td style={{ padding: '5px 0', paddingInlineEnd: 10 }}>{r.homeTeam} – {r.awayTeam}{r.stat.note && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.stat.note}</div>}</td>
                      <td style={{ padding: '5px 0', paddingInlineEnd: 10, fontFamily: 'var(--font-mono)' }}>{r.stat.minutes ?? '—'}</td>
                      <td style={{ padding: '5px 0', paddingInlineEnd: 10, fontFamily: 'var(--font-mono)' }}>{r.stat.goals ?? '—'}</td>
                      <td style={{ padding: '5px 0', paddingInlineEnd: 10, fontFamily: 'var(--font-mono)' }}>{r.stat.assists ?? '—'}</td>
                      <td style={{ padding: '5px 0', fontFamily: 'var(--font-mono)' }}>{r.stat.rating ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
