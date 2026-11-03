// Renders docs/assets/src/agent-command-center.html to docs/assets/tui-agent-command-center.png (1400 wide, as tall as its rows).
// Usage: node docs/assets/src/render.mjs <playwright module path> [chrome path]; then cwebp the PNG.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const [, , playwrightPath, chrome] = process.argv;
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const here = new URL('.', import.meta.url);
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 870 } });
await page.goto(new URL('agent-command-center.html', here).href);
await page.evaluate(() => document.fonts.ready);
await page.setViewportSize({ width: 1400, height: await page.evaluate(() => document.body.scrollHeight + 6) });
await page.screenshot({ path: fileURLToPath(new URL('../tui-agent-command-center.png', here)) });
await browser.close();
