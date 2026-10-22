// Real packaged-app check. Start an isolated app with e2e/app.sh, then:
// ELPIS_PLAYWRIGHT_PACKAGE=... node tests/page-column-app.cjs PORT /tmp/e2e-HOME SHOTS [WIDTH] [light|dark]
// No request interception or replacement of the desktop bridge. Seeds only synthetic skills in the throwaway home.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, leaveSettings } = require('./controls.cjs');
const { ledgerGeometry, sameLedger, sharedColumns } = require('./page-column.cjs');

(async () => {
  const [port, home, shots, widthText = '2000', theme = 'light'] = process.argv.slice(2);
  assert.match(home || '', /^\/tmp\/e2e-[\w-]+$/, 'use the throwaway home printed by e2e/app.sh');
  assert.ok(['900', '1280', '2000'].includes(widthText));
  assert.ok(['light', 'dark'].includes(theme));
  for (let index = 1; index <= 40; index++) {
    const directory = path.join(home, '.agents', 'skills', `a126-column-${String(index).padStart(2, '0')}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: a126-column-${index}\ndescription: Synthetic A126 layout skill for checking a long scrolling Customize column.\n---\nUse only in the A126 layout check.\n`);
  }
  await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://127.0.0.1:'));
    assert.ok(page, 'real packaged renderer window');
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width: Number(widthText), height: 800 });
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await leaveSettings(page);
    if (await page.locator('html').evaluate(element => element.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customize' && response.request().method() === 'GET');
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    const data = await (await response).json();
    assert.ok(data.skills.data.filter(skill => skill.name.startsWith('a126-column-')).length >= 40, 'real engine must discover the synthetic skills');
    await page.locator('.customize-item').last().waitFor();
    const tabs = page.getByRole('radiogroup', { name: 'Customize', exact: true });
    await tabs.getByRole('radio', { name: 'Skills', exact: true }).click();
    const long = await ledgerGeometry(page);
    assert.equal(long.scrolling, true);
    assert.ok(long.gutter > 0, 'acceptance requires native scrollbars');
    await page.screenshot({ path: path.join(shots, `app-skills-${theme}-${widthText}.png`) });
    for (const index of [0, 19, 39]) await page.locator('.customize-item').nth(index).scrollIntoViewIfNeeded();
    await tabs.scrollIntoViewIfNeeded();
    const snapshots = { Skills: long };
    for (const name of ['Plugins', 'Connectors', 'Skills']) {
      await tabs.getByRole('radio', { name, exact: true }).click();
      await page.getByRole('heading', { name: `Your ${name.toLowerCase()}`, exact: true }).waitFor();
      snapshots[name] = await ledgerGeometry(page);
      await page.screenshot({ path: path.join(shots, `app-${name.toLowerCase()}-${theme}-${widthText}.png`) });
    }
    const file = path.join(shots, `app-edges-${theme}-${widthText}.json`);
    await fs.writeFile(file, JSON.stringify(snapshots, null, 2) + '\n');
    console.log(JSON.stringify(snapshots));
    assert.equal(snapshots.Plugins.scrolling, false, 'Plugins must be short in the throwaway profile');
    for (const name of ['Plugins', 'Connectors', 'Skills']) sameLedger(snapshots[name], long, name);
    await page.reload();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: 'Skills', exact: true }).click();
    await page.locator('.customize-item').last().waitFor();
    sameLedger(await ledgerGeometry(page), long, 'after reload');
    await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: 'Plugins', exact: true }).click();
    sameLedger(await ledgerGeometry(page), long, 'empty tab after reload');
    const shells = [];
    await sharedColumns(page, Number(widthText), value => shells.push(value));
    await fs.writeFile(path.join(shots, `app-shells-${theme}-${widthText}.json`), JSON.stringify(shells, null, 2) + '\n');
    console.log(`PASS real bridge: ${theme}, ${widthText}px; ${file}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
