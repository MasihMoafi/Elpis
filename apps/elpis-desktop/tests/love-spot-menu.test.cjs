// Masih, 22 Oct: "for love spot, github, follow us and discord + library are extra; delete them."
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`Love Spot shows no GitHub, Follow us, Discord or Library, and keeps the rest of its menu (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    await f.page.setViewportSize({ width: 1280, height: 800 });
    await f.open(f.page);
    const board = f.page.locator('.love-spot-editor');
    await board.locator('.main-menu-trigger').click();
    const menu = f.page.locator('.dropdown-menu').first();
    await menu.waitFor();
    for (const name of [/GitHub/i, /Follow us/i, /Discord/i]) assert.equal(await menu.getByText(name).count(), 0, `${name} is not in the menu`);
    assert.ok(await menu.getByText(/Help/).count() > 0 && await menu.getByText(/Reset the canvas/i).count() > 0, 'the rest of the menu stays');
    await f.page.keyboard.press('Escape');
    assert.equal(await board.locator('.sidebar-trigger__label-element').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length > 0).length), 0, 'no Library button is shown');
    await f.page.setViewportSize({ width: 860, height: 760 });
    await board.locator('.mobile-misc-tools-container').waitFor();
    assert.equal(await board.locator('.sidebar-trigger__label-element').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length > 0).length), 0, 'nor in the narrow layout');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
