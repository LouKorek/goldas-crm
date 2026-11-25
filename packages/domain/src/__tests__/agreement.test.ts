/* eslint-disable ts-patterns/no-magic-numbers -- test fixtures are literal dates and periods */
import { describe, it, expect } from 'vitest';
import {
  AGREEMENT_PLACEHOLDERS, checkTemplate, fillTemplate, agreementBlocks, agreementPeriod, agreementValues, periodEnd, addMonthsToDay,
  monthsBetween, isMinorOn, ageOn, dayText, isRtlText, SIGNER_FIELD_TEXT,
} from '../engines/agreement';
import * as domain from '../index';

const SAMPLE = [
  '# SAMPLE AGREEMENT',
  'Between {{agency_name}} and {{player_name}}, born {{player_dob}}, ID {{player_id_number}}.',
  '',
  '{{#minor}}Signed for the player by {{guardian_name}}, ID {{guardian_id_number}}.{{/minor}}{{#adult}}The player signs for himself.{{/adult}}',
  '',
  '## Term',
  'From {{start_date}} to {{end_date}} ({{period_months}} months).',
  'Made on {{today}}.',
].join('\n');

describe('the placeholder list', () => {
  it('is small, fixed and exported from the package', () => {
    expect(AGREEMENT_PLACEHOLDERS.map((p) => p.key)).toEqual(['player_name', 'player_dob', 'player_id_number', 'guardian_name', 'guardian_id_number', 'start_date', 'end_date', 'period_months', 'agency_name', 'today']);
    expect(AGREEMENT_PLACEHOLDERS.filter((p) => p.bySigner).map((p) => p.key)).toEqual(['player_id_number', 'guardian_id_number']);
    expect(domain.fillTemplate).toBe(fillTemplate);
  });
});

describe('checkTemplate', () => {
  it('accepts a good template and lists what it uses', () => {
    const r = checkTemplate(SAMPLE);
    expect(r.ok).toBe(true);
    expect(r.used).toContain('player_name');
    expect(r.unknown).toEqual([]);
  });
  it('names unknown and mistyped placeholders', () => {
    const r = checkTemplate('{{player_name}} {{salary}} {{ Player }} {{#child}}x{{/child}}');
    expect(r.ok).toBe(false);
    expect(r.unknown).toEqual(expect.arrayContaining(['salary', 'Player', '#child', '/child']));
  });
  it('finds sections that are not closed or closed out of order', () => {
    expect(checkTemplate('{{#minor}} a').sections).toEqual(['minor']);
    expect(checkTemplate('{{#minor}} a {{/adult}}').ok).toBe(false);
    expect(checkTemplate('{{#minor}} a {{/minor}}').ok).toBe(true);
  });
  it('refuses an empty template', () => {
    expect(checkTemplate('   ').empty).toBe(true);
    expect(checkTemplate(undefined).ok).toBe(false);
  });
});

describe('dates', () => {
  it('formats, adds months and finds the last day of a period', () => {
    expect(dayText('2026-12-01')).toBe('01/12/2026');
    expect(dayText('')).toBe('');
    expect(addMonthsToDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsToDay('2026-11-15', 14)).toBe('2028-01-15');
    expect(periodEnd('2026-12-01', 24)).toBe('2028-11-30');
    expect(monthsBetween('2026-12-01', '2028-11-30')).toBe(24);
    expect(monthsBetween('2026-12-01', '2027-06-30')).toBe(7);
  });
  it('knows a minor from his date of birth', () => {
    expect(ageOn('2009-12-02', '2026-12-01')).toBe(16);
    expect(isMinorOn('2008-12-01', '2026-12-01')).toBe(false);
    expect(isMinorOn('2008-12-02', '2026-12-01')).toBe(true);
    expect(isMinorOn('', '2026-12-01')).toBe(null);
  });
});

describe('agreementPeriod', () => {
  it('defaults to the template default, two years when it names none', () => {
    expect(agreementPeriod({ start: '2026-12-01' })).toEqual({ ok: true, start: '2026-12-01', end: '2028-11-30', months: 24 });
    expect(agreementPeriod({ start: '2026-12-01', defaultMonths: 12 })).toMatchObject({ ok: true, end: '2027-11-30', months: 12 });
  });
  it('takes a length in months or an end date', () => {
    expect(agreementPeriod({ start: '2026-12-01', months: 6 })).toMatchObject({ ok: true, end: '2027-05-31' });
    expect(agreementPeriod({ start: '2026-12-01', end: '2027-06-30' })).toMatchObject({ ok: true, months: 7 });
  });
  it('refuses bad dates, an end before the start and a period over the cap', () => {
    expect(agreementPeriod({ start: '2026-02-30' })).toMatchObject({ ok: false, error: 'start' });
    expect(agreementPeriod({ start: '01/12/2026' })).toMatchObject({ ok: false, error: 'start' });
    expect(agreementPeriod({ start: '2026-12-01', end: '2026-12-01' })).toMatchObject({ ok: false, error: 'order' });
    expect(agreementPeriod({ start: '2026-12-01', end: '2026-11-01' })).toMatchObject({ ok: false, error: 'order' });
    expect(agreementPeriod({ start: '2026-12-01', end: 'soon' })).toMatchObject({ ok: false, error: 'end' });
    expect(agreementPeriod({ start: '2026-12-01', months: 0 })).toMatchObject({ ok: false, error: 'months' });
    expect(agreementPeriod({ start: '2026-12-01', months: 25 })).toMatchObject({ ok: false, error: 'tooLong', maxMonths: 24 });
    expect(agreementPeriod({ start: '2026-12-01', end: '2028-12-01' })).toMatchObject({ ok: false, error: 'tooLong' });
    expect(agreementPeriod({ start: '2026-12-01', months: 13, maxMonths: 12 })).toMatchObject({ ok: false, error: 'tooLong', maxMonths: 12 });
  });
});

describe('fillTemplate', () => {
  const values = agreementValues({ playerName: 'Noam  Levi', dob: '2010-03-15', guardianName: 'Dana Levi', start: '2026-12-01', end: '2028-11-30', months: 24, agencyName: '', today: '2026-11-25' });
  it('fills the values and keeps the minor section for a minor', () => {
    const r = fillTemplate(SAMPLE, values, { minor: true, lang: 'en' });
    expect(r.missing).toEqual([]);
    expect(r.text).toContain('Between Gold A&S and Noam Levi, born 15/03/2010');
    expect(r.text).toContain('Signed for the player by Dana Levi');
    expect(r.text).not.toContain('signs for himself');
    expect(r.text).toContain('From 01/12/2026 to 30/11/2028 (24 months).');
    expect(r.text).toContain('Made on 25/11/2026.');
    expect(r.text).toContain(SIGNER_FIELD_TEXT.en.player_id_number);
    expect(r.text).not.toContain('{{');
  });
  it('keeps the adult section for an adult and reports a missing value', () => {
    const r = fillTemplate(SAMPLE, { ...values, player_dob: '' }, { minor: false, lang: 'he' });
    expect(r.text).toContain('The player signs for himself.');
    expect(r.text).not.toContain('Dana');
    expect(r.missing).toEqual(['player_dob']);
    expect(r.text).toContain(SIGNER_FIELD_TEXT.he.player_id_number);
  });
  it('never leaves more than one blank line where a section was dropped', () => {
    const r = fillTemplate('a\n\n{{#minor}}\nb\n{{/minor}}\n\nc', values, { minor: false });
    expect(r.text).toBe('a\n\nc');
  });
});

describe('agreementBlocks', () => {
  it('reads headings, paragraphs and line breaks', () => {
    expect(agreementBlocks('# Title\nfirst line\nsecond line\n\n\nnext\n## Sub')).toEqual([
      { type: 'h', text: 'Title' }, { type: 'p', text: 'first line\nsecond line' }, { type: 'p', text: 'next' }, { type: 'h', text: 'Sub' },
    ]);
    expect(agreementBlocks('')).toEqual([]);
  });
  it('knows a Hebrew text', () => {
    expect(isRtlText('הסכם ייצוג')).toBe(true);
    expect(isRtlText('Agreement')).toBe(false);
  });
});
