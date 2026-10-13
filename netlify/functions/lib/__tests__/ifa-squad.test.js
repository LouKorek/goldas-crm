// The IFA squad logic Lou's order of 13.10.2026 changed: a squad whose age
// group contradicts the player page is never picked, a club with the exact
// name outranks a club that shares the city, the import refuses to link a
// squad that cannot be the player's, and duplicate records of one squad are
// merged onto the copy that carries the IFA game id.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../../../apps/web/public/tools/ifa-text.js');
const { _internal } = require('../../ifa-import-background.js');
const { sameFixture } = require('../../sync-matches-background.js')._lib;

test('age groups are read from squad labels and cells', () => {
  assert.equal(T.ifaAgeGroupOf("נערים א' לאומית דרום"), 'nearim_a');
  assert.equal(T.ifaAgeGroupOf('נערים ג'), 'nearim_c');
  assert.equal(T.ifaAgeGroupOf('נער.ג דן'), 'nearim_c');
  assert.equal(T.ifaAgeGroupOf('נוער'), 'noar');
  assert.equal(T.ifaAgeGroupOf('טרום ילדים א'), 'trom_a');
  assert.equal(T.ifaAgeGroupOf("ליגת ילדים ב'"), 'yeladim_b');
  assert.equal(T.ifaAgeGroupOf('ליגה לאומית'), null);
});

test('the exact club name outranks a club that only shares the city', () => {
  const idx = [
    { clubId: '2', name: 'הפועל מועדון ספורט חבל מודיעין', sector: 'גברים' },
    { clubId: '1', name: 'עירוני מודיעין', sector: 'גברים' },
  ];
  assert.deepEqual(T.ifaRankClubs(idx, 'עירוני מודיעין', 'Men').map((c) => c.clubId), ['1', '2']);
});

test("a squad of another age group is never picked, however well the club matches", () => {
  const hevel = [{ teamId: '6522', ageGroup: 'נערים ג', league: "נערים ג' דן", teamName: "הפ' מ.ס חבל מודיעין" }];
  assert.equal(T.ifaPickTeam(hevel, "נערים א' לאומית דרום", 'עירוני מודיעין'), null);
  const ironi = [
    { teamId: '6135', ageGroup: 'נערים ג', league: "נערים ג' ארצית מרכז", teamName: 'עירוני מודיעין' },
    { teamId: '6249', ageGroup: 'נערים א', league: "נערים א' לאומית דרום", teamName: 'עירוני מודיעין "צו פיוס"' },
  ];
  assert.equal(T.ifaPickTeam(ironi, "נערים א' לאומית דרום", 'עירוני מודיעין').teamId, '6249');
});

test('the import refuses a squad that cannot be the player’s', () => {
  const now = new Date('2026-10-13T06:00:00Z');
  const eyal = { id: 'e', fullName: 'Eyal', dob: '2010-04-14', currentClub: "Ironi Modi'in" };
  const wrong = { teamId: '6522', ageGroup: 'נערים ג', league: "נערים ג' דן", teamName: "הפ' מ.ס חבל מודיעין", clubName: 'הפועל מועדון ספורט חבל מודיעין' };
  const mm = _internal.ifaMismatch(eyal, wrong, now);
  assert.equal(mm.reason, 'ifa-squad-mismatch'); assert.equal(mm.kind, 'age');
  assert.match(mm.detail, /נערים א/);
  const right = { teamId: '6249', ageGroup: 'נערים א', league: "נערים א' לאומית דרום", teamName: 'עירוני מודיעין "צו פיוס"', clubName: 'עירוני מודיעין' };
  assert.equal(_internal.ifaMismatch(eyal, right, now), null);
  // A youth player in a seniors squad is fine; an adult in a youth squad is not.
  assert.equal(_internal.ifaMismatch(eyal, { ageGroup: 'בוגרים', teamName: 'עירוני מודיעין' }, now), null);
  assert.equal(_internal.ifaMismatch({ ...eyal, dob: '2000-01-01' }, right, now).kind, 'age');
  // Hebrew club names are compared; a different club is a mismatch.
  const heb = { ...eyal, currentClub: 'עירוני מודיעין' };
  assert.equal(_internal.ifaMismatch(heb, right, now), null);
  assert.equal(_internal.ifaMismatch(heb, { ageGroup: 'נערים א', teamName: 'הפועל חדרה', clubName: 'הפועל חדרה' }, now).kind, 'club');
  // A manual age-group override for this season wins over the birth date.
  assert.equal(_internal.ifaMismatch({ ...eyal, ageGroupOverride: { id: 'nearim_c', season: 2026 } }, wrong, now), null);
  // Nothing to check → nothing flagged.
  assert.equal(_internal.ifaMismatch(eyal, null, now), null);
});

test('duplicates of one squad merge onto the copy with the IFA game id', () => {
  const rows = [
    { id: 'old', date: '2026-10-17', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי ניסנוב', sourceMatchId: '2026-10-17|הפועל חדרה|מכבי ניסנוב', time: '', linkedPlayers: ['a', 'b'], createdAt: '2026-09-01T00:00:00Z' },
    { id: 'new', date: '2026-10-17', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי ניסנוב "צו פיוס"', sourceMatchId: '1121999', time: '17:30', linkedPlayers: ['a'], createdAt: '2026-10-12T00:00:00Z' },
    { id: 'other', date: '2026-10-24', homeTeam: 'הפועל חדרה', awayTeam: 'X', sourceMatchId: '1', linkedPlayers: ['a'] },
    { id: 'past', date: '2026-09-01', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי ניסנוב', sourceMatchId: '2', linkedPlayers: ['a'] },
    { id: 'past2', date: '2026-09-01', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי ניסנוב', sourceMatchId: '3', linkedPlayers: ['a'] },
    { id: 'gone', date: '2026-10-17', homeTeam: 'הפועל חדרה', awayTeam: 'מכבי ניסנוב', sourceMatchId: '4', deletedAt: 'x', linkedPlayers: ['a'] },
  ];
  const groups = _internal.duplicateGroups(rows, '2026-10-13');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((m) => m.id).sort(), ['new', 'old']);
  assert.equal(_internal.pickKeeper(groups[0]).id, 'new');
  // Without a game id the copy with a time wins; otherwise the oldest.
  assert.equal(_internal.pickKeeper([{ id: 'x', sourceMatchId: 'd|h|a', time: '', createdAt: '2026-01-01' }, { id: 'y', sourceMatchId: 'd|h|a', time: '19:00', createdAt: '2026-02-01' }]).id, 'y');
  assert.equal(_internal.pickKeeper([{ id: 'x', sourceMatchId: 'd|h|a', createdAt: '2026-01-01' }, { id: 'y', sourceMatchId: 'd|h|a', createdAt: '2026-02-01' }]).id, 'x');
});

test('the "צו פיוס" tag never makes two clubs the same team', () => {
  // Real names from עירוני מודיעין's 2026/27 fixtures (team 6249); before the
  // fix these scored 0.5–0.67 and the sync overwrote nine matches with others.
  assert.equal(T.ifaContainment('א.ס נורדיה ירושלים "צו פיוס"', 'הפ\' מרמורק רחובות "צו פיוס"'), 0);
  assert.equal(T.ifaContainment('עירוני מודיעין "צו פיוס"', 'מכבי יבנה "צו פיוס"'), 0);
  assert.equal(T.ifaContainment('מכבי יבנה "צו פיוס"', 'מ.ס.דימונה "צו פיוס"'), 0);
  assert.equal(T.ifaContainment('עירוני מודיעין "צו פיוס"', 'עירוני מודיעין'), 1);
  assert.ok(T.ifaSameClubName('מכבי ניסנוב "צו פיוס"', 'מכבי ניסנוב'));
  const base = { sourceTeamId: 'u', season: '2026/27' };
  const nordia = { ...base, date: '2026-10-19', homeTeam: 'עירוני מודיעין "צו פיוס"', awayTeam: 'א.ס נורדיה ירושלים "צו פיוס"' };
  const marmorek = { ...base, date: '2026-10-31', homeTeam: 'הפ\' מרמורק רחובות "צו פיוס"', awayTeam: 'עירוני מודיעין "צו פיוס"' };
  const kfarShalem = { ...base, date: '2026-11-28', homeTeam: 'עירוני מודיעין "צו פיוס"', awayTeam: 'מכבי יפו קביליו "יצחק אסא"' };
  assert.equal(sameFixture(nordia, marmorek), false);
  assert.equal(sameFixture(nordia, kfarShalem), false);
  // The same match, first with the provisional id and then with the IFA game
  // id, resolves to the one record (the sync then rewrites sourceMatchId).
  const provisional = { ...nordia, sourceMatchId: '2026-10-19|עירוני מודיעין "צו פיוס"|א.ס נורדיה ירושלים "צו פיוס"' };
  const official = { ...nordia, sourceMatchId: '1130001', time: '20:45' };
  assert.equal(sameFixture(official, provisional), true);
});

test('the IFA\'s "00:00" is "no kickoff time yet"', () => {
  assert.equal(T.normalizeIfaTime('00:00'), '');
  assert.equal(T.normalizeIfaTime('20:45'), '20:45');
  assert.equal(T.normalizeIfaTime('12:00 AM'), '');
  assert.equal(T.normalizeIfaTime('8:30 PM'), '20:30');
});
