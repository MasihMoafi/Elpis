// 5 Nov, Masih: "we added new characters that should change with the theme. None are available currently." Each built-in
// palette has its own character in the pixel style he chose (lib/theme-characters.ts); Elpis keeps Matilda.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');

test('Matilda takes each palette\'s character, and back to Matilda on the Elpis palette', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    const pin = page.locator('.title-bar').getByRole('button', { name: 'Pin Matilda' });
    await pin.waitFor();
    const character = () => pin.locator('img[data-character]').getAttribute('data-character').catch(() => null);
    // Negative: the Elpis palette is Matilda herself.
    assert.equal(await pin.locator('img[data-character]').count(), 0, 'Elpis shows Matilda');
    for (const [palette, name] of [['palette-plum', 'Punk rocker'], ['palette-midnight', 'Detective'], ['palette-paper', 'Ice']]) {
      await openSettings(page);
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await chooseOption(page.getByLabel('Theme palette', { exact: true }), palette);
      await leaveSettings(page);
      await page.waitForFunction(name => document.querySelector('.title-bar img[data-character]')?.dataset.character === name, name);
      assert.equal(await character(), name);
      assert.ok(await pin.locator('img[data-character]').evaluate(img => img.complete && img.naturalWidth > 0), `${name}'s picture loads`);
    }
    // Pinned, her big face is the character too.
    await pin.click();
    const pinned = page.locator('section[aria-label="Pinned Matilda"]'); await pinned.waitFor();
    assert.equal(await pinned.locator('img[data-character]').getAttribute('data-character'), 'Ice');
    assert.equal(await pinned.locator('.matilda-avatar-light, .matilda-avatar-dark').count(), 0, 'no Matilda portrait under her');
    await pinned.locator('.matilda-face').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await openSettings(page);
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await chooseOption(page.getByLabel('Theme palette', { exact: true }), 'elpis');
    await leaveSettings(page);
    await page.waitForFunction(() => !document.querySelector('.title-bar img[data-character]'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
