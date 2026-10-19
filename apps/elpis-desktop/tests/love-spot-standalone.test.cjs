const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

async function nativeCopy(electron, standalone) {
  await standalone.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
  await standalone.keyboard.press('Escape'); await standalone.keyboard.press('ControlOrMeta+a');
  await electron.evaluate(({ clipboard }) => clipboard.clear());
  await standalone.keyboard.press('ControlOrMeta+c');
  await standalone.waitForTimeout(50); // Clipboard writes cross the renderer/main boundary.
  const text = await electron.evaluate(({ clipboard }) => clipboard.readText());
  try { return JSON.parse(text).elements.filter(e => !e.isDeleted); } catch { return []; }
}

async function standaloneFixture(t, { delaySaves = false, holdIncoming = false } = {}) {
  const reference = process.env.LOVE_SPOT_STANDALONE_DIR || path.join(os.homedir(), '.local/lib/excalidraw-local');
  const f = await loveSpotFixture();
  let electron, xvfb;
  t.after(async () => { if (electron) await electron.close(); if (xvfb) xvfb.kill(); await f.close(); });
  const app = path.join(f.root, 'standalone'); await fs.mkdir(path.join(app, 'src'), { recursive: true });
  for (const name of ['main.cjs', 'preload.cjs', 'build.mjs', 'src/app.jsx', 'src/index.html']) await fs.copyFile(path.join(reference, name), path.join(app, name));
  await fs.symlink(path.join(reference, 'node_modules'), path.join(app, 'node_modules'));
  const { syncLoveSpot } = await import('../scripts/sync-love-spot.mjs');
  await syncLoveSpot(app); await syncLoveSpot(app, { build: false });
  if (holdIncoming) {
    const renderer = path.join(app, 'src/app.jsx');
    const text = await fs.readFile(renderer, 'utf8');
    assert.ok(text.includes('const board = window.board;'));
    await fs.writeFile(renderer, text.replace('const board = window.board;', `const board = { ...window.board, onIncoming: callback => window.board.onIncoming(data => {
      if (window.__holdIncoming && data.elements?.some(e => e.isDeleted)) window.__releaseIncoming = () => callback(data);
      else callback(data);
    }) };`));
    execFileSync(process.execPath, ['build.mjs'], { cwd: app });
  }
  if (delaySaves) {
    // Delay a real standalone keyboard save so both clients edit the same base.
    // Only the throwaway main process is instrumented, never the installed app.
    const mainFile = path.join(app, 'main.cjs');
    const saveHandler = "ipcMain.handle('save', (_event, text) => board.save(JSON.parse(text)));";
    const main = await fs.readFile(mainFile, 'utf8'); assert.ok(main.includes(saveHandler));
    await fs.writeFile(mainFile, main.replace(saveHandler, `ipcMain.handle('save', async (_event, text) => {
      const drawing = JSON.parse(text);
      const delayed = fs.existsSync(path.join(__dirname, 'hold-save')) && !fs.existsSync(path.join(__dirname, 'held-save.json'));
      if (delayed) {
        for (const e of drawing.elements) if (!e.isDeleted) e.versionNonce = 0;
        fs.writeFileSync(path.join(__dirname, 'held-save.json'), JSON.stringify(drawing));
        while (!fs.existsSync(path.join(__dirname, 'release-save'))) await new Promise(resolve => setTimeout(resolve, 10));
      }
      const saved = await board.save(drawing);
      if (delayed) fs.writeFileSync(path.join(__dirname, 'save-result.json'), JSON.stringify(saved));
      return saved;
    });`));
  }
  const bootstrap = path.join(app, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, `const {app}=require('electron'); app.setPath('userData', ${JSON.stringify(path.join(f.root, 'profile'))}); app.setPath('pictures', ${JSON.stringify(path.dirname(f.screenshots))}); require('./main.cjs');`);
  xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const display = await new Promise((resolve, reject) => { xvfb.stdio[3].once('data', data => resolve(`:${data.toString().trim()}`)); xvfb.once('error', reject); xvfb.once('exit', code => reject(new Error(`Xvfb exited ${code}`))); });
  await f.open(f.page);
  const nativeEnv = { ...process.env, XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', DISPLAY: display, EXCALIDRAW_LOCAL_DIR: f.directory,
    ELPIS_HOME: path.join(f.root, 'elpis-home'), ELPIS_DESKTOP_PROFILE: path.join(f.root, 'profile') };
  delete nativeEnv.WAYLAND_DISPLAY;
  electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', bootstrap], env: nativeEnv });
  const standalone = await electron.firstWindow(); standalone.setDefaultTimeout(10000);
  const standaloneErrors = []; standalone.on('pageerror', e => standaloneErrors.push(e.message));
  await standalone.locator('.excalidraw canvas').first().waitFor();
  return { f, app, electron, standalone, standaloneErrors };
}

test('a delayed standalone keyboard edit cannot revive an equal-version Elpis delete', async t => {
  const { f, app, electron, standalone, standaloneErrors } = await standaloneFixture(t, { delaySaves: true });
  await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await f.draw(f.page);
  const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'race shape did not save')).elements.find(e => !e.isDeleted);
  await standalone.bringToFront();
  await f.waitFor(async () => (await nativeCopy(electron, standalone)).some(e => e.id === original.id), 'standalone did not receive the race shape');
  // Let initialization and selection saves settle before holding the real edit.
  await standalone.waitForTimeout(650);
  await fs.writeFile(path.join(app, 'hold-save'), '');
  await standalone.keyboard.press('ArrowRight');
  let held;
  await f.waitFor(async () => {
    held = await fs.readFile(path.join(app, 'held-save.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    return held;
  }, 'standalone keyboard save was not held');
  await f.page.bringToFront();
  await f.page.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
  await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('Delete');
  const deleted = (await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'Elpis delete did not save')).elements.find(e => e.id === original.id);
  assert.equal(held.elements.find(e => e.id === original.id).version, deleted.version, 'native eval must create equal versions');
  await fs.writeFile(path.join(app, 'release-save'), '');
  let saved;
  await f.waitFor(async () => {
    saved = await fs.readFile(path.join(app, 'save-result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    return saved;
  }, 'delayed save did not finish');
  assert.equal(saved.scene.elements.find(e => e.id === original.id).isDeleted, true, 'delayed standalone save revived a deleted item');
  await standalone.bringToFront();
  await f.waitFor(async () => !(await nativeCopy(electron, standalone)).some(e => e.id === original.id), 'standalone renderer ignored the winning tombstone');
  await standalone.keyboard.press('ControlOrMeta+z');
  await standalone.waitForTimeout(500);
  assert.equal((await f.scene()).elements.find(e => e.id === original.id).isDeleted, true, 'standalone undo must not undo the remote deletion');
  await f.page.bringToFront(); await f.page.keyboard.press('ControlOrMeta+z');
  await f.waitFor(s => s.elements.some(e => e.id === original.id && !e.isDeleted), 'Elpis undo did not restore');
  await standalone.bringToFront();
  await f.waitFor(async () => (await nativeCopy(electron, standalone)).some(e => e.id === original.id), 'Elpis undo did not reach standalone');
  await standalone.keyboard.press('Delete');
  await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'standalone delete did not save');
  await standalone.keyboard.press('ControlOrMeta+z');
  await f.waitFor(s => s.elements.some(e => e.id === original.id && !e.isDeleted), 'standalone undo did not restore');
  await standalone.keyboard.press('ControlOrMeta+Shift+z');
  await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'standalone redo did not delete');
  const output = path.join(os.homedir(), '.cache/elpis-tests/night-lovespot-sync');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'native-conflict.json'), JSON.stringify({ original, deleted, delayed: held.elements, result: saved.scene.elements }, null, 2));
  assert.deepEqual(standaloneErrors, []); assert.deepEqual(f.errors, []);
});

test('standalone journals live text, Ctrl+S saves without ending it, and app quit flushes', async t => {
  const { f, electron, standalone, standaloneErrors } = await standaloneFixture(t);
  const bounds = await standalone.locator('.excalidraw').boundingBox();
  await standalone.mouse.click(bounds.x + 450, bounds.y + 220); await standalone.keyboard.press('t');
  await standalone.mouse.click(bounds.x + 450, bounds.y + 220);
  const input = standalone.locator('textarea.excalidraw-wysiwyg'); await input.waitFor();
  await standalone.keyboard.type('Native verdict');
  await f.waitFor(s => s.elements.some(e => e.text === 'Native verdict' && !e.isDeleted), 'native live keystrokes did not save');
  await f.draw(f.page, 200);
  await standalone.keyboard.type(' survives remote saves'); await standalone.keyboard.press('Control+s');
  await standalone.getByRole('status', { name: 'Drawing save status' }).filter({ hasText: 'Saved' }).waitFor();
  assert.equal(await input.inputValue(), 'Native verdict survives remote saves');
  // Persist a journal even when the real store refuses its ordinary save.
  await standalone.evaluate(() => { window.__nativeJournal = localStorage.getItem('elpis-draft-v1:love-spot-text-journal'); });
  assert.match(await standalone.evaluate(() => window.__nativeJournal), /Native verdict survives remote saves/);
  await standalone.keyboard.type(' and app quit');
  await electron.evaluate(({ app }) => { app.quit(); });
  await f.waitFor(s => s.elements.some(e => e.text === 'Native verdict survives remote saves and app quit' && !e.isDeleted), 'native quit lost final text');
  assert.deepEqual(standaloneErrors, []); assert.deepEqual(f.errors, []);
});

test('a remote deletion arriving in a real arrow-key batch never becomes undoable', async t => {
  const { f, electron, standalone, standaloneErrors } = await standaloneFixture(t, { holdIncoming: true });
  await f.draw(f.page);
  const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'shape did not save')).elements.find(e => !e.isDeleted);
  await f.waitFor(async () => (await nativeCopy(electron, standalone)).some(e => e.id === original.id), 'standalone did not load the shape');
  await standalone.evaluate(() => { window.__holdIncoming = true; });
  await f.page.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
  await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('Delete');
  await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'delete did not save');
  await standalone.waitForFunction(() => typeof window.__releaseIncoming === 'function');
  await standalone.evaluate(() => window.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { window.__holdIncoming = false; window.__releaseIncoming(); window.__releaseIncoming = null; }
  }, { once: true }));
  await standalone.bringToFront(); await standalone.keyboard.press('ArrowRight');
  await f.waitFor(async () => !(await nativeCopy(electron, standalone)).some(e => e.id === original.id), 'the real key batch did not display the deletion');
  await standalone.keyboard.press('ControlOrMeta+z'); await standalone.waitForTimeout(600);
  assert.equal((await f.scene()).elements.find(e => e.id === original.id)?.isDeleted, true, 'Undo captured a remote delete during a pending local edit');
  assert.equal((await nativeCopy(electron, standalone)).length, 0);
  // The sending window still owns its deliberate delete and may undo it.
  await f.page.keyboard.press('ControlOrMeta+z');
  await f.waitFor(s => !s.elements.find(e => e.id === original.id)?.isDeleted, 'local delete undo stopped working');
  assert.deepEqual(standaloneErrors, []); assert.deepEqual(f.errors, []);
});

test('Love Spot standalone Electron and Elpis exchange mouse strokes in under a second without losing concurrent additions', async t => {
  const { f, standalone, standaloneErrors } = await standaloneFixture(t);
  await Promise.all([f.draw(f.page), f.draw(standalone, 140)]);
  await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 2, 'concurrent windows lost an element');
  const fromStandalone = Date.now(); // Measure propagation after the stroke is published.
  await f.page.bringToFront();
  await f.page.locator('.excalidraw').click({ position: { x: 1000, y: 700 } });
  await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // A disk write is not an acknowledgement from this window. Observe both
  // shapes through the real Copy action before asking Delete to remove them.
  await f.waitFor(async () => {
    await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('ControlOrMeta+c');
    const text = await f.page.evaluate(() => navigator.clipboard.readText());
    try { return JSON.parse(text).elements.filter(e => !e.isDeleted).length === 2; } catch { return false; }
  }, 'both published shapes must reach the Elpis canvas', 700);
  await f.page.keyboard.press('Delete');
  await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 0, 'standalone stroke did not reach Elpis', 700).catch(async e => {
    await f.page.screenshot({ path: '/tmp/love-spot-pages-standalone-failure.png' });
    throw new Error(`${e.message}; scene: ${JSON.stringify((await f.scene()).elements.map(e => [e.id, e.version, e.isDeleted]))}; alerts: ${JSON.stringify(await f.page.locator('.love-spot [role="alert"]').allTextContents())}`);
  });
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
  // A page switch replaces the standalone scene, including its old tombstones and history.
  await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
  await f.page.getByRole('menuitem', { name: 'New page', exact: true }).click();
  await f.waitFor(s => s.page?.name === 'Page 2' && s.elements.length === 0, 'new page was not created');
  await standalone.waitForTimeout(400);
  await f.draw(standalone);
  await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 1, 'standalone could not draw on the new page');
  assert.equal((await f.scene()).elements.length, 1, 'standalone mixed the previous page into the new one');
  await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
  await f.page.getByRole('menuitem', { name: /Current page/ }).click();
  await f.waitFor(s => s.page?.name === 'Current page', 'original page was not restored');
  await standalone.waitForTimeout(400);
  await f.draw(standalone, 60);
  await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'standalone did not follow the return switch');
  assert.equal((await f.scene()).elements.filter(e => !e.isDeleted).length, 1);
  await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const dataURL = await standalone.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 3200; canvas.height = 200;
    const context = canvas.getContext('2d'); context.fillStyle = '#619c87'; context.fillRect(0, 0, 3200, 200);
    return canvas.toDataURL('image/png');
  });
  const image = (await f.scene()).elements.find(e => e.type === 'image');
  await fs.writeFile(path.join(f.directory, 'inbox', 'standalone-large.json'), JSON.stringify({
    elements: [{ ...image, id: 'standalone-large', fileId: 'standalone-large', version: 1, isDeleted: false }],
    files: { 'standalone-large': { id: 'standalone-large', mimeType: 'image/png', dataURL, created: Date.now() } },
  }));
  await f.waitFor(async s => s.files['standalone-large'] && await standalone.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode(); return Math.max(image.naturalWidth, image.naturalHeight) <= 1600;
  }, s.files['standalone-large'].dataURL), 'standalone did not resize an inbox image without the Elpis editor');
  assert.deepEqual(standaloneErrors, []);
  assert.deepEqual(f.errors, []);
});
