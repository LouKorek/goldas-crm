import React, { useState, useEffect, useMemo } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from 'lib/firebase';
import { listenCollection, PATHS } from 'lib/db';
import { fmtDate } from 'lib/constants';
import { PageHeader, ChipGroup, Empty, Spinner, toast } from 'components/ui/UI';
import Icon from 'components/ui/Icons';
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
  const W = 900, H = height, PAD_X = 52, PAD_Y = 26;
  const vals = days.map(d => d.followers);
  let min = Math.min(...vals), max = Math.max(...vals);
  // A flat run (every snapshot identical) would collapse the scale and pin the
  // line to the floor, which reads as a broken chart rather than a steady
  // count. Give it breathing room so it sits mid-height.
  if (max - min < 2) { const c = (max + min) / 2; min = Math.floor(c - 2); max = Math.ceil(c + 2); }
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

// New followers per day. Instagram retains 30 days of this, so it exists for
// dates that predate our own snapshots — which is why it gets its own strip
// instead of being folded into the follower curve above.
function DailyBars({ days, postDays, height = 150 }) {
  const withData = days.filter(d => d.newFollowers != null);
  if (withData.length < 2) return null;

  const W = 900, H = height, PAD_X = 52, PAD_T = 22, PAD_B = 34;
  const max   = Math.max(...withData.map(d => d.newFollowers), 1);
  const total = withData.reduce((s, d) => s + d.newFollowers, 0);
  const best  = withData.reduce((a, b) => (b.newFollowers > a.newFollowers ? b : a));
  const plot  = H - PAD_T - PAD_B;
  const step  = (W - PAD_X * 2) / Math.max(days.length, 1);
  const bw    = Math.max(Math.min(step - 3, 26), 3);
  const cx    = (i) => PAD_X + step * i + step / 2;
  const y     = (v) => PAD_T + plot - (v / max) * plot;

  // Every bar gets its number only when the bars are wide enough to carry one;
  // otherwise the peak is called out and the rest are read off the scale.
  const labelAll = days.length <= 16;
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  const xLabelAt = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '0 2px 2px' }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-2)' }}>
          New follows per day
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
          {total.toLocaleString()} in this period · best day {best.newFollowers} on {fmtDate(best.date)}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', padding: '0 2px 8px', lineHeight: 1.5 }}>
        One bar per day; its height is how many accounts started following that day.
        These are arrivals only — the line above is the net total, after people who left.
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD_X} x2={W - PAD_X} y1={y(v)} y2={y(v)}
              stroke={v === 0 ? 'rgba(212,176,98,0.35)' : 'rgba(212,176,98,0.12)'} strokeWidth="1" />
            <text x={PAD_X - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-3)">{v}</text>
          </g>
        ))}

        {days.map((d, i) => {
          if (d.newFollowers == null) return null;
          const h = Math.max((d.newFollowers / max) * plot, d.newFollowers > 0 ? 2 : 0);
          const isPost = postDays && postDays.has(d.date);
          return (
            <g key={d.date}>
              <rect x={cx(i) - bw / 2} y={PAD_T + plot - h} width={bw} height={h}
                fill={isPost ? 'rgba(107,174,245,0.85)' : 'rgba(107,174,245,0.40)'}>
                <title>{`${fmtDate(d.date)} \u00b7 ${d.newFollowers} new${isPost ? ' \u00b7 post published' : ''}`}</title>
              </rect>
              {(labelAll || d.date === best.date) && d.newFollowers > 0 && (
                <text x={cx(i)} y={PAD_T + plot - h - 5} textAnchor="middle" fontSize="10.5"
                  fill="var(--text-2)" fontWeight="600">{d.newFollowers}</text>
              )}
            </g>
          );
        })}

        {xLabelAt.map(i => (
          <text key={i} x={cx(i)} y={H - 12}
            textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
            fontSize="11" fill="var(--text-3)">{fmtDate(days[i].date)}</text>
        ))}
      </svg>

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-3)', padding: '4px 2px 0' }}>
        <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'rgba(107,174,245,0.85)', marginRight: 5, verticalAlign: 'middle' }} />Day a post went live</span>
        <span><span style={{ display: 'inline-block', width: 9, height: 9, background: 'rgba(107,174,245,0.40)', marginRight: 5, verticalAlign: 'middle' }} />Ordinary day</span>
      </div>
    </div>
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

  const { days, barDays, postDays, kpis, postList } = useMemo(() => {
    // Two kinds of day exist: our own snapshots (absolute follower totals) and
    // days backfilled from Instagram's 30-day insight history, which carry
    // per-day movement but no total. Both belong on the timeline; each chart
    // picks the rows it can actually plot.
    const sorted = [...daily]
      .filter(d => d.date && (d.followers != null || d.newFollowers != null))
      .sort((a, b) => a.date.localeCompare(b.date));
    const snaps = sorted.filter(d => d.followers != null);
    const limit = RANGE_DAYS[range];
    const dayWindow = limit === Infinity ? snaps : snaps.slice(-limit);

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
    const byDate = new Map(snaps.map(d => [d.date, d]));
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

    const barWindow = limit === Infinity ? sorted : sorted.slice(-limit);

    return {
      days: dayWindow,
      barDays: barWindow,
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
          <>Instagram — <a href={IG_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--gold)', textDecoration: 'none' }}>@goldas_loukorek ↗</a> · collected daily from the account</>
        }
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isAdmin && (
              <button className="btn btn-secondary btn-sm" style={{ height: 36 }} onClick={syncNow} disabled={syncing}>
                {syncing ? <><Spinner size={12} /><span className="btn-text">Syncing…</span></> : <><Icon name="refresh" size={12} /><span className="btn-text">Sync now</span></>}
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
          {' '}· Source: Instagram API
          {/* Shown only while the most recent run is actually failing —
              the collector clears this the moment a run succeeds. */}
          {meta?.lastError && (
            <div style={{ color: 'var(--red)', marginTop: 4, overflowWrap: 'anywhere' }}>
              Error: {String(meta.lastError)}
              {/^IG_ACCESS_TOKEN/.test(String(meta.lastError)) && (
                <div style={{ color: 'var(--text-3)', marginTop: 3 }}>
                  Add IG_ACCESS_TOKEN (and IG_USER_ID) to the Netlify environment variables, then sync again.
                </div>
              )}
            </div>
          )}
        </div>
      </PageHeader>

      {daily.length === 0 ? (
        <Empty message="No Instagram data yet — snapshots begin once the daily collector runs (or hit Sync now)."
          action={isAdmin ? <button className="btn btn-primary" onClick={syncNow} disabled={syncing}>First snapshot</button> : null} />
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
            <div className="section-label">Follower growth</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
              Total followers on each day we took a snapshot. Blue markers along the
              bottom are days a post went live — a rise just after one is the post working.
            </div>
            <TrendChart days={days} postDays={postDays} />
            <DailyBars days={barDays} postDays={postDays} />
          </div>

          {/* Posts */}
          <div className="section-label">Posts · engagement &amp; follower impact</div>
          {postList.length === 0 ? (
            <Empty message="Post data appears once Instagram serves the post feed to the collector." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                              borderRadius: 0, padding: '2px 9px', fontSize: 10.5, fontWeight: 600,
                            }} title="Follower change in the 3 days after this post">
                              {p.impact >= 0 ? '+' : ''}{p.impact} followers / 3d
                            </span>
                          )}
                        </div>
                        {/* Two bare numbers side by side told you nothing about
                            which was which. */}
                        <div className="m-meta" style={{ marginTop: 6 }}>
                          {p.likes != null && <span>{fmtNum(p.likes)} likes</span>}
                          {p.comments != null && <span>{fmtNum(p.comments)} comments</span>}
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
