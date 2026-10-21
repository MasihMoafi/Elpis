// Real packaged app only; no mock bridge. Start with the handoff app.sh first.
// ELPIS_PLAYWRIGHT_PACKAGE=/.../playwright node scripts/check-a32-config.cjs PORT /tmp/a32b-shots
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE);
const { openSettings, chooseOption, controlValue } = require('../tests/controls.cjs');

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
  const output = process.argv[3] ?? '/tmp/a32b-shots'; fs.mkdirSync(output, { recursive: true });
  assert(page, 'No Elpis app window');
  const composer = page.getByRole('textbox', { name: /Message Elpis/ });
  const back = async () => page.getByRole('button', { name: 'Back to app' }).click();
  const command = async text => { await composer.fill(text); await composer.press('Enter'); };
  try {
    await command('/config');
    await page.getByRole('heading', { name: 'Settings', level: 2, exact: true }).waitFor();
    const sections = ['Models & accounts', 'Permissions & behavior', 'Context & maintenance', 'Connections & coding', 'App & terminal', 'Advanced'];
    assert.deepEqual(await page.getByRole('heading', { level: 3 }).allTextContents(), sections);
    for (const section of sections) {
      await page.getByRole('button', { name: `Open ${section}`, exact: true }).click();
      await page.getByRole('heading', { name: section, exact: true }).waitFor();
      await back(); await command(`/config ${section}`);
      await page.getByRole('heading', { name: section, exact: true }).waitFor();
      await back(); await command('/config');
    }
    await back(); await command('/config models');
    await page.getByRole('button', { name: 'Open Configuration', exact: true }).click();
    const effort = page.getByLabel('Default reasoning effort', { exact: true });
    await effort.waitFor({ timeout: 5000 }); // Deliberately fails on the unchanged installed build.
    const savedWebSearch = await controlValue(page.getByLabel('Web search', { exact: true })) === 'cached' ? 'live' : 'cached';
    await chooseOption(page.getByLabel('Web search', { exact: true }), savedWebSearch);
    await page.getByRole('status').filter({ hasText: 'Web search saved' }).waitFor();
    await page.screenshot({ path: path.join(output, 'defaults.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Worktrees', exact: true }).click();
    await page.getByLabel('Worktree root', { exact: true }).fill('relative/path');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'absolute folder path' }).waitFor();
    await page.screenshot({ path: path.join(output, 'invalid.png'), fullPage: true });
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await page.getByRole('radio', { name: theme, exact: true }).click();
      await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
      await page.screenshot({ path: path.join(output, `${theme.toLowerCase()}.png`), fullPage: true });
      assert(await page.locator('.settings-page').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Settings overflow');
    }
    await page.reload(); await openSettings(page);
    await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    await page.getByLabel('Web search', { exact: true }).waitFor();
    assert.equal(await controlValue(page.getByLabel('Web search', { exact: true })), savedWebSearch);
    console.log('PASS six sections by list/name, saved default after reload, invalid value and themes; process restart and cross-client round trip use the keys in docs/verification/a32b-config.md');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
