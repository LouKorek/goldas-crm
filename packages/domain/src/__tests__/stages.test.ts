import { describe, it, expect } from 'vitest';
import { stageFromStatus, categoryFromPlayer, playerName, clubKey, isYouthName, playerSchema, dealSchema } from '../index';

describe('stage and category mapping', () => {
  it('maps pipeline statuses', () => {
    expect(stageFromStatus('Not Contacted')).toBe('tracking');
    expect(stageFromStatus('')).toBe('tracking');
    expect(stageFromStatus('Negotiation')).toBe('in_process');
    expect(stageFromStatus('Contract Signed')).toBe('in_process');
    expect(stageFromStatus('Not Relevant')).toBe('not_relevant');
  });
  it('derives category for represented players', () => {
    expect(categoryFromPlayer({ gender: 'Women' })).toBe('women');
    expect(categoryFromPlayer({ currentClubIsYouth: true })).toBe('youth');
    expect(categoryFromPlayer({})).toBe('men');
    expect(categoryFromPlayer({ category: 'jewish', gender: 'Women' })).toBe('jewish');
  });
  it('reads either legacy name field', () => {
    expect(playerName({ fullName: 'A' })).toBe('A');
    expect(playerName({ playerName: ' B ' })).toBe('B');
    expect(playerName({ name: 'C', fullName: 'A' })).toBe('C');
  });
});

describe('clubKey', () => {
  it('folds spellings of the same club', () => {
    expect(clubKey('Hapoel Tel Aviv F.C.')).toBe(clubKey('hapoel tel aviv'));
    expect(clubKey('Hapoel Tel Aviv U19')).toBe(clubKey('Hapoel Tel Aviv'));
    expect(clubKey('הפועל ת"א')).toBe(clubKey('הפועל תל אביב'));
    expect(clubKey('מ.ס. אשדוד')).toBe(clubKey('אשדוד'));
    expect(clubKey('Free Agent')).toBe('');
    expect(clubKey('')).toBe('');
  });
  it('keeps different clubs apart', () => {
    expect(clubKey('Maccabi Haifa')).not.toBe(clubKey('Hapoel Haifa'));
  });
  it('flags youth names', () => {
    expect(isYouthName('Hapoel Tel Aviv U19')).toBe(true);
    expect(isYouthName('בית"ר ירושלים נוער')).toBe(true);
    expect(isYouthName('Hapoel Tel Aviv')).toBe(false);
  });
});

describe('schemas', () => {
  it('accepts a minimal player and fills defaults', () => {
    const p = playerSchema.parse({ name: 'X', stage: 'tracking', category: 'men' });
    expect(p.nationalities).toEqual([]);
    expect(p.source).toBe('manual');
  });
  it('rejects a bad stage', () => {
    expect(() => playerSchema.parse({ name: 'X', stage: 'signed', category: 'men' })).toThrow();
  });
  it('deal needs a club and a known stage', () => {
    expect(() => dealSchema.parse({ playerId: 'p', playerName: 'X', category: 'men', clubName: '', stage: 'Negotiation' })).toThrow();
    expect(dealSchema.parse({ playerId: 'p', playerName: 'X', category: 'men', clubName: 'C', stage: 'Negotiation' }).history).toEqual([]);
  });
});
