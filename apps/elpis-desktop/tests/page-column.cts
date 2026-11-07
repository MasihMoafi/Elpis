const assert = require('node:assert/strict');
const { openSettings } = require('./controls.cts');
type Locator = { evaluate<T>(fn: (element: HTMLElement) => T): Promise<T>; locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; waitFor(): Promise<void>; click(): Promise<void>; all(): Promise<Locator[]>; innerText(): Promise<string> };
type Page = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; setViewportSize(size: { width: number; height: number }): Promise<void> };
type Edges = { left: number; right: number };
type Ledger = { column: Edges; tabs: Edges; content: Edges };
type Geometry = Edges & { scrolling: boolean | null };

async function edges(locator: Locator) {
  return locator.evaluate(element => {
    const { left, right } = element.getBoundingClientRect();
    return { left, right };
  });
}

function sameEdges(actual: Edges, expected: Edges, label: string) {
  for (const edge of ['left', 'right'] as const) assert.ok(Math.abs(actual[edge] - expected[edge]) < 0.1,
    `${label}: ${edge} moved from ${expected[edge]} to ${actual[edge]}px`);
}

async function ledgerGeometry(page: Page) {
  const column = page.locator('.customize[aria-label="Customize"]');
  return {
    column: await edges(column),
    tabs: await edges(column.getByRole('radiogroup', { name: 'Customize', exact: true })),
    content: await edges(column.locator(':scope > section')),
    scrolling: await column.evaluate(element => { const parent = element.parentElement; if (!parent) throw Error('Missing parent'); return parent.scrollHeight > parent.clientHeight; }),
    gutter: await column.evaluate(element => { const parent = element.parentElement; if (!parent) throw Error('Missing parent'); return parent.offsetWidth - parent.clientWidth; }),
  };
}

function sameLedger(actual: Ledger, expected: Ledger, label: string) {
  for (const part of ['column', 'tabs', 'content'] as const) sameEdges(actual[part], expected[part], `${label} ${part}`);
}

async function sharedColumns(page: Page, width: number, record: (entry: { label: string; short: Geometry; tall: Geometry }) => void = () => {}) {
  async function geometry(locator: Locator) {
    return locator.evaluate(element => {
      const { left, right } = element.getBoundingClientRect();
      let owner: HTMLElement | null = element;
      while (owner && !/^(auto|scroll)$/.test(getComputedStyle(owner).overflowY)) owner = owner.parentElement;
      return { left, right, scrolling: owner ? owner.scrollHeight > owner.clientHeight : null };
    });
  }
  async function check(locator: Locator, label: string, mustScroll = false) {
    await locator.waitFor();
    await page.setViewportSize({ width, height: 400 });
    const short = await geometry(locator);
    await page.setViewportSize({ width, height: 5000 });
    const tall = await geometry(locator);
    sameEdges(tall, short, `${label} after losing overflow`);
    if (mustScroll) assert.equal(short.scrolling, true, `${label} must exercise overflow`);
    if (short.scrolling) assert.equal(tall.scrolling, false, `${label} must lose overflow in the tall window`);
    record({ label, short, tall });
    await page.setViewportSize({ width, height: 800 });
    return short.scrolling;
  }
  const nav = page.locator('.nav-list');
  await nav.getByRole('button', { name: 'Lab', exact: true }).click();
  await check(page.getByRole('region', { name: 'Lab', exact: true }).locator('form'), 'Lab', true);
  await nav.getByRole('button', { name: 'Workflows', exact: true }).click();
  await check(page.getByRole('region', { name: 'Workflows', exact: true }), 'Workflows');
  await page.getByRole('button', { name: 'Guide to managing agents', exact: true }).click();
  await check(page.getByRole('region', { name: 'Guide to managing agents', exact: true }), 'Agents guide', true);
  await openSettings(page);
  let settingsScrolls = false;
  for (const tab of await page.getByRole('navigation', { name: 'Settings navigation', exact: true }).getByRole('tab').all()) {
    await tab.click();
    settingsScrolls = await check(page.getByRole('tabpanel'), `Settings: ${await tab.innerText()}`) || settingsScrolls;
  }
  assert.equal(settingsScrolls, true, 'Settings must exercise its inner scrollbar');
}

module.exports = { edges, sameEdges, ledgerGeometry, sameLedger, sharedColumns };
