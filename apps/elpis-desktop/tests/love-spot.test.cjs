const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

test('Love Spot is beside Canvas and loads its editor only after a real click', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.excalidraw').count(), 0);
    const chunks = path.resolve(__dirname, '../out/_next/static/chunks');
    const heavy = [];
    for (const name of await fs.readdir(chunks)) if (name.endsWith('.js') && (await fs.stat(path.join(chunks, name))).size > 200_000 && (await fs.readFile(path.join(chunks, name), 'utf8')).includes('getSceneElementsIncludingDeleted')) heavy.push(name);
    assert.ok(heavy.length, 'the check must identify the actual Excalidraw bundle');
    assert.equal(f.requests.some(url => heavy.some(name => url.endsWith(name))), false, 'opening chat must not load Excalidraw');
    const love = page.getByRole('button', { name: 'Love Spot', exact: true });
    await love.click();
    assert.equal(await page.locator('.nav-list button').evaluateAll(nodes => { const i = nodes.findIndex(n => n.textContent === 'Love Spot'); return nodes[i - 1]?.textContent; }), 'Workflows');
    assert.equal(await love.getAttribute('aria-current'), 'page');
    const icon = love.locator('svg');
    assert.equal(await icon.getAttribute('width'), '16');
    await page.locator('.excalidraw').waitFor();
    assert.ok(f.requests.some(url => heavy.some(name => url.endsWith(name))), 'opening Love Spot must load Excalidraw');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`Love Spot red reads clearly and stays off project and chat status controls · ${colorScheme}`, async () => {
  const cwd = '/tmp/a60-palette-project';
  const f = await loveSpotFixture({ colorScheme, configureClient: client => {
    client.listThreads = async () => ({ data: [{ id: 'review', name: 'Review', cwd, modelProvider: 'openai', status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct' } }], nextCursor: null });
  } });
  try {
    const { page } = f;
    await page.evaluate(cwd => localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'a60', name: 'Palette project', cwd }], selectedId: 'a60' })), cwd);
    await page.reload();
    await page.locator('.project-group .project-toggle svg:not(.sidebar-group-chevron)').waitFor();
    // Restoring the project list does not select a project for a new chat.
    await page.getByRole('button', { name: 'Choose project', exact: true }).click();
    await page.getByRole('menuitem', { name: /Palette project/ }).click();
    await page.locator('.project-row.active').waitFor();
    await page.locator('.thread-row[data-thread-id="review"] .thread-dot[data-state="working"]').first().waitFor();
    await f.open(page);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), colorScheme === 'dark');
    await page.locator('.love-spot-pages button[aria-label="Pages"]').waitFor();
    await page.locator('.excalidraw input.ToolIcon_type_radio:checked + .ToolIcon__icon').first().waitFor();
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const rgb = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const background = element => {
        const ancestors = []; for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
        context.clearRect(0, 0, 1, 1);
        for (const node of ancestors) { context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 1, 1); }
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const luminance = color => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const measure = (selector, property) => { const element = document.querySelector(selector); return contrast(rgb(getComputedStyle(element)[property]), background(element)); };
      const project = document.querySelector('.project-group .project-toggle svg:not(.sidebar-group-chevron)');
      const status = document.querySelector('.thread-row[data-thread-id="review"] .thread-dot[data-state="working"]');
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue('--love-red').trim().toLowerCase(),
        navText: measure('.nav-list button[data-nav-page="loveSpot"]', 'color'),
        navMark: measure('.nav-list button[data-nav-page="loveSpot"] svg', 'fill'),
        pageText: measure('.love-spot-pages button[aria-label="Pages"]', 'color'),
        pageColor: rgb(getComputedStyle(document.querySelector('.love-spot-pages button[aria-label="Pages"]')).color),
        toolMark: measure('.excalidraw input.ToolIcon_type_radio:checked + .ToolIcon__icon', 'color'),
        appAccent: rgb(getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--primary')),
        project: rgb(getComputedStyle(project).color),
        status: rgb(getComputedStyle(status).borderTopColor),
      };
    });
    if (colorScheme === 'light') assert.equal(result.token, '#8b1017', 'the light blood red stays exact');
    for (const name of ['navText', 'pageText']) assert.ok(result[name] >= 4.5, `${colorScheme} ${name}: ${result[name].toFixed(2)}:1`);
    for (const name of ['navMark', 'toolMark']) assert.ok(result[name] >= 3, `${colorScheme} ${name}: ${result[name].toFixed(2)}:1`);
    const blood = result.token.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
    if (colorScheme === 'dark') assert.deepEqual(result.pageColor, blood, 'the dark page selector uses the readable Love Spot red');
    assert.deepEqual(result.project, result.appAccent, `${colorScheme}: project folder uses the app accent`);
    assert.deepEqual(result.status, result.appAccent, `${colorScheme}: chat status uses the app accent`);
    assert.notDeepEqual(result.project, blood, `${colorScheme}: project folder keeps the app accent`);
    assert.notDeepEqual(result.status, blood, `${colorScheme}: chat status keeps the app accent`);
    console.log(`${colorScheme} Love Spot contrast: ${JSON.stringify(result)}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`embedded Love Spot keeps the sidebar and combines its bars when they fit · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  const output = path.join(process.env.HOME, '.cache/elpis-tests/love-confirm');
  await fs.mkdir(output, { recursive: true });
  const measurements = [];
  try {
    const { page } = f;
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
    await page.locator('.title-bar').waitFor();
    const edge = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
    for (let i = 0; i < 4; i++) await edge.press('ArrowRight');
    const before = await sidebar.boundingBox();
    assert.equal(before.width, 320, 'the check must preserve a user-resized sidebar');
    await f.open(page);
    const voiceInfo = page.getByRole('button', { name: 'Why Voice is unavailable', exact: true });
    await voiceInfo.focus();
    // A mouse-opened board leaves focus in pointer mode; tab to the reason as a keyboard user would.
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    const reason = page.getByRole('tooltip');
    await reason.getByText('Connect ChatGPT in Settings → Connections.', { exact: true }).waitFor();
    assert.ok((await voiceInfo.getAttribute('aria-describedby') || '').split(/\s+/).includes(await reason.getAttribute('id')), 'the reason also describes the focused control to assistive technology');
    await page.keyboard.press('Escape'); await reason.waitFor({ state: 'hidden' });
    await voiceInfo.blur();
    for (const width of [1600, 1280, 1024, 820]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(200);
      const bounds = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const navigation = document.querySelector('.sidebar > .nav-list');
        const text = [...navigation.querySelectorAll('button')].map(button => {
          const node = [...button.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
          const range = document.createRange(); range.selectNodeContents(node);
          const r = range.getBoundingClientRect(); return { text: node.textContent, left: r.left, right: r.right };
        });
        return { sidebar: box('.app-shell > .sidebar'), title: box('.workspace-header h1'), tools: box('.love-spot-tools'), editor: box('.love-spot-editor'), controls: ['.love-spot-pages', '.love-spot-tools > [role="group"]'].map(box), text, scrollX, shellScroll: document.querySelector('.app-shell').scrollLeft, scrollWidth: document.documentElement.scrollWidth };
      });
      measurements.push({ width, ...bounds });
      await page.screenshot({ path: path.join(output, `${process.env.LOVE_CONFIRM_PHASE || 'current'}-${colorScheme}-${width}.png`) });
    }
    await fs.writeFile(path.join(output, `${process.env.LOVE_CONFIRM_PHASE || 'current'}-${colorScheme}-layout.json`), JSON.stringify({ before, measurements }, null, 2));
    for (const m of measurements) {
      assert.equal(m.sidebar.x, 0, `sidebar starts at the left edge at ${m.width}`);
      assert.equal(m.sidebar.width, before.width, `sidebar retains its chosen width at ${m.width}`);
      assert.equal(m.scrollX, 0, 'Love Spot must not scroll the whole window sideways');
      assert.equal(m.shellScroll, 0, 'the board must not scroll the sidebar out of the shell');
      assert.ok(m.scrollWidth <= m.width, `the document must fit at ${m.width}`);
      assert.ok(m.text.every(t => t.left >= 0 && t.right <= m.sidebar.right), `sidebar text remains inside its bounds at ${m.width}`);
      assert.ok(m.editor.x >= m.sidebar.right && m.editor.right <= m.width + 1, 'the drawing stays beside the sidebar');
      assert.ok(m.controls.every(c => c.x >= m.sidebar.right && c.right <= m.width + 1), `all toolbar controls fit at ${m.width}`);
      if (m.width >= 1280) {
        const center = r => r.y + r.height / 2;
        assert.ok(Math.abs(center(m.title) - center(m.tools)) <= 2, 'title and page controls share one row');
        assert.ok(m.editor.y - m.title.y < 48, 'only one compact row sits above the drawing');
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
