import { describe, it, expect } from 'vitest';
import {
  COMPLETENESS_ITEMS, COMPLETENESS_WEIGHTS, RECORD_GAPS, playerCompleteness, isOnboarding, toMillis, calendarBlock,
} from '../engines/completeness';

const NOW = new Date('2026-11-25T10:00:00Z');
const REPORT = { list: [], runAt: '2026-11-25T06:00:00Z' };
const FILE = [{ name: 'x.pdf', url: 'data:application/pdf;base64,AA==' }];

// Every item done, for a player under contract at an Israeli club.
const COMPLETE = {
  id: 'p1', fullName: 'Full Player', stage: 'represented', createdAt: '2024-01-01T00:00:00Z',
  contractStatus: 'Under Contract', contractEnd: '2027-06-30', reprEnd: '2027-06-30', passportExpiry: '2030-01-01',
  dob: '2005-01-01', primaryPosition: 'CB', currentClub: 'Maccabi Haifa', foot: 'Right', nationalities: ['Israel'],
  leagueCountry: 'Israel', reprFiles: FILE, passportFiles: FILE, photoFiles: FILE, videoLink: 'https://youtu.be/x',
  ifaTeamUrl: 'https://www.football.org.il/players/player/?player_id=1', profileLink: 'https://www.transfermarkt.com/x/profil/spieler/1',
  siteCard: { on: true, checkedAt: '2026-11-25' },
};
const keys = (xs: { key: string }[]) => xs.map((x) => x.key);

describe('player completeness', () => {
  it('a complete player scores 100 with nothing missing', () => {
    const c = playerCompleteness(COMPLETE, { now: NOW, syncReport: REPORT })!;
    expect(c.score).toBe(100);
    expect(c.missing).toEqual([]);
    expect(c.unknown).toEqual([]);
    expect(c.done.length).toBe(COMPLETENESS_ITEMS.length);
    expect(c.onboarding).toBe(false);
  });

  it('an empty represented player: everything that applies is missing, the unknowable is left out', () => {
    const c = playerCompleteness({ id: 'e' }, { now: NOW })!;
    expect(c.score).toBe(0);
    expect(c.done).toEqual([]);
    // no contract status: contract end does not apply; not in Israel: no IFA link; no site check, no sync report
    expect(keys(c.missing)).not.toContain('contractEnd');
    expect(keys(c.missing)).not.toContain('ifa');
    expect(keys(c.unknown).sort()).toEqual(['calendar', 'siteCard']);
    // most important first
    expect(c.missing[0].weight).toBe(Math.max(...c.missing.map((i) => i.weight)));
  });

  it('only represented players are scored', () => {
    expect(playerCompleteness({ ...COMPLETE, stage: 'tracking' })).toBeNull();
    expect(playerCompleteness({ ...COMPLETE, deletedAt: 'x' })).toBeNull();
    expect(playerCompleteness(null)).toBeNull();
    expect(playerCompleteness({ ...COMPLETE, stage: undefined }, { syncReport: REPORT })!.score).toBe(100);
  });

  it('the score is the done weight over the applicable, knowable weight', () => {
    const w = COMPLETENESS_WEIGHTS;
    const c = playerCompleteness({ ...COMPLETE, videoLink: '', foot: '' }, { now: NOW, syncReport: REPORT })!;
    const total = COMPLETENESS_ITEMS.reduce((n, i) => n + i.weight, 0);
    expect(c.score).toBe(Math.round((100 * (total - w.video - w.foot)) / total));
    expect(keys(c.missing)).toEqual(['video', 'foot']);
    // an unknown item drops out of both sides
    const u = playerCompleteness({ ...COMPLETE, videoLink: '', siteCard: undefined }, { now: NOW, syncReport: REPORT })!;
    expect(u.score).toBe(Math.round((100 * (total - w.siteCard - w.video)) / (total - w.siteCard)));
  });

  it('when: an item that does not apply is neither done nor missing', () => {
    const free = { ...COMPLETE, contractStatus: 'Free', contractEnd: '', currentClub: '', ifaTeamUrl: '' };
    const c = playerCompleteness(free, { now: NOW, syncReport: REPORT })!;
    expect(c.score).toBe(100);
    ['contractEnd', 'currentClub', 'ifa', 'calendar'].forEach((k) => {
      expect(keys(c.done)).not.toContain(k);
      expect(keys(c.missing)).not.toContain(k);
    });
    // abroad, the IFA link does not matter
    const abroad = playerCompleteness({ ...COMPLETE, leagueCountry: 'Spain', ifaTeamUrl: '' }, { syncReport: REPORT })!;
    expect(abroad.score).toBe(100);
    // in Israel it does
    expect(keys(playerCompleteness({ ...COMPLETE, ifaTeamUrl: '' }, { syncReport: REPORT })!.missing)).toEqual(['ifa']);
  });

  it('a document item needs both the file and its date', () => {
    expect(keys(playerCompleteness({ ...COMPLETE, reprFiles: [] }, { syncReport: REPORT })!.missing)).toEqual(['reprAgreement']);
    expect(keys(playerCompleteness({ ...COMPLETE, passportFiles: [], passportExpiry: '' }, { syncReport: REPORT })!.missing)).toEqual(['passport', 'passportExpiry']);
  });

  it('the website card comes from the stamp; the calendar from the match sync report', () => {
    expect(keys(playerCompleteness({ ...COMPLETE, siteCard: { on: false } }, { syncReport: REPORT })!.missing)).toEqual(['siteCard']);
    const stuck = { list: [{ playerId: 'p1', reason: 'ifa-team-not-matched' }], runAt: REPORT.runAt };
    expect(calendarBlock(COMPLETE, { syncReport: stuck })).toBe('ifa-team-not-matched');
    expect(keys(playerCompleteness(COMPLETE, { syncReport: stuck })!.missing)).toEqual(['calendar']);
    // a temporary problem is not a gap in the file
    const temp = { list: [{ playerId: 'p1', reason: 'not-reached-time' }], runAt: REPORT.runAt };
    expect(playerCompleteness(COMPLETE, { syncReport: temp })!.score).toBe(100);
    // added after the sync last ran: not known yet
    const fresh = playerCompleteness({ ...COMPLETE, createdAt: '2026-11-25T08:00:00Z' }, { now: NOW, syncReport: REPORT })!;
    expect(keys(fresh.unknown)).toEqual(['calendar']);
  });

  it('onboarding: added in the last 30 days, whatever the timestamp shape', () => {
    expect(isOnboarding({ createdAt: '2026-11-01T00:00:00Z' }, { now: NOW })).toBe(true);
    expect(isOnboarding({ createdAt: { seconds: Date.parse('2026-10-01T00:00:00Z') / 1000, nanoseconds: 0 } }, { now: NOW })).toBe(false);
    expect(isOnboarding({ createdAt: { toDate: () => new Date('2026-11-20') } }, { now: NOW })).toBe(true);
    expect(isOnboarding({}, { now: NOW })).toBe(false);
    expect(toMillis({ _seconds: 2, _nanoseconds: 5e6 })).toBe(2005);
  });

  it('the daily question asks the record fields, in the order it always did', () => {
    expect(RECORD_GAPS.map((g) => g.field)).toEqual(['contractEnd', 'contractStatus', 'reprEnd', 'passportExpiry', 'dob', 'primaryPosition', 'currentClub', 'foot', 'nationalities']);
    expect(RECORD_GAPS.map((g) => g.weight)).toEqual([100, 95, 90, 70, 60, 50, 45, 20, 15]);
    expect(RECORD_GAPS.find((g) => g.field === 'contractEnd')!.when!({ contractStatus: 'Loan' })).toBe(true);
    expect(RECORD_GAPS.find((g) => g.field === 'currentClub')!.when!({ contractStatus: 'Free' })).toBe(false);
  });

  it('every item has a stable key and both labels', () => {
    expect(new Set(keys(COMPLETENESS_ITEMS)).size).toBe(COMPLETENESS_ITEMS.length);
    COMPLETENESS_ITEMS.forEach((i) => { expect(i.label.he).toBeTruthy(); expect(i.label.en).toBeTruthy(); expect(i.weight).toBeGreaterThan(0); });
  });
});
