// Real-app acceptance, with the real bridge in the throwaway home started by e2e/app.sh.
// ELPIS_PLAYWRIGHT_PACKAGE=... node tests/side-panel-edge-electron.cjs PORT SHOTDIR [before|after]
// Run against the installed package first, then the CI package. No mocks, provider calls or profile edits.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme } = require('./controls.cjs');

async function main() {
  const [port, shots, phase = 'after'] = process.argv.slice(2);
  assert.ok(port && shots, 'usage: side-panel-edge-electron.cjs PORT SHOTDIR [before|after]');
  await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const failures = [];
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the real Elpis window is open');
    page.setDefaultTimeout(6000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const side = page.getByRole('region', { name: 'Side panel', exact: true });
    const edge = page.getByRole('separator', { name: 'Resize side panel', exact: true });
    const reopen = page.getByRole('button', { name: 'Show side panel', exact: true });
    const width = async () => (await side.boundingBox()).width;
    const drag = async (divider, x) => {
      const box = await divider.boundingBox(), y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.up();
    };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1, `${actual}px should equal ${expected}px`);
    for (const scheme of ['light', 'dark']) {
      const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
      if (dark !== (scheme === 'dark')) await chooseTheme(page, scheme);
      try {
        if (!await side.isVisible()) await reopen.click();
        const initial = await width(), box = await edge.boundingBox();
        await drag(edge, box.x + box.width / 2 + 48);
        near(await width(), initial - 48);
        await edge.focus(); await page.keyboard.press('ArrowLeft');
        near(await width(), initial - 16);
        await page.keyboard.press('ArrowRight');
        near(await width(), initial - 48);
        for (const offset of [-1, 24]) {
          const before = await width();
          await page.screenshot({ path: path.join(shots, `${phase}-native-${scheme}-${offset}-open.png`) });
          await drag(edge, await page.evaluate(offset => innerWidth + offset, offset));
          await page.screenshot({ path: path.join(shots, `${phase}-native-${scheme}-${offset}-released.png`) });
          await side.waitFor({ state: 'detached' });
          await reopen.click(); await side.waitFor();
          near(await width(), before);
          await page.screenshot({ path: path.join(shots, `${phase}-native-${scheme}-${offset}-reopened.png`) });
        }
        const sidebar = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
        const left = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
        const before = (await sidebar.boundingBox()).width;
        await drag(left, 0);
        await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
        near((await sidebar.boundingBox()).width, before);
        console.log(`PASS ${scheme}: interior resize, keyboard, right edge/past edge, reopen width, left edge`);
      } catch (error) { failures.push(`${scheme}: ${error.message}`); }
    }
  } finally { await browser.close(); }
  assert.deepEqual(failures, []);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
