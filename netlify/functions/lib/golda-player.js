// Golda for players: a represented player whose number an admin switched on
// (players/{id}.goldaAccess + goldaPhone) can ask Golda about himself on
// WhatsApp. Read-only and his own data only: his profile, his games and
// trainings, his contract and document dates, his own CV. Never other
// players, deals, negotiations, the contract's money terms or the agency's
// notes. She only answers; she never writes to a player first. Anything he
// reports (an injury, an offer, a change) goes to the agency as a note that
// the hourly briefing pass delivers to the admins.
const { playerName, expandTrainings, AGE_GROUPS, israelDate } = require('@goldas/domain');

const MODEL = 'claude-opus-5-5';
const EFFORT = 'medium';
const MAX_TOKENS = 4000;
const MAX_STEPS = 4;
const DAILY_LIMIT = 30;
const PAST_DAYS = 7;
const AHEAD_DAYS = 30;

const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Only the fields a player may see about himself. */
function profileOf(p) {
  const keep = ['currentClub', 'loanFrom', 'primaryPosition', 'secondaryPositions', 'foot', 'dob', 'nationalities', 'contractStatus', 'contractStart', 'contractEnd',
    'loanParentEnd', 'reprStart', 'reprEnd', 'passportExpiry', 'natTeamStatus', 'league', 'profileLink', 'videoLink', 'ifaTeamUrl'];
  const out = { name: playerName(p) };
  for (const k of keep) if (p[k] !== undefined && p[k] !== '' && p[k] !== null) out[k] = p[k];
  return out;
}

/** His games and trainings from a week ago to a month ahead. */
function scheduleOf({ matches = [], trainings = [] }, playerId, today) {
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, AHEAD_DAYS);
  const games = matches.filter((m) => !m.deletedAt && (m.linkedPlayers || []).includes(playerId) && m.date >= from && m.date <= to)
    .map((m) => ({ kind: 'game', date: m.date, time: m.time || '', game: `${m.homeTeam} – ${m.awayTeam}`, place: m.stadiumName || '', competition: m.competition || m.league || '', result: m.result || m.score || '' }));
  const train = [];
  for (const tr of trainings.filter((t) => !t.deletedAt && (t.linkedPlayers || []).includes(playerId))) {
    for (const o of expandTrainings([tr], today, to)) {
      if (o.cancelled) continue;
      const g = AGE_GROUPS.find((x) => x.id === tr.ageGroup);
      train.push({ kind: 'training', date: o.date, time: o.time || tr.time || '', title: tr.title || '', group: g?.he || '', place: tr.place || '' });
    }
  }
  return [...games, ...train].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 60);
}

async function loadPlayerView(db, playerId, now = new Date()) {
  const snap = await db.collection('players').doc(playerId).get();
  if (!snap.exists || snap.data().deletedAt) return null;
  const p = { id: snap.id, ...snap.data() };
  const rows = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const [matches, trainings] = await Promise.all([
    db.collection('matches').where('linkedPlayers', 'array-contains', playerId).get().then(rows).catch(() => []),
    db.collection('trainings').where('linkedPlayers', 'array-contains', playerId).get().then(rows).catch(() => []),
  ]);
  const today = israelDate(now);
  return { player: p, profile: profileOf(p), schedule: scheduleOf({ matches, trainings }, playerId, today), today };
}

const TOOLS = [
  { name: 'my_cv', description: 'Make your own one-page CV (the Gold A&S player sheet, PDF) and send it with the answer. English by default, Hebrew when asked.',
    input_schema: { type: 'object', properties: { lang: { type: 'string', enum: ['en', 'he'] } } } },
  { name: 'tell_agent', description: 'Pass something the player reported to his agents at Gold A&S: an injury, a change in his club or schedule, an offer or a call he got, a document he needs, a question only the agent can answer. One clear Hebrew summary. urgent=true only for an injury, a deadline within days, or an offer that needs an answer now.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['summary'] } },
];

function systemPrompt(view, first) {
  return [
    `You are Golda (גולדה), the assistant of Gold A&S, a football players' agency in Israel. You are talking on WhatsApp with ${view.profile.name}, a player the agency represents. Call him ${first}. Hebrew, female voice, warm and short, unless he writes in another language.`,
    'You only answer questions about him, from the facts below: his profile, contract and document dates, and his schedule (games and trainings from a week ago to a month ahead). Today is ' + view.today + '.',
    'You cannot change anything. When he reports something (injury, a new club or coach, a schedule change, an offer or a call from a club or another agent, a document), thank him, call tell_agent with a clear summary, and tell him you passed it to the agency.',
    'Never talk about other players, the agency\'s other clients, deals, negotiations, offers the agency is working on, money terms of his contract, or the agency\'s internal notes; say that is for his agent (Lou) to discuss with him. Never give legal, medical or financial advice; pass it on with tell_agent.',
    'When he asks for his CV or profile sheet, call my_cv; it is sent right after your answer, so keep the text to one line.',
    'When something is not in the facts, say you do not have it and offer to pass the question on.',
    'WhatsApp formatting: short lines, *bold* only for a heading, no tables.',
    '',
    `Facts:\n${JSON.stringify({ profile: view.profile, schedule: view.schedule })}`,
  ].join('\n');
}

/**
 * One answer to a player. Returns { reply, userText, usage, files, notes }.
 * `notes` are what he asked to pass on (already written to golda_player_notes).
 */
async function runPlayerAgent({ db, admin, identity, text, media, history = [], client, now = new Date() }) {
  const view = await loadPlayerView(db, identity.playerId, now);
  const first = (identity.name || '').split(' ')[0] || identity.name;
  if (!view) return { reply: `${first}, אני לא מוצאת כרגע את הפרטים שלך. כדאי לדבר עם לו.`, userText: text || '', usage: null, files: [], notes: [] };
  const anthropic = client || new (require('@anthropic-ai/sdk'))();
  const files = [];
  const notes = [];
  const userText = (text || '').trim() || (media ? '(sent a file without text)' : '');
  const messages = [];
  for (const h of history.slice(-12)) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += `\n${h.text}`;
    else if (messages.length || role === 'user') messages.push({ role, content: String(h.text || '') });
  }
  let content = userText;
  if (messages.length && messages[messages.length - 1].role === 'user') { content = `${messages[messages.length - 1].content}\n${userText}`; messages.pop(); }
  const blocks = [{ type: 'text', text: content }];
  if (media && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(media.mimeType)) blocks.push({ type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.buffer.toString('base64') } });
  if (media && media.mimeType === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.buffer.toString('base64') } });
  messages.push({ role: 'user', content: blocks });

  const run = {
    async my_cv({ lang = 'en' } = {}) {
      if (files.length) throw new Error('the CV is already attached');
      const file = await require('./golda-pdf.js').playerCvPdf(view.player, { lang });
      files.push(file);
      return { made: true, note: 'It goes out right after your answer.' };
    },
    async tell_agent({ summary, urgent = false } = {}) {
      const s = String(summary || '').trim().slice(0, 1500);
      if (!s) throw new Error('summary is empty');
      const note = { playerId: view.player.id, playerName: view.profile.name, phone: identity.phone || '', summary: s, urgent: Boolean(urgent),
        delivered: false, at: admin.firestore.FieldValue.serverTimestamp(), atMs: now.getTime() };
      await db.collection('golda_player_notes').add(note);
      notes.push(note);
      return { passed: true };
    },
  };

  const usage = { inputTokens: 0, outputTokens: 0, steps: 0 };
  let reply = '';
  const system = systemPrompt(view, first);
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await anthropic.beta.messages.stream({
      model: MODEL, max_tokens: MAX_TOKENS, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: EFFORT },
      system, tools: TOOLS, messages,
    }).finalMessage();
    usage.steps++;
    usage.inputTokens += res.usage?.input_tokens || 0;
    usage.outputTokens += res.usage?.output_tokens || 0;
    if (res.stop_reason === 'refusal') { reply = `${first}, את זה אני לא יכולה לענות. כדאי לדבר עם לו.`; break; }
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) { reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); break; }
    const results = [];
    for (const u of uses) {
      try {
        if (!run[u.name]) throw new Error('unknown tool');
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await run[u.name](u.input || {})) });
      } catch (e) { results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true }); }
    }
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = `${first}, משהו השתבש ולא סיימתי. אפשר לנסח שוב?`;
  const fileNote = media ? ` [file: ${media.filename || 'file'}]` : '';
  return { reply, userText: userText + fileNote, usage, files, notes };
}

/** The admins' message: what players told Golda since the last one. */
function buildPlayerNotesMessage(name, notes) {
  const lines = [`*עדכונים משחקנים, ${name}* 💬`, ''];
  for (const n of notes) lines.push(`${n.urgent ? '🔴 ' : '• '}*${n.playerName}:* ${n.summary}`);
  lines.push('', 'השחקנים יודעים שהעברתי לכם. הם לא רואים את ההודעה הזו.');
  return lines.join('\n');
}

module.exports = { runPlayerAgent, loadPlayerView, profileOf, scheduleOf, systemPrompt, buildPlayerNotesMessage, DAILY_LIMIT, TOOLS };
