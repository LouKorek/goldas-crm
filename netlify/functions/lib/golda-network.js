// The relationship map through Golda, on the same engine as the Contacts map
// (packages/domain/src/engines/network.ts):
//
// 1. network_path: "מה הדרך הכי קצרה ל<מועדון>": the way in to a club, through
//    whom, with the last date on each link; up to three ways, each starting
//    with a different first person to call.
// 2. network_cold: "עם מי לא דיברתי הרבה זמן": contacts whose last date (a
//    touch, a meeting, a requirement, activity on a deal) is older than N days,
//    oldest first, and apart those with no record at all.
// 3. contact_link: "X מכיר את Y" / "X הכיר לנו את Y": add or remove the explicit
//    link, kept on the contact's record (contacts/{id}.knows). The write goes
//    through wa-agent's own `update`, so it is audited and undo_last reverses it.
//
// 4. coldNudge: relationship memory. Once a day at most, from the hourly owner
//    chain, Golda tells the owner about one contact tied to an open deal or an
//    open requirement he has not spoken with for 60 days, and offers to draft a
//    message (draft only; he sends it himself). Her own threshold: the map's
//    COLD_AFTER_DAYS stays as the app uses it.
//
// Reading follows the Contacts page: every role reads; writing needs edit.
// Deals are named by their player, club and stage, never by an amount.
const { can, buildNetwork, wayToClub, coldContacts, networkClubs, cleanKnows, clubKey, warmthOf, israelDate, daysBetween, isClosedStage, NET_LINK_LABELS, COLD_AFTER_DAYS, DEAL_STAGE_LABELS } = require('@goldas/domain');
const { awaitsAnswer } = require('./golda-effort.js');
const taps = require('./golda-taps.js');
const { nudge, chatOf } = require('./golda-nudge.js');

const APP = 'https://goldas-crm.netlify.app';
const MAX_ROWS = 40;
const MAX_DAYS = 3650;
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const has = (hay, q) => { const words = norm(q).split(' ').filter(Boolean); const h = norm(hay); return words.length > 0 && words.every((w) => h.includes(w)); };
const mapLink = (q) => `${APP}/contacts?view=map&${q}`;
const heDate = (d) => (d ? d.split('-').reverse().join('.') : '');

// Relationship memory (coldNudge, below).
const GOLDA_COLD_DAYS = 60;        // Golda's own "a long time"; the map keeps the domain's COLD_AFTER_DAYS
const COLD_AGAIN_DAYS = 30;        // the same contact at most once in this many days
const COLD_META = ['app_meta', 'goldaColdContacts'];
const COLD_BUTTONS = ['לנסח הודעה', 'לא עכשיו'];
const COLD_WAIT_FOR_ANSWER_MS = 2 * 3600000;
const COLD_QUIET = (hour) => hour < 8 || hour >= 22;
const israelHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now));

const NETWORK_TOOL_DEFS = [
  {
    name: 'network_path',
    description: "The way in to a club through the agency's people (the relationship map): who to call first and the chain of people to the club, with the last date on each link and how warm it is. Up to three ways, each with a different first person. Links come only from the CRM: contacts at the club, requirements, deals (stage only, never money), past meetings, and explicit 'knows' links. Use for \"מה הדרך הכי קצרה ל…\", \"דרך מי מגיעים ל…\", \"מי מכיר מישהו ב…\". Several clubs fit the name → nothing is chosen, the candidates come back (ask which).",
    input_schema: {
      type: 'object',
      properties: {
        club: { type: 'string', description: 'The club, as the writer named it (Hebrew or English).' },
        n: { type: 'integer', description: 'How many ways, default 3, max 3.' },
      },
      required: ['club'],
      additionalProperties: false,
    },
  },
  {
    name: 'network_cold',
    description: `Contacts the agency has not spoken to for a long time: the last date and channel of each (a logged touch, a meeting, a requirement they gave, activity on a deal linked to them), oldest first; contacts with no date at all come apart as noRecord (not "cold": nothing was ever logged). Default: more than ${COLD_AFTER_DAYS} days. Use for "עם מי לא דיברתי הרבה זמן", "את מי כדאי להרים טלפון".`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: `Older than this many days; default ${COLD_AFTER_DAYS}.` },
        club: { type: 'string', description: 'Only contacts at this club.' },
        limit: { type: 'integer', description: `Max rows per list, default 15, max ${MAX_ROWS}.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'contact_link',
    description: "Add or remove an explicit link between two contacts: kind 'knows' (\"X מכיר את Y\", they know each other) or 'introduced' (\"X הכיר לנו את Y\": X introduced the agency to Y; contact is X, other is Y). Find each contact by contactId or by name; several fit → nothing is saved and the candidates come back (ask which); a name not in the contacts → nothing is saved (offer to add the contact). Never link two people because their names look alike. Audited; undo_last reverses it.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        contact: { type: 'string', description: 'X: name or contactId.' },
        other: { type: 'string', description: 'Y: name or contactId.' },
        kind: { type: 'string', enum: ['knows', 'introduced'], description: 'Default knows.' },
        note: { type: 'string', description: 'How they know each other, short, only if the writer said it.' },
      },
      required: ['action', 'contact', 'other'],
      additionalProperties: false,
    },
  },
];

/** The rules for the prompt, in one block. */
const networkSection = (role) => `- The relationship map (Contacts → map): "מה הדרך הכי קצרה ל<מועדון>" / "דרך מי מגיעים ל…" → network_path: say who to call first and the chain, each link with its date ("דיברתם לפני 10 ימים", "אין תיעוד"), and the link to the map. "עם מי לא דיברתי הרבה זמן" → network_cold: the oldest first with the last date and channel; the ones with no record are a separate short line, not "cold". Offer to log the call after it happens.${can(role, 'edit') ? '\n- "X מכיר את Y" / "X הכיר לנו את Y" → contact_link action=add (introduced when X introduced the agency to Y). Confirm in one line; undo_last reverses it. Never link people by a similar name: if a name is not in the contacts, ask or offer to add the contact first.' : ''}${can(role, 'manage_settings') ? `\n- Your own nudge that opens with "לא דיברתם מזמן" 📇 (a contact tied to an open deal or an open requirement, silent for ${GOLDA_COLD_DAYS} days): "לנסח הודעה" → the contact it names: find him in contacts, then the draft-only outreach flow (outreach_prepare, the draft, outreach_link); the player is the one of the deal it names, when it names one. You never send it yourself. "לא עכשיו" → fine, one line.` : ''}`;

const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

function networkTools({ db, identity = {}, role, update }) {
  const load = async () => {
    const get = (c) => db.collection(c).get().then(rows).catch(() => []);
    const [contacts, clubs, deals, requirements, meetings, players] = await Promise.all(
      ['contacts', 'clubs', 'deals', 'club_requirements', 'meetings', 'players'].map(get));
    // Only what the engine reads of a deal; its money never leaves Firestore here.
    const lean = deals.map(({ id, playerId, playerName, clubId, clubName, stage, requirementId, enteredStageAt, closedAt, history, createdAt, deletedAt }) =>
      ({ id, playerId, playerName, clubId, clubName, stage, requirementId, enteredStageAt, closedAt, history: (history || []).map((h) => ({ at: h && h.at })), createdAt, deletedAt }));
    return { contacts, net: buildNetwork({ contacts, clubs, deals: lean, requirements, meetings, players, now: new Date() }) };
  };

  const personOut = (n, net) => ({
    name: n.name, type: n.type,
    ...(n.role ? { role: n.role } : {}),
    ...(n.club && net.nodes.get(n.club) ? { club: net.nodes.get(n.club).name } : {}),
    ...(n.type === 'deal' ? { stage: n.stage } : {}),
    ...(n.type === 'contact' ? { contactId: n.ref } : {}),
  });

  const findClub = (net, q) => {
    const clubs = networkClubs(net);
    const key = clubKey(q);
    const exact = clubs.filter((c) => clubKey(c.name) === key);
    if (exact.length) return exact;
    return clubs.filter((c) => has(c.name, q));
  };

  function findContact(contacts, q) {
    const live = contacts.filter((c) => !c.deletedAt);
    const byId = live.find((c) => c.id === String(q).trim());
    if (byId) return [byId];
    const exact = live.filter((c) => norm(c.contactName) === norm(q));
    return exact.length ? exact : live.filter((c) => has(c.contactName, q));
  }
  const candidate = (c) => ({ contactId: c.id, name: c.contactName || '', club: c.clubName || '', role: c.contactRole || '' });

  return {
    network_path: async ({ club, n } = {}) => {
      if (!String(club || '').trim()) throw new Error('which club?');
      const { net } = await load();
      const found = findClub(net, club);
      if (!found.length) return { found: false, note: `No club named "${club}" in the CRM (contacts, requirements, deals, clubs). Say so; offer to add a contact there.` };
      if (found.length > 1) return { found: false, candidates: found.slice(0, 10).map((c) => ({ club: c.name, contacts: c.contacts })), note: 'Several clubs fit; ask which.' };
      const target = found[0];
      const paths = wayToClub(net, target.id, Math.min(3, Math.max(1, Number(n) || 3)));
      const today = israelDate(new Date());
      const ways = paths.map((p) => ({
        cost: p.cost,
        firstCall: personOut(p.steps[1].node, net),
        chain: p.steps.slice(1).map((st) => ({
          ...personOut(st.node, net),
          link: (st.link.kinds || []).map((k) => NET_LINK_LABELS[k].he).join(' + '),
          lastDate: st.link.date || '',
          warmth: warmthOf(st.link.date, today),
        })),
        line: p.steps.map((st, i) => (i === 0 ? 'הסוכנות' : `${st.node.name}${st.link.date ? ` (${heDate(st.link.date)})` : ''}`)).join(' ← '),
      }));
      return {
        club: target.name, contactsAtClub: target.contacts, ways, link: mapLink(`club=${encodeURIComponent(target.id)}`),
        note: ways.length
          ? 'Answer with the first way: who to call first and why (the warmth and date of each link); mention the others in one line. A link with no date is "אין תיעוד". Never an amount of money.'
          : 'No way to this club in the CRM yet: nobody there and nobody who knows someone there. Say so and offer to add a contact or a "knows" link.',
      };
    },

    network_cold: async ({ days, club, limit } = {}) => {
      const d = Math.min(MAX_DAYS, Math.max(1, Number(days) || COLD_AFTER_DAYS));
      const max = Math.min(MAX_ROWS, Math.max(1, Number(limit) || 15));
      const { net } = await load();
      let { cold, noRecord, recent } = coldContacts(net, d);
      if (club) {
        const ids = new Set(findClub(net, club).map((c) => c.id));
        cold = cold.filter((r) => ids.has(r.node.club));
        noRecord = noRecord.filter((r) => ids.has(r.node.club));
      }
      const row = (r) => ({
        ...personOut(r.node, net), phone: r.node.phone || '',
        ...(r.last ? { lastDate: r.last.date, daysAgo: r.days, channel: r.last.channel, via: r.last.source, ...(r.last.note ? { about: r.last.note } : {}) } : {}),
        link: mapLink(`contact=${encodeURIComponent(r.node.ref)}`),
      });
      return {
        olderThanDays: d, coldCount: cold.length, noRecordCount: noRecord.length, spokenRecently: recent,
        cold: cold.slice(0, max).map(row), noRecord: noRecord.slice(0, max).map(row),
        note: 'List the cold ones oldest first with the last date and channel; the no-record ones apart in one short line ("אין תיעוד בכלל"). Offer to log a call.',
      };
    },

    contact_link: async ({ action, contact, other, kind = 'knows', note = '' } = {}) => {
      if (!can(role, 'edit')) throw new Error(`${identity.name || 'the writer'} is a ${role || 'viewer'} and may not edit contacts`);
      if (!['add', 'remove'].includes(action)) throw new Error('action is add or remove');
      if (!['knows', 'introduced'].includes(kind)) throw new Error('kind is knows or introduced');
      const { contacts } = await load();
      const xs = findContact(contacts, contact);
      const ys = findContact(contacts, other);
      if (!xs.length || !ys.length) return { saved: false, missing: [!xs.length && contact, !ys.length && other].filter(Boolean), note: 'Not in the contacts. Nothing saved; ask, or offer to add the contact first. Never link a similar name.' };
      if (xs.length > 1 || ys.length > 1) return { saved: false, candidates: { contact: xs.slice(0, 8).map(candidate), other: ys.slice(0, 8).map(candidate) }, note: 'Several contacts fit; ask which. Nothing saved.' };
      const [x, y] = [xs[0], ys[0]];
      if (x.id === y.id) throw new Error('a contact cannot be linked to himself');
      const mine = cleanKnows(x.knows, x.id);
      const theirs = cleanKnows(y.knows, y.id);
      if (action === 'add') {
        // One link per pair: kept on X; a link already kept on Y about X is replaced.
        const entry = { contactId: y.id, kind, note: String(note || '').trim(), at: new Date().toISOString(), by: identity.email || '' };
        const next = [...mine.filter((k) => k.contactId !== y.id), entry];
        await update({ collection: 'contacts', id: x.id, data: { knows: next } });
        if (theirs.some((k) => k.contactId === x.id)) await update({ collection: 'contacts', id: y.id, data: { knows: theirs.filter((k) => k.contactId !== x.id) } });
        return { saved: true, action, contact: candidate(x), other: candidate(y), kind, link: mapLink(`contact=${encodeURIComponent(x.id)}`), note: 'Confirm in one line. undo_last reverses it.' };
      }
      const hadMine = mine.some((k) => k.contactId === y.id);
      const hadTheirs = theirs.some((k) => k.contactId === x.id);
      if (!hadMine && !hadTheirs) return { saved: false, note: `There is no link between ${x.contactName} and ${y.contactName}. Nothing changed.` };
      if (hadMine) await update({ collection: 'contacts', id: x.id, data: { knows: mine.filter((k) => k.contactId !== y.id) } });
      if (hadTheirs) await update({ collection: 'contacts', id: y.id, data: { knows: theirs.filter((k) => k.contactId !== x.id) } });
      return { saved: true, action, contact: candidate(x), other: candidate(y), note: 'Confirm in one line. undo_last reverses it.' };
    },
  };
}

// ── Relationship memory: "you have not spoken with X for 60 days" ─────────────

const CHANNEL_HE = { call: 'שיחה', whatsapp: 'וואטסאפ', meeting: 'פגישה', email: 'מייל', requirement: 'דרישה שהעביר', deal: 'פעילות בעסקה' };
const ROLE_HE = { 'Sporting Director': 'מנהל מקצועי', 'Head Coach': 'מאמן ראשי', CEO: 'מנכ"ל', President: 'נשיא', Scout: 'סקאוט', Agent: 'סוכן', 'Technical Director': 'מנהל טכני' };
// Only what the engine reads of a deal; its money never leaves Firestore here.
const leanDeal = ({ id, playerId, playerName, clubId, clubName, stage, requirementId, enteredStageAt, closedAt, history, createdAt, deletedAt }) =>
  ({ id, playerId, playerName, clubId, clubName, stage, requirementId, enteredStageAt, closedAt, history: (history || []).map((h) => ({ at: h && h.at })), createdAt, deletedAt });

/**
 * coldCandidates({ contacts, clubs, deals, requirements, meetings, players }, now, days)
 * The contacts worth a nudge: last spoken to more than `days` ago (the same
 * engine as the map, with Golda's own number of days) AND tied to something
 * open: a deal or a requirement that is theirs, or one at their club.
 * Contacts with no date at all are left out: "60 days" cannot be said of them.
 * Best first: their own deal, their own requirement, a deal at their club, a
 * requirement at their club; then the longest silence. Pure.
 */
function coldCandidates({ contacts = [], clubs = [], deals = [], requirements = [], meetings = [], players = [] } = {}, now = new Date(), days = GOLDA_COLD_DAYS) {
  const lean = deals.map(leanDeal);
  const net = buildNetwork({ contacts, clubs, deals: lean, requirements, meetings, players, now });
  const openDeals = lean.filter((d) => !d.deletedAt && !d.closedAt && !isClosedStage(d.stage));
  const openReqs = requirements.filter((r) => !r.deletedAt && (r.status || 'open') === 'open' && !(r.validUntil && r.validUntil < net.today));
  // The club node of a requirement, found the way the engine finds it.
  const byKey = new Map();
  for (const c of clubs.filter((x) => !x.deletedAt)) for (const k of [String(c.key || ''), clubKey(c.name), ...(Array.isArray(c.aliases) ? c.aliases : []).map(clubKey)]) if (k && !byKey.has(k)) byKey.set(k, `k:${c.id}`);
  const clubNodeOf = (r) => (r.clubId && net.nodes.has(`k:${r.clubId}`) ? `k:${r.clubId}` : byKey.get(clubKey(r.clubName)) || (clubKey(r.clubName) ? `k:~${clubKey(r.clubName)}` : ''));
  const dealText = (d) => `עסקה פתוחה: ${[d.playerName, d.clubName].filter(Boolean).join(' ↔ ')} (${DEAL_STAGE_LABELS[d.stage] || d.stage})`;
  const reqText = (r) => `דרישה פתוחה של ${r.clubName}${r.requiredPosition ? `: ${r.requiredPosition}` : ''}`;

  const out = [];
  for (const row of coldContacts(net, days).cold) {
    const n = row.node;
    const refs = new Set((net.adj.get(n.id) || []).flatMap((l) => l.refs));
    const ownDeal = openDeals.find((d) => refs.has(`deal:${d.id}`));
    const ownReq = openReqs.find((r) => refs.has(`req:${r.id}`));
    const clubDeal = n.club ? openDeals.find((d) => (net.nodes.get(`d:${d.id}`) || {}).club === n.club) : null;
    const clubReq = n.club ? openReqs.find((r) => clubNodeOf(r) === n.club) : null;
    const tie = ownDeal ? { rank: 4, text: dealText(ownDeal) } : ownReq ? { rank: 3, text: reqText(ownReq) }
      : clubDeal ? { rank: 2, text: dealText(clubDeal) } : clubReq ? { rank: 1, text: reqText(clubReq) } : null;
    if (!tie) continue;
    out.push({ contactId: n.ref, name: n.name, role: n.role || '', club: n.club && net.nodes.get(n.club) ? net.nodes.get(n.club).name : '',
      days: row.days, lastDate: row.last.date, channel: row.last.channel, tieRank: tie.rank, tie: tie.text });
  }
  return out.sort((a, b) => b.tieRank - a.tieRank || b.days - a.days || a.name.localeCompare(b.name));
}

/** The nudge: who, how long, the last date, what is open with them, and the offer to draft. */
function buildColdNudge(first, c) {
  const who = [ROLE_HE[c.role] || '', c.club].filter(Boolean).join(', ');
  return {
    text: [
      '*לא דיברתם מזמן* 📇',
      `${first}, עם *${c.name}*${who ? ` (${who})` : ''} לא דיברתם כבר ${c.days} ימים. הפעם האחרונה: ${heDate(c.lastDate)}, ${CHANNEL_HE[c.channel] || 'קשר'}.`,
      `${c.tie}.`,
      'לנסח הודעה? אתה שולח אותה בעצמך.',
    ].join('\n'),
    buttons: [...COLD_BUTTONS],
  };
}

/**
 * coldNudge(db, owner, data, now, { hour, send, job, days }) → { sent: 1, contactId } | { skipped: why }
 * Called from the hourly owner chain. At most one nudge a day, the same
 * contact at most once in COLD_AGAIN_DAYS, never in the quiet hours and never
 * on top of a question of hers he has not answered. State in
 * app_meta/goldaColdContacts = { lastSentOn, nudged: { [contactId]: 'YYYY-MM-DD' } }.
 * `data` is what the hourly run already loaded (deals, requirements, meetings,
 * players); contacts and clubs are read here when it has none.
 */
async function coldNudge(db, owner, data = {}, now = new Date(), { hour, send = null, job = { note: () => {} }, days = GOLDA_COLD_DAYS } = {}) {
  if (COLD_QUIET(Number.isFinite(hour) ? hour : israelHour(now))) return { skipped: 'quiet hours' };
  const ref = db.collection(COLD_META[0]).doc(COLD_META[1]);
  const snap = await ref.get();
  const state = snap.exists ? (snap.data() || {}) : {};
  const today = israelDate(now);
  if (state.lastSentOn === today) return { skipped: 'one a day' };
  const read = (c) => db.collection(c).get().then(rows);
  const [contacts, clubs] = await Promise.all([data.contacts || read('contacts'), data.clubs || read('clubs')]);
  const nudged = Object.fromEntries(Object.entries(state.nudged || {}).filter(([, on]) => daysBetween(String(on), today) < COLD_AGAIN_DAYS));
  const pick = coldCandidates({ ...data, contacts, clubs }, now, days).find((c) => !nudged[c.contactId]);
  if (!pick) return { skipped: 'nobody to mention' };

  const { threadRef } = await chatOf(db, owner);
  const thread = await threadRef.get();
  const history = thread.exists && Array.isArray(thread.data().history) ? thread.data().history : [];
  const last = history[history.length - 1];
  if (last && now.getTime() - (Number(last.at) || 0) < COLD_WAIT_FOR_ANSWER_MS && awaitsAnswer(history)) return { skipped: 'waiting for an answer' };

  const first = String(owner.name || '').trim().split(/\s+/)[0] || 'לו';
  const msg = buildColdNudge(first, pick);
  // The count of days is of today: a nudge still waiting for WhatsApp's window a day later is dropped.
  const expiresAt = now.getTime() + 24 * 3600000;
  await nudge(db, owner, { body: msg.text, buttons: msg.buttons, kind: 'cold', remember: true, expiresAt, ref: { type: 'cold', id: pick.contactId } }, { now: now.getTime(), send, job });
  // The whole document is written (no merge), so contacts dropped above are really gone.
  await ref.set({ lastSentOn: today, nudged: { ...nudged, [pick.contactId]: today }, updatedAt: now.getTime() });
  job.note('cold-contact nudge → the owner');
  return { sent: 1, contactId: pick.contactId };
}

/**
 * A tap on the nudge. "לא עכשיו" is answered here with one line and no model
 * call (the contact is not mentioned again for COLD_AGAIN_DAYS either way).
 * "לנסח הודעה" goes to the conversation, which drafts through the outreach flow.
 */
async function onColdTap({ button }) {
  if (button !== 1) return { handled: false };
  return { handled: true, reply: 'בסדר, לא אזכיר את זה שוב בחודש הקרוב.' };
}
const registerTaps = () => taps.onTap('cold', onColdTap);
registerTaps();

module.exports = { networkTools, networkSection, NETWORK_TOOL_DEFS, coldNudge, coldCandidates, buildColdNudge, onColdTap, registerTaps, GOLDA_COLD_DAYS, COLD_AGAIN_DAYS, COLD_BUTTONS };
