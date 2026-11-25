// Golda writes first to a connected player: the one exception to "her
// own-initiative messages go to the owner only".
//
// A represented player an admin connected to Golda (players/{id}.goldaAccess
// + goldaPhone, the "גולדה לשחקן" card) can get three kinds of message, each
// switched separately on his record, all OFF until an admin turns them on
// (the card, or Golda's player_messages tool):
//   goldaWeek              his games and trainings for the coming week, once a week;
//   goldaTrainingReminder  a reminder before each training;
//   goldaMatchWish         good luck before each match.
// Nothing goes to a player whose access is off, who is not represented, who
// has no number, or whose number belongs to someone on the team (the team
// always wins, as in lib/golda-identity.js).
//
// The texts are fixed templates filled from the records (no model call):
// short, warm, Hebrew, in his or her grammatical gender. They hold only his
// own schedule: the date, the time, the teams, the place, the training's
// title and age group. Never notes, deals, contracts, other players or
// anything else on the records. The player record has no sign that he does
// not read Hebrew, so every text is Hebrew.
//
// When: golda-queue-cron looks every ten minutes (dueNow: nothing at night,
// one small query when no player is switched on) and, only when something is
// due, wakes golda-briefing-background with { task: 'player-sends' }, which
// runs runPlayerSends below. Only between 08:00 and 22:00 Israel time.
// The timings are TIMING below, in one place.
// Once per event and per week: app_meta/goldaPlayerSends.keys, like the
// meeting brief. Right before each message the player and the training or
// match are read again, so a session that was moved, cancelled or deleted
// never gets a stale reminder; a moved one gets its own (marked as a change).
// Through lib/wa-outbox.js only (via nudge), so the 24-hour window and the
// templates are respected; a player never gets a content-free template, and
// a reminder that could not reach him before its event expires.
// He stops it himself: "די" / "הפסיקי" / "stop" switches all three off
// (stopForPlayer, called by lib/golda-worker.js before the model), she
// confirms in one line, and the admins hear through golda_player_notes.
const { israelDate, addDays, daysBetween, weekday, playerName, expandTrainings, AGE_GROUPS } = require('@goldas/domain');
const { digits, playerIdentity } = require('./golda-identity.js');
const { nudge } = require('./golda-nudge.js');

/** Every timing in one place. Hours are Israel time; minutes are before the event. */
const TIMING = Object.freeze({
  DAY_FROM_HOUR: 8,          // nothing before 08:00 …
  DAY_TO_HOUR: 22,           // … and nothing from 22:00
  WEEK_WEEKDAY: 6,           // Saturday (0 = Sunday) …
  WEEK_HOUR: 21,             // … at 21:00, after Shabbat ends all year round: the week from Sunday to Saturday
  WEEK_CATCH_UP_UNTIL: 12,   // missed on Saturday evening → Sunday morning until 12:00 (that day to Saturday)
  TRAINING_LEAD_MIN: 120,    // a reminder two hours before he has to be there (a training's time is his arrival time)
  TRAINING_LAST_MIN: 30,     // not later than half an hour before
  MATCH_LEAD_MIN: 240,       // good luck four hours before kickoff …
  MATCH_LAST_MIN: 60,        // … and not in the last hour, when he is in the dressing room
  MATCH_NO_TIME_FROM: 9,     // a match whose time is not known yet: on the day, 09:00 …
  MATCH_NO_TIME_UNTIL: 12,   // … until 12:00
  EVENING_BEFORE_HOUR: 20,   // when the lead time falls before 08:00 (an early training or match), 20:00 the evening before
});
const KEEP_KEYS_DAYS = 14;
const META = ['app_meta', 'goldaPlayerSends'];

/** The switches on the player record, by kind. */
const SEND_FIELDS = Object.freeze({ week: 'goldaWeek', training: 'goldaTrainingReminder', match: 'goldaMatchWish' });
const KINDS = Object.keys(SEND_FIELDS);
const KIND_OF_MESSAGE = { week: 'player-week', training: 'player-training', match: 'player-match' };

const pad = (n) => String(n).padStart(2, '0');
const validTime = (t) => /^\d{1,2}:\d{2}$/.test(String(t || '').trim());
const normTime = (t) => { const [h, m] = String(t).trim().split(':'); return `${pad(+h)}:${pad(+m)}`; };
const minutesOf = (t) => { const [h, m] = normTime(t).split(':').map(Number); return h * 60 + m; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Minutes since midnight in Israel. */
function israelMinutes(now) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
  return (h % 24) * 60 + m;
}
const clockOf = (now) => { const date = israelDate(now); const minutes = israelMinutes(now); return { date, minutes, hour: Math.floor(minutes / 60), weekday: weekday(date) }; };
const isDay = (clock) => clock.hour >= TIMING.DAY_FROM_HOUR && clock.hour < TIMING.DAY_TO_HOUR;

// ── who ──────────────────────────────────────────────────────────────────────
/** Connected: represented, access on, a number. The switches are checked per kind. */
function connected(p) {
  return !!p && !p.deletedAt && p.goldaAccess === true && (p.stage || 'represented') === 'represented' && !!digits(p.goldaPhone);
}
const wants = (p, kind) => connected(p) && p[SEND_FIELDS[kind]] === true;
const anyOn = (p) => KINDS.some((k) => p && p[SEND_FIELDS[k]] === true);

// ── when ─────────────────────────────────────────────────────────────────────
/** The Sunday that starts the week the weekly message is about, when it is due now; else null. */
function weekDue(clock) {
  if (!isDay(clock)) return null;
  if (clock.weekday === TIMING.WEEK_WEEKDAY && clock.hour >= TIMING.WEEK_HOUR) return addDays(clock.date, 1);
  if (clock.weekday === (TIMING.WEEK_WEEKDAY + 1) % 7 && clock.hour < TIMING.WEEK_CATCH_UP_UNTIL) return clock.date;
  return null;
}

/**
 * Whether a message before an event that starts at `date` `time` is due now.
 * lead / last in minutes; returns { inMinutes, evening } or null.
 */
function beforeEvent(clock, date, time, lead, last) {
  const days = daysBetween(clock.date, date);
  if (days < 0 || days > 1) return null;
  const start = minutesOf(time);
  const inMinutes = days * 1440 + start - clock.minutes;
  if (inMinutes < last) return null;
  // The moment it is meant to go: `lead` before, or the evening before when that falls in the night.
  const early = start - lead < TIMING.DAY_FROM_HOUR * 60;
  const target = early ? (days - 1) * 1440 + TIMING.EVENING_BEFORE_HOUR * 60 - clock.minutes : inMinutes - lead;
  if (target > 0) return null;
  return { inMinutes, evening: days === 1 };
}

const keyOf = (kind, playerId, eventId, date, time = '') => `${kind}|${playerId}|${eventId}|${date}|${time}`;
const sameSession = (a, b) => a.split('|').slice(0, 3).join('|') === b.split('|').slice(0, 3).join('|');

/** One player's trainings as sessions of today and tomorrow (not cancelled). */
function sessionsOf(trainings, playerId, from, to) {
  const out = [];
  for (const tr of trainings || []) {
    if (!tr || tr.deletedAt || !(tr.linkedPlayers || []).includes(playerId)) continue;
    for (const o of expandTrainings([tr], from, to)) {
      if (o.cancelled || !validTime(o.time)) continue;
      out.push({ training: tr, date: o.date, time: normTime(o.time), sourceDate: o.sourceDate });
    }
  }
  return out;
}
const gamesOf = (matches, playerId, from, to) => (matches || []).filter((m) => m && !m.deletedAt && (m.linkedPlayers || []).includes(playerId) && isDate(m.date) && m.date >= from && m.date <= to);

/**
 * What is due now for one player, before the sent keys are checked:
 * [{ kind, key, player, ...event }]. Pure, so it is tested.
 */
function dueFor(player, { trainings = [], matches = [] }, now = new Date()) {
  const clock = clockOf(now);
  if (!isDay(clock) || !connected(player)) return [];
  const out = [];
  const tomorrow = addDays(clock.date, 1);
  if (wants(player, 'week')) {
    const start = weekDue(clock);
    if (start) out.push({ kind: 'week', key: keyOf('week', player.id, '-', start), player, weekStart: start });
  }
  if (wants(player, 'training')) {
    for (const s of sessionsOf(trainings, player.id, clock.date, tomorrow)) {
      const when = beforeEvent(clock, s.date, s.time, TIMING.TRAINING_LEAD_MIN, TIMING.TRAINING_LAST_MIN);
      if (when) out.push({ kind: 'training', key: keyOf('training', player.id, `${s.training.id}@${s.sourceDate}`, s.date, s.time), player, ...s, ...when });
    }
  }
  if (wants(player, 'match')) {
    for (const m of gamesOf(matches, player.id, clock.date, tomorrow)) {
      let when = null;
      if (validTime(m.time)) when = beforeEvent(clock, m.date, normTime(m.time), TIMING.MATCH_LEAD_MIN, TIMING.MATCH_LAST_MIN);
      else if (m.date === clock.date && clock.hour >= TIMING.MATCH_NO_TIME_FROM && clock.hour < TIMING.MATCH_NO_TIME_UNTIL) when = { inMinutes: null, evening: false };
      if (when) out.push({ kind: 'match', key: keyOf('match', player.id, m.id, m.date), player, match: m, date: m.date, time: validTime(m.time) ? normTime(m.time) : '', ...when });
    }
  }
  return out;
}

// ── what ─────────────────────────────────────────────────────────────────────
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dm = (d) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
const firstName = (p) => (playerName(p) || '').trim().split(/\s+/)[0] || '';
const she = (p) => p.gender === 'Women';
const g = (p, male, female) => (she(p) ? female : male);
const one = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const groupOf = (tr) => (AGE_GROUPS.find((x) => x.id === tr.ageGroup) || {}).he || '';
const gameOf = (m) => [one(m.homeTeam), one(m.awayTeam)].filter(Boolean).join(' – ');
const STOP_HINT = (p) => `לא רוצה את ההודעות האלה? ${g(p, 'כתוב', 'כתבי')} לי "די".`;

/** The weekly message: his games and trainings from `from` to the Saturday. Null when the week is empty. */
function buildWeek(p, { trainings = [], matches = [] }, weekStart, today = weekStart) {
  const from = today > weekStart ? today : weekStart;
  const to = addDays(weekStart, 6);
  const items = [
    ...gamesOf(matches, p.id, from, to).map((m) => ({ date: m.date, time: validTime(m.time) ? normTime(m.time) : '', text: `משחק: ${gameOf(m)}${m.stadiumName ? ` · ${one(m.stadiumName)}` : ''}` })),
    ...sessionsOf(trainings, p.id, from, to).map((s) => ({ date: s.date, time: s.time, text: `אימון${one(s.training.title) && one(s.training.title) !== 'אימון' ? `: ${one(s.training.title)}` : ''}${s.training.place ? ` · ${one(s.training.place)}` : ''}` })),
  ].sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
  if (!items.length) return null;
  const lines = [`*שבוע טוב, ${firstName(p)}* ⚽`, `הלוח שלך לשבוע ${dm(from)}–${dm(to)}:`];
  let day = '';
  for (const it of items) {
    if (it.date !== day) { day = it.date; lines.push('', `*יום ${DAY_NAMES[weekday(it.date)]} ${dm(it.date)}*`); }
    lines.push(`• ${it.time || 'שעה תעודכן'} ${it.text}`);
  }
  lines.push('', `שבוע מוצלח! אם משהו השתנה, ${g(p, 'כתוב', 'כתבי')} לי ואעביר ללו.`, STOP_HINT(p));
  return lines.join('\n');
}

/** A reminder before a training. `changed`: an earlier reminder went out for this session at another time. */
function buildTraining(p, s, { changed = false } = {}) {
  const when = s.evening ? 'מחר' : 'היום';
  const tr = s.training;
  const title = one(tr.title) && one(tr.title) !== 'אימון' ? one(tr.title) : '';
  const lines = [changed ? `*${firstName(p)}, שינוי באימון ${when}* 🔄` : `*${firstName(p)}, תזכורת: אימון ${when}* ⏰`];
  lines.push(`${g(p, 'צריך', 'צריכה')} להיות שם ב-*${s.time}*${changed ? ` (${dm(s.date)})` : ''}`);
  const what = [title, groupOf(tr)].filter(Boolean).join(' · ');
  if (what) lines.push(what);
  if (tr.place) lines.push(`📍 ${one(tr.place)}`);
  lines.push(`שיהיה אימון טוב! 💪`);
  return lines.join('\n');
}

/** Good luck before a match. */
function buildMatch(p, s) {
  const m = s.match;
  const lines = [s.evening ? `*מחר משחק, ${firstName(p)}!* ⚽` : `*בהצלחה היום, ${firstName(p)}!* ⚽🍀`];
  lines.push(`${gameOf(m)}${s.time ? ` · ${s.time}` : ''}`);
  if (m.stadiumName) lines.push(`📍 ${one(m.stadiumName)}`);
  lines.push(s.evening ? `${g(p, 'תישן', 'תישני')} טוב, ומחר ${g(p, 'תן', 'תני')} הכל. מחזיקים לך אצבעות! 🍀` : `${g(p, 'תן', 'תני')} הכל ${g(p, 'ותיהנה', 'ותיהני')}. מחזיקים לך אצבעות!`);
  return lines.join('\n');
}

// ── the cron's check and the run ─────────────────────────────────────────────
const rowsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

async function loadSwitchedOn(db) {
  return rowsOf(await db.collection('players').where('goldaAccess', '==', true).get()).filter((p) => connected(p) && anyOn(p));
}

/** A player's own trainings and matches (two small queries, only for the kinds he gets). */
async function eventsOf(db, p) {
  const need = (k) => wants(p, k) || wants(p, 'week');
  const [trainings, matches] = await Promise.all([
    need('training') ? db.collection('trainings').where('linkedPlayers', 'array-contains', p.id).get().then(rowsOf) : [],
    need('match') ? db.collection('matches').where('linkedPlayers', 'array-contains', p.id).get().then(rowsOf) : [],
  ]);
  return { trainings, matches };
}

async function loadSent(db) {
  const snap = await db.collection(META[0]).doc(META[1]).get();
  return snap.exists ? (snap.data() || {}) : {};
}

/** Everything due now that was not sent yet. */
async function dueAll(db, now, sentKeys = null) {
  const clock = clockOf(now);
  if (!isDay(clock)) return { due: [], events: {} };
  const players = await loadSwitchedOn(db);
  if (!players.length) return { due: [], events: {} };
  const events = {};
  let due = [];
  for (const p of players) {
    events[p.id] = await eventsOf(db, p);
    due.push(...dueFor(p, events[p.id], now));
  }
  if (due.length) {
    const keys = sentKeys || (await loadSent(db)).keys || {};
    due = due.filter((d) => !keys[d.key]);
  }
  return { due, events };
}

/** The cron's check: is there a message for a player to send right now? Nothing is read at night. */
async function dueNow(db, now = new Date()) {
  return (await dueAll(db, now)).due;
}

/** The event read again right before it is sent: still there, still the same session? */
async function stillDue(db, item, now) {
  const ps = await db.collection('players').doc(item.player.id).get();
  if (!ps.exists) return null;
  const player = { id: ps.id, ...ps.data() };
  if (!wants(player, item.kind)) return null;
  if (item.kind === 'week') return { ...item, player };
  const col = item.kind === 'training' ? 'trainings' : 'matches';
  const es = await db.collection(col).doc(item.kind === 'training' ? item.training.id : item.match.id).get();
  if (!es.exists) return null;
  const rec = { id: es.id, ...es.data() };
  const fresh = dueFor(player, item.kind === 'training' ? { trainings: [rec] } : { matches: [rec] }, now).find((d) => d.key === item.key);
  return fresh || null;
}

/** When the message stops making sense: the event's start (or the week's end). */
function expiryOf(item) {
  if (item.kind === 'week') return new Date(`${addDays(item.weekStart, 7)}T00:00:00+02:00`).getTime();
  const t = item.time || `${pad(TIMING.MATCH_NO_TIME_UNTIL)}:00`;
  // Israel is UTC+2 or +3; the earlier reading (+3) is the safe side.
  return new Date(`${item.date}T${t}:00+03:00`).getTime();
}

/** The staff's numbers: a player whose number is one of them never gets these messages. */
async function staffNumbers(db) {
  const users = rowsOf(await db.collection('app_users').get());
  return new Set(users.map((u) => digits(u.whatsapp)).filter(Boolean));
}

/**
 * Sends what is due. Returns { sent, failed, skipped, items }.
 *   send  tests inject the sender: (u, body, kind, buttons) → { state }
 */
async function runPlayerSends(db, now = new Date(), { send = null, job = { note: () => {} } } = {}) {
  const state = await loadSent(db);
  const sentKeys = state.keys || {};
  const { due, events } = await dueAll(db, now, sentKeys);
  if (!due.length) return { sent: 0, failed: 0, skipped: 0, items: [] };
  const staff = await staffNumbers(db);
  const today = israelDate(now);
  const keys = Object.fromEntries(Object.entries(sentKeys).filter(([k]) => { const d = k.split('|')[3]; return isDate(d) && daysBetween(d, today) <= KEEP_KEYS_DAYS; }));
  const introduced = { ...(state.introduced || {}) };
  const done = [];
  let failed = 0;
  let skipped = 0;
  for (const planned of due) {
    try {
      const item = await stillDue(db, planned, now);
      if (!item) { skipped++; job.note(`player ${planned.kind} skipped (${planned.player.id}): changed or switched off since the check`); continue; }
      const p = item.player;
      if (staff.has(digits(p.goldaPhone))) { skipped++; job.note(`player ${item.kind} skipped (${p.id}): the number belongs to the team`); continue; }
      let body;
      if (item.kind === 'week') {
        body = buildWeek(p, events[p.id] || {}, item.weekStart, today);
        if (!body) { keys[item.key] = now.getTime(); skipped++; job.note(`player week (${p.id}): nothing this week, not sent`); continue; }
      } else if (item.kind === 'training') {
        body = buildTraining(p, item, { changed: Object.keys(keys).some((k) => k !== item.key && sameSession(k, item.key)) });
      } else body = buildMatch(p, item);
      if (item.kind !== 'week' && !introduced[p.id]) body = `${body}\n\n${STOP_HINT(p)}`;
      await nudge(db, playerIdentity(p), { body, kind: KIND_OF_MESSAGE[item.kind], remember: true, carryOnly: true, expiresAt: expiryOf(item) }, { now: now.getTime(), send, job });
      keys[item.key] = now.getTime();
      introduced[p.id] = introduced[p.id] || now.getTime();
      done.push(`${item.kind}:${p.id}`);
      job.note(`player ${item.kind} → ${p.id} (${playerName(p)})${item.date ? ` ${item.date} ${item.time || ''}`.trimEnd() : ''}`);
    } catch (e) {
      failed++;
      job.note(`player ${planned.kind} failed (${planned.player.id}): ${e.message}`);
    }
  }
  if (done.length || skipped) await db.collection(META[0]).doc(META[1]).set({ keys, introduced, updatedAt: now.getTime() });
  return { sent: done.length, failed, skipped, items: done };
}

// ── he stops it himself ──────────────────────────────────────────────────────
// The whole message is the request: "די", "הפסיקי", "stop", "תפסיקי לשלוח לי",
// "בלי הודעות". A sentence that only contains one of these words is a question for her.
const STOP_RE = /^(?:די(?:\s+(?:כבר|תודה|בבקשה))?|(?:ת?הפסיקי|תפסיקי|עצרי)(?:\s+(?:לשלוח(?:\s+לי)?(?:\s+(?:הודעות|תזכורות))?|את\s+ההודעות|עם\s+ההודעות|הודעות|את\s+התזכורות|תזכורות))?(?:\s+(?:תודה|בבקשה))?|בלי\s+הודעות|לא\s+רוצה\s+(?:יותר\s+)?הודעות|stop(?:\s+(?:it|please|messages|sending))?|unsubscribe)$/i;
function isStopCommand(text) {
  const t = String(text || '').replace(/[\s.!,?…🙏🛑✋❌]+$/u, '').replace(/^[\s.!,?]+/, '').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 40 && STOP_RE.test(t);
}

/**
 * The player asked to stop: all three switches off, the admins told through
 * golda_player_notes, an audit row. Returns { wasOn, kinds } (wasOn false: nothing was on).
 */
async function stopForPlayer(db, admin, identity, now = new Date()) {
  const ref = db.collection('players').doc(identity.playerId);
  const snap = await ref.get();
  if (!snap.exists) return { wasOn: false, kinds: [] };
  const p = { id: snap.id, ...snap.data() };
  const kinds = KINDS.filter((k) => p[SEND_FIELDS[k]] === true);
  if (!kinds.length) return { wasOn: false, kinds };
  const FieldValue = admin.firestore.FieldValue;
  const before = Object.fromEntries(KINDS.map((k) => [SEND_FIELDS[k], p[SEND_FIELDS[k]] === true]));
  const after = Object.fromEntries(KINDS.map((k) => [SEND_FIELDS[k], false]));
  await ref.update({ ...after, goldaSendsStoppedAt: now.toISOString(), updatedAt: FieldValue.serverTimestamp() });
  const name = playerName(p);
  await db.collection('audit').add({
    action: 'update', collection: 'players', docId: p.id, name, before, after, fields: Object.keys(after),
    summary: 'the player asked Golda to stop her messages', by: `player:${p.id}`, byName: `${name} (Golda)`, via: 'golda', channel: 'whatsapp',
    actor: 'golda-player', onBehalfOf: '', sender: name, phone: identity.phone || '', at: FieldValue.serverTimestamp(), undone: false,
  }).catch((e) => console.error('[golda-player-sends] audit failed:', e.message));
  const labels = { week: 'לוח שבועי', training: 'תזכורות לאימון', match: 'איחולים לפני משחק' };
  await db.collection('golda_player_notes').add({
    playerId: p.id, playerName: name, phone: identity.phone || '', urgent: false, delivered: false, kind: 'stop',
    summary: `ביקש${she(p) ? 'ה' : ''} שגולדה תפסיק לשלוח הודעות מעצמה (${kinds.map((k) => labels[k]).join(', ')}). כיביתי הכל; אפשר להפעיל שוב בכרטיס "גולדה לשחקן" בדף השחקן.`,
    at: FieldValue.serverTimestamp(), atMs: now.getTime(),
  });
  return { wasOn: true, kinds };
}

/** Her one-line answer. */
const stopConfirmation = (identity) => `בסדר, ${String(identity.name || '').split(' ')[0] || ''}, הפסקתי לשלוח לך הודעות מעצמי. אפשר תמיד לכתוב לי ולשאול 🙂`.replace(', ,', ',');

// ── the agent's tool (admins) ────────────────────────────────────────────────
const PLAYER_MESSAGES_TOOL_DEF = {
  name: 'player_messages',
  description: 'What Golda sends on her own to a represented player connected to her (goldaAccess on, with his number): week = his games and trainings for the coming week (Saturday 21:00), training = a reminder two hours before each training, match = good luck before each match. Each is switched separately and all are off until an admin turns them on. action on/off with kinds (one or more, or all), or status. Admin only. "תשלחי ל… לוח שבועי" → on [week]; "תפסיקי לשלוח ל… תזכורות" → off [training].',
  input_schema: { type: 'object', properties: {
    playerId: { type: 'string' },
    action: { type: 'string', enum: ['on', 'off', 'status'] },
    kinds: { type: 'array', items: { type: 'string', enum: ['week', 'training', 'match', 'all'] } },
  }, required: ['playerId', 'action'], additionalProperties: false },
};

function playerMessagesTools({ db, admin, identity = {}, role, channel = 'whatsapp' }) {
  return {
    player_messages: async ({ playerId, action, kinds = [] } = {}) => {
      if (role !== 'admin') throw new Error('only an admin decides what Golda sends to a player');
      const ref = db.collection('players').doc(String(playerId || ''));
      const snap = await ref.get();
      if (!snap.exists || snap.data().deletedAt) throw new Error('player not found');
      const p = { id: snap.id, ...snap.data() };
      const status = () => ({ player: playerName(p), connected: connected(p), ...Object.fromEntries(KINDS.map((k) => [k, p[SEND_FIELDS[k]] === true])) });
      if (action === 'status') return status();
      if (action !== 'on' && action !== 'off') throw new Error('action is on, off or status');
      const list = !kinds.length || kinds.includes('all') ? KINDS : KINDS.filter((k) => kinds.includes(k));
      if (!list.length) throw new Error('kinds: week, training, match or all');
      const on = action === 'on';
      if (on && !connected(p)) {
        throw new Error((p.stage || 'represented') !== 'represented' ? 'only a represented player can get messages from Golda'
          : 'this player is not connected to Golda yet: an admin first turns on "גולדה לשחקן" with his WhatsApp number (on his page, or goldaAccess + goldaPhone)');
      }
      const before = Object.fromEntries(list.map((k) => [SEND_FIELDS[k], p[SEND_FIELDS[k]] === true]));
      const after = Object.fromEntries(list.map((k) => [SEND_FIELDS[k], on]));
      if (list.every((k) => before[SEND_FIELDS[k]] === on)) return { ...status(), unchanged: true };
      const FieldValue = admin.firestore.FieldValue;
      const who = `${identity.name || ''} (Golda)`.trim();
      await ref.update({ ...after, updatedAt: FieldValue.serverTimestamp(), lastEditedAt: FieldValue.serverTimestamp(), lastEditedBy: identity.email || '', lastEditedByName: who });
      await db.collection('audit').add({
        action: 'update', collection: 'players', docId: p.id, name: playerName(p), before, after, fields: Object.keys(after),
        by: identity.email || '', byName: who, via: 'golda', channel, actor: 'golda', onBehalfOf: identity.email || '',
        sender: identity.name || '', phone: identity.phone || '', at: FieldValue.serverTimestamp(), undone: false,
      });
      Object.assign(p, after);
      return { ...status(), changed: list, note: on ? 'They start at the next due moment, only between 08:00 and 22:00. The player can stop them by writing "די".' : 'Stopped.' };
    },
  };
}

module.exports = {
  TIMING, SEND_FIELDS, KINDS, connected, wants, dueFor, weekDue, beforeEvent, buildWeek, buildTraining, buildMatch,
  dueNow, runPlayerSends, isStopCommand, stopForPlayer, stopConfirmation, playerMessagesTools, PLAYER_MESSAGES_TOOL_DEF, expiryOf, israelMinutes,
};
