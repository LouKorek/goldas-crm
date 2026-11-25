/* eslint-disable ts-patterns/no-magic-numbers -- test fixtures are literal match data */
import { describe, it, expect } from 'vitest';
import {
  seasonOf, currentSeason, playerMatchRows, summarizeStats, seasonsOf, cleanStat, hasStat, playedIn,
} from '../engines/matchStats';
import * as domain from '../index';

const matches = [
  { id: 'm1', date: '2026-09-05', homeTeam: 'A', awayTeam: 'B', linkedPlayers: ['p'], playerStats: { p: { minutes: 90, goals: 1, assists: 0, rating: 7 } } },
  { id: 'm2', date: '2026-10-12', homeTeam: 'C', awayTeam: 'A', linkedPlayers: ['p', 'q'], playerStats: { p: { minutes: 0 }, q: { minutes: 45, rating: 6 } } },
  { id: 'm3', date: '2026-11-20', homeTeam: 'A', awayTeam: 'D', linkedPlayers: ['p'], playerStats: { p: { minutes: 70, goals: 2, assists: 1, rating: 8.5, note: 'great' } } },
  { id: 'm4', date: '2026-11-22', homeTeam: 'A', awayTeam: 'E', linkedPlayers: ['p'] },
  { id: 'gone', date: '2026-11-01', deletedAt: 'x', playerStats: { p: { minutes: 90, goals: 5 } } },
  { id: 'old', date: '2026-03-01', homeTeam: 'A', awayTeam: 'F', linkedPlayers: [], playerStats: { p: { goals: 1 } } },
];

describe('seasons run July to June', () => {
  it('labels a date with its season', () => {
    expect(seasonOf('2026-07-01')).toBe('2026/27');
    expect(seasonOf('2027-06-30')).toBe('2026/27');
    expect(seasonOf('2026-06-30')).toBe('2025/26');
    expect(seasonOf('1999-08-01')).toBe('1999/00');
    expect(seasonOf('')).toBeNull();
    expect(seasonOf('nonsense')).toBeNull();
    expect(currentSeason(new Date('2026-11-25T10:00:00Z'))).toBe('2026/27');
  });
});

describe('a player\'s match rows', () => {
  it('lists his matches with numbers, newest first, outside the recycle bin', () => {
    const rows = playerMatchRows(matches, 'p');
    expect(rows.map((r) => r.matchId)).toEqual(['m3', 'm2', 'm1', 'old']);
    expect(rows[0]).toMatchObject({ date: '2026-11-20', season: '2026/27', homeTeam: 'A', awayTeam: 'D' });
    expect(rows[3].season).toBe('2025/26');
    expect(seasonsOf(rows)).toEqual(['2026/27', '2025/26']);
    expect(playerMatchRows(matches, 'nobody')).toEqual([]);
    expect(playerMatchRows(null, 'p')).toEqual([]);
  });
});

describe('season totals', () => {
  it('sums minutes, goals and assists and averages the rated matches', () => {
    const rows = playerMatchRows(matches, 'p').filter((r) => r.season === '2026/27');
    expect(summarizeStats(rows)).toEqual({ apps: 2, minutes: 160, goals: 3, assists: 1, avgRating: 7.8, rated: 2 });
  });
  it('is all zero with no rating when there is nothing', () => {
    expect(summarizeStats([])).toEqual({ apps: 0, minutes: 0, goals: 0, assists: 0, avgRating: null, rated: 0 });
  });
  it('counts a goal without minutes as an appearance, and 0 minutes as none', () => {
    expect(playedIn({ goals: 1 })).toBe(true);
    expect(playedIn({ minutes: 0 })).toBe(false);
    expect(hasStat({ minutes: 0 })).toBe(true);
    expect(hasStat({})).toBe(false);
  });
});

describe('cleaning what was typed', () => {
  it('keeps whole numbers, a 1-10 rating and one short line', () => {
    expect(cleanStat({ minutes: '70', goals: 1, assists: '', rating: '7.4', note: '  good \n game ' }))
      .toEqual({ minutes: 70, goals: 1, rating: 7.5, note: 'good game' });
    expect(cleanStat({ rating: 11 })).toBeNull();
    expect(cleanStat({ minutes: -3 })).toBeNull();
    expect(cleanStat({ minutes: 0, watchedBy: 'Dani' })).toEqual({ minutes: 0, watchedBy: 'Dani' });
    expect(cleanStat(null)).toBeNull();
  });
});

describe('the package index', () => {
  it('exports the summary functions', () => {
    expect(typeof domain.playerMatchRows).toBe('function');
    expect(typeof domain.seasonOf).toBe('function');
    expect(typeof domain.summarizeStats).toBe('function');
  });
});
