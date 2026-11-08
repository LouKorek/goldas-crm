// Golda's morning briefing, written by the model from the day's facts.
// The facts come from the same engines the app uses (alerts, games, audit);
// the model only decides what matters most and says it clearly. Anything
// going wrong (no key, an API error, an empty answer) falls back to the
// template briefing (lib/golda-briefing.js buildBriefing), so a briefing is
// always sent.
const { isClosedStage } = require('@goldas/domain');
const { fmtDate } = require('./golda-briefing.js');

const MODEL = 'claude-opus-5-5';
const EFFORT = 'high';
const MAX_TOKENS = 16000;
const APP_LINK = 'https://goldas-crm.netlify.app/home/today';

const SYSTEM = [
  "You are Golda (גולדה), the assistant of Gold A&S, a football players' agency in Israel. You write the agent's morning WhatsApp briefing in Hebrew, female voice.",
  'You get the facts as JSON. Use only these facts; never invent a player, a game, a number or a date.',
  'Write it organized and easy to scan on a phone:',
  '1. The first line is given to you; write it exactly.',
  '2. *הכי חשוב היום:* 1 to 3 items: what needs the agent today and why it matters (a game of a represented player, a contract ending, a requirement that fits a player, an overdue task).',
  '3. *היום:* today\'s games, trainings and meetings with the time, one line each (skip if none, say so in one line).',
  '4. *מה השתנה מאתמול:* the team\'s changes in the last 24 hours, grouped by who and what, the important ones by name (skip the section if nothing changed).',
  '5. *לטיפול:* the remaining alerts, grouped, most urgent first; merge similar ones ("3 חוזים מסתיימים החודש: …").',
  '6. *המלצות:* 1 to 3 concrete next steps that connect the facts (for example a club requirement that matches a free player, a deal stuck in the same stage). The opportunities list (open requirements × players with no deal yet, scored by the matching engine) is the best source for these.',
  '7. Only when isSunday is true and there are opportunities: *3 הזדמנויות השבוע:* up to three of them, one line each: the player, the club and position, the score and the main reason, and the next step (open a deal, call the contact). Then do not repeat them in המלצות.',
  '8. Only when isSunday is true: *השבוע:* the week plan from weekAhead, one short line per day that has something (day name and date, then the items with time and player), merged when a day has many; skip empty days.',
  '9. When transferWindows has a window closing within 14 days or opening within 14 days, one line about it inside *הכי חשוב היום* or *לטיפול* (league and date).',
  `10. The last line: הכל בבית: ${APP_LINK}`,
  'WhatsApp formatting only: *bold* for section titles, • for items, no markdown headings, no tables. Short lines. No greeting beyond the first line, no sign-off.',
  'Use what you remember (the memories) to decide what matters to this person, but do not quote them.',
].join('\n');

const firstLine = (name, today) => `*בוקר טוב, ${name}* ☀️ ${fmtDate(today)}`;

/** Force the fixed first line and the app link last, whatever the model wrote. */
function shapeBriefing(text, name, today) {
  let lines = String(text || '').replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return '';
  const head = firstLine(name, today);
  if (/בוקר טוב/.test(lines[0])) lines[0] = head; else lines.unshift(head);
  lines = lines.filter((l) => !l.includes(APP_LINK));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [...lines, '', `הכל בבית: ${APP_LINK}`].join('\n');
}

/** The facts the model sees, kept small. */
function briefingFacts({ name, today, games = [], alerts = [], changes24h = [], deals = [], requirements = [], memories = [], opportunities = [], weekAhead = [], transferWindows = null }) {
  const openDeals = deals.filter((d) => !d.closedAt && !isClosedStage(d.stage));
  const openReqs = requirements.filter((r) => (r.status || 'open') === 'open');
  return {
    person: name,
    today,
    isSunday: new Date(`${today}T12:00:00Z`).getUTCDay() === 0,
    gamesToday: games.slice(0, 30).map((g) => ({ time: g.time, title: g.title, details: g.sub })),
    alerts: alerts.slice(0, 60).map((a) => ({
      type: a.type, severity: a.severity, who: a.subject?.name, what: a.proof?.he, due: a.dueDate,
    })),
    teamChanges24h: changes24h.slice(0, 80).map((c) => ({
      by: c.byName || c.by || '', via: c.via || '', action: c.action, collection: c.collection, record: c.name || '', fields: (c.fields || []).slice(0, 8),
    })),
    openDeals: openDeals.slice(0, 40).map((d) => ({ player: d.playerName || '', club: d.clubName || d.club || '', stage: d.stage || '', updated: d.updatedAt?.toDate?.()?.toISOString?.().slice(0, 10) || '' })),
    openRequirements: openReqs.slice(0, 40).map((r) => ({ club: r.clubName || '', position: r.requiredPosition || r.position || (Array.isArray(r.positions) ? r.positions.join(', ') : ''), gender: r.gender || '', validUntil: r.validUntil || '', notes: String(r.notes || '').slice(0, 200) })),
    weekAhead: weekAhead.slice(0, 7),
    transferWindows: transferWindows ? {
      open: transferWindows.open.map((w) => ({ league: w.league, closes: w.closes, daysLeft: w.daysLeft })),
      opening: transferWindows.opening.filter((w) => w.daysToOpen <= 21).map((w) => ({ league: w.league, opens: w.opens, daysToOpen: w.daysToOpen })),
    } : null,
    opportunities: opportunities.slice(0, 5).map((o) => ({ player: o.player, club: o.club, position: o.position || '', score: o.score, why: String(o.why || '').slice(0, 300), playerStage: o.stage || '' })),
    memories: memories.slice(0, 40).map((m) => (m.about ? `(${m.about}) ${m.text}` : m.text)),
  };
}

/**
 * writeBriefing({ name, today, games, alerts, changes24h, deals, requirements, memories, fallbackText, client })
 * Returns { text, ai: true } or { text: fallbackText, ai: false, reason }.
 */
async function writeBriefing(opts) {
  const { name, today, fallbackText, client } = opts;
  if (!client && !process.env.ANTHROPIC_API_KEY) return { text: fallbackText, ai: false, reason: 'no ANTHROPIC_API_KEY' };
  try {
    const anthropic = client || new (require('@anthropic-ai/sdk'))();
    const msg = await anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT },
      system: SYSTEM,
      messages: [{ role: 'user', content: `First line: ${firstLine(name, today)}\n\nFacts:\n${JSON.stringify(briefingFacts(opts))}` }],
    }).finalMessage();
    const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const shaped = shapeBriefing(text, name, today);
    if (!shaped || shaped.split('\n').filter((l) => l.trim()).length < 3) return { text: fallbackText, ai: false, reason: 'empty answer' };
    return { text: shaped, ai: true, usage: msg.usage };
  } catch (e) {
    return { text: fallbackText, ai: false, reason: e.message || String(e) };
  }
}

const RECAP_SYSTEM = [
  "You are Golda (גולדה), the assistant of Gold A&S, a football players' agency in Israel. On Thursday evening you write the agent's weekly recap on WhatsApp, in Hebrew, female voice.",
  'You get the week as JSON. Use only these facts; never invent a player, a club, a number or a date.',
  '1. The first line is given to you; write it exactly.',
  '2. *השבוע במספרים:* one line: deals moved, contracts signed, new requirements, tasks done and still open (overdue).',
  '3. *עסקאות:* the deal moves that matter, by name (who moved what to which stage); skip if none.',
  '4. *משחקים:* the games our players had this week, short; skip if none.',
  '5. *לשבוע הבא:* what is coming (from nextWeek) and the 1 to 3 things to push before Sunday.',
  '6. Only when quality is given (the owner): *איכות גולדה:* the 👍/👎 counts, and for each 👎 case one line on what went wrong and what you will do differently. Skip when there is no feedback.',
  `7. The last line: הכל בבית: ${APP_LINK}`,
  'WhatsApp formatting only: *bold* section titles, • items, short lines, no headings or tables, no sign-off.',
].join('\n');

const recapFirstLine = (name) => `*סיכום שבוע, ${name}* 📋`;

/** The Thursday recap, written by the model; the fallback is a short template. */
async function writeRecap({ name, facts, nextWeek = [], quality = null, fallbackText, client }) {
  if (!client && !process.env.ANTHROPIC_API_KEY) return { text: fallbackText, ai: false, reason: 'no ANTHROPIC_API_KEY' };
  try {
    const anthropic = client || new (require('@anthropic-ai/sdk'))();
    const { quality: _q, ...week } = facts || {};
    const msg = await anthropic.beta.messages.stream({
      model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
      system: RECAP_SYSTEM,
      messages: [{ role: 'user', content: `First line: ${recapFirstLine(name)}\n\nThe week:\n${JSON.stringify({ ...week, nextWeek: nextWeek.slice(0, 7), ...(quality ? { quality } : {}) })}` }],
    }).finalMessage();
    let text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text || text.split('\n').filter((l) => l.trim()).length < 3) return { text: fallbackText, ai: false, reason: 'empty answer' };
    const lines = text.split('\n').filter((l) => !l.includes(APP_LINK));
    if (!/סיכום שבוע/.test(lines[0])) lines.unshift(recapFirstLine(name)); else lines[0] = recapFirstLine(name);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    text = [...lines, '', `הכל בבית: ${APP_LINK}`].join('\n');
    return { text, ai: true, usage: msg.usage };
  } catch (e) {
    return { text: fallbackText, ai: false, reason: e.message || String(e) };
  }
}

/** The recap without the model: the numbers and the deal moves. */
function buildRecap(name, f, quality = null) {
  const lines = [recapFirstLine(name), '', `*השבוע במספרים:* ${f.dealMoves.length} תנועות בעסקאות · ${f.signed} חוזים נחתמו · ${f.newRequirements.length} דרישות חדשות · ${f.tasksDone} משימות הושלמו · ${f.tasksOpen} פתוחות (${f.tasksOverdue} באיחור)`];
  if (f.dealMoves.length) { lines.push('', '*עסקאות:*'); for (const m of f.dealMoves.slice(0, 10)) lines.push(`• ${m.player} ב${m.club}: ${m.to}`); }
  if (quality && (quality.up || quality.down)) lines.push('', `*איכות גולדה:* ${quality.up} 👍 · ${quality.down} 👎`);
  lines.push('', `הכל בבית: ${APP_LINK}`);
  return lines.join('\n');
}

module.exports = { writeBriefing, shapeBriefing, briefingFacts, firstLine, writeRecap, buildRecap, recapFirstLine, APP_LINK, MODEL, EFFORT };
