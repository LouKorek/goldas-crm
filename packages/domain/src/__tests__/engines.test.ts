import { describe, it, expect } from 'vitest';
import { israelDate, daysAway, nextBirthday, addDays, weekday } from '../engines/dates';
import { computeAlerts } from '../engines/alerts';
import { scoreRequirement, topMatches } from '../engines/matching';
import { canTransition, applyTransition, daysInStage, isStale, funnel } from '../engines/deals';
import { occurrences, expandTrainings, cancelOccurrence, moveOccurrence, describeRule } from '../engines/recurrence';

// 2026-10-12 23:30 UTC is already 2026-10-13 02:30 in Israel.
const lateUtc = new Date('2026-10-12T23:30:00Z');
const noon = new Date('2026-10-12T09:00:00Z'); // 12:00 Israel

describe('dates in Israel time', () => {
  it('rolls the day over on the Israeli clock, not UTC', () => {
    expect(israelDate(noon)).toBe('2026-10-12');
    expect(israelDate(lateUtc)).toBe('2026-10-13');
    expect(daysAway('2026-10-13', lateUtc)).toBe(0);
    expect(daysAway('2026-10-13', noon)).toBe(1);
  });
  it('counts birthdays and ages', () => {
    expect(nextBirthday('2008-10-12', noon)).toEqual({ days: 0, age: 18 });
    expect(nextBirthday('2008-10-11', noon)).toEqual({ days: 364, age: 19 });
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(weekday('2026-10-12')).toBe(1); // Monday
  });
});

describe('alerts engine', () => {
  const players = [
    { id: 'a', fullName: 'Avi', contractEnd: '2026-10-20', contractStatus: 'Under Contract', currentClub: 'Hapoel' },
    { id: 'b', fullName: 'Ben', contractEnd: '2026-10-20', contractStatus: 'Free' },
    { id: 'c', fullName: 'Chen', passportExpiry: '2026-09-01', dob: '2008-10-12' },
    { id: 'd', fullName: 'Deleted', contractEnd: '2026-10-13', deletedAt: 'x' },
  ];
  it('finds contract, passport and 18th birthday alerts', () => {
    const r = computeAlerts({ players, now: noon });
    expect(r.byType.contract.map((a) => a.subject.id)).toEqual(['a']);
    expect(r.byType.contract[0].days).toBe(8);
    expect(r.byType.contract[0].proof.he).toContain('Hapoel');
    expect(r.byType.passport[0].overdue).toBe(true);
    expect(r.byType.birthday[0].age).toBe(18);
    expect(r.byType.birthday[0].severity).toBe('gold');
    expect(r.total).toBe(3);
  });
  it('respects thresholds and switches a type off with an empty list', () => {
    const r = computeAlerts({ players, now: noon, settings: { contractDays: [], passportDays: [30] } });
    expect(r.byType.contract).toHaveLength(0);
    expect(r.byType.passport).toHaveLength(1); // overdue always shows while the type is on
  });
  it('flags stale deals, expired requirements, overdue tasks and failed jobs', () => {
    const r = computeAlerts({
      now: noon,
      deals: [
        { id: 'd1', playerName: 'P', clubName: 'C', stage: 'Waiting Response', enteredStageAt: '2026-09-20T10:00:00Z' },
        { id: 'd2', playerName: 'P', clubName: 'C', stage: 'Waiting Response', enteredStageAt: '2026-10-10T10:00:00Z' },
        { id: 'd3', playerName: 'P', clubName: 'C', stage: 'Negotiation', enteredStageAt: '2026-08-01T10:00:00Z', closedAt: '2026-09-01' },
      ],
      requirements: [{ id: 'r1', clubName: 'Maccabi', requiredPosition: 'CB', validUntil: '2026-10-01' }, { id: 'r2', clubName: 'X', validUntil: '2026-12-01' }],
      tasks: [{ id: 't1', title: 'Call', dueDate: '2026-10-10' }, { id: 't2', title: 'Done', dueDate: '2026-10-01', done: true }],
      jobs: [{ id: 'j1', name: 'tm-watch', status: 'error', error: 'boom', startedAt: new Date('2026-10-12T02:00:00Z') }, { id: 'j2', name: 'old', status: 'error', startedAt: new Date('2026-10-01') }],
    });
    expect(r.byType.deal_stale.map((a) => a.subject.id)).toEqual(['d1']);
    expect(r.byType.deal_stale[0].proof.he).toMatch(/22 ימים/);
    expect(r.byType.requirement_expired.map((a) => a.subject.id)).toEqual(['r1']);
    expect(r.byType.task_overdue.map((a) => a.subject.id)).toEqual(['t1']);
    expect(r.byType.job_failed.map((a) => a.subject.id)).toEqual(['j1']);
    expect(r.alerts[0].severity).toBe('critical');
  });
  it('flags a player whose IFA squad failed the plausibility check', () => {
    const r = computeAlerts({ now: noon, players: [
      { id: 'e', fullName: 'Eyal', autoFetch: { ifaFail: { reason: 'ifa-squad-mismatch', detail: 'נערים ג לא מתאים' } } },
      { id: 'ok', fullName: 'Ok', autoFetch: { ifaFail: { reason: 'ifa-club-not-found' } } },
    ] });
    expect(r.byType.sync_mismatch.map((a) => a.subject.id)).toEqual(['e']);
    expect(r.byType.sync_mismatch[0].proof.he).toMatch(/נערים ג/);
  });
  it('lists matches in the window but does not count them as actions', () => {
    const r = computeAlerts({ now: noon, matches: [{ id: 'm', homeTeam: 'A', awayTeam: 'B', date: '2026-10-13', time: '20:00' }, { id: 'old', homeTeam: 'A', awayTeam: 'B', date: '2026-10-01' }] });
    expect(r.byType.match).toHaveLength(1);
    expect(r.byType.match[0].proof.he).toBe('משחק מחר ב-20:00');
    expect(r.total).toBe(0);
  });
});

describe('matching engine', () => {
  const req = { requiredPosition: 'CB', ageMin: 20, ageMax: 26, gender: 'Men', leagueTier: 'Tier 2', leagueCountry: 'Israel', salary: '10000' };
  const players = [
    { id: 'p1', name: 'Fit', primaryPosition: 'CB', dob: '2003-01-01', gender: 'Men', leagueTier: 'Tier 1', salary: '9000', contractStatus: 'Free' },
    { id: 'p2', name: 'Secondary', primaryPosition: 'CM', secondaryPositions: ['CB'], dob: '2000-01-01', gender: 'Men', leagueTier: 'Tier 3', salary: '13000' },
    { id: 'p3', name: 'Woman', primaryPosition: 'CB', dob: '2003-01-01', gender: 'Women' },
    { id: 'p4', name: 'Gone', primaryPosition: 'CB', stage: 'not_relevant' },
  ];
  it('ranks the best fit first and drops hard mismatches', () => {
    const r = scoreRequirement(req, players, noon);
    expect(r.map((m) => m.playerId)).toEqual(['p1', 'p2']);
    expect(r[0].score).toBeGreaterThan(r[1].score);
    expect(r[0].score).toBeGreaterThanOrEqual(90);
    expect(r[0].reasons.find((x) => x.key === 'money')?.he).toBe('בתקציב ✓');
    expect(r[1].reasons.find((x) => x.key === 'money')?.he).toMatch(/30% מעל/);
  });
  it('topMatches filters by minimum score', () => {
    expect(topMatches(req, players, { n: 5, min: 99, now: noon }).map((m) => m.playerId)).toEqual([]);
    expect(topMatches(req, players, { n: 1, min: 10, now: noon })).toHaveLength(1);
  });
});

describe('deal state machine', () => {
  const deal = { id: 'd', stage: 'Initial Talks', clubName: 'Maccabi', enteredStageAt: '2026-09-20T10:00:00Z', history: [] };
  it('requires confirmation for a mandate without a document', () => {
    expect(canTransition(deal, 'Mandate Received').confirm).toBeTruthy();
    expect(canTransition({ ...deal, mandateFiles: [{}] }, 'Mandate Received').confirm).toBeUndefined();
    expect(canTransition(deal, 'Initial Talks').ok).toBe(false);
    expect(canTransition({ ...deal, closedAt: 'x' }, 'Negotiation').ok).toBe(false);
  });
  it('applies a transition with history, closing and effects', () => {
    const r = applyTransition(deal, 'Contract Signed', 'lou@x', noon, 'signed');
    expect(r.patch.stage).toBe('Contract Signed');
    expect(r.patch.closedAt).toBe(noon.toISOString());
    expect((r.patch.history as unknown[]).length).toBe(1);
    expect(r.effects.suggestPromote).toBe(true);
    expect(r.interaction.text).toBe('Maccabi: שיחות ראשונות → חוזה נחתם');
    const nr = applyTransition({ ...deal, requirementId: 'r' }, 'Not Relevant', 'lou@x', noon);
    expect(nr.effects.freeRequirement).toBe(true);
    expect(() => applyTransition(deal, 'Initial Talks', 'lou@x', noon)).toThrow();
  });
  it('knows how long a deal has waited', () => {
    expect(daysInStage(deal, noon)).toBe(22);
    expect(isStale(deal, noon)).toBe(true);
    expect(isStale({ ...deal, enteredStageAt: '2026-10-10T10:00:00Z' }, noon)).toBe(false);
    expect(funnel([deal, { stage: 'Negotiation' }])['Initial Talks']).toBe(1);
  });
});

describe('weekly recurrence', () => {
  const tr = { id: 't', time: '17:30', rule: { freq: 'weekly' as const, byWeekday: [0, 2, 4], start: '2026-10-01', until: null } };
  it('expands a rule into dated occurrences', () => {
    const occ = occurrences(tr, '2026-10-11', '2026-10-17');
    expect(occ.map((o) => o.date)).toEqual(['2026-10-11', '2026-10-13', '2026-10-15']);
    expect(occ[0].time).toBe('17:30');
    expect(occ[0].recurring).toBe(true);
  });
  it('honours start, until and exceptions', () => {
    const until = { ...tr, rule: { ...tr.rule, until: '2026-10-13' } };
    expect(occurrences(until, '2026-10-11', '2026-10-17').map((o) => o.date)).toEqual(['2026-10-11', '2026-10-13']);
    const cancelled = { ...tr, exceptions: cancelOccurrence(tr, '2026-10-13') };
    expect(occurrences(cancelled, '2026-10-11', '2026-10-17').find((o) => o.sourceDate === '2026-10-13')?.cancelled).toBe(true);
    const moved = { ...tr, exceptions: moveOccurrence(tr, '2026-10-13', '2026-10-14', '18:00') };
    const m = occurrences(moved, '2026-10-11', '2026-10-17').find((o) => o.sourceDate === '2026-10-13');
    expect(m).toMatchObject({ date: '2026-10-14', time: '18:00' });
  });
  it('mixes one-off and recurring trainings', () => {
    const all = expandTrainings([tr, { id: 'o', date: '2026-10-12', time: '10:00' }], '2026-10-11', '2026-10-13');
    expect(all.map((o) => `${o.date} ${o.time}`)).toEqual(['2026-10-11 17:30', '2026-10-12 10:00', '2026-10-13 17:30']);
    expect(describeRule(tr)).toBe('כל א׳, ג׳, ה׳ 17:30');
  });
});
