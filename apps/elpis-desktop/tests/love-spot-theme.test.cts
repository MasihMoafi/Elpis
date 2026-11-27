const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const { chromium }: typeof import('playwright-core') = require('playwright-core');

test('Love Spot controls and Excalidraw menu use the active accent in both themes', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ELPIS_CHROMIUM || '/usr/bin/google-chrome',
  });
  try {
    const page = await browser.newPage();
    const styles = [
      'app/styles/foundation.css',
      'app/styles/panels.css',
      'node_modules/@excalidraw/excalidraw/dist/dev/index.css',
      'components/love-spot.css',
    ].map((file: string) => fs.readFileSync(file, 'utf8')).join('\n');
    const html = [
      '<div class="love-spot-tools accent-scope"><button>New page</button></div>',
      '<section class="love-spot accent-scope"><div class="excalidraw">',
      '<div class="context-menu"><button class="context-menu-item">Copy</button></div>',
      '</div><div class="expected-hover" style="background:var(--hover)"></div></section>',
    ].join('');
    await page.setContent(html);
    await page.addStyleTag({ content: styles });
    for (const dark of [false, true]) for (const accent of ['teal', 'green', 'violet']) {
      await page.evaluate(({ dark: isDark, accent: name }: { dark: boolean; accent: string }) => {
        document.documentElement.classList.toggle('dark', isDark);
        document.documentElement.dataset.accent = name;
      }, { dark, accent });
      const colors = await page.evaluate(() => {
        const color = (selector: string, property: string) => {
          const node = document.querySelector(selector);
          return node ? getComputedStyle(node).getPropertyValue(property).trim() : '';
        };
        return {
          root: color(':root', '--primary'),
          tools: color('.love-spot-tools', '--primary'),
          board: color('.love-spot', '--primary'),
        };
      });
      assert.equal(colors.tools, colors.root, `${accent} toolbar`);
      assert.equal(colors.board, colors.root, `${accent} board`);
      const item = page.locator('.context-menu-item');
      await item.hover();
      const hover = await item.evaluate((el: Element) => getComputedStyle(el).backgroundColor);
      const expected = await page.locator('.expected-hover')
        .evaluate((el: Element) => getComputedStyle(el).backgroundColor);
      assert.equal(hover, expected, `${accent} menu hover`);
    }
  } finally { await browser.close(); }
});
