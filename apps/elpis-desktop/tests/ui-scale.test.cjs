// 30 Oct, Masih: "The sizes and distances being uniform. Modeled by the chatgpt app." One scale on every page
// (DESIGN.md §2): a button's glyph is --icon-size (16), the title bar and the side panel's tabs are 28px, the side
// panel's header is as tall as the chat header (52), and only one error banner shows at a time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`one icon size, one control height and one error at a time (${colorScheme})`, async () => {
  const f = await fixture({ width: 1300, height: 860, colorScheme }), { page } = f;
  try {
    await page.getByRole('button', { name: 'Show side panel' }).click();
    const side = page.getByRole('region', { name: 'Side panel' });
    for (const kind of ['Files', 'Changes']) { await side.getByRole('button', { name: 'New side panel tab', exact: true }).click(); await page.getByRole('menuitem', { name: kind, exact: true }).click(); }
    await page.waitForTimeout(300);
    const found = await page.evaluate(() => {
      const height = e => Math.round(e.getBoundingClientRect().height);
      const glyphs = [...document.querySelectorAll('.title-bar button svg, .nav-list button svg, .workspace-header button svg, .side-header button svg')].filter(s => s.getBoundingClientRect().width && !s.closest('.model-select'));
      return {
        glyphs: [...new Set(glyphs.map(s => Math.round(s.getBoundingClientRect().width)))],
        titleBar: [...new Set([...document.querySelectorAll('.title-bar button')].filter(b => b.offsetParent).map(height))],
        tabs: [...new Set([...document.querySelectorAll('.side-header .task-tab > button[role="tab"]')].map(height))],
        sideHeader: height(document.querySelector('.side-header')), chatHeader: height(document.querySelector('.workspace-header')),
      };
    });
    assert.deepEqual(found.glyphs, [16], 'every glyph in a title-bar, sidebar, header or side-panel button is 16px');
    assert.deepEqual(found.titleBar, [28], 'Back, Forward and the menus are one height');
    assert.deepEqual(found.tabs, [28], 'side-panel tabs use the shared control height');
    assert.equal(found.sideHeader, found.chatHeader, 'the side panel header lines up with the chat header');
    await page.evaluate(() => { const list = document.querySelector('.workspace-notices'); for (const text of ['First failure', 'Second failure']) { const banner = document.createElement('div'); banner.className = 'error-banner'; banner.setAttribute('role', 'alert'); banner.textContent = text; list.append(banner); } });
    assert.deepEqual(await page.locator('.workspace-notices > .error-banner[role="alert"]:visible').allInnerTexts(), ['First failure'], 'one error shows; the next waits until it is dismissed');
  } finally { await f.close(); }
});
