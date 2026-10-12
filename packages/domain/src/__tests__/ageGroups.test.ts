import { describe, it, expect } from 'vitest';
import { ageGroupFor, seasonStartYear, seasonLabel, resolveAgeGroup, isYouthAge } from '../ageGroups';

const oct2026 = new Date('2026-10-12');
const mar2027 = new Date('2027-03-01');
const aug2027 = new Date('2027-08-01');

describe('season boundary', () => {
  it('season starts July 1', () => {
    expect(seasonStartYear(new Date('2026-06-30'))).toBe(2025);
    expect(seasonStartYear(new Date('2026-07-01'))).toBe(2026);
    expect(seasonLabel(oct2026)).toBe('2026/27');
  });
});

describe('IFA cohorts for 2026/27 (ONE article: נערים א-ג = 2010-2012)', () => {
  it('maps birth years to groups', () => {
    expect(ageGroupFor('2010-05-01', oct2026)?.id).toBe('nearim_a');
    expect(ageGroupFor('2011-01-01', mar2027)?.id).toBe('nearim_b'); // same season
    expect(ageGroupFor('2012-12-31', oct2026)?.id).toBe('nearim_c');
    expect(ageGroupFor('2008-03-03', oct2026)?.id).toBe('noar');
    expect(ageGroupFor('2009-03-03', oct2026)?.id).toBe('noar');
    expect(ageGroupFor('2013-03-03', oct2026)?.id).toBe('yeladim_a');
    expect(ageGroupFor('2018-03-03', oct2026)?.id).toBe('trom_c');
  });
  it('moves up a group when the season rolls over', () => {
    expect(ageGroupFor('2010-05-01', aug2027)?.id).toBe('noar');
  });
  it('returns null for adults and bad input', () => {
    expect(ageGroupFor('2000-01-01', oct2026)).toBeNull();
    expect(ageGroupFor('', oct2026)).toBeNull();
    expect(ageGroupFor('not a date', oct2026)).toBeNull();
    expect(isYouthAge('2007-01-01', oct2026)).toBe(false);
  });
});

describe('overrides', () => {
  it('uses a same-season override and ignores a stale one', () => {
    const p = { dob: '2010-05-01', ageGroupOverride: { id: 'noar' as const, season: 2026 } };
    expect(resolveAgeGroup(p, oct2026)?.id).toBe('noar');
    expect(resolveAgeGroup(p, aug2027)?.id).toBe('noar'); // 2027 default is noar anyway
    const stale = { dob: '2012-05-01', ageGroupOverride: { id: 'noar' as const, season: 2025 } };
    expect(resolveAgeGroup(stale, oct2026)?.id).toBe('nearim_c');
  });
});
