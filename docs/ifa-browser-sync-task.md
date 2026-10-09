# Gold A&S ifa sync — the scheduled task

The daily task that reads Israeli fixtures from football.org.il in Chrome on
Lou's computer and publishes them to the CRM. This file is the task's prompt;
the real task holds the secret where `<CRM_SYNC_SECRET>` appears (the same
value as the Netlify environment variable). Keep the two in sync.

Schedule: every day 07:45 Asia/Jerusalem, 15 minutes after the Hapoel Hadera
sync so the two never drive Chrome at the same time.

---

Sync the Israeli players' fixtures from the Israel Football Association into
the Gold A&S CRM, using the browser. Report in Hebrew, briefly.

WHY THE BROWSER
football.org.il is behind Cloudflare and returns 403 to datacentre IPs, so the
CRM's Netlify functions cannot read it. A home connection is not blocked, so
the read runs here, in Chrome, and the CRM only receives the result.

HOW THE SEASONS WORK
The IFA club page can lag behind the fixture list. The script finds a squad
from the player page and the club page (the squad's season), but reads the
fixture list without a season, which gives the newest season that has games
(the data season). It is normal for the two to differ; the report shows both
per player. Only worry when the data season is OLDER than the squad season —
the import refuses that by itself ("last season's fixtures").

TOOLS
Load the Chrome tools in ONE ToolSearch call:
  select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__computer
If the extension is not connected, say so and stop — do not try another route.
Use ONE tab for everything: window.name only survives navigation within a tab.

STEPS
1. Open a tab on https://goldas-crm.netlify.app/ and wait ~5 seconds. Load the
   script same-origin and fetch the list of players to read:
     await new Promise((res, rej) => { const s = document.createElement('script');
       s.src = '/tools/ifa-browser-sync.js?cb=' + Date.now();
       s.onload = res; s.onerror = rej; document.head.appendChild(s); });
     JSON.stringify(await window.GA_TARGETS('<CRM_SYNC_SECRET>'));
   Expect { targets: N, teamKnown, needLookup, ... } with N > 0. A 403 means the
   secret here no longer matches CRM_SYNC_SECRET on Netlify — say so rather
   than guessing; a 503 means it is not set on Netlify at all.

2. Navigate the SAME tab to https://www.football.org.il/ and wait ~10 seconds.
   Load the script from the CRM (a <script src> tag is not subject to CORS):
     await new Promise((res, rej) => { const s = document.createElement('script');
       s.src = 'https://goldas-crm.netlify.app/tools/ifa-browser-sync.js?cb=' + Date.now();
       s.onload = res; s.onerror = rej; document.head.appendChild(s); });
     typeof window.GA_SCRAPE;
   Expect "function". If the page itself is a Cloudflare challenge, wait and
   reload once; if it still is, report that and stop.

3. Start the scrape WITHOUT awaiting it in the same call (one page per known
   squad, about four for a new one; up to a few minutes):
     window.__r = null; window.__e = null;
     window.GA_SCRAPE().then(s => window.__r = s).catch(e => window.__e = String(e));
     'started';
   Then poll every ~20 seconds until one is set:
     JSON.stringify({done: !!window.__r, err: window.__e, result: window.__r});
   If it errors, report the message verbatim and stop.

4. SANITY CHECK before publishing. Refuse to push, and report the numbers, if:
     - result.pages.blocked > 0 (Cloudflare challenged a page)
     - fewer than 70% of the players have a non-null `fixtures` count
     - result.fixtures < 5 (except in June and July, between seasons)
   The import repeats these checks on the server and refuses on its own too.

5. Navigate the SAME tab back to https://goldas-crm.netlify.app/ and wait ~5
   seconds. The navigation reset the JavaScript context, so load the script
   again, same-origin, and confirm the payload survived:
     const before = (window.name||'').length;
     await new Promise((res, rej) => { const s = document.createElement('script');
       s.src = '/tools/ifa-browser-sync.js?cb=' + Date.now();
       s.onload = res; s.onerror = rej; document.head.appendChild(s); });
     JSON.stringify({payloadBytes: before, pushFn: typeof window.GA_PUSH});
   payloadBytes must be well above zero. Then publish:
     JSON.stringify(await window.GA_PUSH('<CRM_SYNC_SECRET>'));
   Expect { status: 202 }.

6. Verify what landed. The import runs in the background; poll the report
   every ~15 seconds, up to six times, until lastRunAt is after the push:
     JSON.stringify(await window.GA_REPORT('<CRM_SYNC_SECRET>'));
   - stats.written / upserts / removed: what was published
   - lastRefused: present when the server refused (quote its reasons)
   - perPlayer: one line per player with action, reason, fixtures, upcoming,
     squadSeason and dataSeason

OUTPUT
- All good and nothing changed since yesterday: one short line.
- Something changed: which players gained or lost upcoming matches, any player
  whose squad was newly found, and any season difference.
- Any check failed, the server refused, or the script errored: say exactly
  what, and that nothing was published.
Never edit CRM data by hand. This task only runs the sync and reports.
