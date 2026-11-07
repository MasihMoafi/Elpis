// A packaged app in a throwaway home, started only through app.sh: the copy gets no session bus, so its tray icon never
// reaches Masih's top bar (R56), and it gets its own bridge and engine. ELPIS_DESKTOP_PROFILE, when given, keeps the
// window's saved state (theme, selected chat, drafts) across a restart; the seed folder keeps the same chats.
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const helper = process.env.ELPIS_E2E_APP_HELPER || path.join(process.env.HOME, '.cache/elpis-tests/e2e/app.sh');

/** Starts the app; resolves once its window exists, with how long that took (app.sh checks once a second). */
async function startApp({ app, port, seed, engine, profile, env = {} }: { app: string; port: number; seed?: string; engine?: string; profile?: string; env?: NodeJS.ProcessEnv }) {
  const started = Date.now();
  let home;
  try {
    ({ stdout: home } = await exec(helper, ['start', app, String(port), ...(seed ? [seed] : [])], { timeout: 240000,
      env: { ...process.env, ELPIS_ENGINE_BIN: engine, ...(profile ? { ELPIS_DESKTOP_PROFILE: profile } : {}), ...env } }));
  } catch (cause) {
    // A copy whose window never came still holds its port: stop it, or the next start cannot open.
    const stderr = cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr) : '';
    const left = /see (\/tmp\/e2e-[^/\s]+)\/app\.log/.exec(stderr)?.[1];
    if (left) await exec(helper, ['stop', left]).catch(() => {});
    throw new Error(`The app window did not open: ${(stderr || (cause instanceof Error ? cause.message : String(cause))).trim()}`);
  }
  home = home.trim().split('\n').pop();
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context: { pages(): { url(): string; setDefaultTimeout(ms: number): void }[] }) => context.pages()).find((page: { url(): string }) => page.url().startsWith('http://127.0.0.1'));
  if (!page) throw new Error('The app window was not found');
  page.setDefaultTimeout(10000);
  return { home, browser, page, windowMs: Date.now() - started };
}

/** The first-run name question appears in a fresh profile; it is not part of these checks. */
async function skipFirstRun(page: { getByRole(role: string, options: { name: string; exact: boolean }): { waitFor(options: { timeout: number }): Promise<void>; click(): Promise<void> } }) {
  const notNow = page.getByRole('button', { name: 'Not now', exact: true });
  await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => {});
}

async function stopApp(running: { browser?: { close(): Promise<void> }; home: string } | null | undefined) {
  if (!running) return;
  await running.browser?.close().catch(() => {});
  await exec(helper, ['stop', running.home]).catch(() => {});
}

module.exports = { startApp, stopApp, skipFirstRun };
