const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cts');

test('Love Spot is beside Canvas and loads its editor only after a real click', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.excalidraw').count(), 0);
    const chunks = path.resolve(__dirname, '../out/_next/static/chunks');
    const heavy: string[] = [];
    for (const name of await fs.readdir(chunks)) if (name.endsWith('.js') && (await fs.stat(path.join(chunks, name))).size > 200_000 && (await fs.readFile(path.join(chunks, name), 'utf8')).includes('getSceneElementsIncludingDeleted')) heavy.push(name);
    assert.ok(heavy.length, 'the check must identify the actual Excalidraw bundle');
    assert.equal(f.requests.some((url: string) => heavy.some(name => url.endsWith(name))), false, 'opening chat must not load Excalidraw');
    const love = page.getByRole('button', { name: 'Love Spot', exact: true });
    await love.click();
    assert.equal(await page.locator('.nav-list button').evaluateAll((nodes: Element[]) => { const i = nodes.findIndex(n => n.textContent === 'Love Spot'); return nodes[i - 1]?.textContent; }), 'Workflows');
    assert.equal(await love.getAttribute('aria-current'), 'page');
    const icon = love.locator('svg');
    assert.equal(await icon.getAttribute('width'), '16');
    await page.locator('.excalidraw').waitFor();
    assert.ok(f.requests.some((url: string) => heavy.some(name => url.endsWith(name))), 'opening Love Spot must load Excalidraw');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light']) test(`embedded Love Spot keeps the sidebar and combines its bars when they fit · ${colorScheme}`, async () => {
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
    assert.equal(await page.getByRole('group', { name: "Matilda's voice", exact: true }).count(), 0, 'unavailable audio has no toolbar group');
    assert.equal(await page.getByRole('button', { name: /^(Why read aloud is unavailable|Voice unavailable|Start voice chat)$/ }).count(), 0);
    assert.equal(await page.getByRole('switch', { name: 'Read replies aloud', exact: true }).count(), 0);
    for (const width of [1600, 1280, 1024, 820]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(200);
      const bounds = await page.evaluate(() => {
        const box = (selector: string) => { const element = document.querySelector(selector); if (!element) throw Error(`Missing ${selector}`); const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const navigation = document.querySelector('.sidebar > .nav-list');
        if (!navigation) throw Error('Missing navigation');
        const text = [...navigation.querySelectorAll('button')].map(button => {
          const node = [...button.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
          if (!node) throw Error('Missing button text');
          const range = document.createRange(); range.selectNodeContents(node);
          const r = range.getBoundingClientRect(); return { text: node.textContent, left: r.left, right: r.right };
        });
        return { sidebar: box('.app-shell > .sidebar'), title: box('.workspace-header h1'), tools: box('.love-spot-tools'), editor: box('.love-spot-editor'), controls: ['.love-spot-pages', '.love-spot-tools > [role="group"]'].map(box), text, scrollX, shellScroll: document.querySelector('.app-shell')?.scrollLeft, scrollWidth: document.documentElement.scrollWidth };
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
      assert.ok(m.text.every((t: { left: number; right: number }) => t.left >= 0 && t.right <= m.sidebar.right), `sidebar text remains inside its bounds at ${m.width}`);
      assert.ok(m.editor.x >= m.sidebar.right && m.editor.right <= m.width + 1, 'the drawing stays beside the sidebar');
      assert.ok(m.controls.every((c: { x: number; right: number }) => c.x >= m.sidebar.right && c.right <= m.width + 1), `all toolbar controls fit at ${m.width}`);
      if (m.width >= 1280) {
        const center = (r: { y: number; height: number }) => r.y + r.height / 2;
        assert.ok(Math.abs(center(m.title) - center(m.tools)) <= 2, 'title and page controls share one row');
        assert.ok(m.editor.y - m.title.y < 48, 'only one compact row sits above the drawing');
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
