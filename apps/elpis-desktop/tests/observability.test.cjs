const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { dashboardRoutes } = require('./dashboard-fixture.cjs');

test('Observability hosts the TUI dashboard assets instead of a second desktop page', async () => {
  const f = await fixture({ width: 1440, height: 1000, routes: dashboardRoutes() });
  try {
    await f.page.getByRole('button', { name: 'Observability', exact: true }).click();
    const iframe = f.page.locator('iframe[title="Elpis dashboard"]');
    await iframe.waitFor({ timeout: 5000 }).catch(() => {});
    assert.equal(await iframe.count(), 1, 'R30: Observability must embed the shared TUI dashboard');
    assert.equal(await f.page.locator('.observed-agent, .observed-chat-row').count(), 0);
    const dashboard = f.page.frameLocator('iframe[title="Elpis dashboard"]');
    await dashboard.getByRole('tab', { name: 'Conversations & agents', exact: true }).waitFor();
    await dashboard.getByRole('tab', { name: 'Tokens', exact: true }).click();
    await dashboard.locator('#panel-tokens').waitFor();
    assert.equal(await dashboard.locator('#panel-tokens').count(), 1);
    await dashboard.getByRole('tab', { name: /Smart Prune/ }).click();
    await dashboard.getByText('Edit pruning instructions', { exact: true }).click();
    await dashboard.locator('#pruner-prompt').fill('My unsaved instructions');
    await chooseTheme(f.page, 'dark');
    assert.equal(await dashboard.locator('#pruner-prompt').inputValue(), 'My unsaved instructions');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
