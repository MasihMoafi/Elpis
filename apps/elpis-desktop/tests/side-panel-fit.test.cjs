const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

for (const colorScheme of ['light', 'dark']) test(`side panel keeps its actions visible with overflowing tabs (${colorScheme})`, async () => {
  const f = await fixture({ width: 900, height: 700, colorScheme }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.open('chat-a');
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    for (const name of ['Files', 'Changes', 'Terminal', 'Terminal']) {
      await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    }
    const side = page.getByRole('region', { name: 'Side panel', exact: true });
    await fs.mkdir('/tmp/elpis-desktop-sweep', { recursive: true });
    await page.screenshot({ path: `/tmp/elpis-desktop-sweep/side-tabs-${colorScheme}.png` });
    const actions = ['New side panel tab', 'Enter full view', 'Close side panel', 'Restart terminal'];
    const visible = async () => {
      const bounds = await side.boundingBox();
      for (const name of actions) {
        const box = await side.getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(box.x >= bounds.x && box.x + box.width <= Math.min(900, bounds.x + bounds.width), `${name} stays inside the side panel: ${JSON.stringify(box)}`);
      }
      await assertUiFit(side, 'scrolling tabs cannot push panel actions outside the window');
    };
    await visible();
    await side.getByRole('button', { name: 'Enter full view', exact: true }).click();
    await side.getByRole('button', { name: 'Exit full view', exact: true }).click();
    await visible();
    // The tabs still scroll to a selected tab and all actions respond to real clicks.
    await side.getByRole('tab', { name: 'Files', exact: true }).click();
    await side.getByRole('tab', { name: 'Terminal 2', exact: true }).click();
    await side.getByRole('button', { name: 'Restart terminal', exact: true }).click();
    await side.getByRole('button', { name: 'Close side panel', exact: true }).click();
    await side.waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
