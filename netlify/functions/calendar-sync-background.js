// Runs the two-way sync between the CRM and Lou's Google calendar (see
// lib/gcal-sync.js for the rules).
//
// Called by calendar-sync-cron every 10 minutes, right after Golda writes a
// match or a training, and from the admin screen. A cheap check runs first:
// when neither the calendar (sync token) nor the CRM (updatedAt / deletedAt
// since the last run) changed, and today's full pass already ran, it stops
// after a handful of reads. Body { force: true } always does the full pass.
//
// Env: FIREBASE_SERVICE_ACCOUNT_KEY.
const { admin, getDb } = require('./lib/firestore.js');
const { withAuth } = require('./lib/auth.js');
const { runJob } = require('./lib/jobs.js');
const { occurrences } = require('@goldas/domain');
const G = require('./lib/gcal-sync.js');

const META = ['app_meta', 'calendarSync'];
const LINKS = 'calendar_links';
const LOCK_MS = 10 * 60 * 1000;
const MAX_REMOVALS = 40;

const FV = admin.firestore.FieldValue;
const stamp = () => ({ updatedAt: FV.serverTimestamp(), lastEditedAt: FV.serverTimestamp(), lastEditedBy: 'calendar', lastEditedByName: 'יומן Google' });
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const linkId = (key) => key.replace(/[/]/g, '_');

async function lock(db) {
  const ref = db.collection(META[0]).doc(META[1]);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const m = snap.exists ? snap.data() : {};
    if (m.lockUntil && m.lockUntil > Date.now()) { tx.set(ref, { dirty: true }, { merge: true }); return null; }
    tx.set(ref, { lockUntil: Date.now() + LOCK_MS, dirty: false }, { merge: true });
    return m;
  });
}

async function crmChangedSince(db, ms) {
  if (!ms) return true;
  const since = admin.firestore.Timestamp.fromMillis(ms);
  const probes = [];
  for (const col of ['matches', 'trainings']) {
    for (const f of ['updatedAt', 'deletedAt']) probes.push(db.collection(col).where(f, '>', since).limit(1).get());
  }
  const res = await Promise.all(probes);
  return res.some((s) => !s.empty);
}

/** The item for one record after a change, by key (null when it left the window). */
function itemFor(kind, record, key, players, win) {
  const list = G.crmItems({
    matches: kind === 'match' ? [record] : [], trainings: kind === 'training' ? [record] : [],
    players, from: win.from, to: win.to, occurrences,
  });
  return list.find((i) => i.key === key) || list[0] || null;
}

async function fullPass(db, cal, meta, job, { force }) {
  const win = G.windowRange();
  const mode = meta.mode === 'push' ? 'push' : 'two_way';
  const timeMin = new Date(`${win.from}T00:00:00Z`).getTime() - 3 * 3600e3;
  const timeMax = new Date(`${G.plusMinutes(win.to, '23:59', 1).date}T00:00:00Z`).getTime() + 3 * 3600e3;

  const [events, matchSnap, trainSnap, playerSnap, linkSnap] = await Promise.all([
    cal.listWindow(new Date(timeMin).toISOString(), new Date(timeMax).toISOString()),
    db.collection('matches').where('date', '>=', win.from).where('date', '<=', win.to).get(),
    db.collection('trainings').get(),
    db.collection('players').get(),
    db.collection(LINKS).get(),
  ]);
  const players = rows(playerSnap).filter((p) => !p.deletedAt);
  const matches = rows(matchSnap);
  const trainings = rows(trainSnap);
  const linkRows = rows(linkSnap);
  const links = new Map(linkRows.map((l) => [l.key, l]));
  const items = G.crmItems({ matches, trainings, players, from: win.from, to: win.to, occurrences });

  const actions = G.plan({ items, events, links, players, mode });
  const ownCount = events.filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.goldasKey && e.status !== 'cancelled').length;
  const removals = actions.filter((a) => a.type === 'remove').length;
  if (!items.length && ownCount > 5) throw new Error(`safety stop: the CRM returned no games or trainings but the calendar has ${ownCount} synced events`);
  if (removals > MAX_REMOVALS && !force) throw new Error(`safety stop: ${removals} events would be removed; run with force after checking`);

  const counts = {};
  const touched = new Set();
  const bump = (t) => { counts[t] = (counts[t] || 0) + 1; };
  const saveLink = (item, ev, hash) => db.collection(LINKS).doc(linkId(item.key)).set({
    key: item.key, kind: item.kind, crmId: item.crmId, occ: item.occ || '', eventId: ev.id, hash,
    eventUpdated: ev.updated || '', date: item.date, at: Date.now(),
  });
  const dropLink = (key) => db.collection(LINKS).doc(linkId(key)).delete().catch(() => {});
  const colOf = (kind) => (kind === 'match' ? 'matches' : 'trainings');

  // Several sessions of one weekly training can change in the same pass, so
  // every patch is worked out again against the record as it is by now.
  const latest = new Map();
  const fresh = (item) => ({ ...item, record: latest.get(`${item.kind}:${item.crmId}`) || item.record });
  const writeCrm = async (item, patch) => {
    await db.collection(colOf(item.kind)).doc(item.crmId).update({ ...patch, ...stamp() });
    const rec = { ...fresh(item).record, ...patch };
    latest.set(`${item.kind}:${item.crmId}`, rec);
    return rec;
  };

  // CRM patch, then draw the record again and put that in the calendar.
  async function pullAndRedraw(item0, ev) {
    const item = fresh(item0);
    const patch = G.pullPatch(item, ev);
    if (!patch) return;
    const rec = await writeCrm(item, patch);
    const next = itemFor(item.kind, rec, item.key, players, win);
    if (!next) { await dropLink(item.key); return; }
    const body = G.desiredEvent(next);
    const saved = await cal.patch(ev.id, body);
    touched.add(saved.id);
    await saveLink(next, saved, G.bodyHash(body));
  }

  async function run(a) {
    switch (a.type) {
      case 'none': return;
      case 'insert': {
        const ev = await cal.upsert(G.eventIdFor(a.item.key), a.body);
        touched.add(ev.id);
        await saveLink(a.item, ev, a.hash);
        return;
      }
      case 'push': {
        const ev = await cal.patch(a.event.id, a.body);
        touched.add(ev.id);
        await saveLink(a.item, ev, a.hash);
        return;
      }
      case 'pull': await pullAndRedraw(a.item, a.event); job.note(`calendar -> CRM: ${a.item.key} ${JSON.stringify(a.patch).slice(0, 160)}`); return;
      case 'adopt': {
        if (a.patch) { await pullAndRedraw(a.item, a.event); job.note(`adopted (calendar newer): ${a.event.summary}`); return; }
        const ev = await cal.patch(a.event.id, a.body);
        touched.add(ev.id);
        await saveLink(a.item, ev, a.hash);
        job.note(`adopted: ${a.event.summary}`);
        return;
      }
      case 'deleted_in_calendar': {
        await writeCrm(a.item, G.deletionPatch(fresh(a.item)));
        await dropLink(a.item.key);
        job.note(`deleted in calendar -> ${Object.keys(a.patch).join(',')}: ${a.item.key}`);
        return;
      }
      case 'fetch_and_reconcile': {
        let ev = null;
        try { ev = await cal.get(a.link.eventId); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
        if (!ev || ev.status === 'cancelled') {
          if (mode !== 'push' && ev) { await run({ type: 'deleted_in_calendar', item: a.item, patch: G.deletionPatch(a.item) }); return; }
          await run({ type: 'insert', item: a.item, body: a.body, hash: a.hash });
          return;
        }
        await run(G.reconcile(a.item, ev, a.body, a.hash, a.link, mode !== 'push'));
        return;
      }
      case 'remove': {
        await cal.remove(a.event.id);
        touched.add(a.event.id);
        await dropLink(a.key);
        return;
      }
      case 'import': {
        const { collection, data } = a.record;
        const ref = await db.collection(collection).add({
          ...data, deletedAt: null, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(), createdBy: 'calendar', createdByName: 'יומן Google',
        });
        const kind = collection === 'matches' ? 'match' : 'training';
        const key = G.keyFor(kind, ref.id, data.date);
        const item = itemFor(kind, { id: ref.id, ...data }, key, players, win);
        if (!item) return;
        const body = G.desiredEvent(item);
        const ev = await cal.patch(a.event.id, body);
        touched.add(ev.id);
        await saveLink(item, ev, G.bodyHash(body));
        job.note(`imported from calendar: ${a.event.summary}`);
        return;
      }
      case 'ignore': job.note(`left alone: "${a.event.summary}" (${a.reason})`); return;
      default: return;
    }
  }

  for (const a of actions) {
    bump(a.type);
    try { await run(a); } catch (e) {
      counts.errors = (counts.errors || 0) + 1;
      job.note(`${a.type} ${a.item ? a.item.key : (a.event && a.event.summary) || ''}: ${e.message}`.slice(0, 400));
      if (e.status === 401 || e.status === 403) throw e;
    }
  }

  // Forget links of the far past.
  const old = linkRows.filter((l) => l.date && l.date < G.plusMinutes(win.from, '00:00', -30 * 1440).date);
  await Promise.all(old.map((l) => dropLink(l.key)));
  return { counts, touched, window: win, items: items.length, events: events.length };
}

async function runSync({ force = false } = {}, job) {
  const db = getDb();
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '{}');
  const client = G.calendarClient(svc);
  const metaRef = db.collection(META[0]).doc(META[1]);
  const meta = await lock(db);
  if (!meta) { job.note('another run is in progress; it will run again when done'); return { skipped: 'busy' }; }
  if (meta.enabled === false) { await metaRef.set({ lockUntil: 0 }, { merge: true }); return { skipped: 'disabled' }; }
  const cal = G.api(client, meta.calendarId || G.DEFAULT_CALENDAR_ID);
  try {
    let loops = 0;
    let result = { changed: false };
    let token = meta.syncToken || null;
    let lastFullMs = meta.lastFullMs || 0;
    let lastFullDay = meta.lastFullDay || '';
    let again = force;
    do {
      const today = G.windowRange().today;
      if (!again) {
        const probe = await cal.changesSince(token);
        const crm = await crmChangedSince(db, lastFullMs);
        if (!probe.changed && !crm && lastFullDay === today) {
          await metaRef.set({ lastCheckAt: Date.now(), state: 'ok', syncToken: probe.token || token }, { merge: true });
          return { changed: false };
        }
      }
      const startedMs = Date.now();
      const r = await fullPass(db, cal, meta, job, { force });
      // Step the sync token past our own writes; anything else that changed
      // meanwhile (Lou editing while we ran) gets one more pass.
      const after = await cal.changesSince(null);
      token = after.token;
      lastFullMs = startedMs;
      lastFullDay = today;
      result = { changed: true, ...r.counts, items: r.items, events: r.events };
      const m = (await metaRef.get()).data() || {};
      again = !!m.dirty && loops < 1;
      if (again) await metaRef.set({ dirty: false }, { merge: true });
      loops += 1;
    } while (again);
    await metaRef.set({
      state: 'ok', serviceAccount: client.email, lastCheckAt: Date.now(), lastFullMs, lastFullDay, syncToken: token,
      lastResult: result, problem: FV.delete(),
    }, { merge: true });
    return result;
  } catch (e) {
    const problem = G.accessProblem(e, client.email);
    await metaRef.set({ state: problem ? problem.state : 'error', serviceAccount: client.email, problem: problem || { state: 'error', hint: String(e.message).slice(0, 300) }, lastCheckAt: Date.now() }, { merge: true });
    if (problem) { job.note(problem.hint); return { blocked: problem.state, newProblem: meta.state !== problem.state }; }
    throw e;
  } finally {
    await metaRef.set({ lockUntil: 0 }, { merge: true }).catch(() => {});
  }
}

exports.handler = withAuth({ action: 'run_sync', internal: true }, async (event) => {
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
  const q = event.queryStringParameters || {};
  const force = !!(body.force || q.force);
  const quiet = !force && !body.reason;
  // The ten-minute check is recorded only when it did something.
  if (quiet) {
    const notes = [];
    const r = await runSync({ force }, { note: (s) => notes.push(s) });
    if (r && (r.changed || r.newProblem)) await runJob('calendar-sync', async (job) => { notes.forEach((n) => job.note(n)); return r; }, { trigger: 'cron' });
    return { statusCode: 200, body: JSON.stringify(r) };
  }
  const r = await runJob('calendar-sync', (job) => runSync({ force }, job), { trigger: body.reason || 'manual' });
  return { statusCode: 200, body: JSON.stringify(r) };
});

exports._internal = { runSync, fullPass, crmChangedSince };
