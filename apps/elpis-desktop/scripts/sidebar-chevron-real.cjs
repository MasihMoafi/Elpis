// V1b real-app acceptance. Run only against e2e/app.sh's throwaway app and real bridge.
// Seed COPIES of real sessions, then arrange the sidebar with real clicks:
// one project chat with agents; pinned chats with and without agents; one group chat with agents;
// one chat with agents left in Recents. Never point this script at Masih's running app.
// ELPIS_E2E_HOME=/tmp/e2e-XXXX ELPIS_PARITY_SHOTS=/path/to/shots
// ELPIS_PLAYWRIGHT_PACKAGE=/path/to/playwright node scripts/sidebar-chevron-real.cjs 9466
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { measureSidebar, checkSidebar, capture } = require('../tests/sidebar-chevron-column.test.cjs');
const { chooseTheme } = require('../tests/controls.cjs');

(async () => {
  const port = Number(process.argv[2]), home = process.env.ELPIS_E2E_HOME, shots = process.env.ELPIS_PARITY_SHOTS;
  assert.ok(port >= 9420 && port <= 9499, 'use an isolated e2e port in 9420–9499');
  assert.match(home || '', /^\/tmp\/e2e-[\w-]+$/, 'ELPIS_E2E_HOME must be the home returned by e2e/app.sh');
  assert.ok(shots, 'set ELPIS_PARITY_SHOTS to the evidence directory');
  assert.match(await fs.readFile(path.join(home, 'app.log'), 'utf8'), new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${port}/`));
  await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`), measured = [];
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the real packaged renderer must be open');
    page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1280, height: 1440 });
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const sidebar = page.locator('aside.sidebar');
    for (const toggle of await sidebar.locator('.sidebar-group-toggle[aria-expanded="false"]').all()) await toggle.click();
    const owners = [];
    for (const section of ['.project-group', 'section[aria-label="Pinned"]', '.chat-group', 'section[aria-label="Recents"]']) {
      const row = sidebar.locator(`${section} .thread-row:not(.child):has(> button[aria-expanded]:first-child)`).first();
      assert.equal(await row.count(), 1, `arrange a chat with agents in ${section} in the throwaway app`);
      owners.push(await row.getAttribute('data-thread-id'));
    }
    const plain = sidebar.locator('section[aria-label="Pinned"] .thread-row:not(.child):not(:has(> button[aria-expanded]:first-child))').first();
    assert.equal(await plain.count(), 1, 'also pin a chat without agents');
    const plainId = await plain.getAttribute('data-thread-id');
    const row = id => sidebar.locator(`.thread-row[data-thread-id="${id}"]`);
    const record = async label => {
      measured.push({ label, ...await measureSidebar(page) });
      await fs.writeFile(path.join(shots, 'v1b-real-boxes.json'), JSON.stringify(measured, null, 2));
    };
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').evaluate(element => element.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
      assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), theme === 'dark');
      for (const id of owners) {
        const current = row(id), toggle = current.getByRole('button', { name: /agents in/ });
        for (const selected of [false, true]) {
          await row(selected ? id : plainId).locator('.thread-link').click();
          assert.equal(await current.evaluate(element => element.classList.contains('active')), selected);
          for (const expanded of [false, true]) {
            if ((await toggle.getAttribute('aria-expanded') === 'true') !== expanded) await toggle.click();
            if (expanded) await current.locator('..').locator('.thread-row.child').first().waitFor();
            await current.locator('.thread-link').hover();
            await record(`${theme} ${id} ${selected ? 'selected' : 'unselected'} ${expanded ? 'expanded' : 'collapsed'}`);
          }
        }
      }
      await row(owners[0]).locator('.thread-link').click();
      await page.keyboard.down('Control');
      try {
        for (const id of owners.slice(1)) await row(id).locator('.thread-link').click();
      } finally { await page.keyboard.up('Control'); }
      assert.equal(await sidebar.locator('.thread-row.selected').count(), owners.length);
      await record(`${theme} multiselected across all four sections`);
      await row(owners[1]).locator('.thread-link').click();
      await capture(page, shots, `v1b-real-${theme}-expanded`);
      await page.reload();
      await row(owners[0]).waitFor();
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await record(`${theme} after reload`);
      await capture(page, shots, `v1b-real-${theme}-reloaded`);
    }
    const failures = [];
    for (const actual of measured) {
      try { checkSidebar(actual, actual.label); } catch (error) { failures.push(error.message); }
    }
    assert.deepEqual(failures, [], 'V1b real-app columns, agent indentation and active-bar gap');
    console.log(`V1b real-app alignment passed (${measured.length} states); evidence: ${shots}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
