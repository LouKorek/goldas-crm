// A brief before every meeting. About an hour before a meeting or a call in
// the CRM's meetings (Lou's agency calendar), Golda sends him a short brief:
// who it is with, what was last agreed, the open deals and tasks, what waits.
//
// When: golda-queue-cron looks every ten minutes (dueNow: two small reads) and,
// only when a meeting is coming up, wakes golda-briefing-background with
// { task: 'meeting-briefs' }, which runs runMeetingBriefs below.
// Once per meeting and day: app_meta/goldaMeetingBriefs.keys['<id>|<date>'].
// To the owner only, through lib/wa-outbox.js. No model call: the brief is
// built from the records, so it is fast and always the same facts the app shows.
const { israelDate, daysBetween, addDays, playerName, isClosedStage, daysInStage, DEAL_STAGE_LABELS } = require('@goldas/domain');
const { whatsappRecipients } = require('./golda-identity.js');
const { visibleMemories } = require('./golda-memory.js');
const { ownerOf, nudge } = require('./golda-nudge.js');

const APP = 'https://goldas-crm.netlify.app';
const META = ['app_meta', 'goldaMeetingBriefs'];
// A meeting is briefed the first time a check finds it between these many
// minutes away: normally 60 to 70 before; one added late still gets its brief.
const FROM_MIN = 10;
const TO_MIN = 70;
const KEEP_KEYS_DAYS = 3;
const NOTE_MAX = 400;

const live = (rows) => (rows || []).filter((r) => r && !r.deletedAt);
const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : String(s || ''); };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const norm = (s) => String(s || '').toLowerCase().replace(/["'׳״.,()\-–]/g, ' ').replace(/\s+/g, ' ').trim();
const minutesOf = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Minutes since midnight in Israel. */
function israelMinutes(now) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
  return (h % 24) * 60 + m;
}

const keyOf = (m) => `${m.id}|${m.date}`;

/** The meetings to brief now: timed, not all-day, starting within the window, not briefed yet. */
function dueMeetings(meetings, sentKeys = {}, now = new Date()) {
  const today = israelDate(now);
  const nowMin = israelMinutes(now);
  const out = [];
  for (const m of live(meetings)) {
    if (m.allDay || !/^\d{4}-\d{2}-\d{2}$/.test(String(m.date || ''))) continue;
    const start = minutesOf(m.time);
    if (start === null) continue;
    const days = daysBetween(today, m.date);
    if (days < 0 || days > 1) continue;
    const inMinutes = days * 1440 + start - nowMin;
    if (inMinutes < FROM_MIN || inMinutes > TO_MIN || sentKeys[keyOf(m)]) continue;
    out.push({ ...m, inMinutes, key: keyOf(m) });
  }
  return out.sort((a, b) => a.inMinutes - b.inMinutes);
}

/** The people and clubs a meeting is about: the linked players, or the names in its title. */
function subjectsOf(meeting, { players = [], deals = [], requirements = [] }) {
  const all = live(players);
  let linked = (meeting.linkedPlayers || []).map((id) => all.find((p) => p.id === id)).filter(Boolean);
  const title = ` ${norm(`${meeting.title || ''} ${meeting.notes || ''}`)} `;
  if (!linked.length) {
    linked = all.filter((p) => { const n = norm(playerName(p)); return n.length >= 4 && n.includes(' ') && title.includes(` ${n} `); }).slice(0, 4);
  }
  const clubs = new Set();
  for (const name of [...live(deals).map((d) => d.clubName), ...live(requirements).map((r) => r.clubName)]) {
    const n = norm(name);
    if (n.length >= 4 && title.includes(` ${n} `)) clubs.add(String(name).trim());
  }
  return { players: linked, clubs: [...clubs].slice(0, 3) };
}

const ageOf = (dob, today) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob || '')); if (!m) return null; let a = Number(today.slice(0, 4)) - Number(m[1]); if (today.slice(5) < `${m[2]}-${m[3]}`) a--; return a; };

/** A date field with how far it is: "30/06/2027 (בעוד 217 ימים)" / "(פג לפני 3 ימים)". */
function dueLine(label, date, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const d = daysBetween(today, date);
  const [y, mo, da] = date.split('-');
  const when = d === 0 ? 'היום' : d > 0 ? `בעוד ${d} ימים` : `עבר לפני ${-d} ימים`;
  return `${label} ${da}/${mo}/${y} (${when})${d < 0 ? ' ⚠️' : d <= 30 ? ' ⏳' : ''}`;
}

/** Everything the brief says, as plain data (tested). */
function meetingFacts(meeting, data, now = new Date()) {
  const today = israelDate(now);
  const { players, clubs } = subjectsOf(meeting, data);
  const ids = new Set(players.map((p) => p.id));
  const openDeal = (d) => !d.closedAt && !isClosedStage(d.stage);
  const dealLine = (d) => {
    const days = daysInStage(d, now);
    return { player: d.playerName || '', club: d.clubName || '', stage: DEAL_STAGE_LABELS[d.stage] || d.stage || '', days: days === null ? null : days };
  };
  const taskOf = (t) => ({ title: t.title || '', dueDate: t.dueDate || '', overdue: Boolean(t.dueDate && t.dueDate < today) });
  const openTasks = live(data.tasks).filter((t) => !t.done);

  const people = players.map((p) => ({
    id: p.id, name: playerName(p), age: ageOf(p.dob, today), woman: p.gender === 'Women', position: p.primaryPosition || '',
    club: p.currentClub || (p.contractStatus === 'Free' ? (p.gender === 'Women' ? 'שחקנית חופשייה' : 'שחקן חופשי') : ''),
    dates: [dueLine('חוזה עד', p.contractEnd, today), dueLine('הסכם ייצוג עד', p.reprEnd, today),
      /^\d{4}/.test(String(p.passportExpiry || '')) && daysBetween(today, p.passportExpiry) <= 120 ? dueLine('דרכון עד', p.passportExpiry, today) : null].filter(Boolean),
    deals: live(data.deals).filter((d) => d.playerId === p.id && openDeal(d)).map(dealLine),
    tasks: openTasks.filter((t) => (t.linkedPlayers || []).includes(p.id)).map(taskOf).slice(0, 4),
  }));
  const clubFacts = clubs.map((name) => ({
    name,
    deals: live(data.deals).filter((d) => norm(d.clubName) === norm(name) && openDeal(d) && !ids.has(d.playerId)).map(dealLine).slice(0, 4),
    requirements: live(data.requirements).filter((r) => norm(r.clubName) === norm(name) && (r.status || 'open') === 'open').map((r) => r.requiredPosition || '').filter(Boolean).slice(0, 4),
  }));

  // What was last agreed: the latest earlier meeting about the same people (or
  // with the same title) that has notes, and what Golda remembers about them.
  const sameTitle = norm(meeting.title);
  const before = live(data.meetings).filter((m) => m.id !== meeting.id && String(m.notes || '').trim()
    && (m.date < meeting.date || (m.date === meeting.date && String(m.time || '') < String(meeting.time || '')))
    && ((m.linkedPlayers || []).some((id) => ids.has(id)) || (sameTitle && norm(m.title) === sameTitle)))
    .sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`));
  const last = before[0] ? { date: before[0].date, title: before[0].title || '', notes: clip(before[0].notes, NOTE_MAX) } : null;
  const names = [...players.map((p) => norm(playerName(p))), ...clubs.map(norm)].filter(Boolean);
  const memories = (data.memories || []).filter((m) => { const t = norm(`${m.about || ''} ${m.text || ''}`); return names.some((n) => t.includes(n)); })
    .slice(0, 3).map((m) => clip(m.text, 220));

  return {
    title: meeting.title || 'פגישה', time: meeting.time || '', endTime: meeting.endTime || '', location: meeting.location || '', meetUrl: meeting.meetUrl || '',
    guests: (Array.isArray(meeting.guests) ? meeting.guests : []).slice(0, 6), agenda: clip(meeting.notes, NOTE_MAX), inMinutes: meeting.inMinutes,
    people, clubs: clubFacts, last, memories,
    link: people.length === 1 ? `${APP}/players/${people[0].id}` : `${APP}/calendar`,
  };
}

/** The brief as WhatsApp text. */
function buildMeetingBrief(first, f) {
  const inMin = Number(f.inMinutes);
  const when = !Number.isFinite(inMin) ? 'בקרוב' : inMin >= 50 ? 'בעוד כשעה' : `בעוד ${inMin} דקות`;
  const out = [`*${first}, פגישה ${when}* 🗓️`, `*${f.title}* · ${f.time}${f.endTime ? `–${f.endTime}` : ''}${f.location ? ` · ${f.location}` : ''}`];
  if (f.meetUrl) out.push(f.meetUrl);
  if (f.guests.length) out.push(`משתתפים: ${f.guests.join(', ')}`);
  if (f.agenda) out.push(`על הפרק: ${f.agenda}`);

  for (const p of f.people) {
    out.push('', `*${p.name}*${[p.position, p.club, p.age !== null ? `${p.woman ? 'בת' : 'בן'} ${p.age}` : ''].filter(Boolean).map((x) => ` · ${x}`).join('')}`);
    for (const d of p.dates) out.push(`• ${d}`);
    for (const d of p.deals) out.push(`• עסקה פתוחה: ${d.club}, בשלב "${d.stage}"${d.days !== null ? ` כבר ${d.days} ימים` : ''}`);
    for (const t of p.tasks) out.push(`• משימה פתוחה: ${t.title}${t.dueDate ? ` (עד ${fmtDate(t.dueDate)})` : ''}${t.overdue ? ' ⚠️ באיחור' : ''}`);
    if (!p.dates.length && !p.deals.length && !p.tasks.length) out.push('• אין תאריכים קרובים, עסקאות או משימות פתוחות.');
  }
  for (const c of f.clubs) {
    if (!c.deals.length && !c.requirements.length) continue;
    out.push('', `*${c.name}*`);
    for (const d of c.deals) out.push(`• עסקה פתוחה: ${d.player}, בשלב "${d.stage}"${d.days !== null ? ` כבר ${d.days} ימים` : ''}`);
    if (c.requirements.length) out.push(`• דרישות פתוחות: ${c.requirements.join(', ')}`);
  }
  if (f.last || f.memories.length) {
    out.push('', '*מה סוכם לאחרונה:*');
    if (f.last) out.push(`• בפגישה הקודמת (${fmtDate(f.last.date)}${f.last.title ? `, ${f.last.title}` : ''}): ${f.last.notes}`);
    for (const m of f.memories) out.push(`• מהזיכרון שלי: ${m}`);
  }
  if (!f.people.length && !f.clubs.some((c) => c.deals.length || c.requirements.length) && !f.last && !f.memories.length) {
    out.push('', 'לא מצאתי במערכת שחקן או מועדון שקשורים לפגישה הזאת. אם היא על שחקן, אפשר לקשר אותו לפגישה ואכין תדריך מלא.');
  }
  out.push('', f.link);
  return out.join('\n');
}

const rowsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

/** Today's and tomorrow's meetings (a meeting just after midnight is briefed the evening before). */
async function loadNear(db, now) {
  const today = israelDate(now);
  const snaps = await Promise.all([today, addDays(today, 1)].map((d) => db.collection('meetings').where('date', '==', d).get()));
  return live(snaps.flatMap(rowsOf));
}

async function loadSent(db) {
  const snap = await db.collection(META[0]).doc(META[1]).get();
  return snap.exists ? (snap.data().keys || {}) : {};
}

/** The cron's cheap check: is there a meeting to brief right now? */
async function dueNow(db, now = new Date()) {
  const near = await loadNear(db, now);
  if (!dueMeetings(near, {}, now).length) return [];
  return dueMeetings(near, await loadSent(db), now);
}

/**
 * Sends the briefs that are due. Returns { sent, failed, meetings }; a brief
 * that failed is tried again at the next check, while its meeting is still ahead.
 *   send  tests inject the sender: (u, body, kind, buttons) → { state }
 */
async function runMeetingBriefs(db, now = new Date(), { send = null, job = { note: () => {} } } = {}) {
  const sentKeys = await loadSent(db);
  const due = dueMeetings(await loadNear(db, now), sentKeys, now);
  if (!due.length) return { sent: 0, meetings: [] };
  const users = rowsOf(await db.collection('app_users').get());
  const owner = ownerOf(whatsappRecipients(users));
  if (!owner) { job.note('meeting brief: the owner has no WhatsApp number on the Team screen'); return { sent: 0, meetings: [], note: 'no owner on WhatsApp' }; }

  const [players, deals, requirements, tasks, meetings, memories] = await Promise.all([
    db.collection('players').get().then(rowsOf), db.collection('deals').get().then(rowsOf), db.collection('club_requirements').get().then(rowsOf),
    db.collection('tasks').get().then(rowsOf), db.collection('meetings').get().then(rowsOf),
    db.collection('golda_memory').get().then(rowsOf).catch(() => []),
  ]);
  const data = { players, deals, requirements, tasks, meetings, memories: visibleMemories(memories, { email: owner.email, phone: owner.phone }) };
  const first = (owner.name || '').split(' ')[0] || 'לו';
  const today = israelDate(now);
  const keys = Object.fromEntries(Object.entries(sentKeys).filter(([k]) => { const d = k.split('|')[1]; return /^\d{4}-\d{2}-\d{2}$/.test(d) && daysBetween(d, today) <= KEEP_KEYS_DAYS; }));
  const done = [];
  let failed = 0;
  for (const m of due) {
    try {
      await nudge(db, owner, { body: buildMeetingBrief(first, meetingFacts(m, data, now)), kind: 'meeting' }, { now: now.getTime(), send, job });
      keys[m.key] = now.getTime();
      done.push(m.title || m.id);
      job.note(`meeting brief → ${owner.email}: ${m.title || m.id} (${m.time})`);
    } catch (e) {
      failed++;
      job.note(`meeting brief failed (${m.title || m.id}): ${e.message}`);
    }
  }
  // Each brief goes out once, whatever happens after: the keys are saved even when a later one failed.
  if (done.length) await db.collection(META[0]).doc(META[1]).set({ keys, updatedAt: now.getTime() });
  return { sent: done.length, failed, meetings: done };
}

module.exports = { dueMeetings, subjectsOf, meetingFacts, buildMeetingBrief, dueNow, runMeetingBriefs, israelMinutes, FROM_MIN, TO_MIN };
