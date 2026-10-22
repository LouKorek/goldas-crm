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
// Every message goes through lib/wa-outbox.js: inside WhatsApp's 24-hour window
// it is sent; outside it, it waits in wa_outbox and the person gets Golda's
// re-engagement template instead (one tap releases what waited). While that
// template awaits Meta's approval, lib/wa-templates.js re-checks it hourly.
const { schedule } = require('@netlify/functions');
const { admin, getDb, OWNER_EMAIL, listRepresented, isLive } = require('./lib/firestore.js');
const { runJob } = require('./lib/jobs.js');
const { computeAlerts, mergeSettings, israelDate, daysBetween, expandTrainings, AGE_GROUPS } = require('@goldas/domain');
const { dedupeKey } = require('./lib/alert-keys.js');
const { buildBriefing, urgentAlerts, buildUrgent, opsAlerts, buildOps } = require('./lib/golda-briefing.js');
const { scraperAccount } = require('./lib/scraper-account.js');
const { whatsappRecipients } = require('./lib/golda-identity.js');
const outbox = require('./lib/wa-outbox.js');
const { ensureTemplate, needsRecheck } = require('./lib/wa-templates.js');

const KEEP_DAYS = 400;
const israelHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now));

async function loadAll(db) {
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(isLive);
  const [players, matches, deals, requirements, tasks, jobs, trainings, users, settingsSnap, sentSnap, audit, ifaSync, scraper, whatsapp] = await Promise.all([
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
  ]);
  return { players, matches, deals, requirements, tasks, jobs, trainings, users,
    settings: mergeSettings({ ...(settingsSnap.exists ? settingsSnap.data() : {}), matchDays: [0] }),
    sent: sentSnap.exists ? (sentSnap.data() || {}) : {}, audit, ifaSync, scraper, whatsapp };
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

function pruneSent(keys, today) {
  const out = {};
  for (const [k, v] of Object.entries(keys || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && daysBetween(String(v), today) <= KEEP_DAYS) out[k] = v;
  return out;
}

async function run(job, now = new Date(), { force = false, send } = {}) {
  const db = getDb();
  const data = await loadAll(db);
  if (needsRecheck(data.whatsapp, now.getTime())) {
    try { const t = await ensureTemplate(db, { now: now.getTime() }); if (!t.skipped) job.note(`template: ${Object.values(t.accounts).map((a) => a.status).join('/')}`); }
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

  const sent = { briefings: { ...(data.sent.briefings || {}) }, alerts: pruneSent(data.sent.alerts, today), ops: pruneSent(data.sent.ops, today) };
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
        await say(u, buildBriefing({ name: first, alerts: r.alerts, games: todaysGames(data, today), goldaActions, now }), 'briefing');
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
  await db.collection('app_meta').doc('goldaSent').set({ ...sent, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { sent: count, recipients: recipients.length, hour };
}

// Every hour at :30. Israel is UTC+2/+3, so "07" Israel time is reached once
// a day whatever the season; the state above makes each briefing one-a-day.
exports.handler = schedule('30 * * * *', async () => {
  try {
    const r = await runJob('golda-briefing', run);
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.error('[golda-briefing] failed:', e);
    return { statusCode: 500, body: String(e.message || e) };
  }
});
exports._internal = { todaysGames, pruneSent, israelHour, run };
