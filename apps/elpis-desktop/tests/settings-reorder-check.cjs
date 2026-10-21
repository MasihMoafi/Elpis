// Shared by the renderer regression and the real packaged-app check. All changes use clicks, drags and keys.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openSettings } = require('./controls.cjs');

const nav = page => page.getByRole('navigation', { name: 'Settings navigation' });
const sections = page => nav(page).locator('[data-slot="section-link"]');
const names = page => sections(page).allTextContents();
async function eventually(check) {
  const until = Date.now() + 5000;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
async function drag(page, source, target, after = false, cancel = false) {
  await source.scrollIntoViewIfNeeded();
  const start = await source.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 6 });
  await target.scrollIntoViewIfNeeded();
  const end = await target.boundingBox();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height * (after ? 0.8 : 0.2), { steps: 15 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}
async function shot(page, directory, name) {
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}
async function check(page, { shots, theme = 'light' } = {}) {
  if (!await nav(page).isVisible()) await openSettings(page);
  await sections(page).first().waitFor();
  const original = await names(page);
  assert.equal(original.length, 6);
  await shot(page, shots, `before-${theme}`);
  const row = label => sections(page).filter({ hasText: label });
  const expectOrder = order => eventually(async () => assert.deepEqual(await names(page), order));
  let order = [...original];
  // First → last; a middle item → first; last → middle. Each move preserves all other relative positions.
  for (const [from, to, after] of [[0, 5, true], [2, 0, false], [5, 2, true]]) {
    const item = order[from], target = order[to];
    await drag(page, row(item), row(target), after);
    order.splice(from, 1); order.splice(order.indexOf(target) + Number(after), 0, item);
    await expectOrder(order);
  }
  await drag(page, row(order[0]), row(order.at(-1)), true, true);
  await expectOrder(order);
  // Alt moves only the focused section; boundaries are no-ops and ordinary arrows keep navigating.
  const focused = order[2];
  await row(focused).focus(); await page.keyboard.press('Alt+ArrowUp');
  [order[1], order[2]] = [order[2], order[1]]; await expectOrder(order);
  assert.equal(await row(focused).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Alt+ArrowDown');
  [order[1], order[2]] = [order[2], order[1]]; await expectOrder(order);
  for (const [label, key] of [[order[0], 'Alt+ArrowUp'], [order.at(-1), 'Alt+ArrowDown']]) {
    await row(label).focus(); await page.keyboard.press(key); await expectOrder(order);
  }
  const search = nav(page).getByRole('textbox', { name: 'Search settings' });
  await search.focus(); await page.keyboard.press('Tab');
  assert.equal(await row(order[0]).evaluate(element => element === document.activeElement), true, 'keyboard-only entry reaches the first section');
  await page.keyboard.press('Alt+ArrowDown');
  [order[0], order[1]] = [order[1], order[0]]; await expectOrder(order);
  await page.keyboard.press('Alt+ArrowUp');
  [order[0], order[1]] = [order[1], order[0]]; await expectOrder(order);
  const group = nav(page).locator('.settings-nav-group').filter({ has: page.getByRole('tab', { name: 'General', exact: true }) });
  const tabs = group.getByRole('tab'), pageOrder = await tabs.allTextContents();
  await tabs.first().focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await tabs.nth(1).evaluate(element => element === document.activeElement), true, 'plain arrows still navigate');
  await page.keyboard.press('Alt+ArrowUp');
  const reorderedPages = [pageOrder[1], pageOrder[0], ...pageOrder.slice(2)];
  await eventually(async () => assert.deepEqual(await tabs.allTextContents(), reorderedPages));
  await page.keyboard.press('Enter');
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true', 'Enter opens the focused page');
  await drag(page, tabs.last(), tabs.first());
  reorderedPages.unshift(reorderedPages.pop());
  await eventually(async () => assert.deepEqual(await tabs.allTextContents(), reorderedPages));
  // Search is editable, empty results are harmless, and filtered reorders keep hidden items in their places.
  await search.fill('no-such-setting-a70'); await page.keyboard.press('Alt+ArrowUp');
  assert.equal(await sections(page).count(), 0);
  await search.fill(''); await expectOrder(order);
  await shot(page, shots, `reordered-${theme}`);
  await page.reload();
  await page.locator('aside.sidebar .account-row').waitFor();
  if (!await nav(page).isVisible()) await openSettings(page);
  await expectOrder(order);
  await eventually(async () => assert.deepEqual(await tabs.allTextContents(), reorderedPages));
  return { sections: order, pages: reorderedPages };
}
async function verifyRestart(page, expected) {
  if (!await nav(page).isVisible()) await openSettings(page);
  await eventually(async () => assert.deepEqual(await names(page), expected.sections));
  const group = nav(page).locator('.settings-nav-group').filter({ has: page.getByRole('tab', { name: 'General', exact: true }) });
  await eventually(async () => assert.deepEqual(await group.getByRole('tab').allTextContents(), expected.pages));
}
module.exports = { check, verifyRestart, drag, shot };
