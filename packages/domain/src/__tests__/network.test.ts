import { describe, it, expect } from 'vitest';
import {
  buildNetwork, wayToClub, coldContacts, networkClubs, linksOf, cleanKnows, phoneKey, coldness, warmthOf, netDate,
  AGENCY, COLD_AFTER_DAYS,
} from '../engines/network';
import { addDays } from '../engines/dates';
import { contactSchema } from '../schemas';

// 12:00 in Israel on 25 Nov 2026.
const NOW = new Date('2026-11-25T10:00:00Z');
const TODAY = '2026-11-25';
const ago = (n: number) => addDays(TODAY, -n);
const iso = (n: number) => `${ago(n)}T09:00:00Z`;
const COMMISSION = 123456;

const input = () => ({
  now: NOW,
  clubs: [
    { id: 'mh', name: 'Maccabi Haifa', key: 'maccabi haifa' },
    { id: 'rb', name: 'Real Betis', key: 'real betis', aliases: ['Betis Sevilla'] },
    { id: 'old', name: 'Gone FC', key: 'gone', deletedAt: 'x' },
  ],
  contacts: [
    // Avi: spoke ten days ago; he introduced the agency to Benny.
    { id: 'a', contactName: 'Avi', clubName: 'Hapoel Ashdod', contactPhone: '050-1111111',
      touches: [{ id: 't1', at: iso(10), channel: 'call', by: 'lou' }, { id: 't0', at: iso(40), channel: 'whatsapp' }],
      knows: [{ contactId: 'b', kind: 'introduced', at: iso(20) }] },
    // Benny works at Betis (by alias), never spoken to directly.
    { id: 'b', contactName: 'Benny Levi', clubName: 'Betis Sevilla', contactPhone: '+972 52 2222222' },
    // Carmel at Maccabi Haifa: last touch 200 days ago, on a deal with Porto.
    { id: 'c', contactName: 'Carmel', clubId: 'mh', clubName: 'מכבי חיפה', contactPhone: '0533333333',
      touches: [{ id: 't2', at: iso(200), channel: 'whatsapp', dealId: 'd1' }] },
    // Dor: no club, only in a meeting 30 days ago.
    { id: 'd', contactName: 'Dor', contactPhone: '' },
    // Hila: nothing at all.
    { id: 'h', contactName: 'Hila', clubName: 'FC Porto' },
    // Two contacts share a phone: a requirement with that phone links neither.
    { id: 'e', contactName: 'Eli', contactPhone: '054-4444444' },
    { id: 'f', contactName: 'Fadi', contactPhone: '+972544444444' },
    // Gal gave a requirement 60 days ago (found by his phone).
    { id: 'g', contactName: 'Gal', clubName: 'Hapoel Beer Sheva', contactPhone: '0555555555' },
    // Deleted contacts are not on the map.
    { id: 'z', contactName: 'Deleted', deletedAt: { seconds: 1 } },
    // A touch with a garbage date and a touch list that is not a list are ignored.
    { id: 'w', contactName: 'Weird', touches: [{ at: 'not a date' }, null, 'x'] },
    { id: 'w2', contactName: 'Weird 2', touches: 'nope', knows: [{ contactId: 'w2' }, { contactId: '' }, { contactId: 'a', kind: 'bogus' }, { contactId: 'a' }] },
  ],
  requirements: [
    { id: 'r1', clubName: 'Hapoel Beer Sheva', contactName: 'Gal', contactPhone: '+972-55-555-5555', createdAt: { seconds: Date.parse(`${ago(60)}T08:00:00Z`) / 1000 } },
    { id: 'r2', clubName: 'Maccabi Haifa', contactName: 'Eli', contactPhone: '0544444444', createdAt: iso(5) },
    // A similar name with no matching phone is never linked to Benny Levi.
    { id: 'r3', clubName: 'Real Betis', contactName: 'Beni Levy', contactPhone: '0529999999', createdAt: iso(3) },
  ],
  deals: [
    { id: 'd1', playerId: 'p1', playerName: 'Noam', clubName: 'FC Porto', stage: 'Negotiation', enteredStageAt: ago(15),
      history: [{ stage: 'Initial Talks', at: iso(50) }], transferFee: String(COMMISSION), commission: String(COMMISSION),
      payments: [{ id: 'x', amount: COMMISSION, currency: 'EUR' }] },
    { id: 'd2', playerId: 'p2', playerName: 'Tal', clubName: 'Hapoel Beer Sheva', stage: 'Offered to Club', requirementId: 'r1', enteredStageAt: ago(8) },
  ],
  meetings: [
    { id: 'm1', title: 'Lunch', date: ago(30), linkedContacts: ['d', 'c'], linkedPlayers: ['p1'] },
    { id: 'm2', title: 'Next week', date: addDays(TODAY, 7), linkedContacts: ['h'] },
  ],
  players: [
    { id: 'p1', fullName: 'Noam', stage: 'represented', currentClub: 'FC Porto' },
    { id: 'p2', playerName: 'Tal', stage: 'tracking', currentClub: 'Somewhere' },
    { id: 'p3', fullName: 'Not linked', stage: 'tracking' },
  ],
});

describe('network engine: the links come from records only', () => {
  const net = buildNetwork(input());
  const pair = (x: string, y: string) => net.links.find((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));

  it('contacts work at the club named on them: by id, by key and by alias, unknown names as their own club', () => {
    expect(pair('c:c', 'k:mh')?.kinds).toContain('works_at');
    expect(pair('c:b', 'k:rb')?.kinds).toContain('works_at');
    expect(net.nodes.get('k:~hapoel ashdod')?.name).toBe('Hapoel Ashdod');
    expect(pair('c:a', 'k:~hapoel ashdod')?.kinds).toEqual(['works_at']);
    expect(net.nodes.has('k:old')).toBe(false);
    expect(net.nodes.has('c:z')).toBe(false);
    expect(pair('c:d', AGENCY)?.kinds).toEqual(['talked']);
  });

  it('a requirement links its contact by a unique phone, never by a similar name or a shared phone', () => {
    expect(pair('c:g', 'k:~hapoel beer sheva')?.kinds.sort()).toEqual(['requirement', 'works_at']);
    expect(net.links.some((l) => l.refs.includes('req:r2'))).toBe(false);
    expect(net.links.some((l) => l.refs.includes('req:r3'))).toBe(false);
  });

  it('deals tie a contact through a touch or through his requirement; the deal links its club and player', () => {
    expect(pair('c:c', 'd:d1')?.kinds).toEqual(['deal']);
    expect(pair('c:g', 'd:d2')?.kinds).toEqual(['deal']);
    expect(pair('d:d1', 'k:~porto')?.kinds).toEqual(['deal']);
    expect(pair('d:d1', 'p:p1')).toBeTruthy();
    expect(pair('p:p1', 'k:~porto')?.kinds).toEqual(['plays_at']);
    expect(pair(AGENCY, 'p:p1')?.kinds).toEqual(['represents']);
    expect(pair(AGENCY, 'p:p2')).toBeUndefined();
    expect(net.nodes.has('p:p3')).toBe(false);
  });

  it('a past meeting links everyone in it; a future one links no one', () => {
    expect(pair('c:d', 'c:c')?.kinds).toEqual(['meeting']);
    expect(pair('c:d', 'p:p1')?.date).toBe(ago(30));
    expect(net.links.some((l) => l.refs.includes('meet:m2'))).toBe(false);
  });

  it('explicit links are read both ways, cleaned, and never to oneself', () => {
    expect(pair('c:a', 'c:b')?.kinds).toEqual(['introduced']);
    expect(pair('c:w2', 'c:a')?.kinds).toEqual(['knows']);
    expect(cleanKnows([{ contactId: 'a' }, { contactId: 'a', kind: 'introduced' }, { contactId: 'me' }, 7], 'me'))
      .toEqual([{ contactId: 'a', kind: 'knows', note: '', at: '', by: '' }]);
    expect(contactSchema.parse({ contactName: 'X', knows: [{ contactId: 'y' }] }).knows[0].kind).toBe('knows');
    expect(() => contactSchema.parse({ contactName: 'X', knows: [{ contactId: 'y', kind: 'cousin' }] })).toThrow();
  });

  it('never carries money from a deal', () => {
    const dump = JSON.stringify({ nodes: [...net.nodes.values()], links: net.links });
    expect(dump).not.toContain(String(COMMISSION));
    expect(net.nodes.get('d:d1')).toEqual({ id: 'd:d1', type: 'deal', name: 'Noam ↔ FC Porto', ref: 'd1', club: 'k:~porto', stage: 'Negotiation' });
  });
});

describe('the way to a club', () => {
  const net = buildNetwork(input());

  it('prefers a warm introduction over a cold call: agency → Avi → Benny → Betis', () => {
    const [best, ...rest] = wayToClub(net, 'k:rb');
    expect(best.steps.map((x) => x.node.id)).toEqual([AGENCY, 'c:a', 'c:b', 'k:rb']);
    // talked 10 days ago (1), introduced 20 days ago (0.75), works at (0.25).
    expect(best.cost).toBe(2);
    expect(best.steps[1].link?.date).toBe(ago(10));
    expect(best.steps[1].warmth).toBe('warm');
    expect(best.steps[2].link?.kinds).toEqual(['introduced']);
    // The next way starts with someone else: a cold call to Benny himself.
    expect(rest.map((p) => p.steps.map((x) => x.node.id))).toEqual([[AGENCY, 'c:b', 'k:rb']]);
    expect(rest[0].steps[1].warmth).toBe('none');
  });

  it('crosses a deal or a meeting when that is the cheapest door', () => {
    const [best] = wayToClub(net, 'k:~porto', 1);
    // Noam (represented) is in a live deal with Porto: through the deal (1 + 0.25 + 0.25)
    // beats Noam's own club link (1 + 1.5) and a cold call to Hila who works there.
    expect(best.steps.map((x) => x.node.id)).toEqual([AGENCY, 'p:p1', 'd:d1', 'k:~porto']);
    expect(best.cost).toBe(1.5);
    const noDeal = wayToClub(buildNetwork({ ...input(), deals: [] }), 'k:~porto');
    expect(noDeal.map((p) => p.steps.map((x) => x.node.id))).toEqual([[AGENCY, 'p:p1', 'k:~porto'], [AGENCY, 'c:h', 'k:~porto']]);
    const withoutNoam = wayToClub(buildNetwork({ ...input(), players: [] }), 'k:~porto', 1)[0];
    expect(withoutNoam.steps.map((x) => x.node.type)).toEqual(['agency', 'contact', 'deal', 'club']);
    expect(withoutNoam.steps[1].node.id).toBe('c:c');
  });

  it('a club nobody links to has no way, and an unknown id gives nothing', () => {
    const lone = buildNetwork({ now: NOW, clubs: [{ id: 'x', name: 'Lone', key: 'lone' }] });
    expect(wayToClub(lone, 'k:x')).toEqual([]);
    expect(wayToClub(net, 'k:nope')).toEqual([]);
    expect(wayToClub(net, 'c:a')).toEqual([]);
  });

  it('lists clubs with how many contacts work there', () => {
    const clubs = networkClubs(net);
    expect(clubs.find((c) => c.id === 'k:rb')?.contacts).toBe(1);
    expect(clubs.map((c) => c.name)).toContain('Hapoel Ashdod');
  });
});

describe('not spoken to for a long time', () => {
  const net = buildNetwork(input());

  it('last date per contact from touches, meetings, requirements and deal activity', () => {
    expect(net.last.get('c:a')).toMatchObject({ date: ago(10), channel: 'call', source: 'touch', by: 'lou' });
    // Carmel: a meeting 30 days ago is later than his touch and the Porto deal (15 days ago is later still).
    expect(net.last.get('c:c')).toMatchObject({ date: ago(15), source: 'deal', ref: 'd1' });
    expect(net.last.get('c:d')).toMatchObject({ date: ago(30), channel: 'meeting', ref: 'm1' });
    // Gal: the deal on his requirement moved 8 days ago.
    expect(net.last.get('c:g')).toMatchObject({ date: ago(8), source: 'deal', ref: 'd2' });
    expect(net.last.get('c:b')).toBeNull();
    expect(net.last.get('c:h')).toBeNull();
  });

  it('cold oldest first; no date at all is its own list, not cold', () => {
    const r = coldContacts(net, 20);
    expect(r.cold.map((x) => [x.node.ref, x.days])).toEqual([['d', 30]]);
    expect(r.noRecord.map((x) => x.node.name)).toEqual(['Benny Levi', 'Eli', 'Fadi', 'Hila', 'Weird', 'Weird 2']);
    expect(r.recent).toBe(3);
    const def = coldContacts(net);
    expect(def.cold).toEqual([]);
    expect(COLD_AFTER_DAYS).toBe(90);
  });

  it('a contact last touched 200 days ago and nothing since is cold, with the channel', () => {
    const only = buildNetwork({ now: NOW, contacts: [{ id: 'c', contactName: 'Carmel', touches: [{ id: 't', at: iso(200), channel: 'whatsapp' }] }] });
    const r = coldContacts(only);
    expect(r.cold[0]).toMatchObject({ days: 200, last: { channel: 'whatsapp', date: ago(200) } });
    expect(linksOf(only, 'c:c')[0].warmth).toBe('cool');
  });
});

describe('helpers', () => {
  it('phones, dates, cold and warm', () => {
    expect(phoneKey('+972 50-123-4567')).toBe('0501234567');
    expect(phoneKey('00972501234567')).toBe('0501234567');
    expect(phoneKey('123')).toBe('');
    expect(netDate({ seconds: Date.parse('2026-01-02T12:00:00Z') / 1000 })).toBe('2026-01-02');
    expect(netDate({ toDate: () => new Date('2026-03-04T12:00:00Z') })).toBe('2026-03-04');
    expect(netDate({})).toBe('');
    expect(netDate('garbage')).toBe('');
    expect([null, 0, 31, 91, 181, 400].map(coldness)).toEqual([3, 0, 0.5, 1, 2, 3]);
    expect(warmthOf('', TODAY)).toBe('none');
    expect(warmthOf(ago(400), TODAY)).toBe('cold');
  });
});
