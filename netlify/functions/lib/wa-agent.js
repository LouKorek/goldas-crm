// Golda — the WhatsApp assistant that edits the CRM on Lou's instructions.
// Claude reads the message, calls the tools below, and the tools write to
// Firestore with the same shapes and audit fields the React app writes
// (src/lib/db.js addDoc_/updateDoc_, uploadFile). Every write is logged in
// wa_audit with the record before and after, so "undo" can reverse it.
const Anthropic = require('@anthropic-ai/sdk');
const C = require('../data/crm-constants.js');

const MODEL = 'claude-opus-5-5';
const OWNER_EMAIL = 'lou.korek@gmail.com';
const FILE_CHUNK = 600 * 1024;
const FILE_MAX = 15 * 1024 * 1024;
const MAX_STEPS = 12;

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
};
const FILE_FIELDS = ['contractFiles', 'passportFiles', 'reprFiles'];
// Fields a tool may never set directly; the server owns them.
const PROTECTED = ['createdAt', 'createdBy', 'updatedAt', 'lastEditedAt', 'lastEditedBy', 'lastEditedByName', 'id'];

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function summarize(col, id, d) {
  const pick = ['fullName', 'playerName', 'title', 'clubName', 'contactName', 'homeTeam', 'awayTeam', 'date', 'status',
    'currentClub', 'primaryPosition', 'dob', 'gender', 'contractStatus', 'league', 'dueDate', 'done', 'contactRole', 'requiredPosition'];
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
  for (const k of ['secondaryPositions']) if (data[k] && (!Array.isArray(data[k]) || data[k].some((p) => !C.POSITIONS.includes(p)))) bad(`${k} must be a list of: ${C.POSITIONS.join(', ')}`);
  for (const k of ['nationalities']) if (data[k] && (!Array.isArray(data[k]) || data[k].some((p) => !C.COUNTRIES.includes(p)))) bad(`${k} must be a list of country names exactly as in the CRM (e.g. "Israel", "United States")`);
  for (const k of Object.keys(data)) if (/(^dob$|Date$|Start$|End$|Expiry$|^date$)/.test(k) && data[k] && !/^\d{4}-\d{2}-\d{2}$/.test(data[k])) bad(`${k} must be YYYY-MM-DD`);
  if (isCreate) {
    const req = { players: ['fullName', 'gender'], club_requirements: ['clubName', 'gender'], matches: ['date', 'homeTeam', 'awayTeam', 'linkedPlayers'], tasks: ['title'] };
    for (const k of req[col] || (col.startsWith('pipeline_') ? ['playerName'] : [])) {
      if (data[k] === undefined || data[k] === '' || (Array.isArray(data[k]) && !data[k].length)) bad(`${k} is required for a new ${COLLECTIONS[col].label}`);
    }
    if (col === 'contacts' && !data.clubName && !data.contactName) bad('a contact needs clubName or contactName');
  }
}

function systemPrompt(name, sender = 'לו') {
  return `You are ${name} (${name === 'גולדה' ? 'Golda' : name}), the assistant of the Gold A&S football agency. People from the agency write to you on WhatsApp (each in their own private chat) and you carry out changes in the agency's CRM yourself, using the tools. The person writing in this chat is ${sender}${sender === 'לו' ? ' (Lou, the agency owner)' : ', a member of Lou\'s team with full permissions'}.

How you talk: always in Hebrew, in the feminine form about yourself ("הוספתי", "עדכנתי", "אני בודקת"), addressing ${sender} by name, friendly and to the point. WhatsApp formatting only: *bold*, short lines, no markdown headers or tables. After acting, say exactly what changed (record, fields, old → new values). Keep replies short.

How you work:
- Find records before changing them (search). Never guess an id. If several records match, list them briefly and ask which one. If nothing matches, say so and offer to create it.
- If an instruction is missing something required, ask for it in one short question rather than inventing it. Don't ask about optional fields.
- Deleting needs the writer's explicit yes: call delete without confirmed first, show what will be deleted and ask; only after they answer yes in a later message call delete again with confirmed=true.
- "בטל"/"תבטל"/undo → call undo_last.
- When they send a file or photo, it is available to attach_file for this message only. If it's unclear to whom or as what (contract / passport / representation agreement), ask.
- Never claim you did something a tool didn't confirm. If a tool returns an error, explain it simply and say what you need.
- You can only work on the CRM data below. You cannot change users/permissions, send messages to other people, or change the website itself; say so if asked.

CRM data (field names are exact; values in lists must match exactly; dates are YYYY-MM-DD):
- players: fullName*, gender* (Men|Women), dob, nationalities [country names], contractStatus (${C.CONTRACT_STATUS.join('|')}), currentClub, currentClubIsYouth (bool), loanFrom (when Loan), contractStart, contractEnd, loanParentEnd, primaryPosition (${C.POSITIONS.join('|')}), secondaryPositions [positions], foot (${C.FOOT_OPTIONS.join('|')}), natTeamStatus (${C.NAT_TEAM_STATUS.join('|')} or ""), passportNumber, passportExpiry, reprStart, reprEnd (representation agreement), notes, profileLink, videoLink, ifaTeamUrl (football.org.il player page, Israeli players), league fields. Files: contractFiles, passportFiles, reprFiles (use attach_file / remove_file, never update these directly).
- pipeline_men / pipeline_women / pipeline_youth / pipeline_jewish (prospects, NOT linked to players): playerName*, status (${C.PIPELINE_STATUS.join('|')}), profileLink, videoLink, agentName, agentPhone, nationalities, dob, primaryPosition, secondaryPositions, height (cm, 130-225, as a string), foot, currentClub, currentClubIsYouth, natTeamStatus, natTeamCountry, transferFee, salary (digits or "Not specified"), notes, league fields, linkedClubs [{clubName, linkedAt ISO}].
- club_requirements: clubName*, gender*, clubIsYouth, tablePosition, contactName, contactRole, contactPhone, requiredPosition (position), ageMin, ageMax, ageNotSpecified (bool), transferFee, salary, notes, league fields.
- contacts: clubName and/or contactName*, clubIsYouth, contactRole (${C.CONTACT_ROLES.join('|')}), contactPhone, league fields.
- tasks: title*, dueDate, priority (Low|Normal|High|Urgent), notes, linkedPlayers [player ids], done (bool).
- matches: date*, time (HH:MM), homeTeam*, awayTeam*, homeTeamIsYouth, awayTeamIsYouth, stadiumName, notes, linkedPlayers* [player ids], source "manual". (Israeli league fixtures also arrive automatically every morning.)
- League fields (players, pipeline, requirements, contacts): leagueMode ("select"|"manual"), leagueCountry (country), leagueTier (${C.LEAGUE_TIERS.join('|')}), leagueManual (free text when manual). The "league" label is computed for you.
Free agents (contractStatus "Free") automatically lose club, contract dates and league.
Today's date: ${new Date().toISOString().slice(0, 10)} (Israel time zone).`;
}

const TOOLS = [
  { name: 'search', description: 'Find records by name or text in one collection, or all collections when collection is omitted. Matches Hebrew or English, partial names, case-insensitive. Returns up to 15 summaries with ids.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Name or words to look for; empty lists recent records' }, collection: { type: 'string', enum: Object.keys(COLLECTIONS) } }, required: ['query'], additionalProperties: false } },
  { name: 'get', description: 'Read one full record by collection and id.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, id: { type: 'string' } }, required: ['collection', 'id'], additionalProperties: false } },
  { name: 'create', description: 'Create a new record. Pass only the fields the user gave (plus required ones). Returns the new id.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, data: { type: 'object' } }, required: ['collection', 'data'], additionalProperties: false } },
  { name: 'update', description: 'Change fields on an existing record (partial update; other fields stay). To clear a field set it to "". Returns before/after of the changed fields.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, id: { type: 'string' }, data: { type: 'object' } }, required: ['collection', 'id', 'data'], additionalProperties: false } },
  { name: 'delete', description: 'Delete a record. First call without confirmed (returns what would be deleted and arms the deletion); after the user explicitly agrees in a later message, call again with confirmed=true.',
    input_schema: { type: 'object', properties: { collection: { type: 'string', enum: Object.keys(COLLECTIONS) }, id: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['collection', 'id'], additionalProperties: false } },
  { name: 'attach_file', description: 'Attach the file or photo sent with THIS message to a player, as a contract, passport or representation agreement document.',
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, field: { type: 'string', enum: FILE_FIELDS }, name: { type: 'string', description: 'Display name for the document; defaults to the file name' }, mode: { type: 'string', enum: ['add', 'replace'], description: 'add (default) keeps existing documents; replace removes them from the player' } }, required: ['playerId', 'field'], additionalProperties: false } },
  { name: 'remove_file', description: 'Remove one document from a player by its display name.',
    input_schema: { type: 'object', properties: { playerId: { type: 'string' }, field: { type: 'string', enum: FILE_FIELDS }, name: { type: 'string' } }, required: ['playerId', 'field', 'name'], additionalProperties: false } },
  { name: 'undo_last', description: 'Reverse the most recent change made through WhatsApp that has not been undone yet.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },
];

function createTools({ db, admin, phone, media, session, assistantName, sender = 'לו' }) {
  const FieldValue = admin.firestore.FieldValue;
  const who = { email: OWNER_EMAIL, name: sender === 'לו' ? `${assistantName} (WhatsApp)` : `${assistantName} (WhatsApp, ${sender})` };
  const audit = (entry) => db.collection('wa_audit').add({ ...entry, phone, sender, at: FieldValue.serverTimestamp(), undone: false });
  const colOk = (c) => { if (!COLLECTIONS[c]) throw new Error(`unknown collection ${c}`); return db.collection(c); };
  const clean = (data) => { const o = { ...(data || {}) }; for (const k of PROTECTED) delete o[k]; return o; };
  const state = { pendingDelete: session.pendingDelete || null, changed: false };

  async function search({ query, collection }) {
    const cols = collection ? [collection] : Object.keys(COLLECTIONS);
    const q = norm(query);
    const words = q.split(' ').filter(Boolean);
    const out = [];
    for (const c of cols) {
      const snap = await colOk(c).get();
      for (const d of snap.docs) {
        const data = d.data();
        const hay = norm([data.fullName, data.playerName, data.title, data.clubName, data.contactName, data.homeTeam, data.awayTeam,
          data.currentClub, data.notes, data.agentName, data.nameHe, data.hebrewName].filter(Boolean).join(' '));
        if (!words.length || words.every((w) => hay.includes(w))) out.push(summarize(c, d.id, data));
        if (out.length >= 15) break;
      }
      if (out.length >= 15) break;
    }
    return out.length ? out : { found: 0, note: 'No match. Names may be stored in English; try the English spelling or part of the name.' };
  }

  async function get({ collection, id }) {
    const s = await colOk(collection).doc(id).get();
    if (!s.exists) throw new Error('not found');
    const d = plain(s.data());
    for (const f of FILE_FIELDS) if (Array.isArray(d[f])) d[f] = d[f].map((r) => ({ name: r.name, uploadedAt: r.uploadedAt, type: r.type }));
    return { collection, id, ...d };
  }

  async function create({ collection, data }) {
    let d = clean(data);
    for (const f of FILE_FIELDS) delete d[f];
    if (collection === 'tasks') d = { priority: 'Normal', done: false, owner: OWNER_EMAIL, ...d };
    if (collection === 'matches') d = { source: 'manual', ...d };
    if (collection.startsWith('pipeline_')) d = { status: 'Not Contacted', ...d };
    if (collection === 'players') d = { contractStatus: 'Under Contract', ...d };
    validate(collection, d, true);
    d = freeAgentRules(collection, withLeague(collection, d));
    if (collection === 'players') {
      const dup = (await db.collection('players').get()).docs.find((x) => norm(x.data().fullName) === norm(d.fullName)
        && x.data().gender === d.gender && (x.data().dob || '') === (d.dob || ''));
      if (dup) throw new Error(`a player with the same name, gender and date of birth already exists (id ${dup.id})`);
    }
    const ref = await colOk(collection).add({ ...d, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      lastEditedAt: FieldValue.serverTimestamp(), createdBy: who.email, lastEditedBy: who.email, lastEditedByName: who.name });
    await audit({ action: 'create', collection, docId: ref.id, before: null, after: d });
    state.changed = true;
    return { created: true, collection, id: ref.id };
  }

  async function update({ collection, id, data }) {
    const ref = colOk(collection).doc(id);
    const s = await ref.get();
    if (!s.exists) throw new Error('not found');
    const before = s.data();
    let d = clean(data);
    for (const f of FILE_FIELDS) delete d[f];
    validate(collection, d, false);
    d = freeAgentRules(collection, withLeague(collection, d, before), before);
    if (!Object.keys(d).length) throw new Error('nothing to change');
    const prev = {};
    for (const k of Object.keys(d)) prev[k] = before[k] === undefined ? null : plain(before[k]);
    await ref.update({ ...d, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(),
      lastEditedBy: who.email, lastEditedByName: who.name, ...(collection === 'tasks' && 'done' in d ? { completedAt: d.done ? new Date().toISOString() : null } : {}) });
    await audit({ action: 'update', collection, docId: id, before: prev, after: d });
    state.changed = true;
    return { updated: true, collection, id, before: prev, after: d };
  }

  async function del({ collection, id, confirmed }) {
    const ref = colOk(collection).doc(id);
    const s = await ref.get();
    if (!s.exists) throw new Error('not found');
    const armed = state.pendingDelete && state.pendingDelete.collection === collection && state.pendingDelete.id === id
      && state.pendingDelete.armedInTurn !== session.turn;
    if (!confirmed || !armed) {
      state.pendingDelete = { collection, id, armedInTurn: session.turn };
      return { needsConfirmation: true, wouldDelete: summarize(collection, id, s.data()),
        instruction: 'Ask Lou to confirm in a new message. Only after Lou says yes, call delete again with confirmed=true.' };
    }
    const before = plain(s.data());
    await ref.delete();
    state.pendingDelete = null;
    await audit({ action: 'delete', collection, docId: id, before, after: null });
    state.changed = true;
    return { deleted: true, collection, id, was: summarize(collection, id, before) };
  }

  async function attachFile({ playerId, field, name, mode }) {
    if (!media) throw new Error('no file was sent with this message; ask Lou to send it again');
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
    // Single-field filter only, so no composite index is needed; volume is tiny.
    const snap = await db.collection('wa_audit').where('phone', '==', phone).get();
    const open = snap.docs.filter((d) => !d.data().undone)
      .sort((a, b) => (b.data().at?.toMillis?.() || 0) - (a.data().at?.toMillis?.() || 0));
    if (!open.length) return { nothingToUndo: true };
    const last = open[0];
    const e = last.data();
    const ref = colOk(e.collection).doc(e.docId);
    const stamp = { updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: who.email, lastEditedByName: who.name };
    if (e.action === 'create') await ref.delete();
    else if (e.action === 'delete') await ref.set({ ...e.before, ...stamp });
    else {
      const restore = {};
      for (const [k, v] of Object.entries(e.before || {})) restore[k] = v === null ? FieldValue.delete() : v;
      await ref.update({ ...restore, ...stamp });
    }
    await last.ref.update({ undone: true, undoneAt: FieldValue.serverTimestamp() });
    state.changed = true;
    return { undone: e.action, collection: e.collection, id: e.docId, restored: e.before };
  }

  const impl = { search, get, create, update, delete: del, attach_file: attachFile, remove_file: removeFile, undo_last: undoLast };
  return { state, run: async (name, input) => {
    if (!impl[name]) throw new Error(`unknown tool ${name}`);
    return impl[name](input || {});
  } };
}

// One WhatsApp message in, one reply out. history is a list of prior
// {role, text} turns (plain text only, so no thinking blocks are replayed).
async function runAgent({ db, admin, phone, text, media, session, assistantName, sender = 'לו', client }) {
  const anthropic = client || new Anthropic();
  const tools = createTools({ db, admin, phone, media, session, assistantName, sender });
  const history = (session.history || []).slice(-20);
  const messages = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += `\n${h.text}`;
    else if (messages.length || role === 'user') messages.push({ role, content: h.text });
  }
  const userText = (text || '').trim() || (media ? '(sent a file without text)' : '');
  const fileNote = media ? `\n[Attached file: ${media.filename} (${media.mimeType}, ${Math.round(media.buffer.length / 1024)} KB) — available to attach_file in this message]` : '';
  const current = { role: 'user', content: userText + fileNote };
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += `\n${current.content}`;
  else messages.push(current);

  let reply = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: systemPrompt(assistantName, sender),
      tools: TOOLS,
      messages,
    });
    if (res.stop_reason === 'refusal') { reply = `מצטערת ${sender}, את זה אני לא יכולה לבצע.`; break; }
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
    const results = [];
    for (const u of uses) {
      try {
        const out = await tools.run(u.name, u.input);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = `${sender}, משהו השתבש באמצע ולא סיימתי. אפשר לנסח שוב?`;
  return { reply, pendingDelete: tools.state.pendingDelete, changed: tools.state.changed, userText: current.content };
}

module.exports = { runAgent, createTools, TOOLS, COLLECTIONS, systemPrompt, _internal: { withLeague, freeAgentRules, validate, norm } };
