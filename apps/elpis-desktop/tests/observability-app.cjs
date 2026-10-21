// Real packaged-app acceptance: node tests/observability-app.cjs CDP_PORT OUTPUT_DIRECTORY
// Run against the installed baseline first, then the package containing the CI renderer of this change.
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
    assert.ok(page, 'Elpis application window must be open');
    page.setDefaultTimeout(10000);
    const open = page.getByLabel('Open sidebar', { exact: true });
    if (await open.isVisible()) await open.click();
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    const frame = page.locator('iframe[title="Elpis dashboard"]');
    await frame.waitFor({ timeout: 8000 }).catch(() => {});
    await page.screenshot({ path: path.join(output, 'observability-click.png') });
    assert.equal(await frame.count(), 1, 'R30: the real Observability page must host the TUI dashboard');
    for (const theme of ['light', 'dark']) {
      await chooseTheme(page, theme);
      const dashboard = page.frameLocator('iframe[title="Elpis dashboard"]');
      await dashboard.getByRole('tab', { name: 'Conversations & agents', exact: true }).waitFor();
      await dashboard.getByRole('tab', { name: 'Conversations & agents', exact: true }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(output, `observability-${theme}.png`) });
      const conversations = dashboard.locator('#agents-conversation');
      const count = await conversations.locator('option').count();
      if (count) for (const index of new Set([0, Math.floor(count / 2), count - 1])) await conversations.selectOption({ index });
      else await dashboard.locator('#agents-empty').waitFor();
      for (const name of ['Conversations & agents', 'Activity', 'Workflow drafts', 'Context', 'Tokens', 'Models', /Smart Prune/, 'API keys']) {
        const tab = dashboard.getByRole('tab', { name, exact: typeof name === 'string' });
        await tab.click(); assert.equal(await tab.getAttribute('aria-selected'), 'true');
      }
      const tabs = dashboard.getByRole('tablist', { name: 'Dashboard views' });
      await tabs.getByRole('tab').first().focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await tabs.getByRole('tab').nth(1).getAttribute('aria-selected'), 'true');
      await dashboard.getByRole('button', { name: 'Pause', exact: true }).click();
      await dashboard.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      await dashboard.getByRole('button', { name: 'Refresh', exact: true }).click();
      await dashboard.getByRole('button', { name: 'Resume', exact: true }).click();
      const overflow = await frame.evaluate(element => element.getBoundingClientRect().right > innerWidth + 1);
      assert.equal(overflow, false, `${theme}: the dashboard must stay within its frame`);
    }
    await page.reload();
    await page.getByRole('button', { name: 'Observability', exact: true }).click();
    await page.frameLocator('iframe[title="Elpis dashboard"]').getByRole('tablist', { name: 'Dashboard views' }).waitFor();
    console.log('PASS: real bridge, all dashboard tabs, keyboard navigation, polling controls, reload, light and dark.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
