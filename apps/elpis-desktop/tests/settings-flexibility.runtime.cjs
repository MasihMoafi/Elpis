// node tests/settings-flexibility.runtime.cjs PACKAGED_APP [9472]
// Packaged Electron, real bridge and native workspace store, empty throwaway profiles; no mocked routes.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, openSettings } = require('./controls.cjs');
const { crossGroup, layout } = require('./settings-flexibility-check.cjs');
const { shot } = require('./settings-reorder-check.cjs');

async function main() {
  assert.ok(process.argv[2], 'Pass a packaged app directory');
  const app = path.resolve(process.argv[2]), port = Number(process.argv[3] || 9472);
  assert.ok(port >= 9420 && port <= 9499, 'Use an isolated CDP port');
  const url = `http://127.0.0.1:${port}`;
  assert.ok(!await fetch(`${url}/json/version`).then(() => true, () => false), 'The CDP port must be free');
  const shots = process.env.ELPIS_SETTINGS_SHOTS || path.resolve(process.env.HOME, '.cache/elpis-tests/settings/shots');
  const failures = [];
  for (const theme of ['light', 'dark']) {
    const home = await fs.mkdtemp('/tmp/e2e-settings-');
    await fs.mkdir(`${home}/run`, { mode: 0o700 });
    const env = { ...process.env, HOME: home, ELPIS_HOME: `${home}/elpis`, CODEX_HOME: `${home}/codex`, ELPIS_CONFIG_DIR: `${home}/elpis`,
      ELPIS_DESKTOP_PROFILE: `${home}/desktop`, XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`,
      XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`, XDG_RUNTIME_DIR: `${home}/run`,
      TMPDIR: home, EXCALIDRAW_LOCAL_DIR: `${home}/love-spot`, EXCALIDRAW_SCREENSHOTS_DIR: `${home}/Screenshots` };
    for (const name of ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELECTRON_RUN_AS_NODE']) delete env[name];
    let child, exited, browser;
    const errors = [];
    async function start() {
      const log = await fs.open(`${home}/app.log`, 'a');
      child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1200x24', `${app}/launch`, '--ozone-platform=x11', `--remote-debugging-port=${port}`], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      await log.close();
      const until = Date.now() + 45000;
      while (Date.now() < until && child.exitCode === null) {
        if (await fetch(`${url}/json/list`).then(r => r.json()).then(items => items.some(item => item.type === 'page'), () => false)) {
          browser = await chromium.connectOverCDP(url);
          const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
          if (page) {
            page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            await page.setViewportSize({ width: 1440, height: 1080 });
            await page.locator('aside.sidebar .account-row').waitFor();
            return page;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw Error(`App did not open: ${await fs.readFile(`${home}/app.log`, 'utf8')}`);
    }
    try {
      console.log(`${theme} isolated HOME: ${home}`);
      let page = await start();
      await chooseTheme(page, theme);
      const expected = await crossGroup(page, { theme, shots });
      await page.keyboard.press('Control+q');
      let timer;
      try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Ctrl+Q did not quit')), 10000); })]); }
      finally { clearTimeout(timer); }
      await browser.close().catch(() => {}); browser = null;
      page = await start(); await openSettings(page);
      assert.deepEqual(await layout(page), expected, 'membership and both orders survive a real process restart');
      await shot(page, shots, `cross-group-restart-${theme}`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme}: native cross-group drag, empty destination, first/middle/last, cancel, reload and restart`);
    } catch (error) { failures.push(`${theme}: ${error.stack}`); console.error(failures.at(-1)); }
    finally {
      await browser?.close().catch(() => {});
      if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      execFileSync(process.env.ELPIS_E2E_HELPER || '/home/masih/.cache/elpis-tests/e2e/app.sh', ['stop', home]);
    }
  }
  assert.deepEqual(failures, []);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
