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
// Reading follows the Contacts page: every role reads; writing needs edit.
// Deals are named by their player, club and stage, never by an amount.
const { can, buildNetwork, wayToClub, coldContacts, networkClubs, cleanKnows, clubKey, warmthOf, israelDate, NET_LINK_LABELS, COLD_AFTER_DAYS } = require('@goldas/domain');

const APP = 'https://goldas-crm.netlify.app';
const MAX_ROWS = 40;
const MAX_DAYS = 3650;
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const has = (hay, q) => { const words = norm(q).split(' ').filter(Boolean); const h = norm(hay); return words.length > 0 && words.every((w) => h.includes(w)); };
const mapLink = (q) => `${APP}/contacts?view=map&${q}`;
const heDate = (d) => (d ? d.split('-').reverse().join('.') : '');

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
const networkSection = (role) => `- The relationship map (Contacts → map): "מה הדרך הכי קצרה ל<מועדון>" / "דרך מי מגיעים ל…" → network_path: say who to call first and the chain, each link with its date ("דיברתם לפני 10 ימים", "אין תיעוד"), and the link to the map. "עם מי לא דיברתי הרבה זמן" → network_cold: the oldest first with the last date and channel; the ones with no record are a separate short line, not "cold". Offer to log the call after it happens.${can(role, 'edit') ? '\n- "X מכיר את Y" / "X הכיר לנו את Y" → contact_link action=add (introduced when X introduced the agency to Y). Confirm in one line; undo_last reverses it. Never link people by a similar name: if a name is not in the contacts, ask or offer to add the contact first.' : ''}`;

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

module.exports = { networkTools, networkSection, NETWORK_TOOL_DEFS };
