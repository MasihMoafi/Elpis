// Masih, 30 Oct: "no half-chat sizes should appear". The sidebar's chat list keeps its rows whole (sidebar-sections test);
// the Settings navigation, the same kind of list, must too: in a short window its last tab was cut in half.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings } = require('./controls.cjs');

const cutTabs = (page: { locator: (selector: string) => { evaluate: (fn: (nav: HTMLElement) => string[]) => Promise<string[]> } }) => page.locator('.settings-nav').evaluate((nav: HTMLElement) => {
  const view = nav.getBoundingClientRect();
  return [...nav.querySelectorAll('[role="tab"]')].map(tab => ({ name: (tab.textContent ?? '').trim(), box: tab.getBoundingClientRect() }))
    .filter(({ box }) => box.height && box.bottom > view.top + .5 && box.top < view.bottom - .5 && (box.top < view.top - .5 || box.bottom > view.bottom + .5))
    .map(({ name, box }) => `${name} ${Math.round(box.top)}-${Math.round(box.bottom)} in ${Math.round(view.top)}-${Math.round(view.bottom)}`);
});

for (const colorScheme of ['light']) test(`Settings navigation never shows a part of a tab (${colorScheme})`, async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, colorScheme, width: 1130, height: 660 }), { page } = f;
  try {
    await f.open('chat-a');
    await openSettings(page);
    for (const height of [660, 620, 700, 590]) {
      await page.setViewportSize({ width: 1130, height });
      await page.waitForTimeout(350);
      assert.deepEqual(await cutTabs(page), [], `at rest, ${height}px`);
      const max = await page.locator('.settings-nav').evaluate((nav: HTMLElement) => nav.scrollHeight - nav.clientHeight);
      for (const top of [Math.round(max / 2), max]) {
        await page.locator('.settings-nav').evaluate((nav: HTMLElement, value: number) => { nav.scrollTop = value; }, top);
        await page.waitForTimeout(450);
        assert.deepEqual(await cutTabs(page), [], `scrolled to ${top} of ${max}, ${height}px`);
      }
      if (height === 660 && process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/settings-nav-${colorScheme}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
