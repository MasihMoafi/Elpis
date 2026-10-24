// Actual main.cjs quit/relaunch, native input and production preload/state store.
// The only boundaries replaced are the local backend, private installed selection,
// deterministic workspace failure and error-dialog reporting. No engine or inference.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const appDirectory = path.resolve(__dirname, '..');
const helper = path.join(__dirname, 'app-update-electron.cjs');
const COMPOSER = 'A12 private composer verdict 821 — متن فارسی';
const NOTE = 'A12 private Love Spot verdict 822';
const QUICK = 'A12 private hidden Quick Entry verdict 823';
const sources = ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/session-windows.cjs', 'desktop/app-updates.cjs', 'desktop/state.cjs', 'desktop/tray.cjs', 'desktop/quick-entry.cjs', 'desktop/quick-entry-preload.cjs', 'desktop/quick-entry.html', 'components/app-update.tsx', 'lib/files-pane.ts', 'lib/desktop.ts', 'components/agents-canvas.tsx'];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, crypto.createHash('sha256').update(await fs.readFile(path.join(appDirectory, file))).digest('hex')])));
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) { try { const value = await check(); if (value) return value; } catch {} if (Date.now() > end) throw Error(message); await new Promise(resolve => setTimeout(resolve, 50)); }
}
const events = async root => (await fs.readFile(path.join(root, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function using(t, { standalone = false, theme = 'light', fileProject = false } = {}, run) {
  assert(process.env.APP_UPDATE_PRIVATE_SESSION === '1' && process.env.DISPLAY && process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'), 'Use private dbus-run-session + Xvfb');
  const before = await hashes();
  const f = await loveSpotFixture();
  const sourceFile = path.join(f.root, 'source-project', 'guard.ts');
  if (fileProject) {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true }); await fs.writeFile(sourceFile, 'export const exact = 1;\n');
    f.chats.push({ id: 'private-source', name: 'Private source edits', cwd: path.dirname(sourceFile), model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
  }
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/app-update-native-'));
  const output = process.env.APP_UPDATE_EVIDENCE_DIR;
  if (output) await fs.mkdir(output, { recursive: true });
  const electron = require(path.join(appDirectory, 'node_modules/electron'));
  const bin = path.join(root, '.local/bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(root, 'profile'), { recursive: true });
  await fs.writeFile(path.join(root, 'profile/workspace.json'), JSON.stringify({ 'elpis-theme': theme, 'elpis-preferences-v1': JSON.stringify({ closeToTray: true, confirmClose: false }) }));
  const launchers = [];
  for (const version of ['one', 'two']) {
    const file = path.join(root, 'versions', version, 'elpis-app');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `#!/bin/sh\nexport APP_UPDATE_REOPENED=1\nexec ${shellQuote(electron)} --no-sandbox --ozone-platform=x11 ${shellQuote(helper)} "$@"\n`, { mode: 0o700 });
    launchers.push(file);
  }
  await fs.symlink(launchers[0], path.join(bin, 'elpis-app'));
  const engine = path.join(root, 'engine'); await fs.writeFile(engine, 'private selection only'); await fs.symlink(engine, path.join(bin, 'elpis-next'));
  let desktop;
  try {
    desktop = await _electron.launch({ executablePath: electron, args: ['--no-sandbox', '--ozone-platform=x11', helper, ...(standalone ? ['--love-spot-app'] : [])], cwd: appDirectory,
      env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', XDG_CONFIG_HOME: path.join(root, 'config'), ELPIS_HOME: path.join(root, 'elpis'), ELPIS_DESKTOP_PROFILE: path.join(root, 'profile'),
        APP_UPDATE_TEST_ROOT: root, SESSION_WINDOW_URL: f.url, LANG: 'C.UTF-8' } });
    const page = await until(() => desktop.windows().find(page => page.url().startsWith(f.url.split('#')[0]) && (standalone ? page.url().includes('love-spot') : !page.url().includes('love-spot'))), 'Main app window did not open');
    page.setDefaultTimeout(12000);
    // Native will-prevent-unload owns this dialog. Playwright's automatic dismissal
    // races the native override after the page has already closed.
    desktop.context().on('page', page => page.on('dialog', () => {}));
    for (const page of desktop.windows()) page.on('dialog', () => {});
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const click = async locator => {
      await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox(); assert(box);
      const native = await (await desktop.browserWindow(locator.page())).evaluate(host => ({ bounds: host.getContentBounds(), zoom: host.webContents.getZoomFactor(), id: host.getNativeWindowHandle().readUInt32LE() }));
      execFileSync('/usr/bin/xdotool', ['windowfocus', '--sync', String(native.id), 'mousemove', '--sync', String(Math.round(native.bounds.x + (box.x + box.width / 2) * native.zoom)), String(Math.round(native.bounds.y + (box.y + box.height / 2) * native.zoom)), 'click', '1']);
    };
    const key = async (target, chord) => {
      const id = await (await desktop.browserWindow(target)).evaluate(host => host.getNativeWindowHandle().readUInt32LE());
      execFileSync('/usr/bin/xdotool', ['windowfocus', '--sync', String(id), 'key', '--clearmodifiers', chord]);
    };
    const update = async () => {
      const temp = path.join(bin, 'elpis-app.next'); await fs.symlink(launchers[1], temp); await fs.rename(temp, path.join(bin, 'elpis-app'));
      await page.getByRole('button', { name: 'Update ready · Restart', exact: true }).waitFor();
    };
    const capture = async (target, name) => {
      if (!output) return;
      const id = await (await desktop.browserWindow(target)).evaluate(host => host.id);
      await desktop.evaluate((_electron, { id, file }) => global.updateTest.capture(id, file), { id, file: path.join(output, name) });
    };
    const note = async target => {
      await target.locator('.excalidraw canvas').first().waitFor();
      const box = await target.locator('.excalidraw').boundingBox();
      await target.mouse.click(box.x + 350, box.y + 220); await target.keyboard.press('t'); await target.mouse.click(box.x + 350, box.y + 220);
      const editor = target.locator('textarea.excalidraw-wysiwyg'); await editor.waitFor(); await editor.fill(NOTE);
    };
    const loveWindow = async () => {
      if (standalone) return page;
      await desktop.evaluate(() => global.updateTest.openLoveSpot());
      return until(() => desktop.windows().find(page => page.url().includes('love-spot')), 'Love Spot window did not open');
    };
    await run({ f, root, desktop, page, click, key, update, note, loveWindow, capture, sourceFile });
    const log = await events(root); assert.equal(log.some(event => event.type === 'fatal'), false, JSON.stringify(log));
  } finally {
    let cleanupTimer;
    await Promise.race([desktop?.close().catch(() => {}), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 5000); })]);
    clearTimeout(cleanupTimer);
    // app.relaunch creates a separate process. On a failing check stop only that
    // test-owned helper, verified by its exact private-root environment.
    let pids = [];
    try { pids = execFileSync('pgrep', ['-f', helper], { encoding: 'utf8' }).trim().split('\n'); } catch {}
    for (const pid of pids) {
      try {
        const environment = (await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');
        if (environment.includes(`APP_UPDATE_TEST_ROOT=${root}`)) process.kill(Number(pid), 'SIGTERM');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    if (output) {
      const receipt = standalone ? 'standalone' : t.name.includes('source-file') ? 'source-file' : t.name.includes('workflow') ? 'workflow' : t.name.includes('Ctrl') ? 'quit' : 'restart';
      await fs.writeFile(path.join(output, `${receipt}-events.json`), JSON.stringify(await events(root), null, 2));
      await fs.writeFile(path.join(output, `${receipt}-source-hashes.json`), JSON.stringify({ before, after: await hashes() }, null, 2));
      await fs.copyFile(path.join(root, 'reopened.png'), path.join(output, `${standalone ? 'standalone' : 'main'}-reopened.png`)).catch(() => {});
    }
    await f.close(); execFileSync('gio', ['trash', root]);
    assert.deepEqual(await hashes(), before, 'Production changed during the native check; rerun the checked source');
  }
}

test('installed update restarts real main and Love Spot windows only after idle safe saves', t => using(t, {}, async ({ f, root, desktop, page, click, key, update, note, loveWindow, capture }) => {
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true }); await composer.fill(COMPOSER);
  const love = await loveWindow(); await note(love); await update();
  await desktop.evaluate(() => global.updateTest.control.trayMenu.items.find(item => item.label === 'Open Quick Entry').click());
  const quick = await until(() => desktop.windows().find(page => page.url().includes('quick-entry.html')), 'Quick Entry did not open');
  await quick.getByRole('textbox', { name: 'Message Elpis', exact: true }).fill(QUICK); await key(quick, 'Escape');
  await until(async () => !await (await desktop.browserWindow(quick)).evaluate(host => host.isVisible()), 'Quick Entry did not hide with unsent text');
  await desktop.evaluate(() => { global.updateTest.control.canRestart = false; });
  await click(page.getByRole('button', { name: 'Update ready · Restart', exact: true }));
  await page.getByRole('alert').filter({ hasText: 'Wait for the voice call' }).waitFor();
  assert.equal(await composer.inputValue(), COMPOSER); assert.equal((await events(root)).filter(event => event.type === 'server-close').length, 0);
  await desktop.evaluate(() => { global.updateTest.control.canRestart = true; });
  await capture(page, 'main-update-light.png');
  await click(page.getByRole('button', { name: 'Update ready · Restart', exact: true }));
  const restored = await until(async () => (await events(root)).find(event => ['restored', 'fatal'].includes(event.type)), 'Selected launcher did not reopen saved text');
  assert.equal(restored.type, 'restored', restored.message);
  assert.equal(restored.mode, 'main'); assert.equal(restored.composer, COMPOSER); assert.equal(restored.quickEntry, QUICK); assert(restored.texts.includes(NOTE));
  await until(async () => (await events(root)).some(event => event.stage === 'reopened' && event.type === 'will-quit'), 'Reopened fixture did not quit');
  assert.equal((await events(root)).filter(event => event.type === 'launch').length, 1);
  assert((await events(root)).some(event => event.type === 'tray-quit-callback'), 'Actual native tray Quit callback ran');
  await f.waitFor(scene => scene.elements.some(item => item.text === NOTE && !item.isDeleted), 'Love Spot text did not persist');
}));

test('Ctrl+Q fails closed on a rejected native draft patch, then quits despite tray preference and beforeunload', t => using(t, {}, async ({ root, desktop, page, key }) => {
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await desktop.evaluate(() => { global.updateTest.control.failWrites = true; }); await composer.fill(COMPOSER);
  await page.evaluate(() => { window.onbeforeunload = () => false; });
  await key(page, 'ctrl+q');
  await until(() => desktop.evaluate(() => global.updateTest.control.errors.length), 'Quit did not report failed workspace save');
  assert.equal(await page.evaluate(() => document.documentElement.inert), false); assert.equal(await composer.inputValue(), COMPOSER);
  assert.equal((await events(root)).filter(event => event.type === 'server-close').length, 0);
  await desktop.evaluate(() => { global.updateTest.control.failWrites = false; });
  await composer.fill(COMPOSER + ' '); await composer.fill(COMPOSER);
  await key(page, 'ctrl+q');
  await until(async () => (await events(root)).some(event => event.type === 'will-quit'), 'Ctrl+Q left the app running');
  const saved = JSON.parse(await fs.readFile(path.join(root, 'profile/workspace.json'), 'utf8'));
  assert(Object.values(saved).includes(COMPOSER), 'Native workspace acknowledged the exact draft');
  assert.equal((await events(root)).filter(event => event.type === 'server-close').length, 1);
}));

test('standalone Love Spot update preserves dock mode and exact active text on relaunch', t => using(t, { standalone: true, theme: 'dark' }, async ({ root, page, click, update, note, capture }) => {
  await note(page); await update(); await page.evaluate(() => { window.onbeforeunload = () => false; });
  await capture(page, 'standalone-update-dark.png');
  await click(page.getByRole('button', { name: 'Update ready · Restart', exact: true }));
  const restored = await until(async () => (await events(root)).find(event => ['restored', 'fatal'].includes(event.type)), 'Standalone selected launcher did not restore text');
  assert.equal(restored.type, 'restored', restored.message);
  assert.equal(restored.mode, 'love-spot'); assert(restored.texts.includes(NOTE));
  await until(async () => (await events(root)).some(event => event.stage === 'reopened' && event.type === 'will-quit'), 'Reopened standalone did not quit');
  assert.equal((await events(root)).filter(event => event.type === 'launch').length, 1);
}));

test('source-file edits block real Quit and Restart, failed Save stays blocked, and deliberate Save/Revert permits Quit', t => using(t, { fileProject: true }, async ({ root, desktop, page, click, key, update, capture, sourceFile }) => {
  const exact = 'export const exact = 821; // متن فارسی\n';
  await click(page.locator('.thread-row[data-thread-id="private-source"] .thread-link'));
  await click(page.getByRole('button', { name: 'Show side panel', exact: true }));
  await click(page.getByRole('button', { name: 'New side panel tab', exact: true })); await click(page.getByRole('menuitem', { name: 'Files', exact: true }));
  await click(page.getByRole('treeitem', { name: 'guard.ts', exact: true }));
  const editor = page.getByRole('textbox', { name: 'Contents of guard.ts', exact: true }); await editor.fill(exact);
  const refusedQuit = async () => {
    const start = (await events(root)).length; await key(page, 'ctrl+q');
    const result = await until(async () => (await events(root)).slice(start).find(event => ['error', 'server-close'].includes(event.type)), 'Quit did not settle');
    assert.equal(result.type, 'error', 'dirty source edits must block Quit before closing the server'); assert.match(result.message, /Save or revert file edits/);
    assert.equal(await page.evaluate(() => document.documentElement.inert), false); assert.equal(await editor.inputValue(), exact);
  };
  await refusedQuit(); assert.equal(await fs.readFile(sourceFile, 'utf8'), 'export const exact = 1;\n');
  await update(); await click(page.getByRole('button', { name: 'Update ready · Restart', exact: true }));
  await page.getByRole('alert').filter({ hasText: 'Save or revert file edits' }).waitFor(); assert.equal((await events(root)).filter(event => event.type === 'server-close').length, 0);
  let failSave = true;
  await page.route('**/api/file', route => failSave && route.request().method() === 'POST' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Private file save refused' }) }) : route.continue());
  const save = page.getByRole('region', { name: 'File viewer' }).getByRole('button', { name: 'Save', exact: true });
  await click(save); await page.getByRole('alert').filter({ hasText: 'Private file save refused' }).waitFor(); await refusedQuit();
  await capture(page, 'source-file-save-refused.png');
  failSave = false; await click(save); await page.waitForFunction(() => window.__elpisHasUnsavedFiles === false);
  assert.equal(await fs.readFile(sourceFile, 'utf8'), exact);
  await editor.fill(exact + '// deliberate revert\n'); await click(page.getByRole('button', { name: 'Revert changes', exact: true }));
  assert.equal(await editor.inputValue(), exact); assert.equal(await page.evaluate(() => window.__elpisHasUnsavedFiles), false);
  await key(page, 'ctrl+q'); await until(async () => (await events(root)).some(event => event.type === 'will-quit'), 'Clean source retry did not quit');
  assert.equal((await events(root)).filter(event => event.type === 'server-close').length, 1);
}));

test('pending workflow debounce is explicitly saved before Quit; rejected native graph storage keeps editing and retry', t => using(t, { theme: 'dark' }, async ({ root, desktop, page, click, key, capture }) => {
  await click(page.getByRole('button', { name: 'Workflows', exact: true })); const graphName = page.getByRole('textbox', { name: 'Graph name', exact: true }); await graphName.waitFor();
  await until(() => desktop.evaluate(() => global.updateTest.control.store.read()['elpis-workflow-draft-v1']), 'Initial graph was not saved');
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await desktop.evaluate(() => { global.updateTest.control.failWorkflowWrites = true; });
  await graphName.fill('Latest pending workflow verdict 826');
  const start = (await events(root)).length; await key(page, 'ctrl+q');
  const result = await until(async () => (await events(root)).slice(start).find(event => ['error', 'server-close'].includes(event.type)), 'Workflow Quit did not settle');
  assert.equal(result.type, 'error', 'a rejected final graph write must block Quit'); assert.match(result.message, /Private workflow save refused/);
  assert.equal(await page.evaluate(() => document.documentElement.inert), false); assert.equal(await graphName.inputValue(), 'Latest pending workflow verdict 826');
  await capture(page, 'workflow-save-refused-dark.png');
  await desktop.evaluate(() => { global.updateTest.control.failWorkflowWrites = false; }); await key(page, 'ctrl+q');
  await until(async () => (await events(root)).some(event => event.type === 'will-quit'), 'Workflow save retry did not quit');
  const saved = JSON.parse(await fs.readFile(path.join(root, 'profile/workspace.json'), 'utf8'));
  assert.equal(JSON.parse(saved['elpis-workflow-draft-v1']).name, 'Latest pending workflow verdict 826');
}));
