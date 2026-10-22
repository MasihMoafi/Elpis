// S3, R36: Settings → Configuration lists the engine's features that are on, then the ones that are off, each by name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const { settingsBody } = require('./settings-fixture.cjs');

const feature = (key, title, enabled) => ({ key, title, description: `${title}.`, enabled });
const settings = () => settingsBody({ features: { available: true, data: [feature('b', 'Beta', false), feature('c', 'Charlie', true), feature('a', 'Alpha', false), feature('d', 'Delta', true)] } });
const switches = (page, group) => page.locator(`section[aria-label="${group}"] [role="switch"]`).evaluateAll(items => items.map(item => item.getAttribute('aria-label')));

test('Features are grouped On, then Off, and each group is alphabetical', async () => {
  const f = await fixture({ routes: { '/api/settings': settings } }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await openSettings(page); await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    await page.locator('section[aria-label="On"]').waitFor();
    assert.deepEqual(await switches(page, 'On'), ['Charlie', 'Delta']);
    assert.deepEqual(await switches(page, 'Off'), ['Alpha', 'Beta']);
    assert.equal(await page.evaluate(() => !!(document.querySelector('section[aria-label="On"]').compareDocumentPosition(document.querySelector('section[aria-label="Off"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'On comes before Off');
    await page.getByLabel('Search features', { exact: true }).fill('alp');
    assert.equal(await page.locator('section[aria-label="On"]').count(), 0, 'a group with no match is not drawn');
    assert.deepEqual(await switches(page, 'Off'), ['Alpha']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
