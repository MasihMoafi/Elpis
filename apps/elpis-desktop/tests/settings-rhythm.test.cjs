// 29 Oct, Masih, of "Plugins & skills" pressed under the MCP servers: "I've already mentioned many many times; for you to
// hold one consistent design pattern. don't you see how these are too close?" Every page, every section, the same rhythm:
// 20px under the page header, 24px between sections.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
for (const colorScheme of ['light', 'dark']) test(`every Settings section sits 24px below the one before (${colorScheme})`, async () => {
  const f = await fixture({ width: 1300, height: 900, colorScheme, routes: {
    '/api/mcp': () => ({ version: 'm1', servers: [{ name: 'rag', enabled: true, command: 'rag-mcp', transport: 'stdio', credentials: [] }, { name: 'whispertype', enabled: false, command: 'python', transport: 'stdio', credentials: [] }], write: { available: true } }),
    '/api/tools/rag': () => ({ stages: [], keys: { openrouter: false } }),
  } }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' }); await openSettings(page);
    const tabs = await page.getByRole('tab').allInnerTexts();
    for (const name of tabs) {
      await page.getByRole('tab', { name: name.trim(), exact: true }).click(); await page.waitForTimeout(500);
      const gaps = await page.evaluate(() => { const panel = document.querySelector('.settings-page');
        const heads = [...panel.querySelectorAll('.settings-group-heading')].filter(h => h.offsetParent);
        const all = [...panel.querySelectorAll('*')].filter(e => e.offsetParent && !e.closest('.settings-group-heading') && e.getBoundingClientRect().height > 0);
        return heads.map(h => { const t = h.getBoundingClientRect().top; const above = all.filter(e => e.getBoundingClientRect().bottom <= t + 0.5 && !e.contains(h)); if (!above.length) return [h.textContent.trim().slice(0, 18), null]; const b = Math.max(...above.map(e => e.getBoundingClientRect().bottom)); const last = above.find(e => e.getBoundingClientRect().bottom === b); return [h.textContent.trim().slice(0, 18), Math.round(t - b), !!last.closest('.settings-page-header')]; }); });
      gaps.forEach(([heading, gap, underHeader]) => assert.equal(gap, underHeader ? 20 : 24, `${name.trim()}: "${heading}" sits ${gap}px below what precedes it`));
      if (process.env.ELPIS_PARITY_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_PARITY_SHOTS}/settings-${name.trim().replace(/\W+/g, '-')}-${colorScheme}.png` });
    }
  } finally { await f.close(); }
});
