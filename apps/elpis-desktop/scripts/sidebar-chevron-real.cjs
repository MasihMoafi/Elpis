// V1 acceptance: connect only to a packaged app started by the isolated e2e/app.sh helper.
// Usage: ELPIS_E2E_HOME=/tmp/e2e-XXXX ELPIS_PARITY_SHOTS=/path/to/shots
//   ELPIS_PLAYWRIGHT_PACKAGE=/path/to/playwright node scripts/sidebar-chevron-real.cjs 9461
// Seed that home's sessions with copies containing a chat with agents and one other root chat.
// In the app, add the seed's project folder, then move the parent chat into it.
// Optional ELPIS_V1_PROJECT / ELPIS_V1_CHAT select title prefixes (defaults: match / Didar).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { measure, check } = require('../tests/sidebar-chevron-column.test.cjs');
const { chooseTheme } = require('../tests/controls.cjs');

const prefix = value => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
(async () => {
  const port = Number(process.argv[2]), home = process.env.ELPIS_E2E_HOME, shots = process.env.ELPIS_PARITY_SHOTS;
  assert.ok(port >= 9420 && port <= 9499, 'use an isolated e2e port in 9420–9499');
  assert.match(home || '', /^\/tmp\/e2e-[\w-]+$/, 'ELPIS_E2E_HOME must be the home returned by e2e/app.sh');
  assert.ok(shots, 'set ELPIS_PARITY_SHOTS to the evidence directory');
  // The launcher wrote this log in the throwaway home; reject an unrelated CDP endpoint.
  assert.match(await fs.readFile(path.join(home, 'app.log'), 'utf8'), new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${port}/`));
  await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const measured = [];
  try {
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the real packaged renderer must be open');
    page.setDefaultTimeout(10000);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const group = page.locator('aside.sidebar .project-group').filter({ has: page.locator('.sidebar-group-name').filter({ hasText: prefix(process.env.ELPIS_V1_PROJECT || 'match') }) });
    assert.equal(await group.count(), 1, 'seed one matching project in the throwaway app');
    const projectToggle = group.locator('.project-toggle');
    if (await projectToggle.getAttribute('aria-expanded') !== 'true') await projectToggle.click();
    const current = group.locator('.thread-row').filter({ has: page.locator('.thread-title').filter({ hasText: prefix(process.env.ELPIS_V1_CHAT || 'Didar') }) });
    assert.equal(await current.count(), 1, 'seed one matching chat with agents');
    const id = await current.getAttribute('data-thread-id');
    const sibling = page.locator(`aside.sidebar .thread-row:not(.child):not([data-thread-id="${id}"]) .thread-link`).first();
    assert.equal(await sibling.count(), 1, 'seed another root chat for the unselected check');
    const toggle = current.getByRole('button', { name: /agents in/ });
    assert.equal(await toggle.count(), 1, 'the seeded chat must have agents');
    const projectChevron = group.locator('.sidebar-group-chevron'), original = await measure(current, projectChevron);
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').evaluate(element => element.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
      assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), theme === 'dark');
      for (const selected of [false, true]) {
        await (selected ? current.locator('.thread-link') : sibling).click();
        assert.equal(await current.evaluate(element => element.classList.contains('active')), selected);
        for (const expanded of [false, true]) {
          if ((await toggle.getAttribute('aria-expanded') === 'true') !== expanded) await toggle.click();
          await current.locator('.thread-link').hover();
          const label = `${theme} ${selected ? 'selected' : 'unselected'} ${expanded ? 'expanded' : 'collapsed'}`;
          const actual = await measure(current, projectChevron);
          measured.push({ label, ...actual });
          await fs.writeFile(path.join(shots, 'v1-real-boxes.json'), JSON.stringify(measured, null, 2));
          // Capture before asserting, so the installed baseline also leaves useful failure evidence.
          if (selected) {
            await page.mouse.move(700, 60);
            const sidebar = await page.locator('aside.sidebar').boundingBox(), spot = await group.boundingBox();
            const top = Math.max(0, spot.y), bottom = Math.min(await page.evaluate(() => innerHeight), spot.y + spot.height);
            await page.screenshot({ path: path.join(shots, `v1-real-${theme}-${expanded ? 'expanded' : 'collapsed'}.png`),
              clip: { x: sidebar.x, y: top, width: sidebar.width, height: bottom - top } });
          }
          for (const key of ['circle', 'title', 'actions']) assert.equal(actual[key], original[key], `${label}: ${key} stays in place`);
          if (expanded) {
            const child = page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).locator('..').locator('.thread-row.child').first();
            await child.waitFor();
            const circle = await child.locator('.thread-dot').boundingBox();
            measured.at(-1).agentIndent = circle.x - actual.circle;
          }
        }
      }
    }
    await page.reload();
    await current.waitFor();
    measured.push({ label: 'after reload', ...await measure(current, projectChevron) });
    await fs.writeFile(path.join(shots, 'v1-real-boxes.json'), JSON.stringify(measured, null, 2));
    for (const actual of measured) {
      check(actual, actual.label, true);
      if ('agentIndent' in actual) assert.equal(actual.agentIndent, 14, `${actual.label}: agents remain indented`);
    }
    console.log(`V1 real-app alignment passed (${measured.length} states); evidence: ${shots}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
