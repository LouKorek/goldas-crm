// Browser sync of Israeli fixtures from football.org.il, run by the scheduled
// task "Gold A&S ifa sync" in Chrome on Lou's computer.
//
// football.org.il answers datacenter IPs with a Cloudflare 403, so Netlify
// cannot read it; a home connection can. The task drives one tab through
// three pages, and window.name carries the data between them (it survives
// navigation inside the same tab, nothing else does):
//
//   1. on the CRM          GA_TARGETS(secret)  → who to read, into window.name
//   2. on football.org.il  GA_SCRAPE()         → fixtures, into window.name
//                          (start it without await and poll window.__r)
//   3. on the CRM          GA_PUSH(secret, { dryRun })  → ifa-import-background
//                          GA_REPORT(secret)   → what the import did
//
// Text parsing (captions, club matching, fixture rows) comes from
// /tools/ifa-text.js, the same file the server sync uses.
(function () {
  'use strict';
  const KIND = 'ga-ifa';
  const CONCURRENCY = 2;
  const GAP_MS = 400;
  const me = document.currentScript && document.currentScript.src;
  const CRM = me ? new URL(me).origin : 'https://goldas-crm.netlify.app';
  const onCrm = () => location.origin === CRM;
  const onIfa = () => /(^|\.)football\.org\.il$/.test(location.hostname);

  function readState() {
    try { const o = JSON.parse(window.name || ''); return o && o.kind === KIND ? o : null; } catch { return null; }
  }
  function writeState(o) { window.name = JSON.stringify({ kind: KIND, ...o }); return window.name.length; }

  function loadText() {
    if (window.GA_IFA_TEXT) return Promise.resolve(window.GA_IFA_TEXT);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = `${CRM}/tools/ifa-text.js?cb=${Date.now()}`;
      s.onload = () => (window.GA_IFA_TEXT ? res(window.GA_IFA_TEXT) : rej(new Error('ifa-text.js loaded but defined nothing')));
      s.onerror = () => rej(new Error('ifa-text.js did not load'));
      document.head.appendChild(s);
    });
  }

  const text = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  // Text of an element without its <span> children (cheerio's
  // .clone().children('span').remove().end().text() on the server).
  function textWithoutSpans(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll(':scope > span').forEach((s) => s.remove());
    return text(c);
  }

  // ── step 1 ──────────────────────────────────────────────────────────────
  window.GA_TARGETS = async function (secret) {
    if (!onCrm()) throw new Error(`GA_TARGETS must run on ${CRM}`);
    const r = await fetch('/.netlify/functions/ifa-targets', { headers: { 'x-sync-secret': secret }, cache: 'no-store' });
    if (!r.ok) throw new Error(`ifa-targets answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const bytes = writeState({ stage: 'targets', targetsAt: j.at, targets: j.targets, clubIndex: j.clubIndex || null });
    return {
      targets: j.targets.length,
      teamKnown: j.targets.filter((t) => t.teamId).length,
      needLookup: j.targets.filter((t) => !t.teamId && !t.error).length,
      badLink: j.targets.filter((t) => t.error).length,
      clubIndexCached: !!j.clubIndex,
      bytes,
    };
  };

  // ── step 2 ──────────────────────────────────────────────────────────────
  window.GA_SCRAPE = async function () {
    if (!onIfa()) throw new Error('GA_SCRAPE must run on football.org.il');
    const st = readState();
    if (!st || st.stage !== 'targets') throw new Error('no targets in window.name — run GA_TARGETS on the CRM first, in this same tab');
    const T = await loadText();
    const t0 = Date.now();
    const pages = { count: 0, blocked: 0, failed: 0 };
    let clubIndex = st.clubIndex;
    let clubIndexFetched = false;
    const clubTeamsCache = new Map();

    let last = 0;
    async function getDoc(path) {
      const wait = last + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      pages.count++;
      let html = '';
      try {
        const res = await fetch(location.origin + path, { credentials: 'include', cache: 'no-store' });
        html = await res.text();
        // Cloudflare's challenge comes back as a 403 with its own page.
        if (/Just a moment|cf-browser-verification|Attention Required/i.test(html)) { pages.blocked++; return null; }
        if (!res.ok || !T.ifaLooksReal(html)) { pages.failed++; return null; }
      } catch (e) { pages.failed++; return null; }
      return new DOMParser().parseFromString(html, 'text/html');
    }

    function parsePlayer(doc) {
      const cap = T.ifaParseCaption(text(doc.querySelector('h2.new-player-data_title')));
      if (!cap) return null;
      const opt = doc.querySelector('select[id*="ddlSeason"] option');
      return { ...cap, seasonId: opt ? opt.getAttribute('value') || '' : '', seasonLabel: text(opt) };
    }
    function parseClubIndex(doc) {
      const out = [];
      doc.querySelectorAll('a[href*="club_id="]').forEach((a) => {
        const id = /club_id=(\d+)/.exec(a.getAttribute('href') || '')?.[1];
        if (!id) return;
        const h = a.querySelector('.head h2');
        if (!h) return;
        const sector = text(h.querySelector('span'));
        const name = textWithoutSpans(h);
        if (name) out.push({ clubId: id, name, sector });
      });
      return out;
    }
    function parseClubTeams(doc) {
      const out = [];
      doc.querySelectorAll('a[href*="team_id="]').forEach((a) => {
        const id = /team_id=(\d+)/.exec(a.getAttribute('href') || '')?.[1];
        const head = a.querySelector('h3.head');
        if (!id || !head) return;
        let league = '', teamName = '';
        a.querySelectorAll('.field_side > div').forEach((d) => {
          const label = text(d.querySelector('span'));
          const value = textWithoutSpans(d);
          if (/ליגה/.test(label)) league = value;
          if (/קבוצה/.test(label)) teamName = value;
        });
        out.push({ teamId: id, ageGroup: textWithoutSpans(head), league, teamName });
      });
      return out;
    }
    function parseFixtures(doc, isEnglish) {
      const out = [], seen = new Set();
      doc.querySelectorAll('a.table_row.link_url').forEach((a) => {
        const cells = {};
        a.querySelectorAll('div.table_col').forEach((col) => {
          const sr = col.querySelector('span.sr-only');
          const labelText = sr ? sr.textContent : '';
          const label = labelText.trim();
          const value = col.textContent.slice(labelText.length).replace(/\s+/g, ' ').trim();
          if (label) cells[label] = value;
        });
        const fx = T.ifaFixtureFromCells(cells, a.getAttribute('href') || '', isEnglish);
        if (fx && !seen.has(fx.sourceMatchId)) { seen.add(fx.sourceMatchId); out.push(fx); }
      });
      return out;
    }

    async function resolve(t) {
      const pdoc = await getDoc(`${t.prefix}players/player/?player_id=${encodeURIComponent(t.playerId)}`);
      if (!pdoc) return { error: 'ifa-player-page-unreadable' };
      const info = parsePlayer(pdoc);
      if (!info) return { error: 'ifa-player-page-unreadable' };
      if (!clubIndex) {
        const idoc = await getDoc(`${t.prefix}clubs/`);
        clubIndex = idoc ? parseClubIndex(idoc) : [];
        clubIndexFetched = clubIndex.length > 0;
        if (!clubIndex.length) clubIndex = null;
      }
      if (!clubIndex) return { error: 'ifa-club-index-unreadable' };
      const clubs = T.ifaRankClubs(clubIndex, info.clubName, t.gender);
      if (!clubs.length) return { error: 'ifa-club-not-found', detail: info.clubName };
      for (const club of clubs.slice(0, 4)) {
        if (!clubTeamsCache.has(club.clubId)) {
          const cdoc = await getDoc(`${t.prefix}clubs/club/?club_id=${encodeURIComponent(club.clubId)}`);
          clubTeamsCache.set(club.clubId, cdoc ? parseClubTeams(cdoc) : []);
        }
        const best = T.ifaPickTeam(clubTeamsCache.get(club.clubId), info.teamLabel, info.clubName);
        if (best) {
          return {
            teamId: best.teamId, clubId: club.clubId, teamName: best.teamName,
            ageGroup: best.ageGroup, league: best.league,
            seasonId: info.seasonId, seasonLabel: info.seasonLabel,
            clubName: info.clubName, teamLabel: info.teamLabel,
          };
        }
      }
      return { error: 'ifa-team-not-matched', detail: [info.clubName, info.teamLabel].filter(Boolean).join(' · ') };
    }

    async function one(t) {
      const out = { id: t.id, name: t.name, teamFrom: t.teamFrom || null };
      if (t.error) return { ...out, error: t.error };
      let teamId = t.teamId;
      if (!teamId) {
        const res = await resolve(t);
        if (res.error) return { ...out, error: res.error, detail: res.detail };
        out.resolved = res;
        out.teamFrom = 'lookup';
        teamId = res.teamId;
      }
      out.teamId = teamId;
      // No season_id: IFA serves the newest season that has a fixture list,
      // which can be ahead of the club page's season. That is expected.
      out.gamesUrl = `${location.origin}${t.prefix}team-details/team-games/?team_id=${encodeURIComponent(teamId)}`;
      const gdoc = await getDoc(`${t.prefix}team-details/team-games/?team_id=${encodeURIComponent(teamId)}`);
      out.gamesOk = !!gdoc;
      if (gdoc) {
        out.fixtures = parseFixtures(gdoc, t.prefix === '/en/');
        const seasons = {};
        out.fixtures.forEach((f) => { seasons[f.season] = (seasons[f.season] || 0) + 1; });
        out.dataSeason = Object.entries(seasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      }
      return out;
    }

    const queue = st.targets.slice();
    const results = [];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const t = queue.shift();
        try { results.push(await one(t)); }
        catch (e) { results.push({ id: t.id, name: t.name, error: 'error', detail: String(e && e.message || e).slice(0, 200) }); }
      }
    }));

    const payload = {
      stage: 'scraped', scrapedAt: new Date().toISOString(), ms: Date.now() - t0,
      pages, results, clubIndex: clubIndexFetched ? clubIndex : null, clubIndexFetched,
    };
    const bytes = writeState(payload);
    return {
      bytes, seconds: Math.round(payload.ms / 1000), pages,
      players: results.length,
      withFixtures: results.filter((r) => r.fixtures && r.fixtures.length).length,
      fixtures: results.reduce((n, r) => n + (r.fixtures ? r.fixtures.length : 0), 0),
      errors: results.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`),
      perPlayer: results.map((r) => ({
        name: r.name, teamId: r.teamId || null, teamFrom: r.teamFrom,
        fixtures: r.fixtures ? r.fixtures.length : null, dataSeason: r.dataSeason || null,
        squadSeason: r.resolved ? r.resolved.seasonLabel : null, error: r.error || null,
      })),
    };
  };

  // ── step 3 ──────────────────────────────────────────────────────────────
  window.GA_PUSH = async function (secret, opts) {
    if (!onCrm()) throw new Error(`GA_PUSH must run on ${CRM}`);
    const st = readState();
    if (!st || st.stage !== 'scraped') throw new Error('no scrape in window.name — run GA_SCRAPE on football.org.il first, in this same tab');
    const body = JSON.stringify({ payload: st, dryRun: !!(opts && opts.dryRun) });
    if (body.length > 250000) throw new Error(`payload is ${body.length} bytes, over the 256 KB background-function limit`);
    const r = await fetch('/.netlify/functions/ifa-import-background', {
      method: 'POST', headers: { 'x-sync-secret': secret, 'Content-Type': 'application/json' }, body,
    });
    return { status: r.status, bytes: body.length };
  };

  window.GA_REPORT = async function (secret) {
    if (!onCrm()) throw new Error(`GA_REPORT must run on ${CRM}`);
    const r = await fetch(`/.netlify/functions/ifa-targets?report=1&nocache=${Math.random()}`, {
      headers: { 'x-sync-secret': secret }, cache: 'reload',
    });
    if (!r.ok) throw new Error(`ifa-targets answered ${r.status}`);
    return r.json();
  };
})();
