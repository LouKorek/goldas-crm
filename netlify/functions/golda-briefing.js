// Golda speaks first. Every hour this checks, for each user who chose
// WhatsApp as a channel and saved their number on the Team screen:
//   1. the morning briefing, once a day at the hour they picked (Israel time):
//      today's games and trainings, what needs action, what Golda did;
//   2. urgent alerts the moment they appear (a contract ending within a week,
//      a night job that failed), each sent once per threshold
//      (lib/alert-keys.js, state in app_meta/goldaSent);
//   3. for admins, operations alerts (lib/golda-briefing.js opsAlerts): a job
//      that failed twice in a row, a quota past 80%, the IFA browser sync
//      silent for 36 hours. Once a day each.
// All of it comes from the alerts engine the app uses; nothing is computed here.
// The morning briefing's text is written by the model from those facts plus
// the last day's audit and the person's memories (lib/golda-briefing-ai.js);
// it falls back to the template briefing if the model is unavailable.
// Urgent and ops messages stay template-based.
// Every message goes through lib/wa-outbox.js: inside WhatsApp's 24-hour window
// it is sent; outside it, it waits in wa_outbox and the person gets Golda's
// digest template instead (the update's title and summary, a button for the
// full text). While a template awaits Meta's approval, lib/wa-templates.js
// re-checks it hourly.
const { schedule } = require('@netlify/functions');
const { admin, getDb, OWNER_EMAIL, listRepresented, isLive } = require('./lib/firestore.js');
const { computeAlerts, mergeSettings, israelDate, daysBetween, expandTrainings, AGE_GROUPS } = require('@goldas/domain');
const { dedupeKey } = require('./lib/alert-keys.js');
const { buildBriefing, urgentAlerts, buildUrgent, opsAlerts, buildOps } = require('./lib/golda-briefing.js');
const { writeBriefing } = require('./lib/golda-briefing-ai.js');
const { opportunitiesOf } = require('./lib/golda-briefs.js');
const { writeRecap, buildRecap } = require('./lib/golda-briefing-ai.js');
const pro = require('./lib/golda-proactive.js');
const tw = require('./lib/transfer-windows.js');
const { visibleMemories } = require('./lib/golda-memory.js');
const { changesFrom } = require('./lib/golda-insights.js');
const { internalHeaders } = require('./lib/auth.js');
const { scraperAccount } = require('./lib/scraper-account.js');
const { whatsappRecipients } = require('./lib/golda-identity.js');
const outbox = require('./lib/wa-outbox.js');
const { ensureTemplate, needsRecheck } = require('./lib/wa-templates.js');

const KEEP_DAYS = 400;
const israelHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now));

async function loadAll(db) {
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isLive);
  const dayAgo = new Date(Date.now() - 86400000);
  const [players, matches, deals, requirements, tasks, jobs, trainings, users, settingsSnap, sentSnap, audit, ifaSync, scraper, whatsapp, recent, memories, meetings, feedback] = await Promise.all([
    listRepresented(db),
    db.collection('matches').get().then(rows),
    db.collection('deals').get().then(rows),
    db.collection('club_requirements').get().then(rows),
    db.collection('tasks').get().then(rows),
    db.collection('jobs').orderBy('startedAt', 'desc').limit(40).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('trainings').get().then(rows),
    db.collection('app_users').get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    db.collection('settings').doc('notifications').get(),
    db.collection('app_meta').doc('goldaSent').get(),
    db.collection('audit').where('via', '==', 'golda').get().then((s) => s.docs.map((d) => d.data())),
    db.collection('app_meta').doc('ifaBrowserSync').get().then((s) => (s.exists ? s.data() : null)),
    scraperAccount().catch(() => null),
    db.collection('app_meta').doc('whatsapp').get().then((s) => (s.exists ? s.data() : {})),
    // Everything the team changed in the last day, for "what changed since yesterday".
    db.collection('audit').where('at', '>=', dayAgo).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []),
    db.collection('golda_memory').get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []),
    // Lou's meetings (kept in sync with his agency calendar "Gold A&S").
    db.collection('meetings').get().then(rows).catch(() => []),
    // The team's 👍/👎 on Golda's answers, for the weekly quality review.
    db.collection('golda_feedback').where('at', '>=', new Date(Date.now() - 8 * 86400000)).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []),
  ]);
  return { players, matches, deals, requirements, tasks, jobs, trainings, users,
    settings: mergeSettings({ ...(settingsSnap.exists ? settingsSnap.data() : {}), matchDays: [0] }),
    sent: sentSnap.exists ? (sentSnap.data() || {}) : {}, audit, ifaSync, scraper, whatsapp, recent, memories,
    meetings, feedback };
}

// Messages between briefings wait for the day: nothing is sent at night.
const QUIET = (hour) => hour < 8 || hour >= 22;

/** Opens follow-up tasks for deals that wait too long and closes the ones that are moot. */
// At most this many new follow-up tasks a day, so the first run on a full
// pipeline does not bury the task list: the longest waits go first.
const FOLLOWUPS_PER_DAY = 5;

async function syncFollowups(db, data, now, job, budget = FOLLOWUPS_PER_DAY) {
  const created = [];
  const FieldValue = admin.firestore.FieldValue;
  for (const t of pro.dealFollowups({ deals: data.deals, tasks: data.tasks, now, owner: OWNER_EMAIL }).slice(0, Math.max(0, budget))) {
    const ref = await db.collection('tasks').add({ ...t, source: 'golda', deletedAt: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      createdBy: 'golda', lastEditedBy: 'golda', lastEditedByName: 'גולדה', lastEditedAt: FieldValue.serverTimestamp() });
    await db.collection('audit').add({ action: 'create', collection: 'tasks', docId: ref.id, after: { title: t.title, dueDate: t.dueDate }, fields: Object.keys(t),
      by: 'golda', byName: 'גולדה', via: 'golda', actor: 'golda-auto', at: FieldValue.serverTimestamp(), undone: false }).catch(() => {});
    created.push({ ...t, id: ref.id });
  }
  const closed = pro.followupsToClose({ deals: data.deals, tasks: data.tasks });
  for (const t of closed) {
    await db.collection('tasks').doc(t.id).update({ done: true, doneAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastEditedBy: 'golda', lastEditedByName: 'גולדה',
      notes: `${(data.tasks.find((x) => x.id === t.id) || {}).notes || ''}\nנסגרה אוטומטית: העסקה ${t.dealStage ? `עברה לשלב "${t.dealStage}"` : 'כבר לא פעילה'}.`.trim() });
  }
  if (created.length || closed.length) job.note(`follow-ups: ${created.length} opened, ${closed.length} closed`);
  return created;
}

function buildFollowupMessage(first, tasks) {
  const lines = [`*פתחתי משימות מעקב, ${first}* ✅`];
  for (const t of tasks.slice(0, 10)) lines.push(`• ${t.title}`);
  lines.push('', 'הן במסך המשימות, ונסגרות לבד כשהעסקה זזה. https://goldas-crm.netlify.app/tasks');
  return lines.join('\n');
}

function todaysGames({ matches, trainings, players }, today) {
  const nameOf = (id) => { const p = players.find((x) => x.id === id); return p ? (p.fullName || p.name || '') : ''; };
  const games = matches.filter((m) => m.date === today).map((m) => ({
    date: m.date, time: m.time || '', title: `${m.homeTeam} – ${m.awayTeam}`,
    sub: [m.stadiumName, (m.linkedPlayers || []).map(nameOf).filter(Boolean).join(', ')].filter(Boolean).join(' · '),
  }));
  for (const tr of trainings) {
    for (const o of expandTrainings([tr], today, today)) {
      if (o.cancelled) continue;
      const group = AGE_GROUPS.find((g) => g.id === tr.ageGroup);
      games.push({ date: o.date, time: o.time || tr.time || '', title: `אימון: ${tr.title || ''}`,
        sub: [group && group.he, tr.place, (tr.linkedPlayers || []).map(nameOf).filter(Boolean).join(', ')].filter(Boolean).join(' · ') });
    }
  }
  return games.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

/** Today's meetings (Lou's agency calendar). */
function todaysMeetings(meetings, players, today) {
  const nameOf = (id) => { const p = players.find((x) => x.id === id); return p ? (p.fullName || p.name || '') : ''; };
  return (meetings || []).filter((m) => m.date === today || (m.endDate && m.date < today && m.endDate >= today)).map((m) => ({
    date: today, time: m.date === today ? (m.time || '') : '', title: `פגישה: ${m.title}`,
    sub: [m.endTime && m.date === today ? `עד ${m.endTime}` : '', m.location, (m.linkedPlayers || []).map(nameOf).filter(Boolean).join(', ')].filter(Boolean).join(' · '),
  }));
}

const safe = (fn, fallback) => { try { return fn(); } catch (e) { console.warn('[briefing]', e.message); return fallback; } };

/** The last week's audit, only when the recap is due. */
async function loadWeek(db) {
  const snap = await db.collection('audit').where('at', '>=', new Date(Date.now() - 7 * 86400000)).get();
  return { audit: snap.docs.map((d) => d.data()) };
}

/** The week's strongest requirement × player matches; a failure only drops them from the briefing. */
function safeOpportunities(data, now) {
  try { return opportunitiesOf({ players: data.players, requirements: data.requirements, deals: data.deals, now, n: 3 }); } catch (e) { console.warn('[briefing] opportunities failed:', e.message); return []; }
}

function pruneSent(keys, today) {
  const out = {};
  for (const [k, v] of Object.entries(keys || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && daysBetween(String(v), today) <= KEEP_DAYS) out[k] = v;
  return out;
}

async function run(job, now = new Date(), { force = false, send, write } = {}) {
  const db = getDb();
  const data = await loadAll(db);
  if (needsRecheck(data.whatsapp, now.getTime())) {
    try { const t = await ensureTemplate(db, { now: now.getTime() }); if (!t.skipped) job.note(`templates: ${Object.values(t.templates).map((x) => `${x.name} ${Object.values(x.accounts).map((a) => a.status).join('/')}`).join(', ')}`); }
    catch (e) { job.note(`template check failed: ${e.message}`); }
  }
  // Each proactive message is sent, or queued with a re-engagement template when the window is closed.
  const say = send || (async (u, body, kind) => {
    const r = await outbox.deliver(db, { to: u.phone, body, kind }, { now: now.getTime() });
    if (r.state === 'queued') job.note(`${kind} → ${u.email}: window closed, queued${r.reengage?.template ? `, template ${r.reengage.template}` : r.reengage?.error ? `, template failed: ${r.reengage.error}` : ''}`);
    return r;
  });
  const today = israelDate(now);
  const hour = israelHour(now);
  const recipients = whatsappRecipients(data.users);
  if (!recipients.length) return { sent: 0, note: 'no WhatsApp recipients' };

  const sent = { briefings: { ...(data.sent.briefings || {}) }, alerts: pruneSent(data.sent.alerts, today), ops: pruneSent(data.sent.ops, today), recaps: { ...(data.sent.recaps || {}) },
    eventsAt: Number(data.sent.eventsAt) || now.getTime() - 3600000,
    followups: data.sent.followups?.date === today ? { ...data.sent.followups } : { date: today, n: 0 } };
  const quiet = QUIET(hour);
  const since = sent.eventsAt;
  // Follow-up tasks are opened in the day only, so the message about them goes out with them.
  const followups = quiet ? [] : await syncFollowups(db, data, now, job, FOLLOWUPS_PER_DAY - sent.followups.n).catch((e) => { job.note(`follow-ups failed: ${e.message}`); return []; });
  sent.followups.n += followups.length;
  const newReqs = quiet ? [] : safe(() => pro.newRequirementFits({ requirements: data.requirements, players: data.players, deals: data.deals, since, now }), []);
  const userNames = Object.fromEntries((data.users || []).map((u) => [String(u.email || u.id || '').toLowerCase(), (u.name || '').split(' ')[0] || u.email]));
  const windowsNow = safe(() => tw.windowStatus(now), null);
  const marks = quiet ? [] : safe(() => tw.windowMarks(now), []);
  const recapTime = pro.isRecapTime(now);
  const recapData = recapTime ? await loadWeek(db).catch(() => ({ audit: [] })) : null;
  const ops = opsAlerts({ jobs: data.jobs, ifaSync: data.ifaSync, scraper: data.scraper, now });
  const dayMs = 86400000;
  const goldaActions = data.audit.filter((a) => (a.at?.toMillis?.() || 0) > now.getTime() - dayMs).length;
  let count = 0;

  for (const u of recipients) {
    const mine = u.role === 'admin' ? data.tasks : data.tasks.filter((x) => (x.owner || OWNER_EMAIL) === u.email);
    const r = computeAlerts({ ...data, tasks: mine, settings: data.settings, now });
    const first = (u.name || '').split(' ')[0] || u.name;
    try {
      if ((force || hour === u.briefingHour) && sent.briefings[u.email] !== today) {
        const games = [...todaysGames(data, today), ...todaysMeetings(data.meetings, data.players, today)]
          .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        const fallbackText = buildBriefing({ name: first, alerts: r.alerts, games, goldaActions, now });
        const changes24h = changesFrom(data.recent || [], { since: '24h', limit: 150 }, {}, now.getTime()).changes;
        const b = await (write || writeBriefing)({
          name: first, today, games, alerts: r.alerts, changes24h, deals: data.deals, requirements: data.requirements,
          opportunities: safeOpportunities(data, now),
          weekAhead: pro.israelClock(now).weekday === 0 ? safe(() => pro.weekAhead(data, now), []) : [],
          transferWindows: windowsNow,
          memories: visibleMemories(data.memories || [], { email: u.email, phone: u.phone }), fallbackText,
        });
        if (!b.ai) job.note(`briefing ${u.email}: template (${b.reason})`);
        await say(u, b.text, 'briefing');
        sent.briefings[u.email] = today; count++;
        job.note(`briefing → ${u.email}`);
      }
      const urgent = urgentAlerts(r.alerts).filter((a) => !sent.alerts[`${u.email}|${dedupeKey(a, data.settings, today)}`]);
      if (urgent.length && sent.briefings[u.email] === today) {   // after the briefing, never before it on the same morning
        await say(u, buildUrgent(first, urgent), 'urgent');
        urgent.forEach((a) => { sent.alerts[`${u.email}|${dedupeKey(a, data.settings, today)}`] = today; });
        count++;
        job.note(`${urgent.length} urgent → ${u.email}`);
      }
      const team = u.role === 'admin' || u.role === 'manager';
      // Between briefings: a new requirement with its best fits, the team's deal moves, the follow-ups opened for me.
      if (!quiet && sent.briefings[u.email] === today) {
        const reqs = team ? newReqs.filter((r) => String(r.by).toLowerCase() !== u.email) : [];
        if (reqs.length) { await say(u, pro.buildRequirementMessage(first, reqs), 'update'); count++; job.note(`${reqs.length} new requirement(s) → ${u.email}`); }
        const moves = u.role === 'admin' ? pro.teamDealMoves({ deals: data.deals, since, email: u.email, names: userNames }) : [];
        if (moves.length) { await say(u, pro.buildMovesMessage(first, moves), 'update'); count++; job.note(`${moves.length} deal move(s) → ${u.email}`); }
        const mineF = followups.filter((t) => String(t.owner || OWNER_EMAIL).toLowerCase() === u.email);
        if (mineF.length) { await say(u, buildFollowupMessage(first, mineF), 'update'); count++; }
        const myMarks = team ? marks.filter((m) => !sent.alerts[`${u.email}|${m.key}`]) : [];
        if (myMarks.length) {
          await say(u, tw.buildWindowMessage(first, myMarks), 'update');
          myMarks.forEach((m) => { sent.alerts[`${u.email}|${m.key}`] = today; });
          count++;
        }
      }
      // Thursday evening: the week that was.
      if (recapTime && sent.recaps[u.email] !== today) {
        const facts = pro.recapFacts({ ...data, audit: recapData.audit, feedback: data.feedback || [] }, now);
        const quality = u.role === 'admin' ? facts.quality : null;
        const nextWeek = safe(() => pro.weekAhead(data, new Date(now.getTime() + 3 * 86400000)), []);
        const b = await (write?.recap || writeRecap)({ name: first, facts, nextWeek, quality, fallbackText: buildRecap(first, facts, quality) });
        if (!b.ai) job.note(`recap ${u.email}: template (${b.reason})`);
        await say(u, b.text, 'recap');
        sent.recaps[u.email] = today; count++;
        job.note(`recap → ${u.email}`);
      }
      const mineOps = u.role === 'admin' ? ops.filter((o) => !sent.ops[`${u.email}|${o.key}`]) : [];
      if (mineOps.length) {
        await say(u, buildOps(first, mineOps), 'ops');
        mineOps.forEach((o) => { sent.ops[`${u.email}|${o.key}`] = today; });
        count++;
        job.note(`${mineOps.length} ops → ${u.email}`);
      }
    } catch (e) {
      job.note(`${u.email}: ${e.message}`);
      console.error('[golda-briefing] send failed:', u.email, e.message);
    }
  }
  if (!quiet) sent.eventsAt = now.getTime();   // at night the events wait for the morning
  await db.collection('app_meta').doc('goldaSent').set({ ...sent, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { sent: count, recipients: recipients.length, hour };
}

// Every hour at :30. Israel is UTC+2/+3, so "07" Israel time is reached once
// a day whatever the season; the state above makes each briefing one-a-day.
// The briefing is written by the model, which takes longer than a scheduled
// function may run, so the cron only kicks golda-briefing-background (up to
// 15 minutes) over HTTP with a single-use internal nonce, like sync-matches-cron.
exports.handler = schedule('30 * * * *', async () => {
  const base = process.env.URL || 'https://goldas-crm.netlify.app';
  try {
    const res = await fetch(`${base}/.netlify/functions/golda-briefing-background`, {
      method: 'POST',
      headers: await internalHeaders('golda-briefing-cron'),
    });
    return { statusCode: 200, body: `triggered: ${res.status}` };
  } catch (e) {
    console.error('[golda-briefing] trigger failed:', e);
    return { statusCode: 500, body: String(e.message || e) };
  }
});
exports._internal = { todaysGames, todaysMeetings, pruneSent, israelHour, run, buildFollowupMessage, QUIET, syncFollowups, FOLLOWUPS_PER_DAY };
