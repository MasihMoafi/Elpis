// OBSRM real packaged app: node tests/sidebar-pages-app.cjs CDP_PORT OUTPUT_DIRECTORY
// Use only an app.sh throwaway instance. Run on the installed baseline, then the CI package.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme } = require('./controls.cjs');
(async () => {
  const output = path.resolve(process.argv[3]); await fs.mkdir(output, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:'));
    assert.ok(page, 'Elpis application window must be open'); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const nav = page.locator('aside.sidebar nav[aria-label="Workspace"]');
    await nav.waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(output, 'initial.png') });
    assert.deepEqual(await nav.getByRole('button').allTextContents(), ['New chat', 'Lab', 'Workflows', 'Love Spot', 'Matilda', 'Customize']);
    const order = ['customize', 'loveSpot', 'canvas', 'experimentLab'];
    for (const position of [0, 2, 4]) {
      const legacy = [...order]; legacy.splice(position, 0, 'observability');
      await page.evaluate(async legacy => {
        const storage = window.elpisDesktop.storage;
        const saved = JSON.parse(storage.getItem('elpis-preferences-v1') || '{}');
        await storage.saveItem('elpis-preferences-v1', JSON.stringify({ ...saved, navOrder: legacy.join(','), view: 'observability' }));
      }, legacy);
      await page.reload();
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await nav.waitFor();
      assert.deepEqual(await nav.getByRole('button').allTextContents(), ['New chat', 'Customize', 'Love Spot', 'Workflows', 'Lab', 'Matilda']);
      assert.equal(await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).isVisible(), true);
    }
    for (const theme of ['light', 'dark']) {
      if (await page.locator('.app-shell').evaluate(element => element.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
      await page.screenshot({ path: path.join(output, `sidebar-${theme}.png`) });
      const fit = await nav.evaluate(element => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll('button')].every(button => {
          const row = button.getBoundingClientRect(); return row.left >= box.left && row.right <= box.right;
        });
      });
      assert.equal(fit, true, 'sidebar rows stay inside the rail');
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: 'Search or start a chat' }).fill('observability');
      assert.equal(await page.getByRole('option', { name: /^Observability$/i }).count(), 0);
      await page.keyboard.press('Escape');
      await nav.getByRole('button', { name: 'Lab', exact: true }).click();
      await page.getByRole('heading', { name: 'Lab', exact: true }).first().waitFor();
      await nav.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log('PASS OBSRM: real app/bridge; default, stale first/middle/last, saved view, reload, commands, clicks, light/dark.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
