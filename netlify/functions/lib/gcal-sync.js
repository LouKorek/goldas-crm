// Two-way sync between the CRM's matches and trainings and Lou's Google
// calendar "Gold A&S Player Schedule".
//
//   CRM -> calendar   every match and every training session of the next
//                     60 days becomes one event, in the format Lou set up
//                     by hand: "אימון — <שחקן>" / "משחק — <שחקן> — <בית> נגד
//                     <חוץ>", a one-minute marker at the time, a popup an
//                     hour before, free (transparent) and private. A game
//                     whose time is not known yet is an all-day event that
//                     ends with "— שעה לאישור" and has no reminder.
//   calendar -> CRM   moving an event, changing its place or its text moves
//                     the CRM record (one session of a weekly training
//                     becomes an exception). Deleting an event cancels the
//                     session, or sends the record to the recycle bin; an
//                     IFA fixture is never deleted, it only stops showing.
//                     An event Lou adds himself ("אימון — נווה סלנט") is
//                     imported, linked to the player by name.
//
// Every event the server owns carries extendedProperties.private.goldasKey
// and a deterministic id, so two runs at the same moment can never create a
// duplicate. `calendar_links/{key}` remembers what each side looked like at
// the last sync; whichever side changed since wins, and when both changed
// the later edit wins.
//
// Auth: the Firebase service account (FIREBASE_SERVICE_ACCOUNT_KEY). Lou
// shares the calendar with its client_email ("make changes to events") and
// the Calendar API is enabled on the gold-as-crm project; until then a run
// records what is missing in app_meta/calendarSync and stops.
const crypto = require('crypto');
const { addDays, israelDate, playerName } = require('@goldas/domain');

const TZ = 'Asia/Jerusalem';
const DEFAULT_CALENDAR_ID = '5d6f4890e0c176670656fdbd875703d81565708942bb1f4ada0922702210d66b@group.calendar.google.com';
const PAST_DAYS = 3;
const AHEAD_DAYS = 60;
const FOOTER = 'מסונכרן עם Gold A&S CRM';
const CRM_URL = 'https://goldas-crm.netlify.app/calendar';
const TBC = 'שעה לאישור';

// ───────────────────────── pure helpers ─────────────────────────

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Calendar event ids allow base32hex (0-9, a-v); hex is a subset. */
const eventIdFor = (key) => `gas${sha(key)}`;

const keyFor = (kind, crmId, occ) => (kind === 'match' ? `m_${crmId}` : `t_${crmId}_${occ}`);

const validTime = (t) => /^\d{1,2}:\d{2}$/.test(String(t || '').trim());
const pad = (n) => String(n).padStart(2, '0');
const normTime = (t) => { const [h, m] = String(t).trim().split(':'); return `${pad(+h)}:${pad(+m)}`; };

/** date + time + minutes, as local wall-clock strings. */
function plusMinutes(date, time, minutes) {
  const [h, m] = normTime(time).split(':').map(Number);
  let total = h * 60 + m + minutes;
  let d = date;
  while (total >= 1440) { total -= 1440; d = addDays(d, 1); }
  return { date: d, time: `${pad(Math.floor(total / 60))}:${pad(total % 60)}` };
}

/** HTML from the Google UI -> plain text. */
function plainText(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** The notes part of an event description (without the sync footer). */
function notesFromDescription(desc) {
  const lines = plainText(desc).split('\n');
  const i = lines.findIndex((l) => l.includes(FOOTER));
  return (i >= 0 ? lines.slice(0, i) : lines).join('\n').trim();
}

/** Local date/time of an event start in Israel; time '' for all-day. */
function eventLocal(ev) {
  const s = ev.start || {};
  if (s.date) return { date: s.date, time: '' };
  if (!s.dateTime) return { date: '', time: '' };
  const d = new Date(s.dateTime);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const normName = (s) => String(s || '').replace(/["'״׳`.\-–—]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * "אימון — נווה סלנט", "משחק — אסף אקרמן — שעה לאישור",
 * "משחק אימון — רפאל ליבסמן — הפועל נגד מכבי" -> { kind, label, names[], home, away }.
 */
function parseSummary(summary) {
  const parts = String(summary || '').split(/\s+[—–-]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const head = parts[0];
  let kind = null;
  if (/^(משחק|game|match)/i.test(head)) kind = 'match';
  else if (/^(אימון|training)/i.test(head)) kind = 'training';
  if (!kind) return null;
  const names = parts[1].split(/\s*[,،&]\s*|\s+ו(?=[א-ת])/).map((x) => x.trim()).filter(Boolean);
  let home = '', away = '';
  for (const p of parts.slice(2)) {
    const m = p.match(/^(.+?)\s+(?:נגד|vs\.?|מול)\s+(.+)$/i);
    if (m) { home = m[1].trim(); away = m[2].trim(); }
  }
  return { kind, label: head, names, home, away };
}

/**
 * The sound skeleton of one name, the same for Hebrew and Latin spellings:
 * consonant classes only, vowels and silent letters dropped, repeats merged.
 * "אסף אקרמן" and "Assaf Ackerman" both give ["sp", "krmn"]. Lou writes
 * names in Hebrew in his calendar; the CRM keeps them in English.
 */
const HE = { 'ב': 'b', 'ג': 'g', 'ד': 'd', 'ז': 's', 'ח': 'k', 'ט': 't', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm', 'ם': 'm', 'נ': 'n', 'ן': 'n',
  'ס': 's', 'פ': 'p', 'ף': 'p', 'צ': 's', 'ץ': 's', 'ק': 'k', 'ר': 'r', 'ש': 's', 'ת': 't' };
const LAT = { b: 'b', v: 'b', w: 'b', c: 'k', k: 'k', q: 'k', g: 'g', j: 'g', d: 'd', t: 't', z: 's', s: 's', l: 'l', m: 'm', n: 'n', p: 'p', f: 'p', r: 'r', x: 'ks' };
function skeletonWord(w) {
  let t = String(w || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/וו/g, 'ב').replace(/ph/g, 'f').replace(/th/g, 't').replace(/(sch|sh|tz|ts)/g, 's').replace(/(ch|kh|ck)/g, 'k');
  let out = '';
  for (const ch of t) {
    const c = HE[ch] || LAT[ch] || '';
    if (c && !out.endsWith(c)) out += c;
  }
  return out;
}
const skeleton = (name) => normName(name).split(' ').map(skeletonWord).filter(Boolean);
// A single Hebrew ו is a vowel (נועם, Noam) or a v (לוי, Levi; נוה, Naveh); try both.
function wordVariants(w) {
  const t = String(w || '');
  if (!/[א-ת]/.test(t) || !/(^|[^ו])ו(?!ו)/.test(t)) return [skeletonWord(t)];
  let forms = [''];
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const single = ch === 'ו' && chars[i - 1] !== 'ו' && chars[i + 1] !== 'ו';
    if (single && forms.length < 8) forms = forms.flatMap((f) => [f, `${f}וו`]);
    else forms = forms.map((f) => f + ch);
  }
  return [...new Set(forms.map(skeletonWord).filter(Boolean))];
}
function nearWord(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;           // one insertion, deletion or change
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** Every word of `name` sounds like a different word of the player's name. */
function soundsLike(name, player) {
  const want = normName(name).split(' ').filter(Boolean).map(wordVariants).filter((v) => v.length);
  const have = skeleton(playerName(player));
  if (!want.length || !have.length) return false;
  const used = new Set();
  return want.every((forms) => {
    const k = have.findIndex((h, idx) => !used.has(idx) && forms.some((w) => nearWord(w, h)));
    if (k < 0) return false;
    used.add(k);
    return true;
  });
}

/** Player ids whose name appears in the parsed names (in Hebrew or English). */
function findPlayers(names, players) {
  const out = [];
  for (const raw of names) {
    const n = normName(raw);
    if (!n) continue;
    const exact = players.filter((p) => normName(playerName(p)) === n);
    let hit = exact.length === 1 ? exact
      : players.filter((p) => { const pn = normName(playerName(p)); return pn && (pn.includes(n) || n.includes(pn)); });
    if (hit.length !== 1) hit = players.filter((p) => soundsLike(raw, p));
    if (hit.length === 1 && !out.includes(hit[0].id)) out.push(hit[0].id);
  }
  return out;
}

/** What one CRM item should look like in the calendar. */
function desiredEvent(item) {
  const names = item.playerNames.join(', ');
  const timed = validTime(item.time);
  let summary;
  if (item.kind === 'match') {
    const teams = item.home && item.away ? `${item.home} נגד ${item.away}` : '';
    summary = [item.label || 'משחק', names || teams, names && teams ? teams : '', timed ? '' : TBC].filter(Boolean).join(' — ');
  } else {
    const who = names || item.title || '';
    summary = [item.label || 'אימון', who].filter(Boolean).join(' — ');
    if (names && item.title && !/^אימון$/.test(item.title.trim()) && item.title.trim() !== names) summary += ` (${item.title.trim()})`;
  }
  const lines = [];
  if (item.notes) lines.push(item.notes);
  lines.push('', `${FOOTER} · ${CRM_URL}`);
  const body = {
    summary,
    description: lines.join('\n').replace(/^\n+/, ''),
    location: item.place || '',
    transparency: 'transparent',
    visibility: 'private',
    extendedProperties: { private: { goldasKey: item.key, goldasKind: item.kind, goldasId: item.crmId, goldasOcc: item.occ || '' } },
  };
  if (timed) {
    const t = normTime(item.time);
    const end = plusMinutes(item.date, t, 1);
    body.start = { dateTime: `${item.date}T${t}:00`, timeZone: TZ };
    body.end = { dateTime: `${end.date}T${end.time}:00`, timeZone: TZ };
    body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] };
  } else {
    body.start = { date: item.date };
    body.end = { date: addDays(item.date, 1) };
    body.reminders = { useDefault: false, overrides: [] };
  }
  return body;
}

const bodyHash = (b) => sha(JSON.stringify([b.summary, b.description, b.location, b.start, b.end, b.reminders]));

const millis = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds != null) return ts._seconds * 1000;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * The CRM items (one per match, one per training session) that belong in the
 * window, with what the calendar needs to draw them.
 */
function crmItems({ matches, trainings, players, from, to, occurrences }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const namesOf = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean).map((p) => playerName(p)).filter(Boolean);
  const items = [];
  // The same game can sit in the CRM twice (two fixture sources): it gets
  // one event, the record created first.
  const seen = new Set();
  const gameKey = (m) => [m.date, (validTime(m.time) ? normTime(m.time) : ''), normName(m.homeTeam), normName(m.awayTeam), [...(m.linkedPlayers || [])].sort().join(',')].join('|');
  const ordered = [...matches].sort((a, b) => (millis(a.createdAt) - millis(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  for (const m of ordered) {
    if (m.deletedAt || m.calendarSkip || !m.date || m.date < from || m.date > to) continue;
    const playerNames = namesOf(m.linkedPlayers);
    if (!playerNames.length && !(m.homeTeam && m.awayTeam)) continue;
    const gk = gameKey(m);
    if (seen.has(gk)) continue;
    seen.add(gk);
    items.push({
      kind: 'match', crmId: m.id, occ: '', key: keyFor('match', m.id), date: m.date, time: m.time || '',
      label: m.calendarLabel || '', home: m.homeTeam || '', away: m.awayTeam || '', place: m.stadiumName || '',
      notes: m.notes || '', playerNames, updatedMs: millis(m.updatedAt || m.createdAt), record: m,
    });
  }
  const live = trainings.filter((t) => !t.deletedAt && !t.calendarSkip);
  for (const t of live) {
    const exNotes = new Map((t.exceptions || []).filter((e) => e.notes).map((e) => [e.date, e.notes]));
    for (const o of occurrences(t, from, to)) {
      if (o.cancelled) continue;
      const playerNames = namesOf(t.linkedPlayers);
      items.push({
        kind: 'training', crmId: t.id, occ: o.sourceDate, key: keyFor('training', t.id, o.sourceDate), date: o.date, time: o.time || '',
        recurring: o.recurring, label: t.calendarLabel || '', title: t.title || '', place: t.place || '', notes: (o.recurring && exNotes.get(o.sourceDate)) || t.notes || '',
        playerNames, updatedMs: millis(t.updatedAt || t.createdAt), record: t,
      });
    }
  }
  return items;
}

/**
 * The CRM patch an edited calendar event implies, or null. Only what the
 * calendar can meaningfully change: date, time, place, notes.
 */
function pullPatch(item, ev) {
  const local = eventLocal(ev);
  const date = local.date;
  if (!date) return null;
  // An all-day "שעה לאישור" event says nothing about the time: keep the one we know.
  const unknownTime = !local.time && String(ev.summary || '').includes(TBC);
  const time = unknownTime && validTime(item.time) ? normTime(item.time) : local.time;
  const place = String(ev.location || '').trim();
  const notes = notesFromDescription(ev.description);
  const rec = item.record;
  if (item.kind === 'match') {
    const p = {};
    if (date !== rec.date) p.date = date;
    if (time !== (validTime(rec.time) ? normTime(rec.time) : '')) p.time = time;
    if (place !== String(rec.stadiumName || '').trim()) p.stadiumName = place;
    if (notes !== String(rec.notes || '').trim()) p.notes = notes;
    return Object.keys(p).length ? p : null;
  }
  // Training.
  const p = {};
  if (!item.recurring) {
    if (date !== rec.date) p.date = date;
    if (time && time !== (validTime(rec.time) ? normTime(rec.time) : '')) p.time = time;
    if (place !== String(rec.place || '').trim()) p.place = place;
    if (notes !== String(rec.notes || '').trim()) p.notes = notes;
    return Object.keys(p).length ? p : null;
  }
  // One session of a weekly training: an exception for that session only
  // (moved date / time, and its own notes, like "הגעה 14:30").
  const curTime = validTime(item.time) ? normTime(item.time) : '';
  const moved = date !== item.date || (time && time !== curTime);
  const notesChanged = notes !== String(item.notes || '').trim();
  if (!moved && !notesChanged) return null;
  const prev = (rec.exceptions || []).find((e) => e.date === item.occ) || {};
  const rest = (rec.exceptions || []).filter((e) => e.date !== item.occ);
  const ex = { date: item.occ };
  const ruleTime = validTime(rec.time) ? normTime(rec.time) : '';
  const newDate = moved ? date : (prev.date2 || item.occ);
  const newTime = moved ? (time || prev.time || '') : (prev.time || '');
  if (newDate !== item.occ) ex.date2 = newDate;
  if (newTime && newTime !== ruleTime) ex.time = newTime;
  if (ex.time && !ex.date2) ex.date2 = item.occ;
  const ownNotes = notesChanged ? notes : prev.notes;
  if (ownNotes && ownNotes !== String(rec.notes || '').trim()) ex.notes = ownNotes;
  p.exceptions = Object.keys(ex).length > 1 ? [...rest, ex] : rest;
  return p;
}

/** What deleting the event in the calendar does to the CRM record. */
function deletionPatch(item) {
  const rec = item.record;
  if (item.kind === 'training' && item.recurring) {
    const rest = (rec.exceptions || []).filter((e) => e.date !== item.occ);
    return { exceptions: [...rest, { date: item.occ, cancelled: true }] };
  }
  if (item.kind === 'match' && rec.source && rec.source !== 'manual' && rec.source !== 'calendar' && rec.source !== 'golda') {
    return { calendarSkip: true };               // an IFA fixture: just stop showing it
  }
  return { deletedAt: new Date(), deletedBy: 'calendar' };
}

/** A new CRM record for an event Lou created in the calendar. */
function importRecord(ev, parsed, playerIds, players) {
  const { date, time } = eventLocal(ev);
  const notes = notesFromDescription(ev.description);
  const place = String(ev.location || '').trim();
  const label = parsed.label && parsed.label !== (parsed.kind === 'match' ? 'משחק' : 'אימון') ? parsed.label : '';
  if (parsed.kind === 'match') {
    const first = players.find((p) => p.id === playerIds[0]);
    return {
      collection: 'matches',
      data: {
        date, time, homeTeam: parsed.home || (first && first.currentClub) || '', awayTeam: parsed.away || '',
        stadiumName: place, notes, linkedPlayers: playerIds, source: 'calendar', calendarLabel: label,
      },
    };
  }
  return {
    collection: 'trainings',
    data: {
      title: 'אימון', date, time, place, notes, linkedPlayers: playerIds, ageGroup: '', rule: null, exceptions: [],
      source: 'calendar', calendarLabel: label,
    },
  };
}

/**
 * Decide what to do. Pure: takes both sides and the links, returns a plan.
 *   items        crmItems(...)
 *   events       calendar events in the window (singleEvents, showDeleted)
 *   links        Map key -> { hash, eventUpdated }
 *   mode         'two_way' | 'push'
 */
function plan({ items, events, links, players, mode = 'two_way' }) {
  const twoWay = mode !== 'push';
  const ours = new Map();
  const foreign = [];
  for (const ev of events) {
    const k = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.goldasKey;
    // A live event wins over a cancelled one carrying the same key (the
    // server's copy that Lou's own event replaced).
    if (k) { if (!ours.has(k) || ours.get(k).status === 'cancelled') ours.set(k, ev); }
    else if (ev.status !== 'cancelled') foreign.push(ev);
  }
  const actions = [];
  const usedForeign = new Set();
  const wanted = new Set();
  const findOwn = (item) => foreign.find((x) => {
    if (usedForeign.has(x.id)) return false;
    const p = parseSummary(x.summary);
    if (!p || p.kind !== item.kind) return false;
    if (eventLocal(x).date !== item.date) return false;
    // Look among this game's own players first: another record with a
    // similar name (a prospect, a duplicate) must not hide the match.
    const linked = item.record.linkedPlayers || [];
    const mine = players.filter((pl) => linked.includes(pl.id));
    if (findPlayers(p.names, mine).length) return true;
    const ids = findPlayers(p.names, players);
    return ids.some((id) => linked.includes(id));
  });

  for (const item of items) {
    wanted.add(item.key);
    const body = desiredEvent(item);
    const hash = bodyHash(body);
    const link = links.get(item.key);
    let ev = ours.get(item.key);

    if (!ev && !link) {
      // Lou may already have this one in the calendar by hand: adopt it.
      const f = findOwn(item);
      if (f) {
        usedForeign.add(f.id);
        const evMs = Date.parse(f.updated || f.created || 0) || 0;
        if (twoWay && evMs > item.updatedMs) {
          const patch = pullPatch(item, f);
          actions.push({ type: 'adopt', item, event: f, patch, body: patch ? null : body, hash });
        } else {
          actions.push({ type: 'adopt', item, event: f, patch: null, body, hash });
        }
        continue;
      }
      actions.push({ type: 'insert', item, body, hash });
      continue;
    }

    if (ev && ev.status === 'cancelled') {
      const crmChanged = link && link.hash !== hash;
      if (twoWay && link && !crmChanged) actions.push({ type: 'deleted_in_calendar', item, patch: deletionPatch(item) });
      else actions.push({ type: 'insert', item, body, hash });   // re-confirms the cancelled id
      continue;
    }
    if (!ev) {
      // Linked, but not in the window listing: moved far away or gone.
      actions.push({ type: 'fetch_and_reconcile', item, body, hash, link });
      continue;
    }
    // Lou has his own event for this game or session (often a "שעה לאישור"
    // placeholder he wants filled in, not doubled): it takes over and the
    // server's copy goes.
    const own = twoWay ? findOwn(item) : null;
    if (own) {
      usedForeign.add(own.id);
      const evMs = Date.parse(own.updated || own.created || 0) || 0;
      const patch = twoWay && evMs > item.updatedMs ? pullPatch(item, own) : null;
      actions.push({ type: 'adopt', item, event: own, patch, body: patch ? null : body, hash, replaces: ev });
      continue;
    }
    actions.push(reconcile(item, ev, body, hash, link, twoWay));
  }

  // Our events whose CRM item is gone (deleted, cancelled, moved out of range).
  for (const [k, ev] of ours) {
    if (wanted.has(k) || ev.status === 'cancelled') continue;
    const { date } = eventLocal(ev);
    actions.push({ type: 'remove', key: k, event: ev, date });
  }

  // Events Lou added himself.
  if (twoWay) {
    for (const ev of foreign) {
      if (usedForeign.has(ev.id)) continue;
      const parsed = parseSummary(ev.summary);
      if (!parsed) { actions.push({ type: 'ignore', event: ev, reason: 'not a game or training title' }); continue; }
      const ids = findPlayers(parsed.names, players);
      if (!ids.length) { actions.push({ type: 'ignore', event: ev, reason: `no player named ${parsed.names.join(', ')}` }); continue; }
      actions.push({ type: 'import', event: ev, record: importRecord(ev, parsed, ids, players) });
    }
  }
  return actions.filter(Boolean);
}

function reconcile(item, ev, body, hash, link, twoWay) {
  const crmChanged = !link || link.hash !== hash;
  const evChanged = !link || link.eventUpdated !== ev.updated;
  if (!crmChanged && !evChanged) return { type: 'none', item, event: ev };
  const evMs = Date.parse(ev.updated || 0) || 0;
  if (twoWay && evChanged && (!crmChanged || evMs > item.updatedMs)) {
    const patch = pullPatch(item, ev);
    if (patch) return { type: 'pull', item, event: ev, patch };
    // Only the title or a field we draw ourselves changed: put ours back.
  }
  return { type: 'push', item, event: ev, body, hash };
}

// ───────────────────────── Calendar API ─────────────────────────

const API = 'https://www.googleapis.com/calendar/v3';

function calendarClient(svc) {
  const { JWT } = require('google-auth-library');
  const jwt = new JWT({ email: svc.client_email, key: svc.private_key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  const call = async (method, path, { params, data } = {}) => {
    try {
      const res = await jwt.request({ url: `${API}${path}`, method, params, data, retry: true });
      return res.data;
    } catch (e) {
      const status = e.response ? e.response.status : 0;
      const reason = e.response && e.response.data && e.response.data.error
        ? (e.response.data.error.errors && e.response.data.error.errors[0] && e.response.data.error.errors[0].reason) || e.response.data.error.status || ''
        : '';
      const err = new Error(`calendar ${method} ${path}: ${status} ${reason || e.message}`);
      err.status = status; err.reason = reason;
      throw err;
    }
  };
  return { call, email: svc.client_email };
}

/**
 * PATCH merges start/end field by field, so turning an all-day event into a
 * timed one (Lou's "שעה לאישור" placeholder once the kick-off is known), or
 * back, must clear the other form explicitly; otherwise Google answers
 * "Start and end times must either both be date or both be dateTime" and
 * the server's copy stays beside Lou's event.
 */
function patchBody(body) {
  const fix = (t) => {
    if (!t || typeof t !== 'object') return t;
    if (t.dateTime) return { ...t, date: null };
    if (t.date) return { ...t, dateTime: null };
    return t;
  };
  return { ...body, start: fix(body.start), end: fix(body.end) };
}

function api(client, calendarId) {
  const cal = `/calendars/${encodeURIComponent(calendarId)}`;
  return {
    async listWindow(timeMin, timeMax) {
      const out = [];
      let pageToken;
      do {
        const r = await client.call('GET', `${cal}/events`, { params: { timeMin, timeMax, singleEvents: true, showDeleted: true, maxResults: 2500, pageToken } });
        out.push(...(r.items || []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    },
    /** Changes since the token; { changed, token }. A missing or expired token counts as changed. */
    async changesSince(token) {
      let changed = false;
      let pageToken;
      let next = null;
      try {
        do {
          const params = token ? { syncToken: token, pageToken, maxResults: 2500 } : { pageToken, maxResults: 2500, showDeleted: true };
          const r = await client.call('GET', `${cal}/events`, { params });
          if ((r.items || []).length) changed = true;
          pageToken = r.nextPageToken;
          next = r.nextSyncToken || next;
        } while (pageToken);
      } catch (e) {
        if (e.status === 410) return this.changesSince(null).then((r) => ({ ...r, changed: true }));
        throw e;
      }
      return { changed: changed || !token, token: next };
    },
    get: (id) => client.call('GET', `${cal}/events/${id}`),
    async upsert(id, body) {
      try {
        return await client.call('POST', `${cal}/events`, { data: { id, ...body } });
      } catch (e) {
        if (e.status !== 409) throw e;
        return client.call('PATCH', `${cal}/events/${id}`, { data: patchBody({ ...body, status: 'confirmed' }) });
      }
    },
    patch: (id, body) => client.call('PATCH', `${cal}/events/${id}`, { data: patchBody(body) }),
    async remove(id) {
      try { await client.call('DELETE', `${cal}/events/${id}`); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    },
    calendarInfo: () => client.call('GET', `${cal}`),
  };
}

/**
 * Try to switch the Calendar API on with the service account itself (works
 * when its roles allow it). Returns { ok, status, message }.
 */
async function enableCalendarApi(svc, projectId) {
  const { JWT } = require('google-auth-library');
  const jwt = new JWT({ email: svc.client_email, key: svc.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  try {
    await jwt.request({ url: `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/calendar-json.googleapis.com:enable`, method: 'POST', data: {} });
    return { ok: true };
  } catch (e) {
    const status = e.response ? e.response.status : 0;
    const message = e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message;
    return { ok: false, status, message: String(message || '').slice(0, 300) };
  }
}

/** Plain words for what is missing, kept in app_meta/calendarSync. */
function accessProblem(e, serviceAccount) {
  if (e.status === 403 && /accessNotConfigured|SERVICE_DISABLED|disabled/i.test(`${e.reason} ${e.message}`)) {
    return { state: 'needs_api', serviceAccount, hint: 'Enable the Google Calendar API on the gold-as-crm project' };
  }
  if (e.status === 404 || e.status === 403) {
    return { state: 'needs_share', serviceAccount, hint: `Share the calendar with ${serviceAccount} ("Make changes to events")` };
  }
  return null;
}

const windowRange = (now = new Date()) => {
  const today = israelDate(now);
  return { today, from: addDays(today, -PAST_DAYS), to: addDays(today, AHEAD_DAYS) };
};

module.exports = {
  DEFAULT_CALENDAR_ID, FOOTER, TBC, TZ,
  eventIdFor, keyFor, plusMinutes, plainText, notesFromDescription, eventLocal, parseSummary,
  findPlayers, soundsLike, desiredEvent, bodyHash, crmItems, pullPatch, deletionPatch, importRecord, plan, reconcile, patchBody,
  calendarClient, api, accessProblem, enableCalendarApi, windowRange, millis,
};
