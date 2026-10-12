const test = require('node:test');
const assert = require('node:assert/strict');
const { planDomains } = require('../auth-domains.js');

test('adds a preview host once and keeps production domains', () => {
  const cur = ['localhost', 'gold-as-crm.firebaseapp.com', 'goldas-crm.netlify.app', 'main--goldas-crm.netlify.app'];
  const next = planDomains(cur, 'deploy-preview-16--goldas-crm.netlify.app');
  assert.deepEqual(next, [...cur, 'deploy-preview-16--goldas-crm.netlify.app']);
  assert.deepEqual(planDomains(next, 'deploy-preview-16--goldas-crm.netlify.app'), next);
});

test('drops the oldest preview hosts beyond the limit', () => {
  const cur = ['goldas-crm.netlify.app', ...Array.from({ length: 8 }, (_, i) => `deploy-preview-${i}--goldas-crm.netlify.app`)];
  const next = planDomains(cur, 'deploy-preview-99--goldas-crm.netlify.app');
  assert.equal(next[0], 'goldas-crm.netlify.app');
  assert.equal(next.length, 1 + 6);
  assert.equal(next.at(-1), 'deploy-preview-99--goldas-crm.netlify.app');
  assert.ok(!next.includes('deploy-preview-0--goldas-crm.netlify.app'));
  assert.ok(next.includes('deploy-preview-7--goldas-crm.netlify.app'));
});
