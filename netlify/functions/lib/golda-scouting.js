// Weekly scouting: on Sunday morning Golda takes a few open club requirements
// and searches the web for outside players who could fill them (not players
// the agency already represents). The candidates are saved on the requirement
// (club_requirements/{id}.scouting) for the Requirements page, and the team
// gets one WhatsApp summary. Golda only suggests names; nobody is contacted.
const { playerName } = require('@goldas/domain');

const MODEL = 'claude-opus-5-5';
const EFFORT = 'high';
const MAX_TOKENS = 16000;
const SCOUT_WEEKDAY = 0;          // Sunday
const SCOUT_HOUR = 10;            // after the morning briefings
const PER_WEEK = 3;               // requirements scouted each week
const REST_DAYS = 6;              // a requirement is scouted at most once a week
const MAX_CANDIDATES = 3;

function israelClock(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(now);
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday').value), hour: Number(parts.find((p) => p.type === 'hour').value) };
}
const isScoutTime = (now = new Date()) => { const c = israelClock(now); return c.weekday === SCOUT_WEEKDAY && c.hour === SCOUT_HOUR; };

const ms = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) || 0 : Number(v) || 0);

/** The open requirements to scout this week: never scouted first, then the longest since the last search. */
function pickRequirements(requirements = [], now = new Date(), n = PER_WEEK) {
  const today = now.toISOString().slice(0, 10);
  return requirements
    .filter((r) => !r.deletedAt && (r.status || 'open') === 'open' && !(r.validUntil && r.validUntil < today))
    .filter((r) => !r.scouting?.at || now.getTime() - ms(r.scouting.at) > REST_DAYS * 86400000)
    .sort((a, b) => (ms(a.scouting?.at) - ms(b.scouting?.at)) || (ms(a.createdAt) - ms(b.createdAt)))
    .slice(0, n);
}

const SYSTEM = [
  "You are Golda (גולדה), the scout of Gold A&S, a football players' agency in Israel.",
  'You get one open requirement from a club. Search the web (Transfermarkt, league sites, football news) for real players who fit it and could realistically move there: the position, the age range, the gender, a level that suits the club and its league, and a contract that is ending, free or a likely loan.',
  'Never suggest a player from the "alreadyOurs" list. Never invent a player, a club or an age: every candidate must come from a page you found, and its link is that page.',
  `Answer with JSON only, no other text: {"candidates":[{"name":"","age":0,"position":"","club":"","why":"one short line in Hebrew: why they fit and their contract situation","link":"https://..."}]}. Up to ${MAX_CANDIDATES} candidates, best first. When you found none that fit, answer {"candidates":[]}.`,
].join('\n');

function requirementFacts(r) {
  const age = r.ageNotSpecified ? 'any' : [r.ageMin, r.ageMax].filter((x) => x != null && x !== '').join('-') || 'any';
  const out = { club: r.clubName, gender: r.gender, youthTeam: !!r.clubIsYouth, position: r.requiredPosition || 'any', age };
  for (const k of ['league', 'leagueCountry', 'leagueName', 'tablePosition', 'transferFee', 'salary', 'notes']) if (r[k]) out[k] = r[k];
  return out;
}

/** The model's JSON, cleaned: real names, http(s) links only, at most three. */
function parseCandidates(text) {
  const s = String(text || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(j.candidates)) return null;
  const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return j.candidates.map((c) => ({
    name: str(c.name, 80),
    age: Number.isFinite(Number(c.age)) && Number(c.age) > 12 && Number(c.age) < 45 ? Math.round(Number(c.age)) : null,
    position: str(c.position, 40),
    club: str(c.club, 80),
    why: str(c.why, 240),
    link: /^https?:\/\/\S+$/i.test(str(c.link, 400)) ? str(c.link, 400) : '',
  })).filter((c) => c.name && c.link).slice(0, MAX_CANDIDATES);
}

/** One requirement, one search. Returns { candidates, ai, reason? }; never throws. */
async function scoutRequirement(req, { client, ours = [] } = {}) {
  if (!client && !process.env.ANTHROPIC_API_KEY) return { candidates: [], ai: false, reason: 'no ANTHROPIC_API_KEY' };
  try {
    const anthropic = client || new (require('@anthropic-ai/sdk'))();
    const messages = [{ role: 'user', content: JSON.stringify({ requirement: requirementFacts(req), alreadyOurs: ours.slice(0, 300) }) }];
    let res;
    for (let step = 0; step < 4; step++) {
      res = await anthropic.beta.messages.stream({
        model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
        system: SYSTEM, tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }], messages,
      }).finalMessage();
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content });   // a long search pauses; send it back to resume
    }
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const candidates = parseCandidates(text);
    if (!candidates) return { candidates: [], ai: false, reason: 'no JSON in the answer' };
    const mine = new Set(ours.map((n) => n.toLowerCase()));
    return { candidates: candidates.filter((c) => !mine.has(c.name.toLowerCase())), ai: true };
  } catch (e) {
    return { candidates: [], ai: false, reason: e.message || String(e) };
  }
}

/** Scout this week's requirements and save what was found on each. Returns [{ req, candidates }]. */
async function runScouting(db, { requirements, players }, now, job, { client, scout = scoutRequirement } = {}) {
  const picked = pickRequirements(requirements, now);
  if (!picked.length) return [];
  const ours = (players || []).filter((p) => !p.deletedAt).map((p) => playerName(p)).filter(Boolean);
  const results = await Promise.all(picked.map(async (req) => {
    const r = await scout(req, { client, ours });
    if (!r.ai) job.note(`scouting ${req.clubName}: ${r.reason}`);
    // A failed search is not saved, so the requirement is tried again next week.
    if (r.ai) await db.collection('club_requirements').doc(req.id).set({ scouting: { at: now.toISOString(), candidates: r.candidates } }, { merge: true });
    return { req, candidates: r.candidates, ai: r.ai };
  }));
  return results.filter((x) => x.ai);
}

/** The WhatsApp summary for the team. */
function buildScoutingMessage(name, results) {
  const found = results.filter((x) => x.candidates.length);
  const lines = [`*סקאוטינג שבועי, ${name}* 🔎`, ''];
  for (const { req, candidates } of found) {
    lines.push(`*${req.clubName}*${req.requiredPosition ? ` · ${req.requiredPosition}` : ''}`);
    for (const c of candidates) lines.push(`• ${c.name}${c.age ? ` (${c.age})` : ''}${c.club ? `, ${c.club}` : ''}: ${c.why}`, `  ${c.link}`);
    lines.push('');
  }
  const none = results.filter((x) => !x.candidates.length).map((x) => x.req.clubName);
  if (none.length) lines.push(`לא מצאתי התאמה טובה ל: ${none.join(', ')}.`, '');
  lines.push('אלה הצעות מהרשת, לא נוצר קשר עם אף אחד. הכל בדרישות: https://goldas-crm.netlify.app/requirements');
  return lines.join('\n');
}

module.exports = { isScoutTime, pickRequirements, parseCandidates, requirementFacts, scoutRequirement, runScouting, buildScoutingMessage, SCOUT_HOUR, PER_WEEK };
