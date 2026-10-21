// xvfb-run -a node tests/improve-installed.runtime.cjs INSTALLATION SHOTS [--before]
// Uses the packaged app, real bridge, native folder chooser and its own disposable home. No provider credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, openSettings, assertDialogActionsExplained } = require('./controls.cjs');
const exec = promisify(execFile);

(async () => {
  const installation = path.resolve(process.argv[2]), shots = path.resolve(process.argv[3]), before = process.argv.includes('--before');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'a116-app-'));
  const wrongFolder = path.join(home, 'not-elpis'); await fs.mkdir(wrongFolder);
  await fs.mkdir(shots, { recursive: true });
  const env = { ...process.env, HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'codex'),
    ELPIS_CONFIG_DIR: path.join(home, 'elpis'), ELPIS_IMPROVE_HOME: path.join(home, 'improve'),
    ELPIS_DESKTOP_PROFILE: path.join(home, 'desktop'), EXCALIDRAW_LOCAL_DIR: path.join(home, 'love-spot'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(home, 'Screenshots'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    TMPDIR: home, ELPIS_NODE_BIN: process.execPath, ELPIS_ENGINE_BIN: process.env.ELPIS_ENGINE_BIN };
  assert.ok(env.ELPIS_ENGINE_BIN, 'Set ELPIS_ENGINE_BIN to the installed runtime executable');
  for (const key of ['ELPIS_SOURCE_REPO', 'ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELPIS_SHARED_BRIDGE', 'ACP_BRIDGE_STORE', 'ELECTRON_RUN_AS_NODE', 'WAYLAND_DISPLAY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CODEX_API_KEY']) delete env[key];
  let app;
  try {
    app = await _electron.launch({ executablePath: path.join(installation, 'runtime/electron/electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.join(installation, 'app')], env, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await page.locator('.app-shell').waitFor(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    for (const theme of ['light', 'dark']) {
      await chooseTheme(page, theme); await openSettings(page);
      await page.getByRole('button', { name: /^(Advanced|Configuration)$/, exact: true }).last().click();
      const row = page.locator('.settings-row').filter({ hasText: 'Open config file' });
      await row.locator('.settings-row-description').click({ button: 'right' });
      const discovered = page.waitForResponse(response => response.url().endsWith('/api/improvements/source') && response.request().method() === 'GET');
      await page.getByRole('menuitem', { name: 'Change this…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Improve Elpis' });
      const request = dialog.getByRole('textbox', { name: 'What should change?' });
      await request.fill('the size of this - the alignment and consistency of the UI here is broken!');
      const source = await (await discovered).json();
      if (!before) { assert.equal(source.configured, true); await dialog.getByText(source.path, { exact: true }).waitFor(); }
      await page.screenshot({ path: path.join(shots, `installed-${before ? 'before' : 'after'}-${theme}.png`) });
      const enabled = await dialog.getByRole('button', { name: 'Start change' }).isEnabled();
      if (before) console.log(`OLD ${theme}: Start change enabled=${enabled}; source=${await dialog.locator('[title]').allTextContents()}`);
      else {
        assert.equal(enabled, true, 'installation must discover the durable checkout without choosing it');
        await request.clear(); await assertDialogActionsExplained(dialog, /Describe.*change/i);
        await request.fill('Keep the request when a folder is rejected');
      }
      const rejected = page.waitForResponse(response => response.url().endsWith('/api/improvements/source') && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Choose source folder' }).click();
      // xdotool drives the real GTK chooser. No replacement of dialog.showOpenDialog or preload APIs.
      const { stdout } = await exec('xdotool', ['search', '--sync', '--onlyvisible', '--name', 'Choose project folder'], { timeout: 10000 });
      const window = stdout.trim().split('\n').at(-1);
      await exec('xdotool', ['windowfocus', '--sync', window]);
      await exec('xdotool', ['key', '--clearmodifiers', 'ctrl+l']);
      await exec('xdotool', ['type', '--clearmodifiers', '--', `${wrongFolder}/`]);
      await exec('xdotool', ['key', '--clearmodifiers', 'Return']);
      await new Promise(resolve => setTimeout(resolve, 400));
      await exec('xdotool', ['key', '--clearmodifiers', 'alt+o']);
      const response = await rejected; assert.equal(response.status(), 400);
      await dialog.getByRole('alert').filter({ hasText: 'This folder is not an Elpis source checkout.' }).waitFor();
      assert.equal(await request.inputValue(), before ? 'the size of this - the alignment and consistency of the UI here is broken!' : 'Keep the request when a folder is rejected');
      console.log(`PASS ${theme}: native folder chooser opened; non-Elpis folder rejected; request retained`);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
  } finally {
    await app?.close();
    // The shared runtime outlives a window; stop only this owned profile's remaining processes.
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const vars = await fs.readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
      if (vars.split('\0').includes(`HOME=${home}`)) { try { process.kill(Number(entry), 'SIGTERM'); } catch {} }
    }
    console.log(`Disposable home retained: ${home}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
