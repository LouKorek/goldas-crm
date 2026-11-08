// Lou's agency calendar "Gold A&S" <-> the CRM's meetings collection.
//
// The agency calendar holds everything of the agency that is not a player's
// game or training (those go to "Gold A&S Player Schedule", gcal-sync.js):
// Lou's meetings with players, business meetings and so on. Each calendar
// event is one record in `meetings` (an instance of a repeating event is its
// own record), kept the same both ways:
//   - an event Lou adds in Google becomes a meeting; one added in the CRM or
//     by Golda becomes an event;
//   - an edit on either side reaches the other; when both sides changed the
//     same meeting since the last sync, the later edit wins;
//   - deleting on either side deletes on the other (the CRM keeps it in the
//     recycle bin, Google in its trash).
// Change detection compares the meeting's fields with what was synced last
// (calendar_links/g_<meetingId>.hash), so a sync never echoes its own writes.
//
// Guests are Google's: the server cannot invite people (a service account
// may not send invitations outside Google Workspace), so guests and the Meet
// link are read from the calendar and never written. Every write uses
// sendUpdates=none, and a description Lou wrote is only replaced when the
// notes were changed in the CRM.
const crypto = require('crypto');
const { addDays, israelDate, playerName } = require('@goldas/domain');
const G = require('./gcal-sync.js');

const AGENCY_CALENDAR_ID = '7dd7e90d8fff0061bf3a20caee6bbb419964f6a202a727e70547a9f89c6de68f@group.calendar.google.com';
const PAST_DAYS = 3;
const AHEAD_DAYS = 120;
const DEFAULT_MINUTES = 60;

const pad = (n) => String(n).padStart(2, '0');
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const validTime = (t) => /^\d{1,2}:\d{2}$/.test(String(t || '').trim());
const normTime = (t) => { const [h, m] = String(t).trim().split(':'); return `${pad(+h)}:${pad(+m)}`; };
const normName = (s) => String(s || '').replace(/["'״׳`.\-–—|()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

const keyFor = (meetingId) => `g_${meetingId}`;
const eventIdFor = (meetingId) => G.eventIdFor(keyFor(meetingId));

/**
 * The comparable shape of a meeting: { title, date, time, endDate, endTime,
 * allDay, location, notes }. A timed meeting without an end lasts an hour.
 */
function normalize(m) {
  const title = String(m.title || '').trim();
  const location = String(m.location || '').trim();
  const notes = String(m.notes || '').replace(/\r/g, '').trim();
  const date = String(m.date || '');
  const timed = !m.allDay && validTime(m.time);
  if (!timed) {
    const endDate = validDate(m.endDate) && m.endDate >= date ? m.endDate : date;
    return { title, date, time: '', endDate, endTime: '', allDay: true, location, notes };
  }
  const time = normTime(m.time);
  let endTime = validTime(m.endTime) ? normTime(m.endTime) : '';
  let endDate = validDate(m.endDate) && m.endDate >= date ? m.endDate : '';
  // No end, or an end that is not after the start on the same day: one hour.
  if (!endTime || ((!endDate || endDate === date) && endTime <= time)) { const e = G.plusMinutes(date, time, DEFAULT_MINUTES); endTime = e.time; endDate = e.date; }
  if (!endDate) endDate = date;
  return { title, date, time, endDate, endTime, allDay: false, location, notes };
}

const minutesBetween = (a, b) => Math.round((Date.parse(`${b.date}T${b.time || '00:00'}:00Z`) - Date.parse(`${a.date}T${a.time || '00:00'}:00Z`)) / 60000);

/**
 * A meeting patch that moves the start (date and/or time) without saying
 * where it ends keeps the meeting's length; the time also sets allDay.
 */
function keepDuration(before, patch) {
  const d = { ...patch };
  if ('time' in d) d.allDay = !validTime(d.time);
  if (!('date' in d) && !('time' in d) && !('allDay' in d)) return d;
  if ('endTime' in d || 'endDate' in d) return d;
  const was = normalize(before);
  const next = { ...before, ...d };
  if (!validDate(next.date)) return d;
  if (!next.allDay && validTime(next.time)) {
    const len = was.allDay ? DEFAULT_MINUTES : Math.max(1, minutesBetween({ date: was.date, time: was.time }, { date: was.endDate, time: was.endTime }));
    const e = G.plusMinutes(next.date, normTime(next.time), len);
    d.endTime = e.time; d.endDate = e.date;
  } else {
    d.time = ''; d.endTime = '';
    d.endDate = addDays(next.date, was.allDay ? Math.max(0, minutesBetween({ date: was.date }, { date: was.endDate }) / 1440) : 0);
  }
  return d;
}

const fieldsHash = (n) => sha(JSON.stringify([n.title, n.date, n.time, n.endDate, n.endTime, n.allDay, n.location, n.notes]));

/** The same shape read from a Google event. */
function fromEvent(ev) {
  const allDay = !!(ev.start && ev.start.date);
  const start = G.eventLocal(ev);
  let endDate = start.date, endTime = '';
  if (allDay && ev.end && ev.end.date) endDate = addDays(ev.end.date, -1);
  if (!allDay && ev.end && ev.end.dateTime) { const e = G.eventLocal({ start: ev.end }); endDate = e.date; endTime = e.time; }
  return normalize({
    title: ev.summary || '', date: start.date, time: allDay ? '' : start.time, endDate, endTime, allDay,
    location: ev.location || '', notes: G.plainText(ev.description),
  });
}

/** Read-only extras the calendar owns. */
function extrasFromEvent(ev) {
  const video = ev.conferenceData && (ev.conferenceData.entryPoints || []).find((e) => e.entryPointType === 'video');
  return {
    guests: (ev.attendees || []).filter((a) => !a.self && !a.resource && !a.organizer).map((a) => a.displayName || a.email).slice(0, 20),
    meetUrl: ev.hangoutLink || (video && video.uri) || '',
    calendarLink: ev.htmlLink || '',
    recurring: !!ev.recurringEventId,
  };
}

/** Players named in a title, or set on the event by the CRM. */
function playersOfEvent(ev, players) {
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const known = new Set(players.map((p) => p.id));
  const out = String(priv.goldasPlayers || '').split(',').map((x) => x.trim()).filter((id) => id && known.has(id));
  const title = normName(ev.summary);
  for (const p of players) {
    const n = normName(playerName(p));
    if (n && n.length >= 4 && title.includes(n) && !out.includes(p.id)) out.push(p.id);
  }
  return out;
}

/** Google body for a meeting; `ev` is the current event, so only what differs is sent. */
function eventBody(meeting, ev = null) {
  const n = normalize(meeting);
  const priv = { goldasMeeting: meeting.id, goldasPlayers: (meeting.linkedPlayers || []).join(',') };
  const body = { summary: n.title || 'פגישה', location: n.location, extendedProperties: { private: priv } };
  if (!ev || G.plainText(ev.description).replace(/\r/g, '').trim() !== n.notes) body.description = n.notes;
  if (n.allDay) {
    body.start = { date: n.date };
    body.end = { date: addDays(n.endDate, 1) };
    if (ev) { body.start.dateTime = null; body.start.timeZone = null; body.end.dateTime = null; body.end.timeZone = null; }
  } else {
    body.start = { dateTime: `${n.date}T${n.time}:00`, timeZone: G.TZ };
    body.end = { dateTime: `${n.endDate}T${n.endTime}:00`, timeZone: G.TZ };
    if (ev) { body.start.date = null; body.end.date = null; }
  }
  return body;
}

/** CRM fields from an event (pull or import). */
function meetingPatch(ev, players, current = null) {
  const n = fromEvent(ev);
  const patch = { ...n, ...extrasFromEvent(ev), calendarEventId: ev.id };
  if (!current || !(current.linkedPlayers || []).length) patch.linkedPlayers = playersOfEvent(ev, players);
  return patch;
}

const millis = G.millis;

/**
 * What to do, from the meetings, the events in the window and the links.
 * Actions: insert, push, pull, link (fields equal, refresh the link),
 * cancel_meeting (event gone), remove_event (meeting deleted), import,
 * remove_orphan (event of a meeting that no longer exists), none.
 * Events outside the window are fetched by the runner (`fetch`).
 */
function plan({ meetings, events, links, from, to, mode = 'two_way' }) {
  const twoWay = mode !== 'push';
  const byEvent = new Map(events.map((e) => [e.id, e]));
  const meetingIds = new Set(meetings.map((m) => m.id));
  const claimed = new Set();
  const actions = [];
  const inWindow = (d) => d && d >= from && d <= to;

  for (const m of meetings) {
    const key = keyFor(m.id);
    const link = links.get(key) || null;
    const evId = m.calendarEventId || (link && link.eventId) || '';
    if (evId) claimed.add(evId);
    if (m.deletedAt) {
      if (link && evId) {
        const ev = byEvent.get(evId);
        if (!ev || ev.status !== 'cancelled') actions.push({ type: 'remove_event', meeting: m, eventId: evId, key });
        else actions.push({ type: 'drop_link', key });
      }
      continue;
    }
    if (!evId) {
      if (inWindow(m.date)) actions.push({ type: 'insert', meeting: m, key });
      continue;
    }
    const ev = byEvent.get(evId);
    if (!ev) { if (inWindow(m.date)) actions.push({ type: 'fetch', meeting: m, eventId: evId, link, key }); continue; }
    actions.push(reconcile(m, ev, link, key, twoWay));
  }

  if (twoWay) {
    for (const ev of events) {
      if (claimed.has(ev.id) || ev.status === 'cancelled') continue;
      const owner = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.goldasMeeting;
      if (owner && !meetingIds.has(owner)) { actions.push({ type: 'remove_orphan', event: ev }); continue; }
      if (owner) continue;   // its meeting points elsewhere; leave it
      const local = G.eventLocal(ev);
      if (!inWindow(local.date)) continue;
      actions.push({ type: 'import', event: ev });
    }
  }
  return actions;
}

/** One linked pair: who changed since the last sync decides. */
function reconcile(m, ev, link, key, twoWay) {
  // Gone from Google: deleted there (we had synced it), or the meeting was
  // restored from the recycle bin after its event was removed (no link left).
  if (ev.status === 'cancelled') return twoWay && link ? { type: 'cancel_meeting', meeting: m, event: ev, key } : { type: 'revive', meeting: m, eventId: ev.id, key };
  const crm = normalize(m);
  const cal = fromEvent(ev);
  const crmH = fieldsHash(crm);
  const calH = fieldsHash(cal);
  if (crmH === calH) return { type: link && link.hash === crmH && link.eventId === ev.id ? 'none' : 'link', meeting: m, event: ev, key, hash: crmH };
  if (!twoWay) return { type: 'push', meeting: m, event: ev, key };
  const crmChanged = !link || link.hash !== crmH;
  const calChanged = !link || link.hash !== calH;
  if (crmChanged && !calChanged) return { type: 'push', meeting: m, event: ev, key };
  if (calChanged && !crmChanged) return { type: 'pull', meeting: m, event: ev, key };
  // Both changed (or never linked): the later edit wins.
  return millis(m.updatedAt) > millis(ev.updated) ? { type: 'push', meeting: m, event: ev, key } : { type: 'pull', meeting: m, event: ev, key };
}

const windowRange = (now = new Date()) => {
  const today = israelDate(now);
  return { today, from: addDays(today, -PAST_DAYS), to: addDays(today, AHEAD_DAYS) };
};

/** Calendar calls for the agency calendar, writes without notifying guests. */
function agencyApi(client, calendarId = AGENCY_CALENDAR_ID) {
  const cal = `/calendars/${encodeURIComponent(calendarId)}`;
  const base = G.api(client, calendarId);
  const q = { sendUpdates: 'none' };
  return {
    ...base,
    async insertAt(id, body) {
      try {
        return await client.call('POST', `${cal}/events`, { params: q, data: { id, ...body } });
      } catch (e) {
        if (e.status !== 409) throw e;
        return client.call('PATCH', `${cal}/events/${id}`, { params: q, data: { ...body, status: 'confirmed' } });
      }
    },
    patch: (id, body) => client.call('PATCH', `${cal}/events/${encodeURIComponent(id)}`, { params: q, data: body }),
    async remove(id) {
      try { await client.call('DELETE', `${cal}/events/${encodeURIComponent(id)}`, { params: q }); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    },
    get: (id) => client.call('GET', `${cal}/events/${encodeURIComponent(id)}`),
  };
}

module.exports = {
  AGENCY_CALENDAR_ID, DEFAULT_MINUTES,
  keyFor, eventIdFor, normalize, keepDuration, fieldsHash, fromEvent, extrasFromEvent, playersOfEvent, eventBody, meetingPatch,
  plan, reconcile, windowRange, agencyApi,
};
