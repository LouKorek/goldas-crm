// Golda — the assistant that edits the CRM on the team's instructions, on
// WhatsApp and inside the app. Claude reads the message, calls the tools
// below, and the tools write to Firestore with the same shapes and audit
// fields the React app writes (src/lib/db.js addDoc_/updateDoc_, uploadFile).
// Golda acts in the sender's name and with the sender's permissions
// (lib/golda-identity.js + can() from the domain package). Every write is
// logged in the one `audit` collection with the record before and after,
// marked via: 'golda', so the Golda screen can show it and "undo" can reverse it.
const Anthropic = require('@anthropic-ai/sdk');
const C = require('../data/crm-constants.js');

const MODEL = 'claude-opus-5-5';
const { OWNER_EMAIL } = require('./firestore.js');
const { stageFromStatus, stageOfPlayer, categoryFromPlayer, playerName, LEGACY_PIPELINE_COLLECTIONS, can, canTransition, applyTransition, isDealStage,
  computeAlerts, mergeSettings, topMatches, explainMatch, israelDate } = require('@goldas/domain');
const { internalHeaders } = require('./auth.js');
const { loadMemories, memorySection, memoryTools } = require('./golda-memory.js');
const { insightTools } = require('./golda-insights.js');
const { briefTools, BRIEF_TOOL_DEFS } = require('./golda-briefs.js');
const { windowStatus, TRANSFER_TOOL_DEF } = require('./transfer-windows.js');
const { recentMistakes, mistakesSection } = require('./golda-feedback.js');
const { keepDuration } = require('./agency-calendar.js');

// Since the model unification every person lives in `players` with a stage
// and a category. Golda keeps speaking in the old collection names (the
// prompt, the tools and Lou's habits all use them), and these map each name
// onto the physical collection plus the filter that selects its records.
const VIRTUAL = { players: { col: 'players', match: (d) => !d.stage || d.stage === 'represented' } };
for (const [category, legacy] of Object.entries(LEGACY_PIPELINE_COLLECTIONS)) {
  VIRTUAL[legacy] = { col: 'players', category, match: (d) => categoryFromPlayer(d) === category && d.stage && d.stage !== 'represented' };
}
const physical = (c) => (VIRTUAL[c] ? VIRTUAL[c].col : c);
const belongs = (c, d) => !d.deletedAt && (!VIRTUAL[c] || VIRTUAL[c].match(d));
// Records deleted by Golda go to the recycle bin, like the app's deletes.
const SOFT_DELETE = new Set(['players', 'clubs', 'deals', 'club_requirements', 'contacts', 'matches', 'tasks', 'trainings', 'meetings']);
const FILE_CHUNK = 600 * 1024;
const FILE_MAX = 15 * 1024 * 1024;
const MAX_STEPS = 60;
const MAX_TOKENS = 64000;
// Golda's depth of thought. Opus 5.5 always thinks; effort sets how hard.
// xhigh suits multi-step agent work (cross-checking, planning, verifying).
const EFFORT = 'xhigh';
const HISTORY_TURNS = 60;   // history entries replayed (user + assistant lines)
const READ_MAX = 20 * 1024 * 1024;   // largest stored file Golda will read (bytes)

const COLLECTIONS = {
  players: { label: 'player', nameField: 'fullName' },
  pipeline_men: { label: 'pipeline prospect (men)', nameField: 'playerName' },
  pipeline_women: { label: 'pipeline prospect (women)', nameField: 'playerName' },
  pipeline_youth: { label: 'pipeline prospect (youth)', nameField: 'playerName' },
  pipeline_jewish: { label: 'pipeline prospect (jewish)', nameField: 'playerName' },
  club_requirements: { label: 'club requirement', nameField: 'clubName' },
  matches: { label: 'match', nameField: 'homeTeam' },
  contacts: { label: 'contact', nameField: 'contactName' },
  tasks: { label: 'task', nameField: 'title' },
  trainings: { label: 'training (one-off or weekly)', nameField: 'title' },
  meetings: { label: "meeting in Lou's agency calendar", nameField: 'title' },
  deals: { label: 'deal (player ↔ club)', nameField: 'playerName' },
  tmWatch: { label: 'TM Watch find (Jewish player spotted on Transfermarkt)', nameField: 'name' },
};
// Readable but never written by Golda.
const READ_ONLY = {
  match_scores: { label: 'nightly match scores of an open requirement', nameField: 'clubName' },
  igDaily: { label: 'Instagram daily stats', nameField: 'date' },
  igPosts: { label: 'Instagram post', nameField: 'caption' },
};
const ALL = { ...COLLECTIONS, ...READ_ONLY };
const FILE_FIELDS = ['contractFiles', 'passportFiles', 'reprFiles'];
// Fields a tool may never set directly; the server owns them.
const PROTECTED = ['createdAt', 'createdBy', 'updatedAt', 'lastEditedAt', 'lastEditedBy', 'lastEditedByName', 'id',
  'calendarEventId', 'calendarLink', 'guests', 'meetUrl', 'recurring'];   // the last five belong to the Google calendar

const MAIN_TOPIC = 'מערכת';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function summarize(col, id, d) {
  const pick = ['fullName', 'playerName', 'name', 'title', 'clubName', 'contactName', 'homeTeam', 'awayTeam', 'date', 'time', 'status',
    'club', 'currentClub', 'primaryPosition', 'dob', 'gender', 'contractStatus', 'contractEnd', 'league', 'dueDate', 'priority', 'done',
    'contactRole', 'requiredPosition', 'marketValue', 'followers', 'newFollowers', 'place', 'rule', 'ageGroup', 'stage', 'clubName', 'validUntil'];
  const out = { collection: col, id };
  for (const k of pick) if (d[k] !== undefined && d[k] !== '') out[k] = d[k];
  for (const f of FILE_FIELDS) if (Array.isArray(d[f]) && d[f].length) out[f] = d[f].map((r) => r.name);
  return out;
}

// JSON-safe copy of a Firestore document (Timestamps → ISO strings).
function plain(v) {
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = plain(x); return o; }
  return v;
}

// One filter of the list tool. Dates are YYYY-MM-DD so they compare as text.
function matches(v, op, want) {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  if (op === 'empty') return empty;
  if (op === 'notEmpty') return !empty;
  if (Array.isArray(v)) {
    const has = v.some((x) => norm(typeof x === 'object' ? JSON.stringify(x) : x).includes(norm(want)));
    return op === 'ne' ? !has : has;
  }
  const num = (x) => (x !== '' && x !== null && !Number.isNaN(Number(x)) ? Number(x) : null);
  const a = num(v), b = num(want);
  const cmp = a !== null && b !== null ? a - b : String(v ?? '').localeCompare(String(want ?? ''));
  switch (op) {
    case 'eq': return typeof want === 'boolean' ? v === want : norm(v) === norm(want);
    case 'ne': return typeof want === 'boolean' ? v !== want : norm(v) !== norm(want);
    case 'contains': return norm(v).includes(norm(want));
    case 'gt': return !empty && cmp > 0;
    case 'gte': return !empty && cmp >= 0;
    case 'lt': return !empty && cmp < 0;
    case 'lte': return !empty && cmp <= 0;
    case 'in': return Array.isArray(want) && want.some((w) => norm(w) === norm(v));
    default: throw new Error(`unknown op ${op}`);
  }
}

// Stored files are base64 data URLs; split into Claude content blocks.
function fileBlocks(dataUrl, label) {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const type = (m[1] || '').toLowerCase();
  const data = m[2];
  if (type === 'application/pdf') return [{ type: 'text', text: label }, { type: 'document', source: { type: 'base64', media_type: type, data } }];
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) return [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: type, data } }];
  if (type.startsWith('text/') || type === 'application/json' || type === 'text/csv') {
    return [{ type: 'text', text: `${label}\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 200000)}` }];
  }
  return null;
}

// The app computes `league` on save (Players.js / Pipeline.js); mirror it so
// lists and filters keep working for records Golda writes.
function withLeague(col, data, before = {}) {
  const m = { ...before, ...data };
  const touched = ['leagueMode', 'leagueCountry', 'leagueTier', 'leagueManual'].some((k) => k in data);
  if (!touched || col === 'matches' || col === 'tasks') return data;
  const league = m.leagueMode === 'manual' ? (m.leagueManual || '')
    : [m.leagueCountry, String(m.leagueTier || '').replace('Tier ', '')].filter(Boolean).join(' ');
  return { ...data, league };
}

// A free agent has no club or contract (Players.js handleSave).
function freeAgentRules(col, data, before = {}) {
  const status = data.contractStatus ?? before.contractStatus;
  if (col !== 'players' || status !== 'Free') return data;
  return { ...data, currentClub: '', currentClubIsYouth: false, loanFrom: '', contractStart: '', contractEnd: '',
    league: '', leagueCountry: '', leagueTier: '', leagueManual: '' };
}

function validate(col, data, isCreate) {
  const bad = (m) => { throw new Error(m); };
  const inList = (k, list) => { if (data[k] && !list.includes(data[k])) bad(`${k} must be one of: ${list.join(', ')}`); };
  inList('primaryPosition', C.POSITIONS);
  inList('foot', C.FOOT_OPTIONS);
  inList('contractStatus', C.CONTRACT_STATUS);
  inList('natTeamStatus', C.NAT_TEAM_STATUS);
  inList('leagueTier', C.LEAGUE_TIERS);
  inList('leagueCountry', C.COUNTRIES);
  inList('contactRole', C.CONTACT_ROLES);
  inList('requiredPosition', C.POSITIONS);
  if (col.startsWith('pipeline_')) inList('status', C.PIPELINE_STATUS);
  if (data.gender && !['Men', 'Women'].includes(data.gender)) bad('gender must be Men or Women');
  if (col === 'trainings') {
    if (data.rule) {
      const r = data.rule;
      if (r.freq !== 'weekly' || !Array.isArray(r.byWeekday) || !r.byWeekday.length || r.byWeekday.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad('rule must be { freq: "weekly", byWeekday: [0-6…], start: YYYY-MM-DD, until: YYYY-MM-DD|null }');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.start || ''))) bad('rule.start must be YYYY-MM-DD');
      if (r.until && !/^\d{4}-\d{2}-\d{2}$/.test(String(r.until))) bad('rule.until must be YYYY-MM-DD or null');
    } else if (isCreate && !data.date) bad('a training needs a date (one-off) or a rule (weekly)');
    if (data.time && !/^\d{2}:\d{2}$/.test(data.time)) bad('time must be HH:MM');
  }
  if (col === 'deals' && data.stage && !C.PIPELINE_STATUS.includes(data.stage)) bad(`stage must be one of: ${C.PIPELINE_STATUS.join(', ')}`);
  for (const k of ['secondaryPositions']) if (data[k] && (!Array.isArray(data[k]) || data[k].some((p) => !C.POSITIONS.includes(p)))) bad(`${k} must be a list of: ${C.POSITIONS.join(', ')}`);
  for (const k of ['nationalities']) if (data[k] && (!Array.isArray(data[k]) || data[k].some((p) => !C.COUNTRIES.includes(p)))) bad(`${k} must be a list of country names exactly as in the CRM (e.g. "Israel", "United States")`);
  for (const k of Object.keys(data)) if (/(^dob$|Date$|Start$|End$|Expiry$|^date$)/.test(k) && data[k] && !/^\d{4}-\d{2}-\d{2}$/.test(data[k])) bad(`${k} must be YYYY-MM-DD`);
  if (isCreate) {
    const req = { players: ['fullName', 'gender'], club_requirements: ['clubName', 'gender'], matches: ['date', 'homeTeam', 'awayTeam', 'linkedPlayers'], tasks: ['title'], trainings: ['title'], meetings: ['title', 'date'], deals: ['playerId', 'clubName'] };
    for (const k of req[col] || (col.startsWith('pipeline_') ? ['playerName'] : [])) {
      if (data[k] === undefined || data[k] === '' || (Array.isArray(data[k]) && !data[k].length)) bad(`${k} is required for a new ${COLLECTIONS[col].label}`);
    }
    if (col === 'contacts' && !data.clubName && !data.contactName) bad('a contact needs clubName or contactName');
  }
}

function topicSection(topic) {
  if (!topic || topic.name === MAIN_TOPIC) {
    return `Current topic: the Gold A&S CRM (the main topic). Here you carry out any CRM request.`;
  }
  return `Current topic: "${topic.name}". The writer opened this topic with: "${topic.purpose || topic.name}". Stay on this topic and help with it fully (research, writing, planning, advice). Do NOT change anything in the CRM in this topic unless the writer explicitly asks for a CRM change in this message; reading the CRM is fine when it helps.`;
}

const ROLE_LINE = {
  admin: 'the agency owner, with full permissions',
  manager: "a member of Lou's team who may view and edit everything (not manage users or settings)",
  viewer: 'a viewer: they may read and ask anything, but you must NOT change the CRM for them (the write tools are not available in this chat; say so politely if asked)',
};

function systemPrompt(name, identity = { name: 'לו', role: 'admin' }, topic = null, topics = [], channel = 'whatsapp', memories = [], mistakes = []) {
  const sender = identity.name || 'לו';
  const where = channel === 'app' ? 'in the chat screen inside the CRM app' : 'on WhatsApp (each in their own private chat; the same conversation continues in the app)';
  return `You are ${name} (${name === 'גולדה' ? 'Golda' : name}), the assistant of the Gold A&S football agency. People from the agency write to you ${where}. You know the agency's CRM inside out: you read and analyse everything in it, including the documents stored in it, give recommendations, and carry out changes yourself using the tools. You can also search the web. The person writing is ${sender}, ${ROLE_LINE[identity.role] || ROLE_LINE.viewer}. Every change you make is recorded in their name.

${topicSection(topic)}
The chat is split into topics, each with its own conversation history; you only see the current topic's history (your long-term memory below is the same in every topic). Topics in this chat: ${[MAIN_TOPIC, ...topics.filter((t) => t !== MAIN_TOPIC)].join(', ')}. The writer switches with "גולדה, נושא חדש: <name>", "גולדה, חזרה לנושא <name>" and "גולדה, חזרה למערכת" (the system handles the switch before you see the message). If asked how topics work, explain these three phrases.

How you talk: always in Hebrew, in the feminine form about yourself ("הוספתי", "עדכנתי", "אני בודקת"), addressing ${sender} by name, warm and precise. WhatsApp formatting only: *bold*, _italic_, line breaks, "•" or "1." items; never markdown headers (#), tables or code blocks.
Match the length and shape of the answer to the ask:
- A quick question or a small change → one or two lines with the answer itself.
- An update, a report, an analysis or a multi-part request → organized writing: a first line that sums up the answer, then *bold* section titles, each with short numbered or • items carrying concrete names, dates, numbers and amounts (no vague "a few players"). Close with "*מה עכשיו:*" and one to three recommended actions, the most important first.
- Never pad: no repeating the question, no filler, no generic advice that the data doesn't support.
When you changed something, say exactly what changed (record, fields, old → new values) and end with a link to it when one exists: a player → https://goldas-crm.netlify.app/players/<id>, a deal → https://goldas-crm.netlify.app/market/deals?deal=<id>, a requirement → https://goldas-crm.netlify.app/market/requirements?req=<id>, a training or match → https://goldas-crm.netlify.app/calendar, a task → https://goldas-crm.netlify.app/tasks.

How you think:
- Understand what the writer is really after before acting. For a complex or multi-step request, plan the steps first, then gather everything you need: list whole collections (not just the first search results), cross-check players, deals, club requirements, matches, trainings, tasks, recent changes (changes) and what you remember. For a broad question ("מה המצב", "תני לי תמונה") start with overview.
- For questions about the data ("who…", "how many…", "which players…", "what's missing…"), answer with concrete names and numbers from the whole collection.
- Act, then verify: after changing records, read them back (get) to confirm the change landed as intended before you report it. If several changes were asked for, do all of them and report each one.
- Connect the dots like an experienced agent would: a contract ending soon and an open club requirement that fits the player → suggest a deal; a deal stuck in a stage → suggest the next step; a requirement with no good candidates → say what profile is missing. Point out anything important you notice (an expired passport, a missing document), in one line.
- When asked for a recommendation or opinion, give a clear one with the reasons, based on the CRM data and, when useful, a web search (club news, league tables, transfer windows, player stats). Say what you checked.
- To know what a document says (contract dates, salary, clauses, passport expiry), read it with read_file. When a file or photo is sent with the message you can see it directly. Offer to update the CRM from what you read (e.g. contractEnd from the contract), and do it if asked.
- Be honest about uncertainty: if the data is missing or contradictory, say so and what would settle it, instead of guessing.

Your memory: you have a long-term memory shared across all topics and conversations (listed at the end of this prompt). When the writer states something that should last (a preference about how they want things, a decision, a standing instruction, context about a player, a club or a contact that isn't a CRM field), or says "תזכרי"/"תזכור", save it with remember, in one clear sentence, then mention it in one line ("שמרתי בזיכרון: …"). CRM facts and decisions are shared with the team (shared=true); personal preferences of the writer are personal (shared=false). Never save passwords, codes, ID or passport numbers, bank details or anything secret. If a memory turns out wrong or the writer asks you to forget it, use forget (and remember the corrected version). Use what you remember without being asked, and never contradict it silently: if the data now disagrees with a memory, say so.

How you work:
- Find records before changing them (search or list). Never guess an id. If several records match, list them briefly and ask which one. If nothing matches, say so and offer to create it.
- If an instruction is missing something required, ask for it in one short question rather than inventing it. Don't ask about optional fields.
- Deleting needs the writer's explicit yes: call delete without confirmed first (one record, or several with items; you may arm more in the same turn), show the whole list of what will be deleted and ask once; only after they answer yes in a later message call delete once with confirmed=true, which deletes everything armed. Never ask for a separate yes per record.
- "בטל"/"תבטל"/undo → call undo_last (it reverses the writer's own last change).
- "מה השתנה…" / what changed (this week, since yesterday, on a player, by someone) → changes. "מה המצב" / the big picture → overview.
- "ספרי לי על <שחקן>" / "מה המצב של…" / before a call or meeting about a player → find the player, then player_brief (one call has everything), plus a short web search for recent news when useful. Answer as a briefing: who he is and where he stands, the dates that matter with days left, deals and fits, the next games, what is missing, and "*מה עכשיו:*". The same for a club with club_brief ("מה יש לנו עם מכבי…").
- "דף שחקן" / "CV" / "פרופיל PDF" / "תשלחי לי את הדף של…" → find the player, then player_pdf (English by default, the sheet clubs abroad get; lang "he" when asked in Hebrew for an Israeli club). The PDF is sent right after your answer, so keep the text to one line saying it is attached. Never send it to anyone but the person asking.
- "חלון העברות" / "מתי נסגר החלון" / "מי מתאים לחלון" → transfer_windows (exact dates and deadline times; Israel is not in it yet, so check the web for the IFA dates and say where you found them), then connect it to players who need a club (free agents, contracts ending, loans ending) and the open requirements.
- Golda opens follow-up tasks by herself for deals that sit too long in a stage (they say "מעקב:" and close by themselves when the deal moves). When asked what to do with a deal, mention its open follow-up.
- "הזדמנויות" / "מה כדאי לקדם" / "את מי להציע" → opportunities: for each, the player, the club and position, the score and the main reason, and the concrete next step (open a deal, call the contact).
- "מי מתאים לדרישה…" / who fits a club's requirement → suggest_matches (live scores from the matching engine). "מה דורש פעולה" / "מה יש היום" → alerts_today. "סנכרני משחקים" → sync_fixtures (admin/manager).
- Moving a deal: update its stage. The deal engine enforces the rules: "Mandate Received" needs a document on the deal or the writer's explicit confirmation (pass confirmed=true in data after they confirm), "Contract Signed" and "Not Relevant" close the deal (reopening a closed deal also needs confirmed=true), and "Not Relevant" frees the linked requirement. Tell the writer when a transition offers a follow-up (e.g. promote the candidate to a represented player: update the player's stage? No: say that the app offers it on the deal board).
- When they send a file or photo, it is available to attach_file for this message only. If it's unclear to whom or as what (contract / passport / representation agreement), ask.
- A photo or screenshot of a schedule (a team's weekly plan, a fixtures list, a coach's message with times): read every line (date, time, place, opponent, which player), resolve relative days ("ראשון", "מחר") against today's date, pass all lines to check_schedule, then show the writer the plan in short lines (what will be created, what already exists, what will be moved, names you could not match) and ask once with buttons [[כפתורים: צרי הכל | רק החדשים | בטלי]]. Only after they agree, create or update everything in one go and report it. A training's time is when the player must be there.
- Voice notes reach you already transcribed, starting with 🎤. Treat them exactly like a typed message; if a name or a number in the transcript looks misheard, ask about that one detail rather than guessing.
- A message starting with [הודעה מועברת] was forwarded from another chat (a coach, a club, a parent, another agent). Say in one line who it seems to be from and what it is about, pull out what matters for the CRM (dates, a player's status, an offer, a club's need) and propose what to record: a note on the player, a task with a date, a requirement, a game or training. Ask once with buttons before writing, unless the writer already said what to do with it. Never answer the original sender: you only talk to the agency.

Buttons: on WhatsApp the writer can tap instead of typing. When your answer ends with a short choice (yes/no before a deletion or a batch of changes, picking between two or three options, the natural next step), end the message with one last line [[כפתורים: א | ב | ג]]: one to three labels, each at most 20 characters, in the writer's words (e.g. [[כפתורים: כן, למחוק | לא]]). The line is turned into real buttons and is never shown as text; a tap comes back to you as a message with the label's text. Use it only for real choices, at most once per message, never for open questions. "תפריט" opens a fixed menu without you.
- Never claim you did something a tool didn't confirm. If a tool returns an error, explain it simply and say what you need.
- You cannot change users/permissions, send messages to other people, or change the website itself; say so if asked. igDaily and igPosts (Instagram stats) are read-only. Users can set their own morning briefing (hour, WhatsApp/email) on the Golda screen in the app, under "הגדרות".

CRM data (field names are exact; values in lists must match exactly; dates are YYYY-MM-DD):
- players: fullName*, gender* (Men|Women), dob, nationalities [country names], contractStatus (${C.CONTRACT_STATUS.join('|')}), currentClub, currentClubIsYouth (bool), loanFrom (when Loan), contractStart, contractEnd, loanParentEnd, primaryPosition (${C.POSITIONS.join('|')}), secondaryPositions [positions], foot (${C.FOOT_OPTIONS.join('|')}), natTeamStatus (${C.NAT_TEAM_STATUS.join('|')} or ""), passportNumber, passportExpiry, reprStart, reprEnd (representation agreement), notes, profileLink, videoLink, ifaTeamUrl (football.org.il player page, Israeli players), league fields. Files: contractFiles, passportFiles, reprFiles (use attach_file / remove_file, never update these directly).
- pipeline_men / pipeline_women / pipeline_youth / pipeline_jewish (prospects, NOT linked to players): playerName*, status (${C.PIPELINE_STATUS.join('|')}), profileLink, videoLink, agentName, agentPhone, nationalities, dob, primaryPosition, secondaryPositions, height (cm, 130-225, as a string), foot, currentClub, currentClubIsYouth, natTeamStatus, natTeamCountry, transferFee, salary (digits or "Not specified"), notes, league fields, linkedClubs [{clubName, linkedAt ISO}].
- club_requirements: clubName*, gender*, clubIsYouth, tablePosition, contactName, contactRole, contactPhone, requiredPosition (position), ageMin, ageMax, ageNotSpecified (bool), transferFee, salary, notes, league fields.
- contacts: clubName and/or contactName*, clubIsYouth, contactRole (${C.CONTACT_ROLES.join('|')}), contactPhone, league fields.
- tasks: title*, dueDate, priority (Low|Normal|High|Urgent), notes, linkedPlayers [player ids], done (bool).
- tmWatch (read and update; Jewish players found on Transfermarkt): name, club, clubCountry, marketValue, status (new|seen|...), starred (bool), addedToPipeline (bool).
- igDaily (read-only): date, followers, newFollowers. igPosts (read-only): Instagram posts and their stats.
- matches: date*, time (HH:MM), homeTeam*, awayTeam*, homeTeamIsYouth, awayTeamIsYouth, stadiumName, notes, linkedPlayers* [player ids], source "manual". (Israeli league fixtures also arrive automatically every morning.)
- trainings: title*, time (HH:MM), place, notes, linkedPlayers [player ids], ageGroup (noar|nearim_a|nearim_b|nearim_c|yeladim_a|yeladim_b|yeladim_c|trom_a|trom_b|trom_c, for youth groups), and EITHER date (one-off, YYYY-MM-DD) OR rule {freq:"weekly", byWeekday:[0=Sunday…6=Saturday], start: YYYY-MM-DD, until: YYYY-MM-DD or null}. To skip or move one session of a weekly training, update exceptions: [{date, cancelled:true}] or [{date, date2, time}] (date = the original session's date).
- Games and trainings are kept in sync, both ways, with Lou's Google calendar "Gold A&S Player Schedule": what you create, move or cancel here appears there within a minute, and what Lou adds or moves there ("אימון — <שחקן>", "משחק — <שחקן>") arrives here within ten minutes. The time of a training is the time the player has to be there (Lou's marker); put start times and other details in notes. So you never need to tell anyone to update the calendar by hand.
- meetings: title*, date*, time (HH:MM start; empty = all day), endTime (HH:MM; default one hour after time), endDate (only for an item longer than a day), allDay (bool), location, notes, linkedPlayers [player ids the meeting is about]. Read-only, from Google: guests, meetUrl, calendarLink. These are Lou's meetings with players, business meetings and everything of the agency that is not a game or training, kept in sync both ways with his Google calendar "Gold A&S" exactly like games and trainings with the player schedule (what Lou adds, moves or deletes there arrives here within ten minutes; what you write appears there within a minute). Games and trainings never go into meetings. You cannot invite guests: if the writer wants invitations sent, they add the guests in Google Calendar. When the writer asks what they have today or this week, include meetings next to games and trainings.
- deals (a player or candidate against one club): playerId*, playerName, clubName*, stage (${C.PIPELINE_STATUS.join('|')}), requirementId, notes. To move a deal, update its stage; "Contract Signed" and "Not Relevant" close it. A deal that waits more than 14 days in a stage shows as an alert.
- club_requirements also carry status (open|filled|closed) and validUntil (YYYY-MM-DD); an open requirement past validUntil shows as an alert. Nightly match scores per open requirement are in match_scores (read with get, id = requirement id).
- League fields (players, pipeline, requirements, contacts): leagueMode ("select"|"manual"), leagueCountry (country), leagueTier (${C.LEAGUE_TIERS.join('|')}), leagueManual (free text when manual). The "league" label is computed for you.
Free agents (contractStatus "Free") automatically lose club, contract dates and league.
Today's date: ${israelDate(new Date())} (Israel time zone).

${memorySection(memories)}
${mistakesSection(mistakes)}`;
}

const TOOLS = [
  { name: 'search', description: 'Find records by name or text in one collection, or all collections when collection is omitted. Matches Hebrew or English, partial names, case-insensitive. Returns up to 15 summaries with ids.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Name or words to look for; empty lists recent records' }, collection: { type: 'string', enum: Object.keys(ALL) } }, required: ['query'], additionalProperties: false } },
  { name: 'list', description: 'Read a whole collection (or the part matching filters) for analysis: counts, comparisons, "who/which/how many" questions. Returns total plus rows. Without fields, each row is a short summary; pass fields to get exactly those fields, or ["*"] for full records.',
    input_schema: { type: 'object', properties: {
      collection: { type: 'string', enum: Object.keys(ALL) },
      where: { type: 'array', description: 'All must match. Dates compare as YYYY-MM-DD text; on list fields, eq/contains mean "includes".',
        items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'empty', 'notEmpty'] }, value: {} }, required: ['field', 'op'], additionalProperties: false } },
      fields: { type: 'array', items: { type: 'string' } },
      sortBy: { type: 'string' }, desc: { type: 'boolean' },
      limit: { type: 'integer', description: 'Max rows, default 200, max 500' },
    }, required: ['collection'], additionalProperties: false } },
  { name: 'get', description: 'Read one full record by collection and id.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(ALL) }, id: { type: 'string' } }, required: ['collection', 'id'], additionalProperties: false } },
  { name: 'read_file', description: "Open a document stored on a player (contract, passport, representation agreement) and see its contents. PDFs and images are shown to you in full. Omit name when the player has a single document in that field.",
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, field: { type: 'string', enum: FILE_FIELDS }, name: { type: 'string', description: 'Display name of the document' } }, required: ['playerId', 'field'], additionalProperties: false } },
  { name: 'player_pdf', description: "Make the branded one-page player CV (PDF with the Gold A&S logo: age, position, foot, club, nationality, national team, notes, video and Transfermarkt links) and send it to the writer with your answer. English for clubs abroad (default), Hebrew for Israeli clubs. The writer forwards it; you never send it to anyone else.",
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, lang: { type: 'string', enum: ['en', 'he'] } }, required: ['playerId'], additionalProperties: false } },
  { name: 'rename_file', description: "Change a stored document's display name without re-uploading it.",
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, field: { type: 'string', enum: FILE_FIELDS }, name: { type: 'string', description: 'Current display name' }, newName: { type: 'string' } }, required: ['playerId', 'field', 'name', 'newName'], additionalProperties: false } },
  { name: 'create', description: 'Create a new record. Pass only the fields the user gave (plus required ones). Returns the new id.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, data: { type: 'object' } }, required: ['collection', 'data'], additionalProperties: false } },
  { name: 'update', description: 'Change fields on an existing record (partial update; other fields stay). To clear a field set it to "". Returns before/after of the changed fields.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, id: { type: 'string' }, data: { type: 'object' } }, required: ['collection', 'id', 'data'], additionalProperties: false } },
  { name: 'delete', description: 'Delete one record (collection + id) or several at once (items). First call without confirmed: it returns what would be deleted and arms those deletions; you may arm more in the same turn. After the user explicitly agrees in a later message, call once with confirmed=true (no items needed) and everything armed is deleted in one go.',
    input_schema: { type: 'object', properties: {
      collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, id: { type: 'string' },
      items: { type: 'array', description: 'Several records to delete together', items: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, id: { type: 'string' } }, required: ['collection', 'id'], additionalProperties: false } },
      confirmed: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'attach_file', description: 'Attach the file or photo sent with THIS message to a player, as a contract, passport or representation agreement document.',
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, field: { type: 'string', enum: FILE_FIELDS }, name: { type: 'string', description: 'Display name for the document; defaults to the file name' }, mode: { type: 'string', enum: ['add', 'replace'], description: 'add (default) keeps existing documents; replace removes them from the player' } }, required: ['playerId', 'field'], additionalProperties: false } },
  { name: 'remove_file', description: 'Remove one document from a player by its display name.',
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, field: { type: 'string', enum: FILE_FIELDS }, name: { type: 'string' } }, required: ['playerId', 'field', 'name'], additionalProperties: false } },
  { name: 'undo_last', description: "Reverse the writer's most recent change made through Golda that has not been undone yet.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'suggest_matches', description: 'The best live matches (players and candidates) for one club requirement, scored 0-100 by the matching engine, each with a worded explanation.',
    input_schema: { type: 'object', properties: { requirementId: { type: 'string' }, n: { type: 'integer', description: 'How many, default 5, max 10' } }, required: ['requirementId'], additionalProperties: false } },
  { name: 'alerts_today', description: "Everything that needs action now, from the CRM's alerts engine: contracts, representation and passports ending, birthdays, upcoming matches, stale deals, expired requirements, overdue tasks, failed night jobs. Same list as the app's Home screen.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'changes', description: 'What changed in the CRM over a period: every create, update and delete by the team in the app or through you, newest first, with who did it, the record and the fields (old → new values for your own changes). Defaults to the last 7 days.',
    input_schema: { type: 'object', properties: {
      since: { type: 'string', description: 'YYYY-MM-DD, an ISO time, or relative like "24h" / "7d" / "30d"' },
      until: { type: 'string', description: 'Same formats; default now' },
      collection: { type: 'string', description: 'Only this collection (players, deals, club_requirements, matches, tasks, trainings, contacts…)' },
      docId: { type: 'string', description: 'Only this record' },
      by: { type: 'string', description: 'Only changes by this person (part of the name or email)' },
      limit: { type: 'integer', description: 'Max rows, default 100, max 300' },
    }, additionalProperties: false } },
  { name: 'overview', description: "The agency at a glance: represented players (by gender and contract status), prospects per category and status, open deals by stage, open and expired club requirements, open and overdue tasks, this week's matches and training sessions, and how many changes you made in the last 7 days. Start here for broad questions.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'remember', description: 'Save something to your long-term memory so you know it in every future conversation: a preference, a decision, a standing instruction, or context about a player, club or contact. One clear sentence. Never secrets, passwords or ID numbers.',
    input_schema: { type: 'object', properties: {
      text: { type: 'string', description: 'The fact, in one or two sentences' },
      about: { type: 'string', description: 'Who or what it is about (a player, club, person or "preference"), short' },
      shared: { type: 'boolean', description: 'true (default): the whole team sees it; false: only the writer (personal preferences)' },
    }, required: ['text'], additionalProperties: false } },
  { name: 'forget', description: 'Delete one memory by its id (shown in "What you remember"), when it is wrong, outdated or the writer asks.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'sync_fixtures', description: 'Start the Israeli fixtures sync now (runs in the background for a few minutes; the Calendar shows the report). Admin and manager only.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  ...BRIEF_TOOL_DEFS, TRANSFER_TOOL_DEF];
// Which tools each role gets. A viewer reads; a manager edits; an admin does everything.
// Reading, the big picture and her own memory are open to every role.
const READ_TOOLS = new Set(['search', 'list', 'get', 'read_file', 'player_pdf', 'suggest_matches', 'alerts_today', 'changes', 'overview', 'remember', 'forget', 'player_brief', 'club_brief', 'opportunities', 'check_schedule', 'transfer_windows']);
const TOOL_ACTION = { create: 'edit', update: 'edit', rename_file: 'edit', attach_file: 'edit', remove_file: 'edit', undo_last: 'edit', delete: 'delete', sync_fixtures: 'run_sync' };
const toolsFor = (role) => TOOLS.filter((t) => READ_TOOLS.has(t.name) || can(role, TOOL_ACTION[t.name]));
// Anthropic-hosted tools; they run server-side, nothing to implement here.
const SERVER_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
];

// Pending deletions: Golda arms what the writer asked to delete, and deletes
// only what was armed in an EARLIER turn, so the yes always comes in its own
// message. Several records can be armed and then confirmed with one yes.
function normalizePending(session) {
  if (Array.isArray(session.pendingDeletes)) return session.pendingDeletes.filter((p) => p && p.collection && p.id);
  const one = session.pendingDelete;
  return one && one.collection && one.id ? [one] : [];
}
const sameTarget = (a, b) => a.collection === b.collection && a.id === b.id;
function armDeletes(pending, items, turn) {
  const out = [...pending];
  for (const it of items) {
    const i = out.findIndex((p) => sameTarget(p, it));
    if (i >= 0) { if (out[i].armedInTurn === undefined) out[i] = { ...out[i], armedInTurn: turn }; continue; }
    out.push({ collection: it.collection, id: it.id, armedInTurn: turn });
  }
  return out;
}
// What a confirmed call may delete: the armed records from earlier turns —
// those named in items, or all of them when items is empty.
function armedFor(pending, items, turn) {
  const ready = pending.filter((p) => p.armedInTurn !== turn);
  if (!items.length) return ready;
  return ready.filter((p) => items.some((it) => sameTarget(p, it)));
}

function createTools({ db, admin, identity, media, session, assistantName, channel = 'whatsapp' }) {
  const FieldValue = admin.firestore.FieldValue;
  const sender = identity.name || 'לו';
  const role = identity.role || 'viewer';
  // Writes are stamped with the person Golda acts for; the name says it was Golda.
  const who = { email: identity.email || OWNER_EMAIL, name: `${sender} (${assistantName})` };
  const audit = (entry) => db.collection('audit').add({
    ...entry, fields: Object.keys(entry.after || entry.before || {}).slice(0, 50),
    by: who.email, byName: who.name, via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '',
    sender, phone: identity.phone || '', at: FieldValue.serverTimestamp(), undone: false,
  });
  const need = (action) => { if (!can(role, action)) throw new Error(`${sender} is a ${role} and may not ${action} here`); };
  const colOk = (c) => { if (!COLLECTIONS[c]) throw new Error(READ_ONLY[c] ? `${c} is read-only` : `unknown collection ${c}`); return db.collection(physical(c)); };
  const readOk = (c) => { if (!ALL[c]) throw new Error(`unknown collection ${c}`); return db.collection(physical(c)); };
  // The documents of a (virtual) collection: live records that belong to it.
  const docsOf = async (c) => (await readOk(c).get()).docs.filter((d) => belongs(c, d.data()));
  const clean = (data) => { const o = { ...(data || {}) }; for (const k of PROTECTED) delete o[k]; return o; };
  const state = { pendingDeletes: normalizePending(session), changed: false, outFiles: [] };

  async function search({ query, collection }) {
    const cols = collection ? [collection] : Object.keys(ALL);
    const q = norm(query);
    const words = q.split(' ').filter(Boolean);
    const out = [];
    for (const c of cols) {
      for (const d of await docsOf(c)) {
        const data = d.data();
        const hay = norm([data.fullName, data.playerName, data.name, data.title, data.clubName, data.contactName, data.homeTeam, data.awayTeam,
          data.currentClub, data.club, data.notes, data.agentName, data.nameHe, data.hebrewName, data.caption].filter(Boolean).join(' '));
        if (!words.length || words.every((w) => hay.includes(w))) out.push(summarize(c, d.id, data));
        if (out.length >= 15) break;
      }
      if (out.length >= 15) break;
    }
    return out.length ? out : { found: 0, note: 'No match. Names may be stored in English; try the English spelling or part of the name.' };
  }

  async function list({ collection, where = [], fields, sortBy, desc, limit }) {
    let rows = (await docsOf(collection)).map((d) => ({ id: d.id, ...plain(d.data()) }));
    for (const w of where || []) rows = rows.filter((r) => matches(r[w.field], w.op, w.value));
    if (sortBy) {
      rows.sort((a, b) => {
        const x = a[sortBy], y = b[sortBy];
        if (x === undefined || x === '' || x === null) return 1;
        if (y === undefined || y === '' || y === null) return -1;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return desc ? -c : c;
      });
    }
    const total = rows.length;
    const n = Math.max(1, Math.min(Number(limit) || 200, 500));
    const full = Array.isArray(fields) && fields.includes('*');
    const out = rows.slice(0, n).map((r) => {
      for (const f of FILE_FIELDS) if (Array.isArray(r[f])) r[f] = r[f].map((x) => x.name);
      if (full) return r;
      if (Array.isArray(fields) && fields.length) { const o = { id: r.id }; for (const k of fields) if (r[k] !== undefined) o[k] = r[k]; return o; }
      return summarize(collection, r.id, r);
    });
    return { collection, total, returned: out.length, rows: out };
  }

  async function findDoc(playerId, field, name) {
    const s = await db.collection('players').doc(playerId).get();
    if (!s.exists) throw new Error('player not found');
    const files = s.data()[field] || [];
    if (!files.length) throw new Error(`${s.data().fullName} has no documents in ${field}`);
    const idx = name ? files.findIndex((r) => norm(r.name) === norm(name)) : (files.length === 1 ? 0 : -1);
    if (idx < 0) {
      const partial = name ? files.findIndex((r) => norm(r.name).includes(norm(name))) : -1;
      if (partial < 0) throw new Error(`which document? documents: ${files.map((r) => r.name).join(', ')}`);
      return { snap: s, files, idx: partial };
    }
    return { snap: s, files, idx };
  }

  // A document Golda made goes out with her answer (WhatsApp document / app attachment).
  async function playerPdf({ playerId, lang = 'en' }) {
    const snap = await db.collection('players').doc(playerId).get();
    if (!snap.exists || snap.data().deletedAt) throw new Error('player not found');
    if (state.outFiles.length >= 3) throw new Error('at most three documents per answer');
    const file = await require('./golda-pdf.js').playerCvPdf({ id: snap.id, ...snap.data() }, { lang });
    state.outFiles.push(file);
    return { made: true, filename: file.filename, sizeKB: Math.round(file.buffer.length / 1024), note: 'The PDF goes out right after your text answer; just say it is attached.' };
  }

  async function readFile({ playerId, field, name }) {
    const { snap, files, idx } = await findDoc(playerId, field, name);
    const ref = files[idx];
    let dataUrl = ref.url || '';
    if (!dataUrl && ref.fileId) {
      const meta = await db.collection('files').doc(ref.fileId).get();
      if (!meta.exists) throw new Error('the stored file is missing');
      if ((meta.data().size || 0) > READ_MAX) throw new Error('file is too large to read');
      const parts = meta.data().parts || 0;
      const chunks = await Promise.all(Array.from({ length: parts }, (_, i) => db.collection('files').doc(ref.fileId).collection('chunks').doc(String(i)).get()));
      if (chunks.some((c) => !c.exists)) throw new Error('the stored file is incomplete');
      dataUrl = chunks.map((c) => c.data().data).join('');
    }
    const blocks = fileBlocks(dataUrl, `Document "${ref.name}" of ${snap.data().fullName} (${field}), uploaded ${ref.uploadedAt || 'unknown'}:`);
    if (!blocks) return { name: ref.name, type: ref.type, note: 'This file type (e.g. Word) cannot be opened here; only PDF, images and text. Ask for a PDF or photo.' };
    return { __content: blocks };
  }

  async function renameFile({ playerId, field, name, newName }) {
    need('edit');
    const { snap, files, idx } = await findDoc(playerId, field, name);
    const to = String(newName || '').trim();
    if (!to) throw new Error('newName is empty');
    const after = files.map((r, i) => (i === idx ? { ...r, name: to } : r));
    await snap.ref.update({ [field]: after, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: who.email, lastEditedByName: who.name });
    if (files[idx].fileId) await db.collection('files').doc(files[idx].fileId).update({ name: to }).catch(() => {});
    await audit({ action: 'update', collection: 'players', docId: playerId, before: { [field]: files }, after: { [field]: after } });
    state.changed = true;
    return { renamed: true, player: snap.data().fullName, from: files[idx].name, to };
  }

  async function get({ collection, id }) {
    const s = await readOk(collection).doc(id).get();
    if (!s.exists || !belongs(collection, s.data())) throw new Error('not found');
    const d = plain(s.data());
    for (const f of FILE_FIELDS) if (Array.isArray(d[f])) d[f] = d[f].map((r) => ({ name: r.name, uploadedAt: r.uploadedAt, type: r.type }));
    return { collection, id, ...d };
  }

  async function create({ collection, data }) {
    need('edit');
    let d = clean(data);
    for (const f of FILE_FIELDS) delete d[f];
    if (collection === 'tasks') d = { priority: 'Normal', done: false, owner: who.email, ...d };
    if (collection === 'meetings') d = { time: '', endTime: '', allDay: !d.time, location: '', notes: '', linkedPlayers: [], source: 'manual', owner: who.email, ...d };
    if (collection === 'matches') d = { source: 'manual', ...d };
    if (collection.startsWith('pipeline_')) d = { status: 'Not Contacted', ...d };
    if (collection === 'players') d = { contractStatus: 'Under Contract', ...d };
    if (collection === 'trainings') d = { linkedPlayers: [], exceptions: [], source: 'golda', ...d };
    if (collection === 'deals') d = { stage: 'Initial Talks', history: [], closedAt: null, source: 'golda', ...d, enteredStageAt: new Date().toISOString() };
    validate(collection, d, true);
    d = freeAgentRules(collection, withLeague(collection, d));
    if (collection === 'players') {
      const dup = (await docsOf('players')).find((x) => norm(x.data().fullName) === norm(d.fullName)
        && x.data().gender === d.gender && (x.data().dob || '') === (d.dob || ''));
      if (dup) throw new Error(`a player with the same name, gender and date of birth already exists (id ${dup.id})`);
      d = { ...d, stage: 'represented', category: categoryFromPlayer(d), name: playerName(d) };
    } else if (VIRTUAL[collection]) {
      d = { ...d, stage: stageFromStatus(d.status), category: VIRTUAL[collection].category, name: playerName(d), source: 'golda' };
    }
    const ref = await colOk(collection).add({ ...d, deletedAt: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      lastEditedAt: FieldValue.serverTimestamp(), createdBy: who.email, lastEditedBy: who.email, lastEditedByName: who.name });
    await audit({ action: 'create', collection, docId: ref.id, before: null, after: d });
    state.changed = true;
    return { created: true, collection, id: ref.id };
  }

  async function update({ collection, id, data }) {
    need('edit');
    const ref = colOk(collection).doc(id);
    const s = await ref.get();
    if (!s.exists || !belongs(collection, s.data())) throw new Error('not found');
    const before = s.data();
    let d = clean(data);
    for (const f of FILE_FIELDS) delete d[f];
    const confirmed = d.confirmed === true;
    delete d.confirmed;
    for (const k of [...(collection === 'deals' ? [] : ['stage']), 'category', 'legacy', 'migratedAt', 'deletedAt', 'deletedBy']) delete d[k];
    validate(collection, d, false);
    // A deal moves through the same state machine as the app's deal board.
    let effects = null;
    if (collection === 'deals' && 'stage' in d && d.stage !== before.stage) {
      if (!isDealStage(d.stage)) throw new Error(`stage must be one of: ${C.PIPELINE_STATUS.join(', ')}`);
      const check = canTransition({ id, ...before }, d.stage, { confirmed });
      if (!check.ok) throw new Error(check.reason || 'this transition is not allowed');
      if (check.confirm && !confirmed) return { needsConfirmation: true, question: check.confirm, instruction: 'Ask the writer; after they agree in a new message, call update again with the same data plus confirmed: true.' };
      const r = applyTransition({ id, ...before }, d.stage, who.email, new Date(), String(d.note || ''), { confirmed });
      delete d.note;
      d = { ...d, ...r.patch };
      effects = r.effects;
      await db.collection('interactions').add({ kind: r.interaction.kind, playerId: before.playerId || '', dealId: id, clubId: before.clubId || '', text: r.interaction.text, by: who.email, at: new Date().toISOString(), deletedAt: null, createdAt: FieldValue.serverTimestamp(), createdBy: who.email });
      if (r.effects.freeRequirement && before.requirementId) await db.collection('club_requirements').doc(before.requirementId).update({ status: 'open' }).catch(() => {});
    }
    d = freeAgentRules(collection, withLeague(collection, d, before), before);
    if (collection === 'meetings') d = keepDuration(before, d);
    if (!Object.keys(d).length) throw new Error('nothing to change');
    // Keep the unified fields in step with what Golda changed.
    if (VIRTUAL[collection] && collection !== 'players' && 'status' in d && d.status !== before.status) d.stage = stageFromStatus(d.status);
    if (VIRTUAL[collection] && ('fullName' in d || 'playerName' in d)) d.name = playerName({ ...before, ...d });
    const prev = {};
    for (const k of Object.keys(d)) prev[k] = before[k] === undefined ? null : plain(before[k]);
    await ref.update({ ...d, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(),
      lastEditedBy: who.email, lastEditedByName: who.name, ...(collection === 'tasks' && 'done' in d ? { completedAt: d.done ? new Date().toISOString() : null } : {}) });
    await audit({ action: 'update', collection, docId: id, before: prev, after: d });
    state.changed = true;
    return { updated: true, collection, id, before: prev, after: d, ...(effects ? { effects } : {}) };
  }

  async function del({ collection, id, confirmed, items }) {
    need('delete');
    const wanted = Array.isArray(items) && items.length ? items : (collection && id ? [{ collection, id }] : []);
    if (!confirmed) {
      if (!wanted.length) throw new Error('nothing to delete: pass collection and id, or items');
      const wouldDelete = [];
      for (const it of wanted) {
        const ref = colOk(it.collection).doc(it.id);
        const snap = await ref.get();
        if (!snap.exists || !belongs(it.collection, snap.data())) throw new Error(`not found: ${it.collection}/${it.id}`);
        wouldDelete.push(summarize(it.collection, it.id, snap.data()));
      }
      state.pendingDeletes = armDeletes(state.pendingDeletes, wanted, session.turn);
      return { needsConfirmation: true, wouldDelete, armed: state.pendingDeletes.length,
        instruction: `${state.pendingDeletes.length} deletion(s) are armed. Show the writer the whole list and ask once; only after they say yes in a new message, call delete once with confirmed=true (no items needed) to delete all of them.` };
    }
    const targets = armedFor(state.pendingDeletes, wanted, session.turn);
    if (!targets.length) {
      const fresh = wanted.filter((it) => !state.pendingDeletes.some((p) => p.collection === it.collection && p.id === it.id));
      if (fresh.length) return del({ items: fresh, confirmed: false });
      throw new Error('nothing armed from an earlier message; arm the deletion first and ask the writer');
    }
    const deleted = [], missing = [];
    for (const t of targets) {
      const ref = colOk(t.collection).doc(t.id);
      const snap = await ref.get();
      if (!snap.exists || !belongs(t.collection, snap.data())) { missing.push(t); continue; }
      const before = plain(snap.data());
      if (SOFT_DELETE.has(physical(t.collection))) {
        await ref.update({ deletedAt: FieldValue.serverTimestamp(), deletedBy: who.email, updatedAt: FieldValue.serverTimestamp() });
      } else {
        await ref.delete();
      }
      await audit({ action: 'delete', collection: t.collection, docId: t.id, before, after: null });
      deleted.push(summarize(t.collection, t.id, before));
    }
    state.pendingDeletes = state.pendingDeletes.filter((p) => !targets.some((t) => t.collection === p.collection && t.id === p.id));
    state.changed = state.changed || deleted.length > 0;
    if (deleted.length === 1 && !missing.length && wanted.length <= 1) return { deleted: true, collection: deleted[0].collection, id: deleted[0].id, was: deleted[0] };
    return { deleted: deleted.length, was: deleted, ...(missing.length ? { missing } : {}) };
  }

  async function attachFile({ playerId, field, name, mode }) {
    need('edit');
    if (!media) throw new Error('no file was sent with this message; ask the writer to send it again');
    if (media.buffer.length > FILE_MAX) throw new Error('file is over 15 MB, the CRM limit');
    const ref = db.collection('players').doc(playerId);
    const s = await ref.get();
    if (!s.exists) throw new Error('player not found');
    const dataUrl = `data:${media.mimeType};base64,${media.buffer.toString('base64')}`;
    const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const chunks = [];
    for (let i = 0; i < dataUrl.length; i += FILE_CHUNK) chunks.push(dataUrl.slice(i, i + FILE_CHUNK));
    await Promise.all(chunks.map((data, i) => db.collection('files').doc(fileId).collection('chunks').doc(String(i)).set({ data })));
    const now = new Date().toISOString();
    const display = name || media.filename;
    await db.collection('files').doc(fileId).set({ name: display, originalName: media.filename, type: media.mimeType, size: media.buffer.length,
      parts: chunks.length, uploadedAt: now, uploadedBy: who.email });
    const fileRef = { fileId, name: display, originalName: media.filename, uploadedAt: now, uploadedBy: who.email, size: media.buffer.length, type: media.mimeType };
    const before = s.data()[field] || [];
    const after = mode === 'replace' ? [fileRef] : [...before, fileRef];
    await ref.update({ [field]: after, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: who.email, lastEditedByName: who.name });
    await audit({ action: 'update', collection: 'players', docId: playerId, before: { [field]: before }, after: { [field]: after } });
    state.changed = true;
    return { attached: true, player: s.data().fullName, field, name: display, documentsNow: after.map((r) => r.name) };
  }

  async function removeFile({ playerId, field, name }) {
    need('edit');
    const ref = db.collection('players').doc(playerId);
    const s = await ref.get();
    if (!s.exists) throw new Error('player not found');
    const before = s.data()[field] || [];
    const after = before.filter((r) => norm(r.name) !== norm(name));
    if (after.length === before.length) throw new Error(`no document named "${name}"; documents: ${before.map((r) => r.name).join(', ') || 'none'}`);
    await ref.update({ [field]: after, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: who.email, lastEditedByName: who.name });
    await audit({ action: 'update', collection: 'players', docId: playerId, before: { [field]: before }, after: { [field]: after } });
    state.changed = true;
    return { removed: true, documentsNow: after.map((r) => r.name) };
  }

  async function undoLast() {
    need('edit');
    // Single-field filter only, so no composite index is needed; Golda's own
    // writes are a few dozen a day. Each person undoes their own changes.
    const snap = await db.collection('audit').where('actor', '==', 'golda').get();
    const mineKey = identity.email ? (d) => d.onBehalfOf === identity.email : (d) => d.phone === identity.phone;
    const open = snap.docs.filter((d) => !d.data().undone && d.data().before !== undefined && mineKey(d.data()))
      .sort((a, b) => (b.data().at?.toMillis?.() || 0) - (a.data().at?.toMillis?.() || 0));
    if (!open.length) return { nothingToUndo: true };
    const last = open[0];
    const e = last.data();
    const ref = colOk(e.collection).doc(e.docId);
    const stamp = { updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: who.email, lastEditedByName: who.name };
    if (e.action === 'create') {
      if (SOFT_DELETE.has(physical(e.collection))) await ref.update({ deletedAt: FieldValue.serverTimestamp(), deletedBy: who.email, ...stamp });
      else await ref.delete();
    } else if (e.action === 'delete') {
      const { deletedAt: _a, deletedBy: _b, ...was } = e.before || {};
      await ref.set({ ...was, deletedAt: null, deletedBy: FieldValue.delete(), ...stamp }, { merge: true });
    }
    else {
      const restore = {};
      for (const [k, v] of Object.entries(e.before || {})) restore[k] = v === null ? FieldValue.delete() : v;
      await ref.update({ ...restore, ...stamp });
    }
    await last.ref.update({ undone: true, undoneAt: FieldValue.serverTimestamp(), undoneBy: who.email });
    state.changed = true;
    return { undone: e.action, collection: e.collection, id: e.docId, restored: e.before };
  }

  async function suggestMatches({ requirementId, n }) {
    const s = await db.collection('club_requirements').doc(requirementId).get();
    if (!s.exists || s.data().deletedAt) throw new Error('requirement not found');
    const req = { id: s.id, ...plain(s.data()) };
    const players = (await db.collection('players').get()).docs.map((d) => ({ id: d.id, ...plain(d.data()) })).filter((p) => !p.deletedAt && stageOfPlayer(p) !== 'not_relevant');
    const top = topMatches(req, players, { n: Math.max(1, Math.min(Number(n) || 5, 10)) });
    return { requirement: summarize('club_requirements', req.id, req), matches: top.map((m) => ({ playerId: m.playerId, name: m.name, score: m.score, why: explainMatch(m, 'he'), link: `https://goldas-crm.netlify.app/players/${m.playerId}` })) };
  }

  async function alertsToday() {
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => !x.deletedAt);
    const [players, matches, deals, requirements, tasks, jobs, settings] = await Promise.all([
      db.collection('players').get().then((s) => rows(s).filter((p) => !p.stage || p.stage === 'represented')),
      db.collection('matches').get().then(rows), db.collection('deals').get().then(rows), db.collection('club_requirements').get().then(rows),
      db.collection('tasks').get().then((s) => rows(s).filter((x) => role === 'admin' || (x.owner || OWNER_EMAIL) === who.email)),
      db.collection('jobs').orderBy('startedAt', 'desc').limit(40).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      db.collection('settings').doc('notifications').get().then((s) => mergeSettings(s.exists ? s.data() : {})),
    ]);
    const r = computeAlerts({ players, matches, deals, requirements, tasks, jobs, settings, now: new Date() });
    return { total: r.total, alerts: r.alerts.map((a) => ({ type: a.type, severity: a.severity, who: a.subject.name, kind: a.subject.kind, id: a.subject.id, what: a.proof.he, dueDate: a.dueDate, days: a.days })) };
  }

  async function syncFixtures() {
    need('run_sync');
    const base = process.env.URL || 'https://goldas-crm.netlify.app';
    const res = await fetch(`${base}/.netlify/functions/sync-matches-background`, { method: 'POST', headers: await internalHeaders('golda-sync') });
    if (!res.ok && res.status !== 202) throw new Error(`sync did not start (${res.status})`);
    return { started: true, note: 'Runs in the background for a few minutes; the Calendar shows the report when it finishes.' };
  }

  const impl = { search, list, get, read_file: readFile, player_pdf: playerPdf, rename_file: renameFile, create, update, delete: del, attach_file: attachFile, remove_file: removeFile, undo_last: undoLast,
    suggest_matches: suggestMatches, alerts_today: alertsToday, sync_fixtures: syncFixtures,
    ...insightTools({ db }), ...memoryTools({ db, identity }), ...briefTools({ db }), transfer_windows: async () => windowStatus(new Date()) };
  return { state, run: async (name, input) => {
    if (!impl[name]) throw new Error(`unknown tool ${name}`);
    const out = await impl[name](input || {});
    // A game or training she wrote shows in Lou's Google calendar at once
    // instead of at the next ten-minute check.
    const col = input && input.collection;
    if ((name === 'undo_last' || (['create', 'update', 'delete'].includes(name) && CALENDAR_COLLECTIONS.has(col)))) kickCalendarSync();
    return out;
  } };
}

const CALENDAR_COLLECTIONS = new Set(['matches', 'trainings', 'meetings']);
let calendarKicked = 0;
function kickCalendarSync() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY || Date.now() - calendarKicked < 5000) return;
  calendarKicked = Date.now();
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  internalHeaders('golda-calendar')
    .then((headers) => fetch(`${base}/.netlify/functions/calendar-sync-background`, { method: 'POST', headers, body: JSON.stringify({ reason: 'golda' }) }))
    .catch((e) => console.warn('[golda] calendar sync kick failed:', e.message));
}

// One WhatsApp message in, one reply out. history is a list of prior
// {role, text} turns (plain text only, so no thinking blocks are replayed).
async function runAgent({ db, admin, identity, text, media, session, assistantName, client, topic = null, topics = [], channel = 'whatsapp', memories }) {
  const anthropic = client || new Anthropic();
  const sender = identity.name || 'לו';
  const tools = createTools({ db, admin, identity, media, session, assistantName, channel });
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0 };
  const history = (topic ? topic.history || [] : session.history || []).slice(-HISTORY_TURNS);
  // Long-term memory is read once per message; a failed read never blocks the reply.
  const remembered = memories || await loadMemories(db, identity).catch((e) => { console.warn('[golda] memory read failed:', e.message); return []; });
  const mistakes = await recentMistakes(db).catch(() => []);
  const system = systemPrompt(assistantName, identity, topic, topics, channel, remembered, mistakes);
  const messages = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += `\n${h.text}`;
    else if (messages.length || role === 'user') messages.push({ role, content: h.text });
  }
  const userText = (text || '').trim() || (media ? '(sent a file without text)' : '');
  const fileNote = media ? `\n[Attached file: ${media.filename} (${media.mimeType}, ${Math.round(media.buffer.length / 1024)} KB) — available to attach_file in this message]` : '';
  const current = { role: 'user', content: userText + fileNote };
  // A PDF or photo sent with the message is also shown to Claude directly.
  const seen = media ? fileBlocks(`data:${media.mimeType};base64,${media.buffer.toString('base64')}`, `The file sent with this message (${media.filename}):`) : null;
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += `\n${current.content}`;
  else messages.push(current);
  if (seen) {
    const last = messages[messages.length - 1];
    last.content = [{ type: 'text', text: last.content }, ...seen];
  }

  let reply = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    // Streamed, so a long report or a deep analysis never hits an HTTP timeout.
    // The automatic cache breakpoint keeps every step of the loop reading the
    // tools, the system prompt and the conversation so far from the cache.
    const res = await anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' },
      system,
      tools: [...toolsFor(identity.role), ...SERVER_TOOLS],
      messages,
    }).finalMessage();
    usage.steps++;
    usage.inputTokens += res.usage?.input_tokens || 0;
    usage.outputTokens += res.usage?.output_tokens || 0;
    usage.cacheReadTokens += res.usage?.cache_read_input_tokens || 0;
    usage.cacheWriteTokens += res.usage?.cache_creation_input_tokens || 0;
    if (res.stop_reason === 'refusal') { reply = `מצטערת ${sender}, את זה אני לא יכולה לבצע.`; break; }
    messages.push({ role: 'assistant', content: res.content });
    // A long web search pauses server-side; resend as-is and it resumes.
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
    const results = [];
    for (const u of uses) {
      try {
        const out = await tools.run(u.name, u.input);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out && out.__content ? out.__content : JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = `${sender}, משהו השתבש באמצע ולא סיימתי. אפשר לנסח שוב?`;
  return { reply, pendingDeletes: tools.state.pendingDeletes, changed: tools.state.changed, userText: current.content, usage, files: tools.state.outFiles };
}

module.exports = { runAgent, createTools, TOOLS, toolsFor, COLLECTIONS, MAIN_TOPIC, MODEL, EFFORT, systemPrompt, _internal: { withLeague, freeAgentRules, validate, norm, matches, fileBlocks, armDeletes, armedFor, normalizePending } };
