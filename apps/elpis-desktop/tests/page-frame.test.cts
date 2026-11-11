// Shared system, requirement 2: "Same kind of page, same frame." Every page's title starts at one point, at every
// window width. Measured on 11 Nov: Love Spot's title sat 4 px to the left of the others and Workflows' 1 px higher.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

const PAGES = ['Workflows', 'Love Spot', 'Observability', 'Customize', 'Lab'];

for (const width of [1100, 1400, 1920]) test(`every page title starts at the same point (${width} px wide)`, async () => {
  const f = await fixture({ width, height: 900, routes: { '/api/workflows/workspace': () => ({ cwd: '/tmp/parity-fixture' }) } });
  try {
    const { page } = f;
    const origins: Record<string, string> = {};
    for (const name of PAGES) {
      await page.locator('.nav-list').getByRole('button', { name, exact: true }).click();
      const title = page.locator('main.workspace .workspace-header h1');
      await title.filter({ hasText: name }).waitFor();
      await page.waitForTimeout(300);
      origins[name] = await title.evaluate((el: HTMLElement) => {
        const main = el.closest('main')!.getBoundingClientRect(), box = el.getBoundingClientRect();
        return `${Math.round(box.left - main.left)},${Math.round(box.top - main.top)}`;
      });
    }
    assert.deepEqual(origins, Object.fromEntries(PAGES.map(name => [name, '16,16'])));
  } finally { await f.close(); }
});
