// A133 real-app acceptance: node tests/sidebar-hover-real.cjs PORT /tmp/e2e-HOME SHOTS
// Start the packaged app with e2e/app.sh and COPIES of session files, never the user's home.
// No mock bridge, requests, CSS or DOM replacements. The setup uses the real desktop store;
// renaming, hovering, menus, resizing and theme changes use the real UI and bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme } = require('./controls.cjs');

(async () => {
  const [port, home, shots] = process.argv.slice(2);
  assert.match(home || '', /^\/tmp\/e2e-[A-Za-z0-9-]+$/, 'use only a throwaway app.sh home');
  assert.ok(Number(port) >= 9420 && Number(port) <= 9499, 'use the assigned test port range');
  await fs.stat(path.join(home, 'elpis', 'sessions'));
  assert.ok((await fs.readFile(path.join(home, 'app.log'), 'utf8')).includes(`127.0.0.1:${port}/`), 'the port must belong to this throwaway app');
  await fs.mkdir(shots, { recursive: true });
  const cwd = path.join(home, 'workspace'); await fs.mkdir(cwd, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const results = [], failures = [];
  try {
    const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the packaged app opened its own renderer');
    page.setDefaultTimeout(15000);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const first = page.locator('aside.sidebar .thread-row').first(); await first.waitFor();
    const id = await first.getAttribute('data-thread-id'), name = 'Didar — latest build and chat visibility';
    // Fixture setup through the actual IPC store; no replacement of the bridge or desktop API.
    await page.evaluate(async ({ id, cwd }) => {
      await window.elpisDesktop.storage.saveItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'match-making', name: 'match-making', cwd }], selectedId: null }));
      await window.elpisDesktop.storage.saveItem('elpis-project-chats-v1', JSON.stringify({ [id]: 'match-making' }));
    }, { id, cwd });
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const target = page.locator(`aside.sidebar .project-group .thread-row[data-thread-id="${id}"]`), link = target.locator('.thread-link');
    await link.press('F2');
    await page.getByRole('textbox', { name: 'Conversation name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await target.locator('.thread-title').filter({ hasText: name }).waitFor();
    const geometry = () => target.evaluate(element => {
      const link = element.querySelector('.thread-link'), title = element.querySelector('.thread-title');
      const rowStyle = getComputedStyle(element), linkStyle = getComputedStyle(link);
      return { row: element.getBoundingClientRect().toJSON(), title: title.getBoundingClientRect().toJSON(),
        titleEnd: element.getBoundingClientRect().right - parseFloat(rowStyle.paddingRight) - parseFloat(rowStyle.borderRightWidth) - parseFloat(linkStyle.paddingRight),
        nativeTitle: link.getAttribute('title') };
    });
    const resize = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
    for (const theme of ['light', 'dark']) {
      await chooseTheme(page, theme);
      for (const width of [256, 200, 480]) {
        await resize.focus();
        for (let i = 0; i < 20 && Number(await resize.getAttribute('aria-valuenow')) !== width; i++) {
          await resize.press(Number(await resize.getAttribute('aria-valuenow')) < width ? 'ArrowRight' : 'ArrowLeft');
        }
        await page.getByRole('textbox', { name: 'Search conversations', exact: true }).focus();
        await page.mouse.move(700, 60);
        const before = await geometry();
        await page.screenshot({ path: path.join(shots, `${theme}-${width}-rest.png`) });
        await link.hover();
        const after = await geometry(), nativeTitle = after.nativeTitle;
        const record = { theme, width, before, after };
        if (nativeTitle) failures.push(`${theme}/${width}: native title can cover its row`);
        if (Math.abs(before.title.right - before.titleEnd) >= 0.5) failures.push(`${theme}/${width}: rest reserves ${before.titleEnd - before.title.right}px for controls`);
        if (JSON.stringify(after.title) !== JSON.stringify(before.title) || JSON.stringify(after.row) !== JSON.stringify(before.row)) failures.push(`${theme}/${width}: hover changes the name or row geometry`);
        if (!nativeTitle) {
          const tooltip = page.getByRole('tooltip').filter({ hasText: name }); await tooltip.waitFor();
          record.tooltip = await tooltip.boundingBox(); record.sidebar = await page.locator('aside.sidebar').boundingBox();
          if (record.tooltip.x < record.sidebar.x + record.sidebar.width + 5.5) failures.push(`${theme}/${width}: tooltip covers the sidebar`);
          assert.equal(await tooltip.innerText(), name);
        }
        await page.screenshot({ path: path.join(shots, `${theme}-${width}.png`) }); results.push(record);
        await page.mouse.move(700, 60);
        await link.focus();
        record.focused = await geometry();
        if (JSON.stringify(record.focused.title) !== JSON.stringify(before.title) || JSON.stringify(record.focused.row) !== JSON.stringify(before.row)) failures.push(`${theme}/${width}: focus changes the name or row geometry`);
        const actions = target.locator('.thread-row-actions');
        if (await actions.count()) {
          await page.waitForFunction(id => getComputedStyle(document.querySelector(`.project-group .thread-row[data-thread-id="${id}"] .thread-row-actions`)).opacity === '1', id);
          for (const label of [`Pin ${name}`, `Archive ${name}`]) {
            if (await target.getByRole('button', { name: label, exact: true }).isVisible() !== (width !== 200)) failures.push(`${theme}/${width}: inappropriate menu fallback for ${label}`);
          }
        } else failures.push(`${theme}/${width}: missing control overlay`);
        await page.screenshot({ path: path.join(shots, `${theme}-${width}-focus.png`) });
        await page.getByRole('textbox', { name: 'Search conversations', exact: true }).focus();
        await page.mouse.move(700, 60);
        if (await actions.count()) {
          await page.waitForFunction(id => getComputedStyle(document.querySelector(`.project-group .thread-row[data-thread-id="${id}"] .thread-row-actions`)).opacity === '0', id);
        }
      }
      await resize.focus();
      for (let i = 0; i < 20 && Number(await resize.getAttribute('aria-valuenow')) !== 200; i++) {
        await resize.press(Number(await resize.getAttribute('aria-valuenow')) < 200 ? 'ArrowRight' : 'ArrowLeft');
      }
      await target.hover();
      await target.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: 'Archive', exact: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    await fs.writeFile(path.join(shots, 'geometry.json'), JSON.stringify({ results, failures }, null, 2));
    console.log(JSON.stringify({ results, failures }, null, 2));
    assert.deepEqual(failures, [], 'A133: the real app must preserve the name and keep the label outside the sidebar');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
