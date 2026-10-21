// node tests/settings-reorder.runtime.cjs /tmp/a70-app [9470]
// Real packaged Electron + its own bridge/engine, no mocks, credentials or real-profile reads.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, leaveSettings } = require('./controls.cjs');
const { check, verifyRestart, shot } = require('./settings-reorder-check.cjs');

async function main() {
  const app = path.resolve(process.argv[2]), port = Number(process.argv[3] || 9470);
  assert.ok(port >= 9420 && port <= 9499, 'Use an isolated DevTools port in 9420–9499');
  const url = `http://127.0.0.1:${port}`;
  if (await fetch(`${url}/json/version`).then(() => true, () => false)) throw Error(`Port ${port} is already in use`);
  const home = await fs.mkdtemp('/tmp/e2e-a70-');
  await fs.mkdir(path.join(home, 'run'), { mode: 0o700 });
  const env = { ...process.env, HOME: home, ELPIS_HOME: `${home}/elpis`, CODEX_HOME: `${home}/codex`, ELPIS_CONFIG_DIR: `${home}/elpis`,
    XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`,
    XDG_RUNTIME_DIR: `${home}/run`, TMPDIR: home, EXCALIDRAW_LOCAL_DIR: `${home}/love-spot`, EXCALIDRAW_SCREENSHOTS_DIR: `${home}/Screenshots`, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
  for (const name of ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELECTRON_RUN_AS_NODE']) delete env[name];
  let child, browser, exit;
  const errors = [];
  async function start() {
    const log = await fs.open(path.join(home, 'app.log'), 'a');
    child = spawn('xvfb-run', ['-a', path.join(app, 'launch'), '--ozone-platform=x11', `--remote-debugging-port=${port}`], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    exit = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    await log.close();
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (child.exitCode !== null) break;
      if (await fetch(`${url}/json/list`).then(r => r.json()).then(rows => rows.some(row => row.type === 'page'), () => false)) {
        browser = await chromium.connectOverCDP(url);
        const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
        if (!page) throw Error('No Elpis renderer window');
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('aside.sidebar .account-row').waitFor();
        return page;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error(`App did not open: ${await fs.readFile(path.join(home, 'app.log'), 'utf8')}`);
  }
  try {
    console.log(`A70 isolated real app: ${home}`);
    let page = await start();
    for (const theme of ['light', 'dark']) {
      await leaveSettings(page); await chooseTheme(page, theme);
      const expected = await check(page, { theme, shots: '/tmp/a70-shots/real' });
      await fs.writeFile(path.join(home, `expected-${theme}.json`), JSON.stringify(expected, null, 2));
      // Real Ctrl+Q followed by a fresh Electron process against the same native workspace store.
      await page.keyboard.press('Control+q');
      let timer;
      try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Ctrl+Q did not quit within 10s')), 10000); })]); }
      finally { clearTimeout(timer); }
      await browser.close().catch(() => {}); browser = null;
      page = await start();
      await verifyRestart(page, expected);
      await shot(page, '/tmp/a70-shots/real', `restart-${theme}`);
      console.log(`PASS ${theme}: first/middle/last drag, Escape, keyboard, empty search, reload and real restart`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close().catch(() => {});
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    // The approved helper stops only processes whose HOME is exactly this /tmp/e2e-* profile.
    try { execFileSync(path.join(process.env.ELPIS_E2E_HELPERS || '/home/masih/.cache/elpis-tests/e2e', 'app.sh'), ['stop', home]); }
    catch (error) { console.error(`Cleanup failed for ${home}: ${error.message}`); process.exitCode = 1; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
