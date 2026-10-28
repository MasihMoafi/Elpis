// node tests/settings2.runtime.cjs PACKAGED_APP [9476]
// Real packaged Electron and bridge; no mocked routes or account credentials.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, openSettings } = require('./controls.cjs');
const shots = process.env.ELPIS_SETTINGS2_SHOTS || path.resolve(process.env.HOME, '.cache/elpis-tests/settings2/shots');
const visit = async (page, name) => page.getByRole('tab', { name, exact: true }).click();
async function capture(page, name) { await fs.mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); }
async function main() {
  assert.ok(process.argv[2], 'Pass a packaged app directory');
  const app = path.resolve(process.argv[2]), port = Number(process.argv[3] || 9476), url = `http://127.0.0.1:${port}`;
  assert.ok(port >= 9420 && port <= 9499);
  assert.ok(!await fetch(url + '/json/version').then(() => true, () => false), 'CDP port is already in use');
  const failures = [];
  for (const theme of ['light', 'dark']) {
    const home = await fs.mkdtemp('/tmp/e2e-s2-');
    await fs.mkdir(`${home}/run`, { mode: 0o700 });
    await fs.mkdir(`${home}/elpis/memories`, { recursive: true });
    await fs.mkdir(`${home}/.local/bin`, { recursive: true });
    await fs.symlink(`${app}/launch`, `${home}/.local/bin/elpis-app`);
    await fs.writeFile(`${home}/elpis/AGENTS.md`, 'Initial instructions');
    await fs.writeFile(`${home}/elpis/memories/MEMORY.md`, 'Initial memory');
    const env = { ...process.env, HOME: home, ELPIS_HOME: `${home}/elpis`, CODEX_HOME: `${home}/codex`, ELPIS_CONFIG_DIR: `${home}/elpis`, ELPIS_DESKTOP_PROFILE: `${home}/desktop`,
      XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`, XDG_RUNTIME_DIR: `${home}/run`, TMPDIR: home,
      EXCALIDRAW_LOCAL_DIR: `${home}/love-spot`, EXCALIDRAW_SCREENSHOTS_DIR: `${home}/Screenshots` };
    for (const key of ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    let child, exited, browser, page;
    async function start() {
      const log = await fs.open(`${home}/app.log`, 'a');
      child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1200x24', `${app}/launch`, '--ozone-platform=x11', `--remote-debugging-port=${port}`], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); }); await log.close();
      const until = Date.now() + 45000;
      while (Date.now() < until && child.exitCode === null) {
        if (await fetch(url + '/json/list').then(r => r.json()).then(items => items.some(item => item.type === 'page'), () => false)) {
          browser = await chromium.connectOverCDP(url);
          page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
          if (page) { page.setDefaultTimeout(8000); await page.setViewportSize({ width: 1440, height: 1080 }); await page.locator('aside.sidebar .account-row').waitFor(); return; }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw Error(`App did not open: ${await fs.readFile(`${home}/app.log`, 'utf8')}`);
    }
    async function quit() {
      await page.keyboard.press('Control+q'); let timer;
      try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Ctrl+Q did not quit')), 10000); })]); }
      finally { clearTimeout(timer); }
      await browser.close(); browser = null;
    }
    try {
      console.log(`${theme}: isolated HOME ${home}`);
      await start(); await chooseTheme(page, theme); await openSettings(page); await visit(page, 'Personalization');
      for (const [label, file, initial] of [['Global instructions', 'AGENTS.md', 'Initial instructions'], ['Memory file', 'memories/MEMORY.md', 'Initial memory']]) {
        const editor = page.getByRole('textbox', { name: label, exact: true });
        await editor.waitFor(); await page.waitForFunction(({ label, initial }) => document.querySelector(`textarea[aria-label="${label}"]`)?.value === initial, { label, initial });
        await editor.fill(`Saved ${label}\nفارسی\n${'long '.repeat(500)}`); await editor.press('Control+s');
        await page.getByRole('status').filter({ hasText: `${label} saved.` }).waitFor();
        assert.match(await fs.readFile(`${home}/elpis/${file}`, 'utf8'), /فارسی/);
      }
      await capture(page, `real-personalization-${theme}`);
      const instructions = () => page.getByRole('textbox', { name: 'Global instructions', exact: true });
      await fs.writeFile(`${home}/elpis/AGENTS.md`, 'Changed outside Settings');
      await instructions().fill('Keep this draft through a rejected save and restart'); await instructions().press('Control+s');
      await page.getByRole('alert').filter({ hasText: 'File changed elsewhere' }).waitFor();
      await visit(page, 'General');
      const sleep = () => page.getByRole('switch', { name: 'Prevent sleep while Elpis is working', exact: true });
      await sleep().click(); await capture(page, `real-general-${theme}`);
      await visit(page, 'Appearance');
      for (const label of ['Interface size', 'Code size']) await page.getByRole('radiogroup', { name: label, exact: true }).getByRole('radio', { name: 'Large', exact: true }).click();
      await page.getByRole('radiogroup', { name: 'Corner style', exact: true }).getByRole('radio', { name: 'Rounded', exact: true }).click();
      await capture(page, `real-appearance-${theme}`);
      await quit(); await start(); await openSettings(page); await visit(page, 'Personalization');
      await instructions().waitFor(); assert.equal(await instructions().inputValue(), 'Keep this draft through a rejected save and restart');
      assert.equal(await fs.readFile(`${home}/elpis/AGENTS.md`, 'utf8'), 'Changed outside Settings');
      await instructions().fill(`Saved Global instructions\nفارسی\n${'long '.repeat(500)}`);
      // This is still a recovered draft based on the old version: save should keep refusing, without destroying it.
      await instructions().press('Control+s'); await page.getByRole('alert').filter({ hasText: 'File changed elsewhere' }).waitFor();
      await visit(page, 'General'); assert.equal(await sleep().getAttribute('aria-checked'), 'true');
      await visit(page, 'Appearance');
      for (const label of ['Interface size', 'Code size']) assert.equal(await page.getByRole('radiogroup', { name: label, exact: true }).getByRole('radio', { name: 'Large', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('html').getAttribute('data-corners'), 'rounded');
      await visit(page, 'Keyboard shortcuts');
      const search = page.getByRole('textbox', { name: 'Search keyboard shortcuts', exact: true });
      await search.fill('Settings'); await page.getByRole('button', { name: 'Shortcut for Settings', exact: true }).waitFor();
      await search.fill(''); await search.press('Control+Shift+p'); assert.match(await search.inputValue(), /Ctrl\+Shift\+P/);
      await search.fill('Ctrl+,'); await page.getByRole('button', { name: 'Shortcut for Settings', exact: true }).waitFor();
      await capture(page, `real-shortcuts-${theme}`);
      await visit(page, 'About');
      const identity = JSON.parse(await fs.readFile(`${app}/app/package.json`, 'utf8'));
      await page.getByText(identity.version, { exact: true }).waitFor();
      assert.ok(identity.commit, 'The package must retain its commit'); await page.getByText(identity.commit, { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Release notes', exact: true }).waitFor();
      // A genuine installed-selection change, confined to this HOME. No process can be launched from this non-executable file.
      await fs.mkdir(`${home}/other`); await fs.writeFile(`${home}/other/launch`, '#!/bin/sh\nexit 1\n', { mode: 0o600 });
      await fs.rename(`${home}/.local/bin/elpis-app`, `${home}/old-launcher-link`); await fs.symlink(`${home}/other/launch`, `${home}/.local/bin/elpis-app`);
      const restart = page.getByRole('tabpanel').getByRole('button', { name: 'Update ready · Restart', exact: true });
      await restart.click(); await page.getByRole('alert').filter({ hasText: /EACCES|permission denied/i }).waitFor();
      await capture(page, `real-about-${theme}`);
      console.log(`PASS ${theme}: file saves/conflict/restart draft, native preferences, shortcut search and live installed-update refusal`);
    } catch (error) {
      if (page) await capture(page, `real-before-or-failure-${theme}`).catch(() => {});
      failures.push(`${theme}: ${error.stack}`);
    } finally {
      await browser?.close().catch(() => {});
      if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      execFileSync(process.env.ELPIS_E2E_APP_HELPER || path.join(os.homedir(), '.cache/elpis-tests/e2e/app.sh'), ['stop', home], { stdio: 'ignore' });
    }
  }
  if (failures.length) throw Error(failures.join('\n'));
  console.log('Not exercised here: an authenticated model turn and the OS sleep state; see desktop/sleep-blocker.test.cjs.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
