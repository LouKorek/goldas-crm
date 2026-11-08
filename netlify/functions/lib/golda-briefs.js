// Golda's agent-style read tools, built on the same engines the app uses:
//   player_brief    everything about one player in one answer (record, documents,
//                   dates, deals, games, trainings, meetings, tasks, recent
//                   changes, and the open club requirements the player fits);
//   club_brief      everything about one club before a call or a meeting;
//   opportunities   the strongest player ↔ requirement matches that have no deal yet;
//   check_schedule  a schedule read from a photo, a screenshot or a forwarded
//                   message, checked against the CRM before anything is created:
//                   who each line is about, and what already exists that day.
// The pure parts take plain rows so they are tested without Firestore.
const { israelDate, addDays, daysAway, expandTrainings, isClosedStage, scoreRequirement, stageOfPlayer, playerName, categoryFromPlayer } = require('@goldas/domain');
const { findPlayers } = require('./gcal-sync.js');

const DAY = 86400000;
const APP = 'https://goldas-crm.netlify.app';
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : v ? Date.parse(v) || 0 : 0);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/["'״׳`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const live = (rows) => (rows || []).filter((r) => r && !r.deletedAt);
const isOpenDeal = (d) => !d.closedAt && !isClosedStage(d.stage);
const reqOpen = (r, today) => (r.status || 'open') === 'open' && !(r.validUntil && r.validUntil < today);
const files = (p, f) => (Array.isArray(p[f]) ? p[f].map((x) => x.name).filter(Boolean) : []);

/** A requirement and a player that already have a live deal between them. */
function hasDeal(deals, req, playerId) {
  const club = norm(req.clubName);
  return deals.some((d) => isOpenDeal(d) && d.playerId === playerId && (d.requirementId === req.id || (club && norm(d.clubName) === club)));
}

/**
 * opportunitiesOf({ players, requirements, deals, now, n, min })
 * The best open requirement ↔ player pairs with no open deal, each player and
 * each requirement used once, strongest first.
 */
function opportunitiesOf({ players = [], requirements = [], deals = [], now = new Date(), n = 3, min = 60 }) {
  const today = israelDate(now);
  const pool = live(players).filter((p) => stageOfPlayer(p) !== 'not_relevant');
  const openDeals = live(deals);
  const pairs = [];
  for (const req of live(requirements).filter((r) => reqOpen(r, today))) {
    for (const m of scoreRequirement(req, pool, now)) {
      if (!m.eligible || m.score < min || hasDeal(openDeals, req, m.playerId)) continue;
      pairs.push({ req, m });
    }
  }
  pairs.sort((a, b) => b.m.score - a.m.score);
  const usedP = new Set(); const usedR = new Set(); const out = [];
  for (const { req, m } of pairs) {
    if (usedP.has(m.playerId) || usedR.has(req.id)) continue;
    usedP.add(m.playerId); usedR.add(req.id);
    out.push({
      club: req.clubName || '', requirementId: req.id, position: req.requiredPosition || '', validUntil: req.validUntil || '',
      playerId: m.playerId, player: m.playerName, stage: m.stage, score: m.score,
      why: m.reasons.map((r) => r.he).join(' · '),
      links: { player: `${APP}/players/${m.playerId}`, requirement: `${APP}/market/requirements?req=${req.id}` },
    });
    if (out.length >= n) break;
  }
  return out;
}

const dateLine = (label, date, now) => {
  if (!date) return null;
  const d = daysAway(date, now);
  return { what: label, date, daysLeft: d };
};

/** Everything about one player. `data` holds plain rows of each collection. */
function playerBriefOf(data, playerId, now = new Date()) {
  const p = live(data.players).find((x) => x.id === playerId);
  if (!p) throw new Error('player not found');
  const today = israelDate(now);
  const until = addDays(today, 21);
  const name = playerName(p);
  const linked = (r) => Array.isArray(r.linkedPlayers) && r.linkedPlayers.includes(playerId);
  const missing = [];
  const stage = stageOfPlayer(p);
  if (stage === 'represented') {
    if (!files(p, 'reprFiles').length) missing.push('representation agreement document');
    if (p.contractStatus && p.contractStatus !== 'Free' && !files(p, 'contractFiles').length) missing.push('contract document');
    if (!files(p, 'passportFiles').length && !p.passportNumber) missing.push('passport');
    if (!p.dob) missing.push('date of birth');
    if (!p.ifaTeamUrl && (p.nationalities || []).includes('Israel')) missing.push('IFA team link (games sync)');
  }
  const deals = live(data.deals).filter((d) => d.playerId === playerId)
    .map((d) => ({ id: d.id, club: d.clubName || '', stage: d.stage || '', open: isOpenDeal(d), sinceDays: Math.floor((now.getTime() - ms(d.stageAt || d.updatedAt || d.createdAt)) / DAY) || 0, link: `${APP}/market/deals?deal=${d.id}` }));
  const games = live(data.matches).filter((m) => linked(m) && m.date >= today && m.date <= until)
    .sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`))
    .map((m) => ({ date: m.date, time: m.time || '', game: `${m.homeTeam || ''} – ${m.awayTeam || ''}`, place: m.stadiumName || '' }));
  const sessions = expandTrainings(live(data.trainings).filter(linked), today, until).filter((o) => !o.cancelled)
    .map((o) => ({ date: o.date, time: o.time, title: (live(data.trainings).find((t) => t.id === o.trainingId) || {}).title || '' }));
  const meetings = live(data.meetings).filter((m) => (linked(m) || norm(m.title).includes(norm(name))) && (m.date || '') >= addDays(today, -30))
    .sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`))
    .map((m) => ({ date: m.date, time: m.time || '', title: m.title || '', past: m.date < today }));
  const tasks = live(data.tasks).filter((t) => linked(t) && !t.done).map((t) => ({ title: t.title, dueDate: t.dueDate || '', priority: t.priority || '' }));
  const changes = (data.audit || []).filter((a) => a.docId === playerId && ms(a.at) > now.getTime() - 30 * DAY)
    .sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 12)
    .map((a) => ({ at: new Date(ms(a.at)).toISOString().slice(0, 10), action: a.action, by: a.byName || a.by || '', fields: (a.fields || []).slice(0, 8) }));
  const fits = live(data.requirements).filter((r) => reqOpen(r, today))
    .map((r) => ({ r, m: scoreRequirement(r, [p], now)[0] }))
    .filter((x) => x.m && x.m.eligible && x.m.score >= 45)
    .sort((a, b) => b.m.score - a.m.score).slice(0, 5)
    .map(({ r, m }) => ({ club: r.clubName || '', requirementId: r.id, score: m.score, why: m.reasons.map((x) => x.he).join(' · '), alreadyDeal: hasDeal(live(data.deals), r, playerId) }));
  const memories = (data.memories || []).filter((m) => norm(`${m.about || ''} ${m.text || ''}`).includes(norm(name).split(' ')[0] || '~')).slice(0, 8).map((m) => m.text);
  return {
    player: {
      id: p.id, name, stage, category: categoryFromPlayer(p), position: p.primaryPosition || '', secondary: p.secondaryPositions || [],
      dob: p.dob || '', club: p.currentClub || '', league: p.league || '', contractStatus: p.contractStatus || '', loanFrom: p.loanFrom || '',
      nationalities: p.nationalities || [], foot: p.foot || '', natTeam: p.natTeamStatus || '', status: p.status || '', notes: String(p.notes || '').slice(0, 600),
      links: { crm: `${APP}/players/${p.id}`, profile: p.profileLink || '', video: p.videoLink || '', ifa: p.ifaTeamUrl || '' },
    },
    dates: [dateLine('contract ends', p.contractEnd, now), dateLine('representation ends', p.reprEnd, now), dateLine('passport expires', p.passportExpiry, now), dateLine('loan parent contract ends', p.loanParentEnd, now)].filter(Boolean),
    documents: { contract: files(p, 'contractFiles'), passport: files(p, 'passportFiles'), representation: files(p, 'reprFiles') },
    missing, deals, nextGames: games, nextTrainings: sessions.slice(0, 12), meetings, openTasks: tasks, changesLast30Days: changes,
    fitsOpenRequirements: fits, memories,
  };
}

/** Everything about one club, matched loosely by name in every collection. */
function clubBriefOf(data, clubName, now = new Date()) {
  const q = norm(clubName);
  if (!q) throw new Error('clubName is required');
  const today = israelDate(now);
  const has = (v) => { const n = norm(v); return n && (n.includes(q) || q.includes(n)); };
  const reqs = live(data.requirements).filter((r) => has(r.clubName));
  const pool = live(data.players).filter((p) => stageOfPlayer(p) !== 'not_relevant');
  return {
    club: clubName,
    requirements: reqs.map((r) => ({
      id: r.id, position: r.requiredPosition || '', gender: r.gender || '', ageMin: r.ageMin || '', ageMax: r.ageMax || '', salary: r.salary || '', fee: r.transferFee || '',
      status: (r.status || 'open'), validUntil: r.validUntil || '', expired: Boolean(r.validUntil && r.validUntil < today), notes: String(r.notes || '').slice(0, 300),
      bestFits: reqOpen(r, today) ? scoreRequirement(r, pool, now).filter((m) => m.eligible && m.score >= 50).slice(0, 3).map((m) => ({ playerId: m.playerId, name: m.playerName, score: m.score })) : [],
      link: `${APP}/market/requirements?req=${r.id}`,
    })),
    contacts: live(data.contacts).filter((c) => has(c.clubName)).map((c) => ({ name: c.contactName || '', role: c.contactRole || '', phone: c.contactPhone || '' })),
    deals: live(data.deals).filter((d) => has(d.clubName)).map((d) => ({ player: d.playerName || '', stage: d.stage || '', open: isOpenDeal(d), link: `${APP}/market/deals?deal=${d.id}` })),
    ourPlayersThere: live(data.players).filter((p) => has(p.currentClub) || has(p.loanFrom)).map((p) => ({ id: p.id, name: playerName(p), stage: stageOfPlayer(p), contractEnd: p.contractEnd || '' })),
    meetings: live(data.meetings).filter((m) => has(m.title) || has(m.location) || norm(m.notes).includes(q)).map((m) => ({ date: m.date, time: m.time || '', title: m.title })).slice(-10),
    games: live(data.matches).filter((m) => (has(m.homeTeam) || has(m.awayTeam)) && m.date >= addDays(today, -14) && m.date <= addDays(today, 30))
      .map((m) => ({ date: m.date, time: m.time || '', game: `${m.homeTeam} – ${m.awayTeam}` })).slice(0, 10),
  };
}

/**
 * checkScheduleOf(items, data, now)
 * items: [{ kind: 'match'|'training', date, time, players: [names], home, away, title, place, notes }]
 * Each comes back with the players it names (Hebrew or English), names it could
 * not place, and what already exists that day for those players, plus a verdict:
 *   create          nothing like it in the CRM yet
 *   exists          the same game or session is already there (same time)
 *   update_time     it is there with another time (offer to fix the time)
 *   unknown_player  no player could be matched; ask who it is
 *   bad_date        the date is missing or not YYYY-MM-DD
 */
function checkScheduleOf(items, data, now = new Date()) {
  const players = live(data.players);
  const trainings = live(data.trainings);
  const matches = live(data.matches);
  const hhmm = (t) => (/^\d{1,2}:\d{2}$/.test(String(t || '').trim()) ? String(t).trim().padStart(5, '0') : '');
  return (items || []).slice(0, 60).map((it, i) => {
    const names = (Array.isArray(it.players) ? it.players : [it.players]).filter(Boolean).map(String);
    const ids = findPlayers(names, players);
    const known = ids.map((id) => ({ id, name: playerName(players.find((p) => p.id === id)) }));
    const unknown = names.filter((n) => !findPlayers([n], players).length);
    const base = { index: i, kind: it.kind, date: it.date || '', time: hhmm(it.time), players: known, unknownNames: unknown };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it.date || ''))) return { ...base, verdict: 'bad_date' };
    if (!known.length) return { ...base, verdict: 'unknown_player' };
    const mine = (r) => Array.isArray(r.linkedPlayers) && r.linkedPlayers.some((id) => ids.includes(id));
    let existing = [];
    if (it.kind === 'match') {
      existing = matches.filter((m) => m.date === it.date && mine(m)).map((m) => ({ collection: 'matches', id: m.id, time: hhmm(m.time), what: `${m.homeTeam || ''} – ${m.awayTeam || ''}` }));
    } else {
      existing = expandTrainings(trainings.filter(mine), it.date, it.date).filter((o) => !o.cancelled)
        .map((o) => ({ collection: 'trainings', id: o.trainingId, time: hhmm(o.time), recurring: o.recurring, sourceDate: o.sourceDate, what: (trainings.find((t) => t.id === o.trainingId) || {}).title || '' }));
    }
    const t = hhmm(it.time);
    const verdict = !existing.length ? 'create' : existing.some((e) => e.time === t || (!t && !e.time)) ? 'exists' : 'update_time';
    return { ...base, existing, verdict, past: it.date < israelDate(now) };
  });
}

function briefTools({ db }) {
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const load = async (names) => {
    const out = {};
    await Promise.all(names.map(async (n) => {
      if (n === 'audit') out.audit = rows(await db.collection('audit').where('at', '>=', new Date(Date.now() - 30 * DAY)).get());
      else if (n === 'memories') out.memories = rows(await db.collection('golda_memory').get()).filter((m) => m.shared !== false);
      else out[n] = rows(await db.collection(n === 'requirements' ? 'club_requirements' : n).get());
    }));
    return out;
  };
  return {
    async player_brief({ playerId }) {
      return playerBriefOf(await load(['players', 'deals', 'matches', 'trainings', 'meetings', 'tasks', 'requirements', 'audit', 'memories']), playerId);
    },
    async club_brief({ clubName }) {
      return clubBriefOf(await load(['players', 'deals', 'matches', 'meetings', 'contacts', 'requirements']), clubName);
    },
    async opportunities({ n, min }) {
      const d = await load(['players', 'requirements', 'deals']);
      return { opportunities: opportunitiesOf({ ...d, n: Math.max(1, Math.min(Number(n) || 5, 10)), min: Number(min) || 55 }) };
    },
    async check_schedule({ items }) {
      return { items: checkScheduleOf(items, await load(['players', 'matches', 'trainings'])) };
    },
  };
}

const BRIEF_TOOL_DEFS = [
  { name: 'player_brief', description: 'Everything about one player in one call: the record, contract / representation / passport dates with days left, stored documents and what is missing, deals, games and trainings in the next 3 weeks, meetings, open tasks, changes in the last 30 days, open club requirements the player fits (with scores), and shared memories. Use it for "ספרי לי על…", "מה המצב של…", and before a meeting or a call about a player.',
    input_schema: { type: 'object', properties: { playerId: { type: 'string' } }, required: ['playerId'], additionalProperties: false } },
  { name: 'club_brief', description: "Everything about one club: its requirements (with the best-fitting players), contacts, deals, our players there, meetings and games. Use it before a call or a meeting with a club, and for \"מה יש לנו עם…\".",
    input_schema: { type: 'object', properties: { clubName: { type: 'string', description: 'The club name, Hebrew or English, part of it is fine' } }, required: ['clubName'], additionalProperties: false } },
  { name: 'opportunities', description: 'The strongest matches between open club requirements and players or candidates that have no deal yet, each player and requirement once, with the score and why. Use for "הזדמנויות", "מה כדאי לקדם", "את מי להציע".',
    input_schema: { type: 'object', properties: { n: { type: 'integer', description: 'How many, default 5, max 10' }, min: { type: 'integer', description: 'Minimum score, default 55' } }, additionalProperties: false } },
  { name: 'check_schedule', description: 'Before creating games or trainings read from a photo, a screenshot, a forwarded message or a list: pass every line here. Returns, per line, which players it is about (Hebrew names are matched to the English names in the CRM), names that matched nobody, what already exists that day, and a verdict (create / exists / update_time / unknown_player / bad_date). Then show the writer the plan and ask once before creating.',
    input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['match', 'training'] }, date: { type: 'string', description: 'YYYY-MM-DD' }, time: { type: 'string', description: 'HH:MM, empty if unknown' },
      players: { type: 'array', items: { type: 'string' } }, home: { type: 'string' }, away: { type: 'string' }, title: { type: 'string' }, place: { type: 'string' }, notes: { type: 'string' },
    }, required: ['kind', 'date', 'players'], additionalProperties: false } } }, required: ['items'], additionalProperties: false } },
];

module.exports = { opportunitiesOf, playerBriefOf, clubBriefOf, checkScheduleOf, briefTools, BRIEF_TOOL_DEFS };
