// Masih, 22 Oct: arrow keys must change the page by the stroke, as in ChatGPT, in the sidebar and in Settings, with no Enter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const title = page => page.locator('.workspace-header h1');
const nav = page => page.locator('aside.sidebar nav[aria-label="Workspace"]');

test('in the sidebar an arrow opens the page it reaches, but never New chat, the search field or a switch', async () => {
  const f = await fixture();
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await nav(page).getByRole('button', { name: 'Ledger', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.workspace-header h1')?.textContent === 'Ledger');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.workspace-header h1')?.textContent === 'Love Spot');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Love Spot', 'focus is on the page it opened');
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineOffset), '-2px', 'the focus ring is drawn inside the row, where the column does not clip it');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim().replace(/Ctrl\+N$/, '')), 'New chat', 'three more arrows reach New chat');
    await page.waitForTimeout(400);
    assert.equal(await title(page).innerText(), 'Love Spot', 'pages passed in quick strokes do not open, and New chat is not activated');
    const switchControl = page.getByRole('switch', { name: 'Session Manager', exact: true }), before = await switchControl.getAttribute('aria-checked');
    await nav(page).getByRole('button', { name: 'Ledger', exact: true }).focus();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    assert.equal(await switchControl.getAttribute('aria-checked'), before, 'reaching the switch does not flip it');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('in Settings an arrow selects the section it reaches', async () => {
  const f = await fixture();
  try {
    const { page } = f;
    await openSettings(page);
    const tabs = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab');
    await tabs.first().click();
    await page.waitForTimeout(150);
    const first = await tabs.first().innerText();
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement.textContent.trim());
    assert.notEqual(second, first.trim());
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true', 'the tab it reached is the selected one');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), first.trim());
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
