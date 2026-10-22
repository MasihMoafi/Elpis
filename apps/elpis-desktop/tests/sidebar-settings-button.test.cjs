const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('the sidebar footer has a Settings button that opens General settings', async () => {
  const f = await fixture();
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.locator('aside.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await f.page.locator('.settings-title').waitFor();
    assert.equal(await f.page.locator('.settings-title').innerText(), 'Settings');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
