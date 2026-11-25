// /p/<token>: a player's live page, the private link the owner sends to a
// club. Photo, key facts, video, this season's totals and the CV, in the
// agency's public look (gold-as.com), not the CRM's theme. No sign-in: the
// token in the link is the key, good until the link expires or is revoked
// (netlify/functions/player-page.js). The page shows only what that function
// returns, and that function returns only what a club may see.
import React, { useEffect, useState } from 'react';
import { loadPlayerPage, loadPlayerPhoto, playerCvUrl } from 'data/playerPages';
import HE from '../i18n/he.js';

// The agency's public colours. This page is the one place they are written
// out: it must look like gold-as.com in either CRM theme.
const GREEN = '#0d3d2e';
const CARD = 'rgb(13,28,21)';
const GOLD = '#c9a227';
const INK = '#f4f0e6';
const MUTED = 'rgba(244,240,230,0.64)';
const RULE = 'rgba(201,162,39,0.24)';
const LOGO = '/logo.png';

const TEXT = {
  en: {
    agency: 'Football Agency', age: 'Age', born: 'Born', height: 'Height', metres: 'metres', foot: 'Foot', position: 'Position',
    profile: 'Profile', nationality: 'Nationality', club: 'Current club', freeAgent: 'Free agent', natTeam: 'National team',
    otherPos: 'Other positions', video: 'Highlights', watch: 'Watch the video', play: 'Play the video', openYouTube: 'Open on YouTube',
    season: 'Season', cv: 'Download CV', tm: 'Transfermarkt profile', link: 'Player profile', contact: 'Contact',
    until: 'Private link, valid until', preview: 'Preview. Your own look at this page is not counted as an opening.',
    former: 'Former', youth: 'Youth', foot_: { Right: 'Right', Left: 'Left', Both: 'Both' },
    stats: { games: 'Games', starts: 'Starts', minutes: 'Minutes', goals: 'Goals', assists: 'Assists', cleanSheets: 'Clean sheets', yellow: 'Yellow cards', red: 'Red cards' },
  },
  he: {
    agency: 'סוכנות כדורגל', age: 'גיל', born: 'שנת לידה', height: 'גובה', metres: 'מטר', foot: 'רגל', position: 'עמדה',
    profile: 'פרופיל', nationality: 'אזרחות', club: 'מועדון נוכחי', freeAgent: 'שחקן חופשי', natTeam: 'נבחרת',
    otherPos: 'עמדות נוספות', video: 'קטעים נבחרים', watch: 'צפייה בסרטון', play: 'הפעלת הסרטון', openYouTube: 'פתיחה ביוטיוב',
    season: 'עונת', cv: 'הורדת קורות חיים', tm: 'פרופיל טרנספרמרקט', link: 'פרופיל השחקן', contact: 'יצירת קשר',
    until: 'קישור פרטי, בתוקף עד', preview: 'תצוגה מקדימה. הצפייה שלך בעמוד לא נספרת כפתיחה.',
    former: 'לשעבר', youth: 'נוער', foot_: { Right: 'ימין', Left: 'שמאל', Both: 'שתיהן' },
    stats: { games: 'משחקים', starts: 'בהרכב', minutes: 'דקות', goals: 'שערים', assists: 'בישולים', cleanSheets: 'שער נקי', yellow: 'צהובים', red: 'אדומים' },
  },
};
const STAT_ORDER = ['games', 'starts', 'minutes', 'goals', 'assists', 'cleanSheets', 'yellow', 'red'];

const CSS = `
@font-face { font-family: 'Bebas Neue'; font-weight: 400; font-display: swap; src: url('/fonts/BebasNeue-400.ttf') format('truetype'); }
/* The CRM locks html and body to the window's height (its content pane scrolls); this page scrolls itself the same way. */
.pp { height: 100vh; height: 100dvh; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; background: ${GREEN}; color: ${INK}; font-family: 'Heebo', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.5;
  padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(28px + env(safe-area-inset-bottom, 0px)); -webkit-font-smoothing: antialiased; }
.pp *, .pp *::before, .pp *::after { box-sizing: border-box; }
.pp-wrap { width: 100%; max-width: 980px; margin: 0 auto; display: grid; gap: 16px; }
.pp-stack { display: grid; gap: 16px; min-width: 0; align-content: start; }
.pp-top { display: flex; align-items: center; gap: 12px; padding: 4px 2px 8px; }
.pp-logo { width: 44px; height: 44px; border-radius: 10px; border: 1px solid ${RULE}; object-fit: cover; flex: none; }
.pp-brand { font-family: 'Bebas Neue', 'Heebo', sans-serif; font-size: 24px; letter-spacing: 0.08em; line-height: 1; color: ${GOLD}; }
.pp-sub { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: ${MUTED}; margin-top: 4px; }
.pp[dir="rtl"] .pp-sub, .pp[dir="rtl"] .pp-label, .pp[dir="rtl"] .pp-fig-k, .pp[dir="rtl"] .pp-eyebrow { letter-spacing: 0; text-transform: none; }
.pp-note { border: 1px solid ${RULE}; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: ${GOLD}; background: rgba(201,162,39,0.08); }
.pp-card { background: ${CARD}; border: 1px solid ${RULE}; border-radius: 18px; padding: 20px; min-width: 0; }
.pp-hero { display: grid; gap: 20px; padding: 16px; }
.pp-photo { position: relative; width: 100%; aspect-ratio: 4 / 5; max-height: 62vh; border-radius: 14px; overflow: hidden; background: radial-gradient(120% 90% at 50% 0%, #175a44 0%, ${GREEN} 55%, ${CARD} 100%); display: flex; align-items: center; justify-content: center; }
.pp-photo img { width: 100%; height: 100%; object-fit: cover; object-position: center top; display: block; }
.pp-mono { font-family: 'Bebas Neue', 'Heebo', sans-serif; font-size: clamp(72px, 26vw, 140px); line-height: 1; color: ${GOLD}; opacity: 0.9; letter-spacing: 0.04em; }
.pp-photo::after { content: ''; position: absolute; inset: 0; border-radius: 14px; box-shadow: inset 0 0 0 1px ${RULE}; pointer-events: none; }
.pp-id { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.pp-eyebrow { font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: ${GOLD}; font-weight: 700; }
.pp-name { font-family: 'Bebas Neue', 'Heebo', sans-serif; font-weight: 400; font-size: clamp(40px, 12vw, 68px); line-height: 0.96; letter-spacing: 0.02em; margin: 0; color: ${INK}; overflow-wrap: anywhere; }
.pp[dir="rtl"] .pp-name, .pp-name.pp-he { font-weight: 700; letter-spacing: 0; line-height: 1.08; font-size: clamp(34px, 10vw, 56px); }
.pp-strap { color: ${MUTED}; font-size: 15px; }
.pp-figs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: ${RULE}; border: 1px solid ${RULE}; border-radius: 14px; overflow: hidden; }
.pp-fig { background: ${CARD}; padding: 14px 10px 12px; text-align: center; min-width: 0; }
.pp-fig-v { font-family: 'Bebas Neue', 'Heebo', sans-serif; font-size: 32px; line-height: 1; color: ${INK}; letter-spacing: 0.02em; }
.pp-fig-v.pp-he { font-family: 'Heebo', system-ui, sans-serif; font-weight: 700; font-size: 25px; line-height: 32px; letter-spacing: 0; }
.pp-fig-k { font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: ${GOLD}; margin-top: 7px; font-weight: 700; }
.pp-fig-s { font-size: 11px; color: ${MUTED}; margin-top: 2px; }
.pp-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: auto; }
.pp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 12px 20px; border-radius: 12px; font: inherit; font-weight: 700; font-size: 14.5px; text-decoration: none; cursor: pointer; flex: 1 1 200px; text-align: center; border: 1px solid ${GOLD}; transition: filter 0.15s ease, background 0.15s ease; }
.pp-btn-gold { background: ${GOLD}; color: ${CARD}; }
.pp-btn-line { background: transparent; color: ${GOLD}; }
.pp-btn:hover { filter: brightness(1.08); }
.pp-btn-line:hover { background: rgba(201,162,39,0.1); }
.pp a:focus-visible, .pp button:focus-visible { outline: 2px solid ${INK}; outline-offset: 3px; }
.pp-label { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: ${GOLD}; font-weight: 700; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid ${RULE}; }
.pp-row { display: grid; grid-template-columns: minmax(96px, 34%) minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid rgba(244,240,230,0.08); }
.pp-row:last-child { border-bottom: 0; padding-bottom: 0; }
.pp-row dt { color: ${MUTED}; font-size: 13.5px; }
.pp-row dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.pp-video { position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; background: #000; border: 0; padding: 0; display: block; cursor: pointer; }
.pp-video img, .pp-video iframe { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: 0; }
.pp-play { position: absolute; inset: 0; margin: auto; width: 72px; height: 72px; border-radius: 50%; background: ${GOLD}; display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 28px rgba(0,0,0,0.45); }
.pp-play::before { content: ''; border-style: solid; border-width: 13px 0 13px 21px; border-color: transparent transparent transparent ${CARD}; margin-inline-start: 5px; }
.pp-more { display: inline-block; margin-top: 12px; color: ${GOLD}; font-size: 13.5px; }
.pp-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.pp-stat { border: 1px solid ${RULE}; border-radius: 12px; padding: 14px 8px 12px; text-align: center; }
.pp-foot { text-align: center; color: ${MUTED}; font-size: 13px; padding: 10px 0 0; display: grid; gap: 6px; }
.pp-foot a { color: ${GOLD}; text-decoration: none; font-weight: 700; }
.pp-foot small { font-size: 11.5px; opacity: 0.85; }
.pp-center { min-height: 100%; display: flex; align-items: center; justify-content: center; }
.pp-msg { max-width: 420px; text-align: center; display: grid; gap: 14px; justify-items: center; padding: 32px 24px; }
.pp-msg img { width: 84px; height: 84px; border-radius: 18px; border: 1px solid ${RULE}; }
.pp-msg p { margin: 0; font-size: 16px; line-height: 1.6; }
.pp-pulse { animation: pp-pulse 1.4s ease-in-out infinite; }
@keyframes pp-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pp-pulse { animation: none; } .pp-btn { transition: none; } }
@media (min-width: 760px) {
  .pp { padding: 28px 28px 40px; font-size: 16px; }
  .pp-wrap, .pp-stack { gap: 20px; }
  .pp-hero { grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 32px; padding: 24px; align-items: stretch; }
  .pp-photo { max-height: none; }
  .pp-id { padding: 6px 0; gap: 18px; }
  .pp-figs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .pp-two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
  .pp-card { padding: 24px; }
  .pp-btn { flex: 0 1 auto; }
}
`;

const hasHebrew = (s) => /[֐-׿]/.test(String(s || ''));
const initials = (name) => { const w = String(name || '').split(/\s+/).filter(Boolean); return (w.length > 1 ? [w[0], w[w.length - 1]] : w).map((x) => Array.from(x)[0]).join('').toUpperCase(); };
const metres = (cm) => (cm / 100).toFixed(2);
// The CRM keeps countries in English; a Hebrew page says them in Hebrew, from
// the CRM's own dictionary. A league is "<country> <tier>" unless typed by hand.
const place = (s, lang) => (lang === 'he' && s ? (HE[s] || s) : s);
const leagueName = (s, lang) => {
  const m = /^(.+?) (\d+)$/.exec(s || '');
  return m ? `${place(m[1], lang)} ${m[2]}` : place(s, lang);
};

/** Head tags a private page needs, taken back when the page is left. */
function usePrivatePage(title) {
  useEffect(() => {
    const added = [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']].map(([name, content]) => {
      const m = document.createElement('meta'); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    const theme = document.querySelector('meta[name="theme-color"]');
    const was = { theme: theme?.getAttribute('content'), bg: document.body.style.background };
    theme?.setAttribute('content', GREEN);
    document.body.style.background = GREEN;
    return () => { added.forEach((m) => m.remove()); if (theme && was.theme) theme.setAttribute('content', was.theme); document.body.style.background = was.bg; };
  }, []);
  useEffect(() => { document.title = title; }, [title]);
}

function Shell({ lang = 'en', children }) {
  return (
    <main className="pp" lang={lang} dir={lang === 'he' ? 'rtl' : 'ltr'}>
      <style>{CSS}</style>
      {children}
    </main>
  );
}

/** One calm sentence, in both languages: the page cannot know which the reader wants. */
function Message({ en, he, action }) {
  return (
    <Shell>
      <div className="pp-center">
        <div className="pp-card pp-msg">
          <img src={LOGO} alt="Gold A&S" />
          <p lang="en">{en}</p>
          <p lang="he" dir="rtl">{he}</p>
          {action}
          <a className="pp-more" href="https://gold-as.com" rel="noreferrer noopener" style={{ marginTop: 0 }}>gold-as.com</a>
        </div>
      </div>
    </Shell>
  );
}

function Video({ video, L }) {
  const [playing, setPlaying] = useState(false);
  if (!video) return null;
  if (!video.youtubeId) {
    return (
      <section className="pp-card">
        <h2 className="pp-label">{L.video}</h2>
        <a className="pp-btn pp-btn-gold" href={video.url} target="_blank" rel="noreferrer noopener" style={{ display: 'flex' }}>{L.watch}</a>
      </section>
    );
  }
  return (
    <section className="pp-card">
      <h2 className="pp-label">{L.video}</h2>
      {playing ? (
        <div className="pp-video" style={{ cursor: 'default' }}>
          {/* YouTube's player needs to know which site embeds it: the site's address only, never this page's. */}
          <iframe src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&rel=0&playsinline=1`} title={L.video}
            referrerPolicy="strict-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        </div>
      ) : (
        <button type="button" className="pp-video" onClick={() => setPlaying(true)} aria-label={L.play}>
          <img src={`https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <span className="pp-play" aria-hidden="true" />
        </button>
      )}
      <a className="pp-more" href={video.url} target="_blank" rel="noreferrer noopener">{L.openYouTube} ↗</a>
    </section>
  );
}

function Page({ token }) {
  const [state, setState] = useState({ phase: 'loading' });
  const [photo, setPhoto] = useState(null);
  const [round, setRound] = useState(0);
  const data = state.data;
  usePrivatePage(data?.player?.name ? `${data.player.name} · Gold A&S` : 'Gold A&S');

  useEffect(() => {
    let live = true;
    setState({ phase: 'loading' });
    loadPlayerPage(token).then((d) => {
      if (!live) return;
      setState({ phase: 'ready', data: d });
      if (d.player?.photo) loadPlayerPhoto(token).then((p) => { if (live) setPhoto(p); });
    }).catch((e) => { if (live) setState({ phase: e.status === 404 ? 'gone' : 'error' }); });
    return () => { live = false; };
  }, [token, round]);

  if (state.phase === 'loading') {
    return <Shell><div className="pp-center"><img className="pp-logo pp-pulse" src={LOGO} alt="Gold A&S" style={{ width: 72, height: 72, borderRadius: 16 }} /></div></Shell>;
  }
  if (state.phase === 'gone') {
    return <Message en="This link is no longer available. Please ask Gold A&S for a new one." he="הקישור הזה כבר לא זמין. אפשר לבקש קישור חדש מהסוכנות." />;
  }
  if (state.phase === 'error') {
    return <Message en={BROKEN.en} he={BROKEN.he}
      action={<button type="button" className="pp-btn pp-btn-line" style={{ flex: 'none' }} onClick={() => setRound((n) => n + 1)}>Try again · נסו שוב</button>} />;
  }

  const lang = data.lang === 'he' ? 'he' : 'en';
  const L = TEXT[lang];
  const p = data.player || {};
  const contact = data.contact || {};
  const nt = p.nationalTeam;
  const natTeam = nt ? (lang === 'he'
    ? [place(nt.country, lang), nt.youth ? L.youth : '', nt.former ? L.former : ''].filter(Boolean).join(' · ')
    : `${nt.former ? `${L.former} ` : ''}${nt.country}${nt.youth ? ` ${L.youth}` : ''}`) : '';
  const nations = (p.nationalities || []).map((n) => place(n, lang));
  const figures = [
    p.age ? [L.age, String(p.age), p.birthYear ? `${L.born} ${p.birthYear}` : ''] : null,
    p.heightCm ? [L.height, metres(p.heightCm), L.metres] : null,
    p.foot ? [L.foot, L.foot_[p.foot] || p.foot, ''] : null,
    p.position ? [L.position, p.position, ''] : null,
  ].filter(Boolean);
  const rows = [
    [L.club, p.club ? `${p.club}${p.league ? ` (${leagueName(p.league, lang)})` : ''}` : (p.freeAgent ? L.freeAgent : '')],
    [L.natTeam, natTeam],
    [L.otherPos, (p.otherPositions || []).join(' / ')],
  ].filter(([, v]) => v);
  const totals = data.stats?.totals || null;
  const tiles = totals ? STAT_ORDER.filter((k) => Number(totals[k]) > 0).map((k) => [L.stats[k], Number(totals[k]).toLocaleString('en-US')]) : [];
  const until = data.expiresAt ? new Date(data.expiresAt).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const side = !!p.video || tiles.length > 0;
  const eyebrow = [p.position, p.club || (p.freeAgent ? L.freeAgent : '')].filter(Boolean).join('  ·  ');

  return (
    <Shell lang={lang}>
      <div className="pp-wrap">
        <header className="pp-top">
          <img className="pp-logo" src={LOGO} alt="" />
          <div>
            <div className="pp-brand" dir="ltr">GOLD A&amp;S</div>
            <div className="pp-sub">{L.agency}</div>
          </div>
        </header>

        {data.preview && <div className="pp-note" role="status">{L.preview}</div>}

        <section className="pp-card pp-hero">
          <div className="pp-photo">
            {photo ? <img src={photo} alt={p.name} /> : <span className="pp-mono" aria-hidden="true">{initials(p.name)}</span>}
          </div>
          <div className="pp-id">
            {eyebrow && <div className="pp-eyebrow"><bdi>{eyebrow}</bdi></div>}
            <h1 className={`pp-name${hasHebrew(p.name) ? ' pp-he' : ''}`}><bdi>{p.name}</bdi></h1>
            {nations.length > 0 && <div className="pp-strap"><bdi>{nations.join('  ·  ')}</bdi></div>}
            {figures.length > 0 && (
              <div className="pp-figs" style={figures.length < 4 ? { gridTemplateColumns: `repeat(${figures.length === 3 ? 3 : Math.min(figures.length, 2)}, minmax(0, 1fr))` } : undefined}>
                {figures.map(([k, v, s]) => (
                  <div className="pp-fig" key={k}>
                    <div className={`pp-fig-v${hasHebrew(v) ? ' pp-he' : ''}`} dir="ltr">{v}</div>
                    <div className="pp-fig-k">{k}</div>
                    {s && <div className="pp-fig-s">{s}</div>}
                  </div>
                ))}
              </div>
            )}
            <div className="pp-actions">
              <a className="pp-btn pp-btn-gold" href={playerCvUrl(token)} download rel="noreferrer">{L.cv}</a>
              {p.profile && <a className="pp-btn pp-btn-line" href={p.profile.url} target="_blank" rel="noreferrer noopener">{p.profile.transfermarkt ? L.tm : L.link} ↗</a>}
            </div>
          </div>
        </section>

        <div className={rows.length > 0 && side ? 'pp-stack pp-two' : 'pp-stack'}>
          {rows.length > 0 && (
            <section className="pp-card">
              <h2 className="pp-label">{L.profile}</h2>
              <dl style={{ margin: 0 }}>
                {rows.map(([k, v]) => <div className="pp-row" key={k}><dt>{k}</dt><dd><bdi>{v}</bdi></dd></div>)}
              </dl>
            </section>
          )}
          {side && (
          <div className="pp-stack">
            <Video video={p.video} L={L} />
            {tiles.length > 0 && (
              <section className="pp-card">
                <h2 className="pp-label">{L.season} <span dir="ltr">{data.stats.season}</span></h2>
                <div className="pp-stats">
                  {tiles.map(([k, v]) => (
                    <div className="pp-stat" key={k}>
                      <div className="pp-fig-v" dir="ltr">{v}</div>
                      <div className="pp-fig-k">{k}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
          )}
        </div>

        <footer className="pp-foot">
          <div>
            <a href={contact.url || 'https://gold-as.com'} target="_blank" rel="noreferrer noopener" dir="ltr">{contact.site || 'gold-as.com'}</a>
            {'  ·  '}<bdi>{contact.agent?.[lang] || 'Lou Korek'}</bdi>{'  ·  '}<bdi>{contact.title?.[lang] || 'FIFA Licensed Agent'}</bdi>
          </div>
          {until && <small>{L.until} {until}</small>}
        </footer>
      </div>
    </Shell>
  );
}

const BROKEN = { en: 'The page could not be loaded. Please try again in a moment.', he: 'לא הצלחנו לטעון את העמוד. נסו שוב בעוד רגע.' };

// A club never meets the CRM's own error screen: whatever breaks, this page
// answers in its own voice.
class Guard extends React.Component {
  constructor(props) { super(props); this.state = { broken: false }; }
  static getDerivedStateFromError() { return { broken: true }; }
  render() { return this.state.broken ? <Message en={BROKEN.en} he={BROKEN.he} /> : this.props.children; }
}

export default function PlayerPage({ token }) {
  return <Guard><Page token={token} /></Guard>;
}
