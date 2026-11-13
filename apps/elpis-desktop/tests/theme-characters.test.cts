// 5–7 Nov, Masih: "we added new characters that should change with the theme." Every built-in
// palette has its own character in the pixel style he chose (lib/theme-characters.ts); Elpis keeps Matilda.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cts');
const { openSettings, leaveSettings, chooseOption, untilTrue } = require('./controls.cts');

const ALL_CHARACTERS = [
  ['palette-plum', 'Punk rocker'],
  ['palette-midnight', 'Detective'],
  ['palette-paper', 'Ice'],
  ['palette-teal', 'Teal'],
  ['palette-gold', 'Gold'],
  ['palette-violet', 'Violet'],
  ['palette-coral', 'Coral'],
  ['palette-green', 'Green'],
  ['palette-blue', 'Blue'],
  ['palette-rose', 'Rose'],
  ['palette-ink', 'Ink'],
];

test('Matilda takes each palette\'s character across all 11 character themes, is selectable directly in Love Spot, and returns to Matilda on the Elpis palette', async () => {
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
      if (name === 'Ice') {
        const backgrounds = await page.locator('html').evaluate((root: HTMLElement) =>
          ['light', 'dark'].map(mode => root.style.getPropertyValue(`--palette-${mode}-background`).trim()));
        assert.deepEqual(backgrounds, ['#f7f8fa', '#101215'], 'Ice carries Silver colours with her portrait');
      }
    }
    // Pinned, her big face is the character too.
    await pin.click();
    const pinned = page.locator('section[aria-label="Pinned Matilda"]'); await pinned.waitFor();
    assert.equal(await pinned.locator('img[data-character]').getAttribute('data-character'), 'Ice');
    assert.equal(await pinned.locator('.matilda-avatar-light, .matilda-avatar-dark').count(), 0, 'no Matilda portrait under her');

    // Open Love Spot and switch through all 11 characters + Matilda using Love Spot's Character selector.
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
      const selected = menu.locator('[aria-current="true"]');
      assert.equal(await selected.count(), 1, 'one character is visibly chosen');
      assert.equal(await selected.getAttribute('data-character-id'), palette === 'palette-plum' ? 'elpis' : 'palette-plum');
      assert.equal(await menu.locator('svg').count(), 0, 'portraits replace the tick column');
      assert.equal(await menu.locator('[data-character-id]').count(), ALL_CHARACTERS.length + 1, 'every character and Matilda');
      assert.equal(await menu.locator('[data-character-id]:not(:has(img))').count(), 0, 'every character keeps its portrait');
      const selectedStyle = await selected.evaluate((row: HTMLElement) => {
        const style = getComputedStyle(row);
        return { weight: Number(style.fontWeight), background: style.backgroundColor };
      });
      assert.ok(selectedStyle.weight >= 600, 'chosen name is bold');
      assert.notEqual(selectedStyle.background, 'rgba(0, 0, 0, 0)', 'chosen row has a tint');
      assert.ok(await menu.locator('[data-character-id]:not([aria-current])').first().evaluate((row: HTMLElement) => Number(getComputedStyle(row).fontWeight) < 600), 'other names keep normal weight');
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
    // The menu gives the focus back once it has closed, a frame after Escape (Base UI's FloatingFocusManager).
    await untilTrue(() => picker.evaluate((button: HTMLElement) => button === document.activeElement), 'menu returns focus to its button');

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

// 13 Nov, Masih, on the Create your own form: "this give your char a name shouldn't be at the bottom!" and "why is
// there the faces saved? if I'm to create a new one there will be a new face". Each reason sits at its field; a new
// character starts with an empty face and gets hers from the file he chooses.
test('a new character starts with an empty face, gets it from the chosen image, and each missing field says so at that field', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    const face = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    await page.route('**/api/characters/sources', (route: { fulfill(options: object): Promise<unknown> }) => route.fulfill({ json: { sources: [], unavailable: [] } }));
    await page.route('**/api/characters/portrait', (route: { fulfill(options: object): Promise<unknown> }) => route.fulfill({ json: { image: face } }));
    await page.locator('.title-bar').getByRole('button', { name: 'Character', exact: true }).click();
    await page.locator('[data-matilda-character-menu]').getByRole('menuitem', { name: 'Create your own', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create your own', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('img').count(), 0, 'no saved face, Matilda\'s or another, is shown');
    assert.equal(await dialog.getByRole('img', { name: 'No portrait yet', exact: true }).count(), 1, 'an empty face instead');
    assert.equal(await dialog.getByLabel('Character portrait', { exact: true }).count(), 0, 'no select of saved faces');
    const name = dialog.getByLabel('Name', { exact: true }), file = dialog.getByLabel('Choose portrait image', { exact: true });
    const nameHint = dialog.locator('#character-name-hint');
    assert.equal(await nameHint.innerText(), 'Give your character a name.');
    assert.match(await name.getAttribute('aria-describedby') ?? '', /character-name-hint/, 'the name field is described by its reason');
    const [nameBox, hintBox, fileBox] = await Promise.all([name.boundingBox(), nameHint.boundingBox(), file.boundingBox()]);
    assert.ok(nameBox && hintBox && fileBox && hintBox.y >= nameBox.y + nameBox.height && hintBox.y < fileBox.y, 'the reason sits directly under Name');
    const footer = dialog.locator('[data-slot="alert-dialog-footer"]');
    assert.equal(await footer.getByText('Give your character a name.').count(), 0, 'not at the bottom');
    const save = dialog.getByRole('button', { name: 'Save character', exact: true });
    assert.equal(await save.isDisabled(), true);
    assert.match(await save.getAttribute('aria-describedby') ?? '', /character-name-hint/, 'Save names the reason at the field');
    assert.equal(await dialog.locator('#character-description-hint').innerText(), 'Describe your character first.');
    assert.equal(await dialog.locator('#character-portrait-hint').innerText(), 'Choose an image for her face.');
    await dialog.getByLabel('Description', { exact: true }).fill('A patient astronomer');
    await name.fill('Vega');
    assert.equal(await nameHint.count(), 0, 'a named character has no name reason');
    assert.equal(await save.isDisabled(), true, 'still no face');
    await file.setInputFiles({ name: 'vega.png', mimeType: 'image/png', buffer: Buffer.from(face.slice(face.indexOf(',') + 1), 'base64') });
    await dialog.getByRole('img', { name: 'Character preview', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('img', { name: 'Character preview', exact: true }).getAttribute('src'), face, 'her face is the chosen image');
    assert.equal(await dialog.getByRole('img', { name: 'No portrait yet', exact: true }).count(), 0);
    assert.equal(await save.isDisabled(), false);
    assert.equal(await save.getAttribute('aria-describedby'), null);
    await name.fill('');
    assert.equal(await nameHint.innerText(), 'Give your character a name.', 'clearing the name brings its reason back at the field');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
