// 5–7 Nov, Masih: "we added new characters that should change with the theme." Every built-in
// palette has its own character in the pixel style he chose (lib/theme-characters.ts); Elpis keeps Matilda.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cts');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cts');

const ALL_CHARACTERS = [
  ['palette-plum', 'Punk rocker'],
  ['palette-midnight', 'Detective'],
  ['palette-paper', 'Ice'],
  ['palette-teal', 'Teal'],
  ['palette-gold', 'Gold'],
  ['palette-violet', 'Violet'],
  ['palette-silver', 'Silver'],
  ['palette-coral', 'Coral'],
  ['palette-green', 'Green'],
  ['palette-blue', 'Blue'],
  ['palette-rose', 'Rose'],
  ['palette-ink', 'Ink'],
];

test('Matilda takes each palette\'s character across all 12 themes, is selectable directly in Love Spot, and returns to Matilda on the Elpis palette', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    const pin = page.locator('.title-bar').getByRole('button', { name: 'Pin Matilda' });
    await pin.waitFor();
    const character = () => pin.locator('img[data-character]').getAttribute('data-character').catch(() => null);
    // Negative: the Elpis palette is Matilda herself.
    assert.equal(await pin.locator('img[data-character]').count(), 0, 'Elpis shows Matilda');
    for (const [palette, name] of ALL_CHARACTERS.slice(0, 3)) {
      await openSettings(page);
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await chooseOption(page.getByLabel('Theme palette', { exact: true }), palette);
      await leaveSettings(page);
      await page.waitForFunction((name: string) => document.querySelector('.title-bar img[data-character]')?.getAttribute('data-character') === name, name);
      assert.equal(await character(), name);
      assert.ok(await pin.locator('img[data-character]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), `${name}'s picture loads`);
    }
    // Pinned, her big face is the character too.
    await pin.click();
    const pinned = page.locator('section[aria-label="Pinned Matilda"]'); await pinned.waitFor();
    assert.equal(await pinned.locator('img[data-character]').getAttribute('data-character'), 'Ice');
    assert.equal(await pinned.locator('.matilda-avatar-light, .matilda-avatar-dark').count(), 0, 'no Matilda portrait under her');

    // Open Love Spot and switch through all 12 characters + Matilda using Love Spot's Character selector.
    await f.open(page);
    const picker = page.locator('.love-spot-tools').getByRole('button', { name: 'Character', exact: true });
    await picker.waitFor();
    for (const [palette, name] of ALL_CHARACTERS) {
      await picker.click();
      const item = page.locator(`[data-character-id="${palette}"]`);
      await item.waitFor();
      await item.click();
      await page.waitForFunction((expected: string) => document.querySelector('section[aria-label="Pinned Matilda"] img[data-character]')?.getAttribute('data-character') === expected, name);
      assert.equal(await pinned.locator('img[data-character]').getAttribute('data-character'), name);
      assert.ok(await pinned.locator('img[data-character]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), `${name}'s picture loads in Love Spot`);
    }

    // Selecting Matilda in Love Spot returns to the default Matilda portrait.
    await picker.click();
    await page.locator('[data-character-id="elpis"]').click();
    await page.waitForFunction(() => !document.querySelector('section[aria-label="Pinned Matilda"] img[data-character]'));
    assert.equal(await pinned.locator('img[data-character]').count(), 0, 'Matilda default restored from Love Spot');

    await pinned.locator('.matilda-face').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.title-bar img[data-character]'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`characters can be selected beside pinned Matilda without leaving the chat (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    const { page } = f;
    await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
    const pinned = page.getByRole('region', { name: 'Pinned Matilda', exact: true });
    await pinned.waitFor();
    const place = await pinned.boundingBox();
    await pinned.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
    const draft = page.getByRole('textbox', { name: 'Message Matilda', exact: true });
    await draft.fill('Keep this draft while I choose');
    const picker = pinned.getByRole('button', { name: 'Character', exact: true });
    await picker.waitFor();
    for (const [palette, name] of ALL_CHARACTERS.filter((_, index, all) => index === 0 || index === all.length - 1)) {
      await picker.focus();
      await page.keyboard.press('Enter');
      const menu = page.locator('[data-matilda-character-menu]');
      await menu.waitFor();
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 960, 'picker fits in the window');
      await menu.locator(`[data-character-id="${palette}"]`).click();
      await page.waitForFunction((expected: string) => document.querySelector('.matilda-face img[data-character]')?.getAttribute('data-character') === expected, name);
      assert.equal(await draft.inputValue(), 'Keep this draft while I choose');
      assert.equal(await draft.isVisible(), true, 'choosing a character keeps the mini chat open');
      assert.deepEqual(await pinned.boundingBox(), place, 'choosing a character keeps her place');
      assert.ok(await pinned.locator('.matilda-face img[data-character]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0));
    }
    await picker.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await draft.isVisible(), true, 'Escape closes only the character menu');
    assert.equal(await picker.evaluate((button: HTMLElement) => button === document.activeElement), true, 'menu returns focus to its button');

    await page.reload();
    await pinned.waitFor();
    assert.equal(await pinned.locator('.matilda-face img[data-character]').getAttribute('data-character'), 'Ink', 'choice survives reload');
    await picker.focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-matilda-character-menu] [data-character-id="elpis"]').click();
    await page.waitForFunction(() => !document.querySelector('.matilda-face img[data-character]'));
    assert.equal(await pinned.locator('.matilda-face .matilda-avatar-light').count() > 0, true, 'Matilda can be restored');
    await pinned.getByRole('button', { name: 'Unpin Matilda', exact: true }).focus();
    await page.keyboard.press('Enter');
    const titlePicker = page.locator('.title-bar').getByRole('button', { name: 'Character', exact: true });
    await titlePicker.click();
    await page.locator('[data-matilda-character-menu] [data-character-id="palette-paper"]').click();
    await page.waitForFunction(() => document.querySelector('.title-bar .matilda-pin img[data-character]')?.getAttribute('data-character') === 'Ice');
    assert.equal(f.turns.length, 0, 'choosing a character never sends the draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
