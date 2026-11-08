// Contract terms Golda reads from a player's contract: only known keys, clean
// numbers and dates, and a free agent loses them with the rest of the contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal: { cleanContractTerms, validate, freeAgentRules } } = require('../wa-agent.js');

test('terms keep known keys, numbers from text and dated clauses', () => {
  const t = cleanContractTerms({ salary: '12,000', currency: 'ILS', salaryPeriod: 'month', releaseClause: 500000, optionDeadline: '2027-05-01', optionHolder: 'club', optionYears: '1',
    keyDates: [{ date: '2027-01-15', label: 'תשלום חתימה שני' }], bonuses: '5,000 לגול', secret: 'x', notes: 'סעיף שחרור רק לחו"ל' });
  assert.equal(t.salary, 12000);
  assert.equal(t.releaseClause, 500000);
  assert.equal(t.optionYears, 1);
  assert.deepEqual(t.keyDates, [{ date: '2027-01-15', label: 'תשלום חתימה שני' }]);
  assert.equal(t.secret, undefined);
  assert.ok(t.extractedAt);
});

test('bad dates, money and choices are refused with a clear reason', () => {
  assert.throws(() => cleanContractTerms({ optionDeadline: '1/5/2027' }), /optionDeadline must be YYYY-MM-DD/);
  assert.throws(() => cleanContractTerms({ salary: 'a lot' }), /salary must be a number/);
  assert.throws(() => cleanContractTerms({ optionHolder: 'agent' }), /optionHolder/);
  assert.throws(() => cleanContractTerms({ keyDates: [{ date: 'soon' }] }), /keyDates\[0\]\.date/);
  assert.throws(() => cleanContractTerms('salary 10k'), /must be an object/);
});

test('an update with terms is cleaned in place; a free agent loses them', () => {
  const d = { contractTerms: { salary: '1 000', extra: 1 } };
  validate('players', d, false);
  assert.equal(d.contractTerms.salary, 1000);
  assert.equal(d.contractTerms.extra, undefined);
  assert.equal(freeAgentRules('players', { contractStatus: 'Free' }).contractTerms, null);
  assert.equal(cleanContractTerms(null), null);
});
