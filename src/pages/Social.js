import React, { useState, useEffect, useMemo } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, PATHS } from 'lib/db';
import { fmtDate } from 'lib/constants';
import { PageHeader, ChipGroup, Empty, Spinner, toast, ScraperCredits } from 'components/ui/UI';
import { useRole } from 'lib/roleContext';

// Social dashboard — Instagram growth for @goldas_loukorek, built from the
// daily PUBLIC snapshots collected by ig-watch-background (no account access).

const IG_URL = 'https://www.instagram.com/goldas_loukorek/';
const RANGES = ['14D', '30D', '90D', 'All'];
const RANGE_DAYS = { '14D': 14, '30D': 30, '90D': 90, 'All': Infinity };
const TYPE_META = {
  image:    { emoji: '🖼', label: 'Photo' },
  carousel: { emoji: '🎞', label: 'Carousel' },
  video:    { emoji: '📹', label: 'Reel / Video' },
};

const tsToDate = (ts) => (ts && typeof ts.toDate === 'function') ? ts.toDate() : (ts ? new Date(ts) : null);
const fmtNum = (n) => (n == null ? '—' : n.toLocaleString());

// ── Minimal SVG line chart with post-day markers ──────────────────
function TrendChart({ days, postDays, height = 220 }) {
  if (days.length < 2) {
    return (
      <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
        Trends appear after at least two daily snapshots — the collector runs every morning.
      </div>
    );
  }
  const W = 900, H = height, PAD_X = 46, PAD_Y = 22;
  const vals = days.map(d => d.followers);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(max - min, 1);
  const x = (i) => PAD_X + (i / (days.length - 1)) * (W - PAD_X * 2);
  const y = (v) => H - PAD_Y - ((v - min) / span) * (H - PAD_Y * 2);
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(days.length - 1).toFixed(1)},${H - PAD_Y} L${x(0).toFixed(1)},${H - PAD_Y} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="sg-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(212,176,98,0.30)" />
          <stop offset="100%" stopColor="rgba(212,176,98,0)" />
        </linearGradient>
      </defs>
      {/* gridlines: min / mid / max */}
      {[min, (min + max) / 2, max].map((v, i) => (
        <g key={i}>
          <line x1={PAD_X} x2={W - PAD_X} y1={y(v)} y2={y(v)} stroke="rgba(212,176,98,0.10)" strokeWidth="1" />
          <text x={PAD_X - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-3)">
            {Math.round(v).toLocaleString()}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#sg-fill)" />
      <path d={path} fill="none" stroke="var(--gold)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {/* post-day markers */}
      {days.map((d, i) => postDays.has(d.date) && (
        <g key={d.date}>
          <line x1={x(i)} x2={x(i)} y1={PAD_Y} y2={H - PAD_Y} stroke="rgba(107,174,245,0.20)" strokeWidth="1.5" />
          <circle cx={x(i)} cy={H - PAD_Y} r="4" fill="var(--blue)">
            <title>{`Post published · ${fmtDate(d.date)}`}</title>
          </circle>
        </g>
      ))}
      {/* end-point */}
      <circle cx={x(days.length - 1)} cy={y(vals[vals.length - 1])} r="4.5" fill="var(--gold)" />
      {/* x labels: first / last */}
      <text x={x(0)} y={H - 4} textAnchor="start" fontSize="11" fill="var(--text-3)">{fmtDate(days[0].date)}</text>
      <text x={x(days.length - 1)} y={H - 4} textAnchor="end" fontSize="11" fill="var(--text-3)">{fmtDate(days[days.length - 1].date)}</text>
    </svg>
  );
}

function Kpi({ label, value, delta, deltaLabel }) {
  const up = delta > 0, down = delta < 0;
  return (
    <div className="card" style={{ padding: '14px 18px', flex: '1 1 140px', minWidth: 130 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, color: 'var(--gold)', lineHeight: 1.15, marginTop: 4 }}>{value}</div>
      {delta != null && (
        <div style={{ fontSize: 11.5, marginTop: 3, color: up ? 'var(--green-ok)' : down ? 'var(--red)' : 'var(--text-3)' }}>
          {up ? '▲' : down ? '▼' : '•'} {Math.abs(delta).toLocaleString()}{deltaLabel ? ` ${deltaLabel}` : ''}
        </div>
      )}
    </div>
  );
}

export default function Social() {
  const { isAdmin } = useRole();
  const [daily, setDaily] = useState([]);
  const [posts, setPosts] = useState([]);
  const [meta, setMeta]   = useState(null);
  const [range, setRange] = useState('30D');
  const [syncing, setSyncing] = useState(false);

  useEffect(() => listenCollection(PATHS.IG_DAILY, setDaily), []);
  useEffect(() => listenCollection(PATHS.IG_POSTS, setPosts), []);
  useEffect(() => onSnapshot(doc(db, 'app_meta', 'igWatch'),
    s => setMeta(s.exists() ? s.data() : null), () => setMeta(null)), []);

  const { days, postDays, kpis, postList } = useMemo(() => {
    const sorted = [...daily].filter(d => d.date && d.followers != null).sort((a, b) => a.date.localeCompare(b.date));
    const limit = RANGE_DAYS[range];
    const dayWindow = limit === Infinity ? sorted : sorted.slice(-limit);

    const allPosts = [...posts].sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''));
    const pDays = new Set(allPosts.map(p => (p.takenAt || '').slice(0, 10)).filter(Boolean));

    // Followers delta over the visible window.
    const first = dayWindow[0], last = dayWindow[dayWindow.length - 1];
    const deltaFollowers = first && last ? last.followers - first.followers : null;
    const deltaFollowing = first && last && first.following != null && last.following != null ? last.following - first.following : null;
    const deltaPosts     = first && last && first.postCount != null && last.postCount != null ? last.postCount - first.postCount : null;

    // Engagement: average likes+comments across known posts.
    const engPosts = allPosts.filter(p => p.likes != null);
    const avgEng = engPosts.length
      ? Math.round(engPosts.reduce((s2, p) => s2 + (p.likes || 0) + (p.comments || 0), 0) / engPosts.length)
      : null;
    const engRate = avgEng != null && meta?.followers ? ((avgEng / meta.followers) * 100).toFixed(1) : null;

    // Post impact: follower change from the snapshot on post day to +3 days.
    const byDate = new Map(sorted.map(d => [d.date, d]));
    const impact = (p) => {
      const d0s = (p.takenAt || '').slice(0, 10);
      if (!d0s || !byDate.size) return null;
      const base = byDate.get(d0s) || [...byDate.values()].filter(d => d.date <= d0s).pop();
      if (!base) return null;
      const horizon = [...byDate.values()].filter(d => d.date > base.date && d.date <= addDays(d0s, 3)).pop();
      if (!horizon) return null;
      return horizon.followers - base.followers;
    };
    const withImpact = allPosts.map(p => ({ ...p, impact: impact(p) }));

    return {
      days: dayWindow,
      postDays: pDays,
      kpis: { deltaFollowers, deltaFollowing, deltaPosts, avgEng, engRate },
      postList: withImpact,
    };
  }, [daily, posts, range, meta]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await fetch('/.netlify/functions/ig-watch-background', { method: 'POST' });
      toast.success('Snapshot started — data refreshes in under a minute.');
    } catch (e) { toast.error('Could not start snapshot.'); }
    setTimeout(() => setSyncing(false), 4000);
  };

  const lastRun = tsToDate(meta?.lastRunAt);

  return (
    <div>
      <PageHeader
        title="Social"
        subtitle={
          <>Instagram — <a href={IG_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)', textDecoration: 'none' }}>@goldas_loukorek ↗</a> · public data, collected daily</>
        }
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isAdmin && (
              <button className="btn btn-secondary btn-sm" style={{ height: 36 }} onClick={syncNow} disabled={syncing}>
                {syncing ? <><Spinner size={12} /> Syncing…</> : '🔄 Sync now'}
              </button>
            )}
          </div>
        }
      >
        <div className="filter-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <ChipGroup options={RANGES} value={range} onChange={setRange} required />
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-3)' }}>
          {lastRun
            ? <>Last snapshot: {fmtDate(lastRun.toISOString().slice(0, 10))} {lastRun.toTimeString().slice(0, 5)} · {daily.length} days collected</>
            : 'No snapshot yet — the first daily run starts the history.'}
          {meta?.lastError && <span style={{ color: 'var(--red)' }}> · Last error: {String(meta.lastError).slice(0, 90)}</span>}
          {' '}· <ScraperCredits />
        </div>
      </PageHeader>

      {daily.length === 0 ? (
        <Empty icon="📸" message="No Instagram data yet — snapshots begin once the daily collector runs (or hit Sync now)."
          action={isAdmin ? <button className="btn btn-primary" onClick={syncNow} disabled={syncing}>🔄 First snapshot</button> : null} />
      ) : (
        <>
          {/* KPI row */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <Kpi label="Followers" value={fmtNum(meta?.followers)} delta={kpis.deltaFollowers} deltaLabel={`in ${range === 'All' ? 'total' : range}`} />
            <Kpi label="Following" value={fmtNum(meta?.following)} delta={kpis.deltaFollowing} deltaLabel={range === 'All' ? '' : `in ${range}`} />
            <Kpi label="Posts" value={fmtNum(meta?.postCount)} delta={kpis.deltaPosts} deltaLabel={range === 'All' ? '' : `in ${range}`} />
            <Kpi label="Avg engagement" value={kpis.avgEng != null ? fmtNum(kpis.avgEng) : '—'} delta={null} deltaLabel="" />
            <Kpi label="Engagement rate" value={kpis.engRate != null ? `${kpis.engRate}%` : '—'} delta={null} deltaLabel="" />
          </div>

          {/* Followers trend + post markers */}
          <div className="card" style={{ padding: '16px 18px', marginBottom: 16 }}>
            <div className="section-label">Followers over time</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
              Blue dots mark days a post went live — spikes right after them show what converts.
            </div>
            <TrendChart days={days} postDays={postDays} />
          </div>

          {/* Posts */}
          <div className="section-label">Posts · engagement &amp; follower impact</div>
          {postList.length === 0 ? (
            <Empty icon="🖼" message="Post data appears once Instagram serves the post feed to the collector." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 980 }}>
              {postList.map(p => {
                const t = TYPE_META[p.type] || TYPE_META.image;
                return (
                  <div key={p.shortcode} className="card card-body" style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <a href={p.url} target="_blank" rel="noopener noreferrer"
                            style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-1)', textDecoration: 'none' }}>
                            {t.emoji} {t.label} <span style={{ color: 'var(--gold)', fontSize: 12 }}>↗</span>
                          </a>
                          {p.takenAt && <span className="m-sub">{fmtDate(p.takenAt.slice(0, 10))}</span>}
                          {p.impact != null && (
                            <span style={{
                              background: p.impact >= 0 ? 'var(--green-bg)' : 'var(--red-bg)',
                              color: p.impact >= 0 ? 'var(--green-ok)' : 'var(--red)',
                              borderRadius: 999, padding: '2px 9px', fontSize: 10.5, fontWeight: 600,
                            }} title="Follower change in the 3 days after this post">
                              {p.impact >= 0 ? '+' : ''}{p.impact} followers / 3d
                            </span>
                          )}
                        </div>
                        <div className="m-meta" style={{ marginTop: 6 }}>
                          {p.likes != null && <span>❤️ {fmtNum(p.likes)}</span>}
                          {p.comments != null && <span>💬 {fmtNum(p.comments)}</span>}
                        </div>
                        {p.caption && (
                          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                            {p.caption}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
