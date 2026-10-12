import { describe, it, expect } from 'vitest';
import { can, normalizeRole, roleLabel, FUTURE_ROLES, ROLES } from '../permissions';
import { POSITIONS, COUNTRIES, ISO2, flagEmoji, isEuropean } from '../constants';

describe('can()', () => {
  it('admin can do everything', () => {
    expect(can('admin', 'purge')).toBe(true);
    expect(can('admin', 'manage_users')).toBe(true);
  });
  it('manager edits but cannot purge or manage users', () => {
    expect(can('manager', 'edit')).toBe(true);
    expect(can('manager', 'delete')).toBe(true);
    expect(can('manager', 'purge')).toBe(false);
    expect(can('manager', 'manage_users')).toBe(false);
  });
  it('viewer and unknown roles are read-only', () => {
    expect(can('viewer', 'edit')).toBe(false);
    expect(can(undefined, 'read')).toBe(true);
    expect(can('owner', 'edit')).toBe(false);
    expect(normalizeRole('nonsense')).toBe('viewer');
  });
  it('future roles exist in the model only and grant nothing yet', () => {
    expect(FUTURE_ROLES).toEqual(['scout', 'player']);
    for (const r of FUTURE_ROLES) {
      expect((ROLES as readonly string[]).includes(r)).toBe(false);
      expect(normalizeRole(r)).toBe('viewer');
      expect(can(r, 'edit')).toBe(false);
      expect(can(r, 'read')).toBe(true);
    }
  });
  it('labels', () => {
    expect(roleLabel('admin')).toBe('מנהל מערכת');
    expect(roleLabel('manager', 'en')).toBe('Manager');
  });
});

describe('constants', () => {
  it('reference lists are intact', () => {
    expect(POSITIONS).toHaveLength(13);
    expect(COUNTRIES.length).toBeGreaterThan(200);
    expect(ISO2['Israel']).toBe('IL');
    expect(flagEmoji('Israel')).toBe('🇮🇱');
    expect(flagEmoji('Atlantis')).toBe('');
    expect(isEuropean(['Israel', 'France'])).toBe(true);
    expect(isEuropean(['Israel'])).toBe(false);
  });
});
