// Masih, 30 Oct: "no half-chat sizes should appear". The sidebar's chat list keeps its rows whole (sidebar-sections test);
// the Settings navigation, the same kind of list, must too: in a short window its last tab was cut in half.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings } = require('./controls.cts');

const cutTabs = (page: { locator: (selector: string) => { evaluate: (fn: (nav: HTMLElement) => string[]) => Promise<string[]> } }) => page.locator('.settings-nav [role="tablist"]').evaluate((nav: HTMLElement) => {
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
      const max = await page.locator('.settings-nav [role="tablist"]').evaluate((nav: HTMLElement) => nav.scrollHeight - nav.clientHeight);
      for (const top of [Math.round(max / 2), max]) {
        await page.locator('.settings-nav [role="tablist"]').evaluate((nav: HTMLElement, value: number) => { nav.scrollTop = value; }, top);
        await page.waitForTimeout(450);
        assert.deepEqual(await cutTabs(page), [], `scrolled to ${top} of ${max}, ${height}px`);
      }
      if (height === 660 && process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/settings-nav-${colorScheme}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 10 Nov: "Back to app", "Settings" and Search touched in his 750 px window, and so did every section heading.
test('Settings title and section headings keep room around them at every window height', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1100, height: 750 }), { page } = f;
  try {
    await f.open('chat-a');
    await openSettings(page);
    for (const height of [600, 750, 1000, 1300]) {
      await page.setViewportSize({ width: 1100, height });
      await page.waitForTimeout(350);
      const gaps = await page.locator('.settings-nav').evaluate((nav: HTMLElement) => {
        const box = (el: Element | null) => el!.getBoundingClientRect();
        const title = box(nav.querySelector('.settings-title'));
        // The room above a heading's text: from the row above to the text (a heading is one row, its text at the foot).
        const headings = [...nav.querySelectorAll('.settings-section-link')].map(h => {
          const above = h.parentElement!.previousElementSibling?.lastElementChild;
          const range = document.createRange();
          range.selectNodeContents(h);
          return above ? range.getBoundingClientRect().top - box(above).bottom : 99;
        });
        return { above: title.top - box(nav.querySelector('.back-link')).bottom, below: box(nav.querySelector('.search-field')).top - title.bottom, headings };
      });
      assert.ok(gaps.above >= 8 && gaps.below >= 8, `${height}px: title gaps ${JSON.stringify(gaps)}`);
      assert.ok(gaps.headings.every((gap: number) => gap >= 12), `${height}px: heading gaps ${gaps.headings.join(', ')}`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
