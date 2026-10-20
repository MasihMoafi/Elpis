const { test } = require('node:test');
const assert = require('node:assert/strict');

test('usage notifications leave the model catalogue alone while sign-in changes refresh it', async () => {
  const { changesModelCatalog } = await import('../lib/account-events.ts');
  assert.equal(changesModelCatalog('account/rateLimits/updated'), false);
  for (const method of ['account/updated', 'account/login/completed', 'claudeSubscription/write']) {
    assert.equal(changesModelCatalog(method), true);
  }
});
