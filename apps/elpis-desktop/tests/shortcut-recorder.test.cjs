// S6, R38: a shortcut row says when it is listening, and the new keys replace the old ones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

test('a focused shortcut says it is listening and records the pressed keys', async () => {
  const f = await fixture({}), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await openSettings(page); await page.getByRole('tab', { name: 'Keyboard shortcuts', exact: true }).click();
    const recorder = page.getByLabel('Shortcut for New chat', { exact: true });
    await recorder.focus();
    assert.equal((await recorder.innerText()).trim(), 'Press the new keys…');
    await page.keyboard.press('Control+Alt+Shift+J');
    await page.keyboard.press('Tab');
    assert.deepEqual(await recorder.locator('kbd').allTextContents(), ['Ctrl', 'Alt', 'Shift', 'J']);
    await page.getByRole('button', { name: 'Reset shortcut for New chat', exact: true }).click();
    assert.deepEqual(await recorder.locator('kbd').allTextContents(), ['Ctrl', 'N']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
