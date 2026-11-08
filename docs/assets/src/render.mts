// Renders docs/assets/src/agent-command-center.html to docs/assets/tui-agent-command-center.png (1400 wide, as tall as its rows).
// Usage: node docs/assets/src/render.mts <playwright module path> [chrome path]; then cwebp the PNG.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
};
type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };

const [, , playwrightPath, chrome] = process.argv;
const { chromium } = createRequire(import.meta.url)(playwrightPath as string) as { chromium: { launch(options: { executablePath?: string }): Promise<Browser> } };
const here = new URL('.', import.meta.url);
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 870 } });
await page.goto(new URL('agent-command-center.html', here).href);
await page.evaluate(() => document.fonts.ready);
await page.setViewportSize({ width: 1400, height: await page.evaluate(() => document.body.scrollHeight + 6) });
await page.screenshot({ path: fileURLToPath(new URL('../tui-agent-command-center.png', here)) });
await browser.close();
