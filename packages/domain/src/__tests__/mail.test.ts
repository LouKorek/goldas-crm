import { describe, expect, it } from 'vitest';
import { normalizeEmail, emailDomainOf, normalizeMailDomain, isFreeMailDomain, clubDomainProblem, addressInDomain } from '../mail.js';

describe('mail addresses and club domains', () => {
  it('reads an address the way people paste it', () => {
    expect(normalizeEmail(' Dana.Levi@Club.co.il ')).toBe('dana.levi@club.co.il');
    expect(normalizeEmail('Dana Levi <dana@club.co.il>')).toBe('dana@club.co.il');
    expect(normalizeEmail('mailto:dana@club.co.il')).toBe('dana@club.co.il');
    expect(normalizeEmail('dana@')).toBe('');
    expect(normalizeEmail('dana levi@club.co.il')).toBe('');
    expect(normalizeEmail('dana@localhost')).toBe('');
    expect(emailDomainOf('x@mail.club.co.il')).toBe('mail.club.co.il');
  });

  it('turns what is typed as a domain into a bare domain', () => {
    expect(normalizeMailDomain('@club.co.il')).toBe('club.co.il');
    expect(normalizeMailDomain('https://www.club.co.il/he?x=1')).toBe('club.co.il');
    expect(normalizeMailDomain('office@fc-porto.pt')).toBe('fc-porto.pt');
    expect(normalizeMailDomain('club')).toBe('');
    expect(normalizeMailDomain('-club.com')).toBe('');
  });

  it('never accepts a free mail domain as a club domain', () => {
    const free = ['gmail.com', 'walla.co.il', 'yahoo.co.uk', 'hotmail.fr', 'outlook.co.il', 'mail.walla.co.il', '@gmail.com'];
    expect(free.filter((d) => !isFreeMailDomain(d))).toEqual([]);
    const clubs = ['club.co.il', 'yahoosports.com', 'maccabi-haifa.co.il', 'fcporto.pt'];
    expect(clubs.filter(isFreeMailDomain)).toEqual([]);
    expect(clubDomainProblem('gmail.com')).toBe('free');
    expect(clubDomainProblem('not a domain')).toBe('invalid');
    expect(clubDomainProblem('')).toBe(null);
    expect(clubDomainProblem('www.mhfc.co.il')).toBe(null);
  });

  it('an address is in a domain when its host is the domain or below it', () => {
    expect(addressInDomain('a@mhfc.co.il', 'mhfc.co.il')).toBe(true);
    expect(addressInDomain('a@office.mhfc.co.il', 'mhfc.co.il')).toBe(true);
    expect(addressInDomain('a@notmhfc.co.il', 'mhfc.co.il')).toBe(false);
  });
});
