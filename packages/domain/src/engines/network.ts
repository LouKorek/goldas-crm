// The relationship map: who the agency knows, who knows whom, and the way in
// to a club. One graph built from records the CRM already holds; nothing is
// guessed from a similar name.
//
// Nodes: the agency, contacts, clubs, deals and players.
// Links, and the fields they come from:
//   talked       agency – contact   the contact's last date (below)
//   works_at     contact – club     contact.clubId, else the club whose key or alias
//                                   has the same clubKey() as contact.clubName (the
//                                   app's own club identity); unknown names become a
//                                   club of their own, never merged by similarity
//   knows        contact – contact  contact.knows[] (Lou said "X knows Y")
//   introduced   contact – contact  contact.knows[] with kind 'introduced' (X introduced
//                                   the agency to Y)
//   meeting      person – person    contacts (meeting.linkedContacts) and players
//                                   (meeting.linkedPlayers) in the same past meeting
//   requirement  contact – club     club_requirements: contactId, else the contact
//                                   whose phone equals the requirement's contactPhone
//                                   (only when exactly one contact has that phone)
//   deal         contact – deal     a touch on the contact naming the deal (dealId),
//                                   or the deal answers a requirement of the contact
//                deal – club, deal – player   the deal itself
//   represents   agency – player    a represented player
//   plays_at     player – club      player.currentClubId / currentClub
//
// A contact's last date is the latest of: a touch (contact.touches[].at), a
// past meeting he was in, a requirement he gave (its creation), and activity
// on a deal linked to him (stage history, entered stage, closed). Money on a
// deal is never read here.
//
// The way to a club is the cheapest path from the agency. Each link costs a
// base plus how cold it is:
//   cold(days): ≤30 → 0, ≤90 → 0.5, ≤180 → 1, ≤365 → 2, older or no date → 3
//   talked 1 + cold; meeting 1 + cold; knows 1 + cold/2; introduced 0.75 + cold/2
//     (a link Lou vouched for ages more slowly than a conversation);
//   requirement and contact–deal 0.5 + cold; represents 1;
//   works_at, deal–club, deal–player 0.25 (facts, not conversations);
//   plays_at 1.5 (a player is a weaker door than the club's own staff).
// So one call last week to a man who knows the club's director beats a cold
// call to the director himself: 1 + 1 + 0.25 against 1 + 3 + 0.25.
import { toDateStr, daysBetween, israelDate } from './dates.js';
import { clubKey } from '../clubs.js';

export type NetNodeType = 'agency' | 'contact' | 'club' | 'deal' | 'player';
export type NetLinkKind = 'talked' | 'works_at' | 'knows' | 'introduced' | 'meeting' | 'requirement' | 'deal' | 'represents' | 'plays_at';
export type Warmth = 'warm' | 'cool' | 'cold' | 'none';

export interface NetNode {
  id: string;
  type: NetNodeType;
  name: string;
  /** The record id in its own collection ('' for the agency and clubs known only by name). */
  ref: string;
  /** Contacts and players: the club node they belong to on the map; deals: their club. */
  club?: string;
  role?: string;
  phone?: string;
  stage?: string;
}

export interface NetLink {
  a: string;
  b: string;
  kinds: NetLinkKind[];
  /** The latest date on the link, 'YYYY-MM-DD' or ''. */
  date: string;
  cost: number;
  /** Which records made the link: meeting ids, deal ids, requirement ids. */
  refs: string[];
}

export interface LastContact {
  date: string;
  /** 'touch' channels as written ('call', 'whatsapp'…), or 'meeting', 'requirement', 'deal'. */
  channel: string;
  source: 'touch' | 'meeting' | 'requirement' | 'deal';
  ref: string;
  note?: string;
  by?: string;
}

export interface Network {
  today: string;
  nodes: Map<string, NetNode>;
  links: NetLink[];
  adj: Map<string, NetLink[]>;
  last: Map<string, LastContact | null>;
}

export const KNOWS_KINDS = ['knows', 'introduced'] as const;
export type KnowsKind = typeof KNOWS_KINDS[number];
export interface KnowsLink { contactId: string; kind: KnowsKind; note: string; at: string; by: string }

export const AGENCY = 'agency';
const ID = { contact: (id: string) => `c:${id}`, club: (id: string) => `k:${id}`, clubByName: (key: string) => `k:~${key}`, deal: (id: string) => `d:${id}`, player: (id: string) => `p:${id}` };

type Rec = Record<string, unknown> & { id?: string };
export interface NetworkInput {
  contacts?: Rec[];
  clubs?: Rec[];
  deals?: Rec[];
  requirements?: Rec[];
  meetings?: Rec[];
  players?: Rec[];
  now?: Date;
}

const MS_PER_SECOND = 1000;
const EPSILON = 1e-9;
const CENTS = 100;
/** A phone needs at least this many digits to identify one person. */
const MIN_PHONE_DIGITS = 9;
const ISRAEL_CC = '972';
const INTL_PREFIX = '00';
/** Days → how cold, read top-down; past the last row (or no date) it is MAX_COLD. */
const COLD_STEPS: ReadonlyArray<{ upTo: number; cold: number }> = [
  { upTo: 30, cold: 0 }, { upTo: 90, cold: 0.5 }, { upTo: 180, cold: 1 }, { upTo: 365, cold: 2 },
];
const MAX_COLD = 3;
/** Warmth words: warm within WARM_DAYS, cool within COOL_DAYS, cold after. */
export const WARM_DAYS = 90;
const COOL_DAYS = 365;
/** Default for "not spoken to for a long time". */
export const COLD_AFTER_DAYS = 90;
const DEFAULT_PATHS = 3;
/** Base costs per link kind (see the table at the top). */
const BASE = { talked: 1, meeting: 1, knows: 1, introduced: 0.75, requirement: 0.5, deal: 0.5, represents: 1, works_at: 0.25, plays_at: 1.5 } as const;
/** An explicit link Lou vouched for ages at this fraction of the speed of a conversation. */
const VOUCHED_AGING = 0.5;

const s = (v: unknown) => (v == null ? '' : String(v)).trim();
const live = (r: Rec | null | undefined): r is Rec => !!r && !!r.id && !r.deletedAt;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A date-like value (ISO, 'YYYY-MM-DD', Firestore Timestamp, {seconds}) as 'YYYY-MM-DD', or ''. */
export const netDate = (v: unknown): string => {
  if (v && typeof v === 'object' && !(v instanceof Date) && typeof (v as { toDate?: unknown }).toDate !== 'function') {
    const secs = (v as { seconds?: unknown; _seconds?: unknown }).seconds ?? (v as { _seconds?: unknown })._seconds;
    if (typeof secs === 'number') return toDateStr(new Date(secs * MS_PER_SECOND)) || '';
    return '';
  }
  return toDateStr(v) || '';
};

const later = (a: string, b: string) => (a > b ? a : b);

/** Phone as an identity: digits, Israeli +972 folded to 0. '' when too short to identify anyone. */
export const phoneKey = (v: unknown): string => {
  // Keeps digits only: "+972-50 123" → "97250123"; "abc" → "".
  let d = s(v).replace(/\D/g, '');
  if (d.startsWith(INTL_PREFIX)) d = d.slice(INTL_PREFIX.length);
  if (d.startsWith(ISRAEL_CC)) d = `0${d.slice(ISRAEL_CC.length)}`;
  return d.length >= MIN_PHONE_DIGITS ? d : '';
};

/** How cold a link of this age is (see the table at the top). */
export const coldness = (days: number | null): number =>
  (days == null ? MAX_COLD : (COLD_STEPS.find((x) => days <= x.upTo) || { cold: MAX_COLD }).cold);

/** Warm within 90 days, cool within a year, cold after that, none without a date. */
export const warmthOf = (date: string, today: string): Warmth => {
  if (!date) return 'none';
  const d = daysBetween(date, today);
  if (d <= WARM_DAYS) return 'warm';
  return d <= COOL_DAYS ? 'cool' : 'cold';
};

const COST: Record<NetLinkKind, (cold: number) => number> = {
  talked: (c) => BASE.talked + c,
  meeting: (c) => BASE.meeting + c,
  knows: (c) => BASE.knows + c * VOUCHED_AGING,
  introduced: (c) => BASE.introduced + c * VOUCHED_AGING,
  requirement: (c) => BASE.requirement + c,
  deal: (c) => BASE.deal + c,
  represents: () => BASE.represents,
  works_at: () => BASE.works_at,
  plays_at: () => BASE.plays_at,
};
// Links whose cost does not depend on a date.
const FACT: ReadonlySet<NetLinkKind> = new Set(['works_at', 'represents', 'plays_at']);

/** The explicit "knows" links of a contact, cleaned: known kinds, no self links, one per other contact. */
export const cleanKnows = (list: unknown, selfId = ''): KnowsLink[] => {
  const out: KnowsLink[] = [];
  for (const x of arr(list)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Rec;
    const contactId = s(r.contactId);
    if (!contactId || contactId === selfId || out.some((o) => o.contactId === contactId)) continue;
    const kind = (KNOWS_KINDS as readonly string[]).includes(s(r.kind)) ? (s(r.kind) as KnowsKind) : 'knows';
    out.push({ contactId, kind, note: s(r.note), at: s(r.at), by: s(r.by) });
  }
  return out;
};

/** Touches on a contact, read defensively (another feature writes them): { at, channel, dealId, note, by }. */
const touchesOf = (c: Rec) => arr(c.touches)
  .filter((t): t is Rec => !!t && typeof t === 'object')
  .map((t) => ({ id: s(t.id), date: netDate(t.at), channel: s(t.channel), dealId: s(t.dealId), note: s(t.note), by: s(t.by) }))
  .filter((t) => t.date);

/** The latest activity on a deal: its stage history, the stage it entered, its closing. Never its money. */
const dealActivity = (d: Rec): string => {
  let best = later(netDate(d.enteredStageAt), netDate(d.closedAt));
  for (const h of arr(d.history)) if (h && typeof h === 'object') best = later(best, netDate((h as Rec).at));
  if (!best) best = netDate(d.createdAt);
  return best;
};

export function buildNetwork(input: NetworkInput): Network {
  const today = israelDate(input.now || new Date());
  const nodes = new Map<string, NetNode>();
  const pairs = new Map<string, NetLink>();
  const add = (n: NetNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id) as NetNode; };
  add({ id: AGENCY, type: 'agency', name: 'Gold A&S', ref: '' });

  /** `fact`: the link is a fact of the record (a deal's own club and player), not a conversation. */
  const link = (a: string, b: string, kind: NetLinkKind, date: string, ref = '', fact = false) => {
    if (!a || !b || a === b || !nodes.has(a) || !nodes.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const days = date ? Math.max(0, daysBetween(date, today)) : null;
    const cost = fact ? BASE.works_at : COST[kind](FACT.has(kind) ? 0 : coldness(days));
    const cur = pairs.get(key);
    if (!cur) { pairs.set(key, { a, b, kinds: [kind], date, cost, refs: ref ? [ref] : [] }); return; }
    if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
    cur.date = later(cur.date, date);
    cur.cost = Math.min(cur.cost, cost);
    if (ref && !cur.refs.includes(ref)) cur.refs.push(ref);
  };

  // Clubs: the records, and an index from every key and alias to the club.
  const clubByKey = new Map<string, string>();
  for (const c of (input.clubs || []).filter(live)) {
    const id = ID.club(c.id as string);
    add({ id, type: 'club', name: s(c.name) || s(c.key), ref: c.id as string });
    for (const k of [s(c.key), clubKey(c.name), ...arr(c.aliases).map(clubKey)]) if (k && !clubByKey.has(k)) clubByKey.set(k, id);
  }
  /** The club node for a record: by id when it names one, else by clubKey of the name. */
  const clubNode = (clubId: unknown, clubName: unknown): string => {
    const cid = s(clubId);
    if (cid && nodes.has(ID.club(cid))) return ID.club(cid);
    const key = clubKey(clubName);
    if (!key) return '';
    const known = clubByKey.get(key);
    if (known) return known;
    const id = ID.clubByName(key);
    add({ id, type: 'club', name: s(clubName), ref: '' });
    clubByKey.set(key, id);
    return id;
  };

  // Contacts and who works where.
  const contacts = (input.contacts || []).filter(live);
  const phoneOwners = new Map<string, string[]>();
  for (const c of contacts) {
    const id = ID.contact(c.id as string);
    const club = clubNode(c.clubId, c.clubName);
    add({ id, type: 'contact', name: s(c.contactName) || s(c.clubName), ref: c.id as string, club, role: s(c.contactRole), phone: s(c.contactPhone) });
    const pk = phoneKey(c.contactPhone);
    if (pk) phoneOwners.set(pk, [...(phoneOwners.get(pk) || []), id]);
    if (club) link(id, club, 'works_at', '');
  }
  const contactByPhone = (v: unknown): string => {
    const owners = phoneOwners.get(phoneKey(v)) || [];
    return owners.length === 1 ? owners[0] : '';
  };

  // Players that take part in a link: represented, in a deal, or in a meeting.
  const players = new Map<string, Rec>();
  for (const p of (input.players || []).filter(live)) players.set(p.id as string, p);
  const playerNode = (pid: unknown): string => {
    const p = players.get(s(pid));
    if (!p) return '';
    const id = ID.player(p.id as string);
    if (!nodes.has(id)) {
      const club = clubNode(p.currentClubId, p.currentClub);
      add({ id, type: 'player', name: s(p.fullName) || s(p.playerName) || s(p.name), ref: p.id as string, club, stage: s(p.stage) });
      if (club) link(id, club, 'plays_at', '');
    }
    return id;
  };
  for (const p of players.values()) if (s(p.stage) === 'represented') link(AGENCY, playerNode(p.id), 'represents', '');

  // Last dates per contact, collected as the links are made.
  const last = new Map<string, LastContact | null>();
  const seen = (cid: string, lc: LastContact) => {
    if (!lc.date || lc.date > today) return;
    const cur = last.get(cid);
    if (!cur || lc.date > cur.date) last.set(cid, lc);
  };

  // Requirements: a contact and a club meet in it.
  const reqContact = new Map<string, string>();
  for (const r of (input.requirements || []).filter(live)) {
    const cid = s(r.contactId) && nodes.has(ID.contact(s(r.contactId))) ? ID.contact(s(r.contactId)) : contactByPhone(r.contactPhone);
    if (!cid) continue;
    reqContact.set(r.id as string, cid);
    const date = netDate(r.createdAt) || netDate(r.date);
    const club = clubNode(r.clubId, r.clubName);
    if (club) link(cid, club, 'requirement', date, `req:${r.id}`);
    if (date) seen(cid, { date, channel: 'requirement', source: 'requirement', ref: r.id as string });
  }

  // Deals: the deal, its club and player; contacts tied by a touch or by their requirement.
  const dealContacts = new Map<string, Set<string>>();
  const tie = (dealId: string, cid: string) => dealContacts.set(dealId, new Set([...(dealContacts.get(dealId) || []), cid]));
  for (const c of contacts) for (const t of touchesOf(c)) if (t.dealId) tie(t.dealId, ID.contact(c.id as string));
  for (const d of (input.deals || []).filter(live)) {
    const id = ID.deal(d.id as string);
    const club = clubNode(d.clubId, d.clubName);
    add({ id, type: 'deal', name: [s(d.playerName), s(d.clubName)].filter(Boolean).join(' ↔ '), ref: d.id as string, club, stage: s(d.stage) });
    const date = dealActivity(d);
    if (club) link(id, club, 'deal', date, `deal:${d.id}`, true);
    const pn = playerNode(d.playerId);
    if (pn) link(id, pn, 'deal', date, `deal:${d.id}`, true);
    const viaReq = reqContact.get(s(d.requirementId));
    if (viaReq) tie(d.id as string, viaReq);
    for (const cid of dealContacts.get(d.id as string) || []) {
      link(cid, id, 'deal', date, `deal:${d.id}`);
      if (date) seen(cid, { date, channel: 'deal', source: 'deal', ref: d.id as string, note: s(d.stage) });
    }
  }

  // Meetings in the past: everyone in the room met everyone else.
  for (const m of (input.meetings || []).filter(live)) {
    const date = netDate(m.date);
    if (!date || date > today) continue;
    const people = [
      ...arr(m.linkedContacts).map((x) => ID.contact(s(x))).filter((x) => nodes.has(x)),
      ...arr(m.linkedPlayers).map(playerNode).filter(Boolean),
    ];
    for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) link(people[i], people[j], 'meeting', date, `meet:${m.id}`);
    for (const p of people) if (p.startsWith('c:')) seen(p, { date, channel: 'meeting', source: 'meeting', ref: m.id as string, note: s(m.title) });
  }

  // Touches and the explicit links on each contact.
  for (const c of contacts) {
    const id = ID.contact(c.id as string);
    for (const t of touchesOf(c)) seen(id, { date: t.date, channel: t.channel || 'touch', source: 'touch', ref: t.id, note: t.note, by: t.by });
    for (const k of cleanKnows(c.knows, c.id as string)) link(id, ID.contact(k.contactId), k.kind, netDate(k.at));
  }

  // The agency talked to each contact; the link is as warm as the last date.
  for (const c of contacts) {
    const id = ID.contact(c.id as string);
    if (!last.has(id)) last.set(id, null);
    link(AGENCY, id, 'talked', (last.get(id) || { date: '' }).date);
  }

  const links = [...pairs.values()];
  const adj = new Map<string, NetLink[]>();
  for (const l of links) for (const n of [l.a, l.b]) adj.set(n, [...(adj.get(n) || []), l]);
  return { today, nodes, links, adj, last };
}

export interface PathStep { node: NetNode; link: NetLink | null; warmth: Warmth }
export interface NetPath { cost: number; steps: PathStep[] }

const other = (l: NetLink, n: string) => (l.a === n ? l.b : l.a);

/** Cheapest path from the agency to `target`, never through a banned node. Ties: fewer steps. */
function cheapest(net: Network, target: string, banned: Set<string>): NetPath | null {
  const dist = new Map<string, { cost: number; hops: number; prev: string; via: NetLink | null }>();
  dist.set(AGENCY, { cost: 0, hops: 0, prev: '', via: null });
  const done = new Set<string>();
  for (;;) {
    let cur = '';
    let best: { cost: number; hops: number } | null = null;
    for (const [n, d] of dist) {
      if (done.has(n)) continue;
      if (!best || d.cost < best.cost - EPSILON || (Math.abs(d.cost - best.cost) < EPSILON && d.hops < best.hops)) { best = d; cur = n; }
    }
    if (!cur || !best) return null;
    if (cur === target) break;
    done.add(cur);
    // A club is a place, not a person: the path may cross one (colleagues) but never the agency again.
    for (const l of net.adj.get(cur) || []) {
      const nx = other(l, cur);
      if (done.has(nx) || banned.has(nx) || nx === AGENCY) continue;
      const cost = best.cost + l.cost;
      const hops = best.hops + 1;
      const d = dist.get(nx);
      if (!d || cost < d.cost - EPSILON || (Math.abs(cost - d.cost) < EPSILON && hops < d.hops)) dist.set(nx, { cost, hops, prev: cur, via: l });
    }
  }
  const steps: PathStep[] = [];
  for (let n = target; n; n = (dist.get(n) as { prev: string }).prev) {
    const d = dist.get(n) as { prev: string; via: NetLink | null };
    steps.unshift({ node: net.nodes.get(n) as NetNode, link: d.via, warmth: d.via ? warmthOf(d.via.date, net.today) : 'none' });
  }
  return { cost: Math.round((dist.get(target) as { cost: number }).cost * CENTS) / CENTS, steps };
}

/**
 * The way from the agency to a club: up to `max` paths, each starting with a
 * different first person to call, cheapest first.
 */
export function wayToClub(net: Network, clubNodeId: string, max = DEFAULT_PATHS): NetPath[] {
  if (!net.nodes.has(clubNodeId) || (net.nodes.get(clubNodeId) as NetNode).type !== 'club') return [];
  const out: NetPath[] = [];
  const banned = new Set<string>();
  while (out.length < max) {
    const p = cheapest(net, clubNodeId, banned);
    if (!p || p.steps.length <= 1) break;
    out.push(p);
    const first = p.steps[1].node.id;
    if (first === clubNodeId) break;
    banned.add(first);
  }
  return out;
}

/** The club nodes, by name, for a picker; each with how many contacts work there. */
export function networkClubs(net: Network): Array<{ id: string; name: string; contacts: number }> {
  const count = new Map<string, number>();
  for (const n of net.nodes.values()) if (n.type === 'contact' && n.club) count.set(n.club, (count.get(n.club) || 0) + 1);
  return [...net.nodes.values()].filter((n) => n.type === 'club')
    .map((n) => ({ id: n.id, name: n.name, contacts: count.get(n.id) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ColdRow { node: NetNode; last: LastContact | null; days: number | null }

/**
 * "Not spoken to for a long time": contacts whose last date is more than
 * `days` ago, oldest first; contacts with no date at all apart, as no record.
 */
export function coldContacts(net: Network, days = COLD_AFTER_DAYS): { cold: ColdRow[]; noRecord: ColdRow[]; recent: number } {
  const cold: ColdRow[] = [];
  const noRecord: ColdRow[] = [];
  let recent = 0;
  for (const n of net.nodes.values()) {
    if (n.type !== 'contact') continue;
    const lc = net.last.get(n.id) || null;
    if (!lc) { noRecord.push({ node: n, last: null, days: null }); continue; }
    const d = daysBetween(lc.date, net.today);
    if (d > days) cold.push({ node: n, last: lc, days: d }); else recent++;
  }
  cold.sort((a, b) => (b.days as number) - (a.days as number) || a.node.name.localeCompare(b.node.name));
  noRecord.sort((a, b) => a.node.name.localeCompare(b.node.name));
  return { cold, noRecord, recent };
}

/** The links of one node, warmest first, for a detail card. */
export function linksOf(net: Network, nodeId: string): Array<{ link: NetLink; node: NetNode; warmth: Warmth }> {
  return (net.adj.get(nodeId) || []).map((l) => ({ link: l, node: net.nodes.get(other(l, nodeId)) as NetNode, warmth: warmthOf(l.date, net.today) }))
    .sort((a, b) => (b.link.date || '').localeCompare(a.link.date || '') || a.link.cost - b.link.cost);
}

export const NET_LINK_LABELS: Record<NetLinkKind, { he: string; en: string }> = {
  talked: { he: 'דיברנו', en: 'Talked' },
  works_at: { he: 'עובד/ת ב', en: 'Works at' },
  knows: { he: 'מכירים', en: 'Know each other' },
  introduced: { he: 'הכיר/ה לנו', en: 'Introduced us' },
  meeting: { he: 'באותה פגישה', en: 'Same meeting' },
  requirement: { he: 'דרישה', en: 'Requirement' },
  deal: { he: 'עסקה', en: 'Deal' },
  represents: { he: 'מיוצג', en: 'Represented' },
  plays_at: { he: 'משחק ב', en: 'Plays at' },
};
