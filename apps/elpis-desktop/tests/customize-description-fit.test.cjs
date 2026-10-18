const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

const description = 'Check every shared component, compare the rendered layout with the design, and explain which parts need attention before changing the interface. '.repeat(3);
for (const colorScheme of ['light', 'dark']) for (const width of [1280, 900]) test(`Ledger keeps the full description available (${colorScheme}, ${width}px)`, async () => {
  const f = await fixture({ width, height: width === 900 ? 700 : 800, colorScheme, routes: {
    '/api/customize': () => ({ skills: { data: [{ name: 'web-dev', path: '/tmp/fixture/web-dev/SKILL.md', scope: 'user', enabled: true, description }], errors: [] },
      plugins: { data: [{ id: 'design', name: 'Design', marketplace: 'Local', enabled: true, description }] }, connectors: { data: [] } }),
  } }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
    for (const section of ['Skills', 'Plugins']) {
      await page.getByRole('radiogroup', { name: 'Ledger', exact: true }).getByRole('radio', { name: section, exact: true }).click();
      const text = page.locator('.customize-description');
      await text.waitFor(); await text.hover();
      assert.equal(await text.getAttribute('title'), description, 'an ellipsis must expose the full description on hover');
      await assertUiFit(page.locator('.customize'), `${section} descriptions fit at ${width}px`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
