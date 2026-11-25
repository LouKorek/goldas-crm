/* eslint-disable ts-patterns/no-magic-numbers -- test fixtures are literal match data */
import { describe, it, expect } from 'vitest';
import {
  isMonthKey, monthOf, addMonths, lastFullMonth, reportMonths, monthName, monthlyReportFacts, cleanReportText, reportOf,
  REPORT_DID_MAX_LINES, REPORT_DID_LINE_MAX, REPORT_NEXT_MAX,
} from '../engines/monthlyReport';
import { playerSchema } from '../schemas';
import * as domain from '../index';

const matches = [
  { id: 'aug', date: '2026-08-20', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p'], playerStats: { p: { minutes: 90, goals: 2 } } },
  { id: 'o1', date: '2026-10-04', homeTeam: 'A', awayTeam: 'C', competition: 'Liga Leumit', linkedPlayers: ['p'], playerStats: { p: { minutes: 90, goals: 1, assists: 1, rating: 8, note: 'great', watchedBy: 'Dani' } } },
  { id: 'o2', date: '2026-10-18', homeTeam: 'D', awayTeam: 'A', linkedPlayers: ['p'], playerStats: { p: { minutes: 0 } } },
  { id: 'o3', date: '2026-10-31', homeTeam: 'A', awayTeam: 'E', league: 'State Cup', linkedPlayers: ['p'], playerStats: { p: { minutes: 25.4, assists: 1 } } },
  { id: 'nov', date: '2026-11-02', homeTeam: 'A', awayTeam: 'F', linkedPlayers: ['p'], playerStats: { p: { minutes: 90, goals: 3 } } },
  { id: 'bin', date: '2026-10-10', deletedAt: 'x', playerStats: { p: { minutes: 90, goals: 5 } } },
  { id: 'last', date: '2026-05-01', homeTeam: 'A', awayTeam: 'G', playerStats: { p: { minutes: 90, goals: 4 } } },
];

describe('months', () => {
  it('reads and moves months', () => {
    expect(isMonthKey('2026-10')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-1')).toBe(false);
    expect(isMonthKey(null)).toBe(false);
    expect(monthOf('2026-10-31')).toBe('2026-10');
    expect(monthOf('')).toBe(null);
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-10', -12)).toBe('2025-10');
  });

  it('the last full month is the one before today in Israel', () => {
    expect(lastFullMonth(new Date('2026-11-25T10:00:00Z'))).toBe('2026-10');
    expect(lastFullMonth(new Date('2027-01-01T08:00:00Z'))).toBe('2026-12');
    // 1 November 00:30 in Israel is still 31 October in UTC
    expect(lastFullMonth(new Date('2026-10-31T22:30:00Z'))).toBe('2026-10');
  });

  it('the picker offers the last twelve months, newest first', () => {
    const list = reportMonths(new Date('2026-11-25T10:00:00Z'));
    expect(list).toHaveLength(12);
    expect(list[0]).toBe('2026-10');
    expect(list[11]).toBe('2025-11');
  });

  it('names a month in Hebrew and English', () => {
    expect(monthName('2026-10', 'he')).toBe('אוקטובר 2026');
    expect(monthName('2026-10', 'en')).toBe('October 2026');
    expect(monthName('2026-01')).toBe('ינואר 2026');
    expect(monthName('nope', 'en')).toBe('nope');
  });
});

describe('monthlyReportFacts', () => {
  const f = monthlyReportFacts(matches, 'p', '2026-10');

  it('lists the month\'s matches oldest first, without rating, note or watcher', () => {
    expect(f.matches.map((m) => m.matchId)).toEqual(['o1', 'o2', 'o3']);
    expect(f.matches[0]).toEqual({ matchId: 'o1', date: '2026-10-04', title: 'A – C', competition: 'Liga Leumit', minutes: 90, goals: 1, assists: 1, played: true });
    expect(f.matches[1].played).toBe(false);
    expect(f.matches[2]).toMatchObject({ competition: 'State Cup', minutes: 25, assists: 1 });
    const json = JSON.stringify(f);
    // Any of the agency's own words ("rating", "great", "Dani" would match; "Liga Leumit" would not).
    expect(json).not.toMatch(/rating|great|Dani|watchedBy|note/);
  });

  it('the month\'s totals and the season up to the end of the month', () => {
    expect(f.monthTotals).toEqual({ apps: 2, minutes: 115, goals: 1, assists: 2 });
    // August and October; not November (after the month), not May (last season), not the bin
    expect(f.season).toEqual({ label: '2026/27', apps: 3, minutes: 205, goals: 3, assists: 2 });
  });

  it('a month with no matches is empty, not an error', () => {
    const none = monthlyReportFacts(matches, 'p', '2026-09');
    expect(none.matches).toEqual([]);
    expect(none.monthTotals).toEqual({ apps: 0, minutes: 0, goals: 0, assists: 0 });
    expect(none.season.apps).toBe(1);
    expect(monthlyReportFacts(null, 'p', '2026-10').matches).toEqual([]);
    expect(monthlyReportFacts(matches, 'nobody', '2026-10').monthTotals.apps).toBe(0);
  });
});

describe('cleanReportText', () => {
  it('keeps at most five short lines and drops bullets and empty lines', () => {
    const r = cleanReportText({ did: '• נפגשנו עם המאמן\n\n2) שלחנו סרטון   לשלוש קבוצות\n- a\nb\nc\nd\ne', next: '  נמשיך\nלעקוב  ' });
    expect(r.did).toEqual(['נפגשנו עם המאמן', 'שלחנו סרטון לשלוש קבוצות', 'a', 'b', 'c']);
    expect(r.did).toHaveLength(REPORT_DID_MAX_LINES);
    expect(r.next).toBe('נמשיך לעקוב');
  });

  it('cuts long lines and a long next step', () => {
    const r = cleanReportText({ did: ['x'.repeat(400)], next: 'y'.repeat(900) });
    expect(r.did[0].length).toBe(REPORT_DID_LINE_MAX);
    expect(r.did[0].endsWith('…')).toBe(true);
    expect(r.next.length).toBe(REPORT_NEXT_MAX);
  });

  it('takes nothing and gives nothing', () => {
    expect(cleanReportText(null)).toEqual({ did: [], next: '' });
    expect(cleanReportText({ did: [null, ' ', 3] })).toEqual({ did: ['3'], next: '' });
  });
});

describe('the stored text', () => {
  it('reportOf reads one month', () => {
    const p = { monthlyReports: { '2026-10': { did: ['a'], next: 'b', status: 'draft' } } };
    expect(reportOf(p, '2026-10')?.next).toBe('b');
    expect(reportOf(p, '2026-09')).toBe(null);
    expect(reportOf({}, '2026-10')).toBe(null);
  });

  it('the player schema keeps monthlyReports', () => {
    const parsed = playerSchema.parse({ name: 'X', stage: 'represented', category: 'men',
      monthlyReports: { '2026-10': { did: ['a'], next: 'b', status: 'approved', by: 'lou', at: '2026-11-01T10:00:00Z', turn: 4 } } });
    expect(parsed.monthlyReports?.['2026-10']).toMatchObject({ did: ['a'], next: 'b', status: 'approved', turn: 4 });
    expect(() => playerSchema.parse({ name: 'X', stage: 'represented', category: 'men', monthlyReports: { '2026-10': { status: 'sent' } } })).toThrow();
  });

  it('is exported from the package', () => {
    expect(typeof domain.monthlyReportFacts).toBe('function');
    expect(typeof domain.lastFullMonth).toBe('function');
    expect(typeof domain.cleanReportText).toBe('function');
  });
});
