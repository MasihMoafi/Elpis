const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

test('Love Spot standalone Electron and Elpis exchange mouse strokes in under a second without losing concurrent additions', async () => {
  const reference = process.env.LOVE_SPOT_STANDALONE_DIR || path.join(os.homedir(), '.local/lib/excalidraw-local');
  const f = await loveSpotFixture();
  let electron, xvfb;
  try {
    const app = path.join(f.root, 'standalone'); await fs.mkdir(path.join(app, 'src'), { recursive: true });
    for (const name of ['main.cjs', 'preload.cjs', 'build.mjs', 'src/app.jsx', 'src/index.html']) await fs.copyFile(path.join(reference, name), path.join(app, name));
    await fs.symlink(path.join(reference, 'node_modules'), path.join(app, 'node_modules'));
    const { syncLoveSpot } = await import('../scripts/sync-love-spot.mjs');
    await syncLoveSpot(app); await syncLoveSpot(app, { build: false });
    const bootstrap = path.join(app, 'bootstrap.cjs');
    await fs.writeFile(bootstrap, `const {app}=require('electron'); app.setPath('userData', ${JSON.stringify(path.join(f.root, 'profile'))}); app.setPath('pictures', ${JSON.stringify(path.dirname(f.screenshots))}); require('./main.cjs');`);
    xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    const display = await new Promise((resolve, reject) => { xvfb.stdio[3].once('data', data => resolve(`:${data.toString().trim()}`)); xvfb.once('error', reject); xvfb.once('exit', code => reject(new Error(`Xvfb exited ${code}`))); });
    await f.open(f.page);
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', bootstrap], env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', DISPLAY: display, EXCALIDRAW_LOCAL_DIR: f.directory } });
    const standalone = await electron.firstWindow(); standalone.setDefaultTimeout(10000);
    await standalone.locator('.excalidraw canvas').first().waitFor();
    await Promise.all([f.draw(f.page), f.draw(standalone, 140)]);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 2, 'concurrent windows lost an element');
    const fromStandalone = Date.now(); // Measure propagation after the stroke is published.
    await f.page.bringToFront();
    await f.page.waitForTimeout(200);
    await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('Delete');
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 0, 'standalone stroke did not reach Elpis', 700);
    assert.ok(Date.now() - fromStandalone < 1000);
    await f.draw(f.page, 60);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 1, 'Elpis stroke was not saved');
    const fromElpis = Date.now();
    await standalone.bringToFront();
    await standalone.locator('.excalidraw').click({ position: { x: 1000, y: 700 } });
    await standalone.waitForTimeout(200);
    await standalone.keyboard.press('ControlOrMeta+a'); await standalone.keyboard.press('Delete');
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 0, 'Elpis stroke did not reach standalone', 700).catch(async e => { await standalone.screenshot({ path: '/tmp/love-spot-standalone-failure.png' }); throw new Error(`${e.message}; scene: ${JSON.stringify((await f.scene()).elements.map(e => [e.type, e.version, e.isDeleted]))}`); });
    assert.ok(Date.now() - fromElpis < 1000);
    const shot = await f.page.screenshot();
    await fs.writeFile(path.join(f.screenshots, 'shared.png'), shot);
    await f.page.getByRole('button', { name: 'Add shared.png to drawing', exact: true }).click();
    await f.waitFor(s => s.elements.filter(e => e.type === 'image').length === 1, 'two screenshot watchers duplicated the same picture');
    await standalone.waitForTimeout(300);
    await standalone.keyboard.press('ControlOrMeta+a'); await standalone.keyboard.press('Delete');
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 0, 'standalone did not receive the screenshot');
    await standalone.waitForTimeout(300);
    assert.equal((await f.scene()).elements.filter(e => e.type === 'image').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { if (electron) await electron.close(); if (xvfb) xvfb.kill(); await f.close(); }
});
