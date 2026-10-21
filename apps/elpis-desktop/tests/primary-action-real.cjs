// Run against a packaged app with its real bridge in a throwaway home:
// ELPIS_PLAYWRIGHT_PACKAGE=... node tests/primary-action-real.cjs PORT SCREENSHOT_DIRECTORY
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const assert = require('node:assert/strict');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');
const { colours, evidence, assertColours } = require('./primary-action-colours.cjs');

(async () => {
  const [port, directory] = process.argv.slice(2);
  if (!(Number(port) >= 9420 && Number(port) <= 9499) || !directory) throw Error('Expected throwaway app PORT (9420–9499) and SCREENSHOT_DIRECTORY');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'Elpis window opened');
    page.setDefaultTimeout(15000);
    assert.ok(await page.evaluate(() => navigator.userAgent.includes('Electron/') && typeof window.elpisDesktop?.storage?.flush === 'function'), 'packaged Electron app with its native bridge');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const measurements = [];
    for (const theme of ['light', 'dark']) {
      for (const accent of ['amber', 'orange']) {
        await openSettings(page);
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
        await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
        await leaveSettings(page);
        await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
        measurements.push(...await colours(page, theme, directory, accent));
      }
    }
    await evidence(directory, measurements);
    assertColours(measurements);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.elpisDesktop.storage.flush());
    console.log('PASS: packaged app, native bridge, five Send states in both themes and orange accents');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
