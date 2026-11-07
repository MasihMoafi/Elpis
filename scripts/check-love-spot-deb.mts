#!/usr/bin/env node
// check-love-spot-deb.mts DEB [SHOTS_DIR]: unpacks the standalone Love Spot .deb, starts it on a private X display
// (xvfb-run) with a throwaway HOME, and checks that it runs as its own app: its data lands in
// ~/.local/share/love-spot (never ~/.elpis-next), its window is the board marked as the app, and Models & accounts
// offers Anthropic by API key with no Claude or Antigravity subscription. Needs ELPIS_PLAYWRIGHT_PACKAGE or playwright.
// Run as: xvfb-run -a nice -n 19 node scripts/check-love-spot-deb.mts <deb> [shots dir]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const [deb, shots] = process.argv.slice(2) as [string | undefined, string | undefined];
if (!deb || !fs.existsSync(deb)) throw new Error('usage: check-love-spot-deb.mts <love-spot.deb> [screenshots dir]');
const { chromium } = createRequire(import.meta.url)(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright') as typeof import('playwright');
const base = fs.mkdtempSync(path.join(process.env.ELPIS_STAGE_DIR || os.tmpdir(), 'love-spot-check-'));
const root = path.join(base, 'root'), home = path.join(base, 'home');
fs.mkdirSync(home);
execFileSync('dpkg-deb', ['-x', deb, root]);
const port = await new Promise<number>(resolve => { const server = net.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
const env = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, HOME: home, LANG: 'C.UTF-8', LOVE_SPOT_ROOT: path.join(root, 'opt/love-spot'),
  XDG_RUNTIME_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'love-spot-run-')), NO_PROXY: '127.0.0.1,localhost' };
const app = spawn(path.join(root, 'usr/bin/love-spot'), ['--no-sandbox', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let stderr = ''; app.stderr.on('data', chunk => { stderr += chunk; });
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
let browser: import('playwright').Browser | undefined;
try {
  const deadline = Date.now() + 90_000;
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!browser) throw new Error(`Love Spot did not start.\n${stderr.slice(-2000)}`);
  let page: import('playwright').Page | undefined;
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().includes('/love-spot.html'));
    if (!page) await new Promise(r => setTimeout(r, 500));
  }
  if (!page) throw new Error('No Love Spot window opened.');
  await page.locator('.excalidraw canvas').first().waitFor({ timeout: 60_000 });
  check('window is the board, marked as the Love Spot app', new URL(page.url()).searchParams.get('app') === 'love-spot', page.url());
  const own = path.join(home, '.local/share/love-spot');
  check('data in its own home', fs.existsSync(path.join(own, 'config.toml')), own);
  check('nothing in Elpis\'s home', !fs.existsSync(path.join(home, '.elpis-next')));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.locator('.love-spot-tools').getByRole('button', { name: 'Models & accounts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Models & accounts' });
    const anthropic = dialog.locator('[data-provider="claude"]');
    await anthropic.getByRole('textbox', { name: 'Anthropic API key', exact: true }).waitFor({ timeout: 30_000 });
    if (theme === 'light') {
      check('Anthropic offered by API key', true);
      check('no Claude subscription sign-in', await anthropic.getByRole('button', { name: 'Add Claude account' }).count() === 0);
      check('no Antigravity subscription', await dialog.locator('[data-provider="gemini"]').count() === 0);
      check('ChatGPT sign-in offered', await dialog.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).count() === 1);
    }
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `signin-06-standalone-accounts-${theme}.png`) }); }
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
} finally {
  await browser?.close().catch(() => {});
  try { process.kill(-app.pid!, 'SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 1500));
  try { process.kill(-app.pid!, 'SIGKILL'); } catch {}
  execFileSync('gio', ['trash', base]);
}
const failed = results.filter(item => !item.ok).length;
console.log(failed ? `STANDALONE_DEB_CHECK_FAIL (${failed})` : 'STANDALONE_DEB_CHECK_PASS');
process.exit(failed ? 1 : 0);
