const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture } = require('./parity-fixture.cjs');
const { createTestTempDir, removeTestTempDir } = require('./temp-root.cjs');

test('a scoped companion request captures a chosen external app on a private display', async () => {
  const profiles = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(profiles, { recursive: true });
  const root = createTestTempDir(path.join(profiles, 'screen-capture-'));
  const f = await fixture({ desktop: false });
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const display = await new Promise((resolve, reject) => { xvfb.once('error', reject); xvfb.stdio[3].once('data', value => resolve(`:${String(value).trim()}`)); });
  const environment = { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent',
    ELECTRON_OZONE_PLATFORM_HINT: 'x11', HOME: root, ELPIS_HOME: root, SESSION_WINDOW_PROFILE: path.join(root, 'profile'), SESSION_WINDOW_URL: f.page.url(), SESSION_BROWSER_TOOLS: '1' };
  let electron, external, nativeErrors = '';
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'session-windows-electron.cjs')], env: environment });
    electron.process().stderr.on('data', data => { nativeErrors = (nativeErrors + data).slice(-6000); });
    const page = await electron.firstWindow(); page.setDefaultTimeout(12000);
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.evaluate(() => window.elpisDesktop.screenCapture.setSession('matilda-board'));
    const credentials = await electron.evaluate(({ Menu }) => {
      const original = Menu.buildFromTemplate;
      Menu.buildFromTemplate = (...args) => { const menu = original(...args); global.captureMenu = menu; return menu; };
      return { socketPath: global.browserSocket.path, capability: global.browserSocket.scope('matilda-board') };
    });
    external = spawn('python3', ['-c', `import gi\ngi.require_version('Gtk','3.0')\nfrom gi.repository import Gtk, GLib\nw=Gtk.Window(title='External capture proof')\nw.set_decorated(False)\nw.set_default_size(520,320)\nw.move(70,90)\ncss=Gtk.CssProvider()\ncss.load_from_data(b'window {background-color:#c21f3d;} label {color:#ffffff;font:26px Sans;}')\nGtk.StyleContext.add_provider_for_screen(w.get_screen(),css,800)\nw.add(Gtk.Label(label='Outside Elpis: captured page'));w.show_all()\nGLib.timeout_add(250,lambda: print('READY',flush=True) and False)\nGtk.main()`], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { external.once('error', reject); external.once('exit', code => reject(Error(`External page exited ${code}`))); external.stdout.once('data', resolve); });
    const externalId = execFileSync('xdotool', ['search', '--name', '^External capture proof$'], { env: environment, encoding: 'utf8' }).trim().split('\n')[0];
    // Xvfb has no window manager to mark top-level application windows for Chromium's native capturer.
    execFileSync('xprop', ['-id', externalId, '-f', 'WM_STATE', '32c', '-set', 'WM_STATE', '1, 0'], { env: environment });
    const { callBrowser } = await import('../bridge/browser-mcp.mjs');
    await assert.rejects(callBrowser(credentials.socketPath, 'screen_screenshot', {}, credentials.capability, 'other-chat'), /Open this chat/);
    const capture = callBrowser(credentials.socketPath, 'screen_screenshot', {}, credentials.capability, 'matilda-board');
    capture.catch(() => {});
    // Use the real native source menu and keyboard; the menu's public item labels identify its chosen external app.
    const deadline = Date.now() + 10000;
    let labels;
    while (!(labels = await electron.evaluate(() => global.captureMenu?.items.map(item => item.label)))?.some(label => label === 'External capture proof')) {
      if (Date.now() > deadline) throw Error(`The external source did not appear in the native screenshot menu: ${JSON.stringify(labels)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const index = labels.indexOf('External capture proof');
    execFileSync('xdotool', ['key', '--clearmodifiers', 'Home', ...Array(index).fill('Down'), 'Return'], { env: environment });
    const result = await capture;
    assert.equal(result.content[0].type, 'image'); assert.equal(result.content[0].mimeType, 'image/jpeg');
    if (process.env.ELPIS_SCREEN_CAPTURE_SHOTS) {
      await fs.mkdir(process.env.ELPIS_SCREEN_CAPTURE_SHOTS, { recursive: true });
      await fs.writeFile(path.join(process.env.ELPIS_SCREEN_CAPTURE_SHOTS, 'external-page.jpg'), Buffer.from(result.content[0].data, 'base64'));
    }
    const decoded = await electron.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64')), size = image.getSize(), pixels = image.toBitmap();
      const offset = (Math.floor(size.height * 0.8) * size.width + Math.floor(size.width * 0.8)) * 4;
      return { size, bgr: [...pixels.subarray(offset, offset + 3)] };
    }, result.content[0].data);
    assert.ok(decoded.size.width >= 500 && decoded.size.height >= 300);
    assert.ok(decoded.bgr[2] > 170 && decoded.bgr[1] < 70 && decoded.bgr[0] < 100, `the image contains the red external page, not Elpis: ${JSON.stringify(decoded)}`);
    await page.evaluate(() => window.elpisDesktop.screenCapture.setSession(null));
    await assert.rejects(callBrowser(credentials.socketPath, 'screen_screenshot', {}, credentials.capability, 'matilda-board'), /Open this chat/);
  } catch (error) { console.error(nativeErrors); throw error; } finally {
    external?.kill(); if (electron) await electron.close(); xvfb.kill(); await f.close(); removeTestTempDir(root);
  }
});
