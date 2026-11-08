// Rule R12 on every page (Masih, 20 Oct: "the buttons must be navigable via arrow keys; they aren't in settings page").
// For every visible, enabled button or link on the chat, every Settings section and Workflows, an arrow key must move
// focus to another control in the same area (its dialog, region, nav, aside, main, header, footer, form or labelled
// section; a tab list or radio group inside that area counts as inside it), whenever that area holds another control. This test does not reuse lib/arrow-keys.ts: it presses the real
// keys and reads where focus went. Menu buttons open their menu with the arrows and are left out; a closed drop-down
// list is an ordinary button here, which Enter or Space opens (Masih, 20 Oct: arrowing through Settings › General
// stopped at Speed). Text fields, the board, the drawing, editors and terminals keep their own keys.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings, openPatterns } = require('./controls.cts');

/** Every checked control on the page as it is now; returns the ones no arrow key moved away from. */

test('a closed drop-down passes the arrow keys on; Enter and Space open it', { timeout: 60000 }, async () => {
  const f = await fixture({ desktop: true });
  try {
    await f.open('chat-a');
    await openSettings(f.page);
    await f.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'General', exact: true }).click();
    const send = f.page.getByRole('combobox', { name: 'Send shortcut', exact: true }), list = f.page.getByRole('listbox');
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await send.focus();
      await f.page.keyboard.press(key);
      // Send shortcut is first in its group, so Up stays put there (at an end nothing moves); neither key opens it.
      if (key === 'ArrowDown') assert.equal(await send.evaluate((el: Element) => el === document.activeElement), false, 'ArrowDown leaves Send shortcut');
      assert.equal(await list.count(), 0, `${key} does not open Send shortcut`);
    }
    for (const key of ['Enter', ' ']) {
      await send.focus();
      await f.page.keyboard.press(key);
      await list.waitFor({ timeout: 3000 });
      await f.page.keyboard.press('Escape');
      await list.waitFor({ state: 'detached', timeout: 3000 });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('pending sidebar navigation stops when focus leaves its control and activates when focus stays', async () => {
  const time = new Date();
  const f = await fixture({ desktop: true, clockTime: time });
  try {
    const { page } = f;
    await f.open('chat-a');
    const nav = page.locator('aside.sidebar nav[aria-label="Workspace"]');
    const workflows = nav.getByRole('button', { name: 'Workflows', exact: true });
    const loveSpot = nav.getByRole('button', { name: 'Love Spot', exact: true });
    await workflows.click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    await openPatterns(canvas);
    const sources = canvas.getByRole('link', { name: 'Sources for Debate + judge', exact: true });
    await sources.waitFor();
    await page.clock.pauseAt(new Date(time.getTime() + 60_000));

    await workflows.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await loveSpot.evaluate((element: Element) => element === document.activeElement), true);
    await sources.focus();
    await page.clock.runFor(1000);
    assert.equal(await canvas.isVisible(), true, 'a stale sidebar schedule cannot replace the focused page');
    assert.equal(await sources.evaluate((element: Element) => element === document.activeElement), true, 'focus remains on the connected workflow control');

    await workflows.focus(); await page.keyboard.press('ArrowDown');
    await sources.focus(); await loveSpot.focus();
    await page.clock.runFor(1000);
    assert.equal(await canvas.isVisible(), true, 'returning to the old destination does not revive a cancelled schedule');

    await workflows.focus(); await page.keyboard.press('ArrowDown');
    await page.clock.runFor(1000);
    await page.getByRole('heading', { name: 'Love Spot', exact: true }).waitFor();
    assert.equal(await loveSpot.evaluate((element: Element) => element === document.activeElement), true, 'held focus still opens its destination without Enter');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
