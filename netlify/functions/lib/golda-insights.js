// Two read tools that give Golda the big picture:
//   changes   what changed in the CRM over a period (the one `audit` collection
//             the app and Golda both write), with the record's name;
//   overview  the agency at a glance: players, prospects, deals, requirements,
//             tasks, this week's games and Golda's own recent work.
// The pure parts (changesFrom, overviewOf) take plain rows so they are tested.
const { israelDate, addDays, expandTrainings, isClosedStage } = require('@goldas/domain');

const DAY = 86400000;
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : v ? Date.parse(v) || 0 : 0);
const nameOf = (d = {}) => d.fullName || d.playerName || d.name || d.title || d.clubName || d.contactName
  || (d.homeTeam ? `${d.homeTeam} – ${d.awayTeam || ''}` : '') || '';
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/** Parse since/until (YYYY-MM-DD, an ISO time, or "7d"/"24h") to ms. */
function parseWhen(v, now, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const rel = /^(\d+)\s*([dh])$/i.exec(String(v).trim());
  if (rel) return now - Number(rel[1]) * (rel[2].toLowerCase() === 'd' ? DAY : 3600000);
  const t = Date.parse(isoDay.test(String(v)) ? `${v}T00:00:00+02:00` : String(v));
  if (Number.isNaN(t)) throw new Error('since/until must be YYYY-MM-DD, an ISO time, or like "7d" / "24h"');
  return t;
}

/**
 * changesFrom(rows, { since, until, collection, docId, by, limit }, names)
 *   rows   audit documents ({ id, action, collection, docId, by, byName, via, at, fields, before, after })
 *   names  { "collection/docId": "record name" } for rows that carry no snapshot
 */
function changesFrom(rows, opts = {}, names = {}, now = Date.now()) {
  const since = parseWhen(opts.since, now, now - 7 * DAY);
  const until = parseWhen(opts.until, now, now + 60000);
  const by = opts.by ? String(opts.by).toLowerCase() : '';
  const picked = rows.filter((r) => {
    const t = ms(r.at);
    if (!t || t < since || t > until) return false;
    if (opts.collection && r.collection !== opts.collection && !(opts.collection.startsWith('pipeline_') && r.collection === 'players')) return false;
    if (opts.docId && r.docId !== opts.docId) return false;
    if (by && !`${r.by || ''} ${r.byName || ''} ${r.sender || ''}`.toLowerCase().includes(by)) return false;
    return true;
  }).sort((a, b) => ms(b.at) - ms(a.at));
  const n = Math.max(1, Math.min(Number(opts.limit) || 100, 300));
  const out = picked.slice(0, n).map((r) => {
    const row = {
      at: new Date(ms(r.at)).toISOString(), action: r.action, collection: r.collection, docId: r.docId,
      name: nameOf(r.after || r.before || {}) || names[`${r.collection}/${r.docId}`] || '',
      byName: r.byName || r.by || '', via: r.via || '', fields: r.fields || Object.keys(r.after || r.before || {}).slice(0, 30),
    };
    if (r.undone) row.undone = true;
    if (r.via === 'golda' && r.action === 'update' && r.before && r.after) {
      const diff = {};
      for (const k of Object.keys(r.after).slice(0, 12)) {
        if (/Files$/.test(k)) continue;
        diff[k] = { from: r.before[k] ?? null, to: r.after[k] ?? null };
      }
      row.diff = diff;
    }
    return row;
  });
  return { since: new Date(since).toISOString(), until: new Date(Math.min(until, now)).toISOString(), total: picked.length, returned: out.length, changes: out };
}

const count = (rows, key) => rows.reduce((o, r) => { const k = key(r) || '—'; o[k] = (o[k] || 0) + 1; return o; }, {});

/** The agency at a glance. Rows are live (not deleted) documents. */
function overviewOf({ players = [], deals = [], requirements = [], tasks = [], matches = [], trainings = [], audit = [] }, now = new Date()) {
  const today = israelDate(now);
  const weekEnd = addDays(today, 6);
  const represented = players.filter((p) => !p.stage || p.stage === 'represented');
  const prospects = players.filter((p) => p.stage && p.stage !== 'represented');
  const prospectsBy = {};
  for (const p of prospects) {
    const cat = p.category || 'other';
    prospectsBy[cat] = prospectsBy[cat] || { total: 0, byStatus: {} };
    prospectsBy[cat].total++;
    const st = p.status || p.stage;
    prospectsBy[cat].byStatus[st] = (prospectsBy[cat].byStatus[st] || 0) + 1;
  }
  const open = deals.filter((d) => !d.closedAt && !isClosedStage(d.stage));
  const reqOpen = requirements.filter((r) => (r.status || 'open') === 'open');
  const reqExpired = reqOpen.filter((r) => r.validUntil && r.validUntil < today);
  const tasksOpen = tasks.filter((t) => !t.done);
  const overdue = tasksOpen.filter((t) => t.dueDate && t.dueDate < today);
  const weekMatches = matches.filter((m) => m.date >= today && m.date <= weekEnd)
    .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));
  const sessions = expandTrainings(trainings, today, weekEnd).filter((o) => !o.cancelled);
  const goldaWeek = audit.filter((a) => a.via === 'golda' && ms(a.at) > now.getTime() - 7 * DAY);
  return {
    today,
    represented: { total: represented.length, byGender: count(represented, (p) => p.gender), byContract: count(represented, (p) => p.contractStatus) },
    prospects: { total: prospects.length, byCategory: prospectsBy },
    deals: { open: open.length, byStage: count(open, (d) => d.stage) },
    requirements: { open: reqOpen.length, expired: reqExpired.length, expiredList: reqExpired.slice(0, 10).map((r) => ({ id: r.id, club: r.clubName, validUntil: r.validUntil })) },
    tasks: { open: tasksOpen.length, overdue: overdue.length, overdueList: overdue.slice(0, 10).map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate })) },
    thisWeek: {
      matches: weekMatches.length,
      matchList: weekMatches.slice(0, 15).map((m) => ({ id: m.id, date: m.date, time: m.time || '', game: `${m.homeTeam} – ${m.awayTeam}` })),
      trainingSessions: sessions.length,
    },
    goldaChangesLast7Days: goldaWeek.length,
  };
}

function insightTools({ db }) {
  const live = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => !x.deletedAt);
  async function changes(opts = {}) {
    const now = Date.now();
    const since = parseWhen(opts.since, now, now - 7 * DAY);
    // Single-field range on `at`, so no composite index is needed.
    const snap = await db.collection('audit').where('at', '>=', new Date(since)).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const result = changesFrom(rows, opts, {}, now);
    // Name the records the app's audit lines don't carry a snapshot of (at most 40 reads).
    const missing = [...new Set(result.changes.filter((c) => !c.name && c.docId).map((c) => `${c.collection}/${c.docId}`))].slice(0, 40);
    const names = {};
    await Promise.all(missing.map(async (key) => {
      const [col, id] = key.split('/');
      try { const s = await db.collection(col).doc(id).get(); if (s.exists) names[key] = nameOf(s.data()); } catch { /* unknown collection */ }
    }));
    for (const c of result.changes) if (!c.name) c.name = names[`${c.collection}/${c.docId}`] || '';
    return result;
  }
  async function overview() {
    const now = new Date();
    const [players, deals, requirements, tasks, matches, trainings, audit] = await Promise.all([
      db.collection('players').get().then(live), db.collection('deals').get().then(live),
      db.collection('club_requirements').get().then(live), db.collection('tasks').get().then(live),
      db.collection('matches').get().then(live), db.collection('trainings').get().then(live),
      db.collection('audit').where('at', '>=', new Date(now.getTime() - 7 * DAY)).get().then((s) => s.docs.map((d) => d.data())),
    ]);
    return overviewOf({ players, deals, requirements, tasks, matches, trainings, audit }, now);
  }
  return { changes, overview };
}

module.exports = { changesFrom, overviewOf, insightTools, parseWhen, nameOf };
