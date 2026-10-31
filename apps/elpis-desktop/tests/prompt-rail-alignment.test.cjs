// The user-message rail stays in the existing gutter, clear of the transcript, through pane and reading-width changes.
// A narrow pane hides it rather than covering text. Exercise the exported renderer only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings } = require('./controls.cjs');

async function geometry(page) {
  return page.locator('.prompt-rail').evaluate(rail => {
    const column = document.querySelector('.chat-content').getBoundingClientRect();
    const pane = rail.parentElement.getBoundingClientRect();
    const box = rail.getBoundingClientRect();
    const right = Math.max(box.right, ...[...rail.querySelectorAll('.prompt-tick i')].map(mark => mark.getBoundingClientRect().right));
    return { gap: column.left - right, left: box.left, right, width: box.width, paneLeft: pane.left, paneRight: pane.right };
  });
}

async function aligned(page, state) {
  await page.locator('.prompt-rail').waitFor({ state: 'visible' });
  const actual = await geometry(page);
  assert.ok(Math.abs(actual.width - 28) <= 0.5, `${state}: the rail keeps its 28px width: ${JSON.stringify(actual)}`);
  assert.ok(actual.gap >= 3.5, `${state}: the rail stays clear of the text: ${JSON.stringify(actual)}`);
  assert.ok(actual.gap <= 48, `${state}: the rail sits beside the chat column, not at the window edge: ${JSON.stringify(actual)}`);
  assert.ok(actual.left >= actual.paneLeft && actual.right <= actual.paneRight,
    `${state}: the full rail hit area must stay in its chat pane: ${JSON.stringify(actual)}`);
}

async function shot(page, theme, state) {
  if (!process.env.ELPIS_PARITY_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_PARITY_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `prompt-rail-alignment-${theme}-${state}.png`) });
}

for (const colorScheme of ['light', 'dark']) test(`prompt rail stays beside the chat column through pane and reading-width changes (${colorScheme})`, async () => {
  const f = await fixture({ width: 1920, height: 800, colorScheme, showScrollbars: true });
  const { page } = f;
  try {
    await f.open('chat-a');
    const marks = page.getByRole('navigation', { name: 'User messages' }).locator('[data-slot="prompt-mark"]');
    for (const width of [1920, 1440, 1130, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await aligned(page, `sidebar open, ${width}px`);
      await marks.nth(1).hover();
      await page.waitForFunction(() => document.querySelector('[data-distance="0"] i')?.getBoundingClientRect().width >= 25.9);
      await aligned(page, `widest hovered dash, ${width}px`);
      await page.mouse.move(width - 8, 8);
    }
    await page.setViewportSize({ width: 1920, height: 800 });
    await shot(page, colorScheme, 'sidebar-open');
    await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
    for (const width of [1920, 1440, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await aligned(page, `sidebar closed, ${width}px`);
    }
    await page.setViewportSize({ width: 1920, height: 800 });
    await shot(page, colorScheme, 'sidebar-closed');
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();

    // Use the real reading setting: the rail follows the same width token.
    await openSettings(page);
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.getByRole('radiogroup', { name: 'Transcript width' }).getByRole('radio', { name: 'Wide', exact: true }).click();
    await leaveSettings(page);
    await aligned(page, 'wide transcript, sidebar open');
    assert.equal(await page.locator('.chat-content').evaluate(column => getComputedStyle(column).maxWidth), '1100px');
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await aligned(page, 'wide transcript beside the side panel');
    await shot(page, colorScheme, 'side-panel');
    await page.getByRole('button', { name: 'Enter full view', exact: true }).click();
    assert.equal(await page.locator('.prompt-rail').isVisible(), false, 'full view preserves its existing hidden rail');
    await page.getByRole('button', { name: 'Exit full view', exact: true }).click();
    await page.setViewportSize({ width: 1130, height: 800 });
    assert.equal(await page.locator('.prompt-rail').isVisible(), false, 'a narrow chat pane does not overlay marks on text');
    await page.getByRole('button', { name: 'Close side panel', exact: true }).click();

    // A real mark still scrolls to its user message after moving with the column.
    await page.setViewportSize({ width: 1920, height: 800 });
    await marks.first().click();
    await page.waitForFunction(() => document.querySelector('[data-slot="prompt-mark"][aria-current="true"]')?.getAttribute('aria-label') === 'Jump to user message 1');
    await page.waitForFunction(() => {
      const scroller = document.querySelector('.chat-scroll');
      const distance = scroller.querySelector('.user-turn').getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      return distance >= -1 && distance <= 40;
    });
    const distance = await page.locator('.chat-scroll').evaluate(scroller => {
      const prompt = scroller.querySelector('.user-turn');
      return prompt.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
    assert.ok(distance >= -1 && distance <= 40, `mark click reaches the actual first prompt (${distance}px)`);
    for (const width of [896, 760]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.locator('.prompt-rail').isVisible(), false, `${width}px keeps the existing narrow layout`);
    }
    await shot(page, colorScheme, 'narrow');
    assert.deepEqual(f.errors, []);
  } catch (error) {
    await shot(page, colorScheme, 'failure');
    throw error;
  } finally { await f.close(); }
});
