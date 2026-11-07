// Shared by the renderer regression and the real packaged-app check. All changes use clicks, drags and keys.
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openSettings } = require('./controls.cjs');

type Box = { x: number; y: number; width: number; height: number };
type Locator = {
  getByRole(role: string, options?: object): Locator; locator(selector: string): Locator; filter(options: object): Locator;
  first(): Locator; last(): Locator; nth(index: number): Locator; allTextContents(): Promise<string[]>;
  isVisible(): Promise<boolean>; count(): Promise<number>; waitFor(options?: object): Promise<void>; focus(): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>; boundingBox(): Promise<Box | null>; getAttribute(name: string): Promise<string | null>;
  fill(value: string): Promise<void>; evaluate<T>(fn: (element: HTMLElement) => T): Promise<T>;
};
type Page = {
  getByRole(role: string, options?: object): Locator; locator(selector: string): Locator;
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
  keyboard: { press(key: string): Promise<void> }; screenshot(options: { path: string }): Promise<void>; reload(): Promise<void>;
};
function swap(items: string[], a: number, b: number) {
  const first = items[a], second = items[b]; assert.ok(first !== undefined && second !== undefined);
  items[a] = second; items[b] = first;
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings navigation' });
const sections = (page: Page) => nav(page).locator('[data-slot="section-link"]');
const names = (page: Page) => sections(page).allTextContents();
async function eventually<T>(check: () => Promise<T>) {
  const until = Date.now() + 5000;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
async function drag(page: Page, source: Locator, target: Locator, after = false, cancel = false, during?: () => Promise<void>) {
  await source.scrollIntoViewIfNeeded();
  const start = await source.boundingBox();
  assert.ok(start);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2, { steps: 6 });
  await target.scrollIntoViewIfNeeded();
  const end = await target.boundingBox();
  assert.ok(end);
  await page.mouse.move(end.x + end.width / 2, end.y + end.height * (after ? 0.8 : 0.2), { steps: 15 });
  if (during) await during();
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}
async function shot(page: Page, directory: string | undefined, name: string) {
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}
async function check(page: Page, { shots, theme = 'light' }: { shots?: string; theme?: string } = {}) {
  if (!await nav(page).isVisible()) await openSettings(page);
  await sections(page).first().waitFor();
  const original = await names(page);
  assert.deepEqual([...original].sort(), ['Models & accounts', 'Permissions & behavior', 'Context & maintenance', 'Connections & coding', 'App & terminal', 'Advanced'].sort());
  await shot(page, shots, `before-${theme}`);
  const row = (label: string | undefined) => sections(page).filter({ hasText: label });
  const expectOrder = (order: string[]) => eventually(async () => assert.deepEqual(await names(page), order));
  const order = [...original];
  // First → last; a middle item → first; last → middle. Each move preserves all other relative positions.
  for (const [from, to, after] of [[0, 5, true], [2, 0, false], [5, 2, true]] as const) {
    const item = order[from], target = order[to];
    assert.ok(item && target);
    await drag(page, row(item), row(target), after);
    order.splice(from, 1); order.splice(order.indexOf(target) + Number(after), 0, item);
    await expectOrder(order);
  }
  await drag(page, row(order[0]), row(order.at(-1)), true, true);
  await expectOrder(order);
  // Alt moves only the focused section; boundaries are no-ops and ordinary arrows keep navigating.
  const focused = order[2];
  await row(focused).focus(); await page.keyboard.press('Alt+ArrowUp');
  swap(order, 1, 2); await expectOrder(order);
  assert.equal(await row(focused).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Alt+ArrowDown');
  swap(order, 1, 2); await expectOrder(order);
  for (const [label, key] of [[order[0], 'Alt+ArrowUp'], [order.at(-1), 'Alt+ArrowDown']] as const) {
    await row(label).focus(); await page.keyboard.press(key); await expectOrder(order);
  }
  const search = nav(page).getByRole('textbox', { name: 'Search settings' });
  await search.focus(); await page.keyboard.press('Tab');
  assert.equal(await row(order[0]).evaluate(element => element === document.activeElement), true, 'keyboard-only entry reaches the first section');
  await page.keyboard.press('Alt+ArrowDown');
  swap(order, 0, 1); await expectOrder(order);
  await page.keyboard.press('Alt+ArrowUp');
  swap(order, 0, 1); await expectOrder(order);
  const group = nav(page).locator('.settings-nav-group').filter({ has: page.getByRole('tab', { name: 'General', exact: true }) });
  const tabs = group.getByRole('tab'), pageOrder = await tabs.allTextContents();
  await tabs.first().focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await tabs.nth(1).evaluate(element => element === document.activeElement), true, 'plain arrows still navigate');
  await page.keyboard.press('Alt+ArrowUp');
  const [firstPage, secondPage] = pageOrder; assert.ok(firstPage && secondPage);
  const reorderedPages = [secondPage, firstPage, ...pageOrder.slice(2)];
  await eventually(async () => assert.deepEqual(await tabs.allTextContents(), reorderedPages));
  await page.keyboard.press('Enter');
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true', 'Enter opens the focused page');
  await drag(page, tabs.last(), tabs.first());
  const lastPage = reorderedPages.pop(); assert.ok(lastPage); reorderedPages.unshift(lastPage);
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
async function verifyRestart(page: Page, expected: { sections: string[]; pages: string[] }) {
  if (!await nav(page).isVisible()) await openSettings(page);
  await eventually(async () => assert.deepEqual(await names(page), expected.sections));
  const group = nav(page).locator('.settings-nav-group').filter({ has: page.getByRole('tab', { name: 'General', exact: true }) });
  await eventually(async () => assert.deepEqual(await group.getByRole('tab').allTextContents(), expected.pages));
}
module.exports = { check, verifyRestart, drag, shot };
