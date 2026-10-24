const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const path = require('node:path');

async function dragDivider(page, edge, x, release = true) {
  const box = await edge.boundingBox(), y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  if (release) await page.mouse.up();
  return y;
}

async function dividerShot(page, name) {
  if (!process.env.A120_SCREENSHOTS) return;
  await fs.mkdir(process.env.A120_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.A120_SCREENSHOTS, `${process.env.A120_STAGE || 'candidate'}-${name}.png`) });
}

for (const colorScheme of ['light', 'dark']) {
  for (const past of [false, true]) test(`side divider release ${past ? 'past' : 'at'} right edge closes and restores width (${colorScheme})`, async () => {
    const f = await fixture({ width: 1280, height: 800, colorScheme }), { page } = f;
    try {
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await f.open('chat-a');
      const reopen = page.getByRole('button', { name: 'Show side panel', exact: true });
      await reopen.click();
      const side = page.getByRole('region', { name: 'Side panel', exact: true });
      const edge = page.getByRole('separator', { name: 'Resize side panel', exact: true });
      // Exercise both an empty panel and the browser's existing hide/select close path.
      if (!past) await side.getByRole('button', { name: 'Browser tab', exact: true }).click();
      if (!past) {
        const box = await edge.boundingBox();
        await dragDivider(page, edge, box.x + box.width / 2 - 48);
      }
      const width = (await side.boundingBox()).width;
      await dividerShot(page, `${colorScheme}-${past ? 'past' : 'at'}-open`);
      await dragDivider(page, edge, past ? 1304 : 1279, false);
      assert.equal(await side.isVisible(), true, 'closing waits until release');
      await page.mouse.up();
      await dividerShot(page, `${colorScheme}-${past ? 'past' : 'at'}-released`);
      await side.waitFor({ state: 'detached' });
      if (!past) {
        assert.equal(await page.evaluate(() => window.__browser.visible), false, 'the existing close path hides the native browser');
        assert.equal(await page.evaluate(() => window.__browser.tabs.length), 1, 'closing preserves the browser tab');
      }
      await reopen.click();
      await side.waitFor();
      assert.ok(Math.abs((await side.boundingBox()).width - width) <= 1, 'reopening restores the width from before the closing drag');
      if (!past) assert.equal(await page.evaluate(() => window.__browser.visible), true, 'reopening selects the browser again');
      await dividerShot(page, `${colorScheme}-${past ? 'past' : 'at'}-reopened`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`side divider interior drags, retreat, cancellation and keyboard only resize (${colorScheme})`, async () => {
    const f = await fixture({ width: 1280, height: 800, colorScheme }), { page } = f;
    try {
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await f.open('chat-a');
      await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
      const side = page.getByRole('region', { name: 'Side panel', exact: true });
      const edge = page.getByRole('separator', { name: 'Resize side panel', exact: true });
      const before = await side.boundingBox(), box = await edge.boundingBox();
      await dragDivider(page, edge, box.x + box.width / 2 - 64);
      assert.ok(Math.abs((await side.boundingBox()).width - (before.width + 64)) <= 1, 'an interior drag resizes normally');
      await dragDivider(page, edge, 1260);
      assert.equal(Math.round((await side.boundingBox()).width), 200, 'an interior release below minimum clamps without closing');
      const y = await dragDivider(page, edge, 1304, false);
      await page.mouse.move(1260, y);
      await page.mouse.up();
      assert.equal(await side.isVisible(), true, 'reaching the edge then retreating does not close');
      await dragDivider(page, edge, 1304, false);
      await edge.dispatchEvent('pointercancel', { pointerId: 1 });
      await page.mouse.up();
      assert.equal(await side.isVisible(), true, 'a cancelled edge drag does not close');
      await edge.focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(Math.round((await side.boundingBox()).width), 232, 'Left still widens by 32px');
      await page.keyboard.press('ArrowRight');
      assert.equal(Math.round((await side.boundingBox()).width), 200, 'Right still narrows by 32px');
      await dividerShot(page, `${colorScheme}-interior`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`sidebar divider closes toward left edge and restores width (${colorScheme})`, async () => {
    const f = await fixture({ width: 1280, height: 800, colorScheme }), { page } = f;
    try {
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      const sidebar = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
      const edge = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
      await edge.focus();
      await page.keyboard.press('ArrowRight');
      const width = (await sidebar.boundingBox()).width;
      await dragDivider(page, edge, 0);
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      assert.ok(Math.abs((await sidebar.boundingBox()).width - width) <= 1, 'the shared left-edge gesture also restores the sidebar width');
      await page.reload();
      await edge.waitFor();
      assert.ok(Math.abs((await sidebar.boundingBox()).width - width) <= 1, 'the closing drag does not overwrite the stored sidebar width');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

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
