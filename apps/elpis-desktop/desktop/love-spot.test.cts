const { createTestTempDir, removeTestTempDir } = require('../tests/temp-root.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

type Control = { dirty: unknown; workflowSaved: boolean; inert?: boolean; readFailure?: boolean };
type Relaunch = { execPath: string; args: string[] };
type Call = string | ['thread', string] | ['relaunch', Relaunch];
type Host = { isDestroyed: () => boolean; webContents: { executeJavaScript: (script: string) => Promise<unknown> } };

// The standalone app makes its own home on start; tests give it a throwaway one, never the real ~/.local/share/love-spot.
const launchHome = createTestTempDir(path.join(require('node:os').tmpdir(), 'love-dock-home-'));
test.after(() => removeTestTempDir(launchHome));
let launchEnv: Record<string, string> = {};
async function launch(args: string[], flushText?: () => Promise<boolean>, flushBrowsers?: () => Promise<void>, canRestart = async () => true) {
  const app = new EventEmitter(); let ready!: () => void, lock!: { loveSpot: boolean };
  const identity: Record<string, string> = {};
  Object.assign(app, { setName: (name: string) => { identity.name = name; }, setPath: (key: string, value: string) => { identity[key] = value; },
    setDesktopName: (name: string) => { identity.desktop = name; }, getPath: () => '/tmp/love-dock-test',
    commandLine: { appendSwitch() {}, getSwitchValue: () => '' },
    requestSingleInstanceLock: (data: { loveSpot: boolean }) => { lock = data; return true; },
    whenReady: () => new Promise<void>(resolve => { ready = resolve; }), quit() {}, relaunch: (value: Relaunch) => calls.push(['relaunch', value]) });
  const calls: Call[] = []; const host = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, focus: () => calls.push('focus-chat') };
  const openers = { threads: { queue: (id: string) => calls.push(['thread', id]) }, newChats: { queue() {} } };
  const sessions = { windows: new Set<Host>(), flushText, flushBrowsers: async () => { calls.push('browser-flush'); await flushBrowsers?.(); }, openersFor: () => openers,
    open: async () => { calls.push('chat'); return host; }, openLoveSpot: async () => { calls.push('love'); }, openWorkflows: async () => { calls.push('workflows'); } };
  const electron = { app, ipcMain: { handle() {}, removeHandler() {} }, dialog: { showErrorBox() {} }, Menu: { buildFromTemplate: (x: unknown) => x, setApplicationMenu() {} } };
  const context = vm.createContext({ __dirname, console, process: { argv: ['electron', 'app', ...args], env: { HOME: launchHome, ...launchEnv }, platform: 'linux' },
    sessions, openers, testStore: { get: () => null, flush: async () => calls.push('workspace-flush') }, testServer: { canRestart, close: async () => calls.push('board-close') },
    require: (name: string) => name === './app-updates.cts' ? { executableLauncher: (file: string) => file, createAppUpdates: () => ({ setRunningEngine() {} }) } : name === 'electron' ? electron : name === './quick-entry.cts' ? { startQuickEntry: () => { calls.push('quick-entry'); return { start: async () => {} }; } }
      : name === './tray.cts' ? { createCloseToTray: () => ({}), createTray: () => { calls.push('tray'); return { destroy() {} }; } }
      : name === './screenshot-popup.cts' ? { createScreenshotPopup: () => ({ attach: () => () => {}, dispose() {} }), drawsOnWayland: () => false } : require(name) });
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, 'main.cts'), 'utf8')), context);
  vm.runInContext('server = testServer; store = testStore; sessionWindows = sessions; primaryOpeners = openers;', context);
  ready();
  const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
  return { app, calls, lock, settle, identity, sessions, quit: () => vm.runInContext('quitApp', context)(), restart: (target: string) => vm.runInContext('quitApp', context)(target) };
}

function editableHost(control: Control, calls: Call[]) {
  const webContents = Object.assign(new EventEmitter(), { executeJavaScript: async (script: string) => {
    if (script.includes('__elpisHasUnsavedFiles')) { calls.push('files-check'); if (control.readFailure) throw Error('Private file status read failed'); return control.dirty; }
    if (script.includes('__elpisFlushWorkflow')) { calls.push('workflow-flush'); return control.workflowSaved; }
    if (script.includes('inert = true')) control.inert = true;
    if (script.includes('inert = false')) control.inert = false;
    if (script.includes('storage')) calls.push('storage-flush');
    return true;
  } });
  return { isDestroyed: () => false, webContents };
}
for (const action of ['quit', 'restart']) test(`explicit ${action} keeps all windows open for hidden source edits and permits a clean retry`, async () => {
  const f = await launch([], async () => true), clean: Control = { dirty: false, workflowSaved: true }, hidden: Control = { dirty: true, workflowSaved: true };
  f.sessions.windows.add(editableHost(clean, f.calls)); f.sessions.windows.add(editableHost(hidden, f.calls));
  const run = () => action === 'quit' ? f.quit() : f.restart('/selected/new/launch');
  await assert.rejects(run(), /Save or revert file edits/);
  assert.equal(hidden.dirty, true); assert.equal(clean.inert, false); assert.equal(hidden.inert, false);
  assert.ok(!f.calls.includes('board-close')); assert.ok(!f.calls.includes('storage-flush'));
  hidden.dirty = false; assert.equal(await run(), true); assert.ok(f.calls.includes('board-close'));
});
test('explicit quit flushes the latest workflow before native storage and refuses a failed graph save', async () => {
  const f = await launch([], async () => true), control: Control = { dirty: false, workflowSaved: false };
  f.sessions.windows.add(editableHost(control, f.calls));
  await assert.rejects(f.quit(), /Workflow could not be saved/);
  assert.ok(!f.calls.includes('storage-flush')); assert.ok(!f.calls.includes('board-close')); assert.equal(control.inert, false);
  control.workflowSaved = true; assert.equal(await f.quit(), true);
  assert.ok(f.calls.lastIndexOf('workflow-flush') < f.calls.indexOf('storage-flush'));
  assert.ok(f.calls.indexOf('storage-flush') < f.calls.indexOf('board-close'));
});
for (const dirty of [undefined, null, 1, 'false']) test(`an invalid installed file status (${String(dirty)}) refuses explicit quit`, async () => {
  const f = await launch([], async () => true), control: Control = { dirty, workflowSaved: true };
  f.sessions.windows.add(editableHost(control, f.calls));
  await assert.rejects(f.quit(), /Save or revert file edits/); assert.equal(control.inert, false); assert.ok(!f.calls.includes('board-close'));
});
test('a failed file status read restores editing and permits retry after the renderer recovers', async () => {
  const f = await launch([], async () => true), control: Control = { dirty: false, workflowSaved: true, readFailure: true };
  f.sessions.windows.add(editableHost(control, f.calls));
  await assert.rejects(f.quit(), /Private file status read failed/); assert.equal(control.inert, false); assert.ok(!f.calls.includes('board-close'));
  control.readFailure = false; assert.equal(await f.quit(), true);
});

test('app quit waits for live text before closing the board server; a failure permits retry', async () => {
  let release!: (value: boolean) => void, saves = 0;
  const f = await launch([], () => { saves++; return new Promise(resolve => { release = resolve; }); });
  let prevented = 0, quit = 0; f.app.quit = () => { quit++; };
  const request = () => f.app.emit('before-quit', { preventDefault() { prevented++; } });
  request(); await f.settle();
  assert.equal(saves, 1); assert.equal(prevented, 1); assert.ok(!f.calls.includes('board-close')); assert.equal(quit, 0);
  release(false); await f.settle(); assert.equal(quit, 0); assert.ok(!f.calls.includes('board-close'));
  request(); await f.settle(); assert.equal(saves, 2);
  release(true); await f.settle(); assert.ok(f.calls.includes('board-close')); assert.equal(quit, 1);
  assert.ok(f.calls.indexOf('browser-flush') < f.calls.indexOf('board-close'));
});

test('app quit waits for browser persistence and permits retry after a failed save', async () => {
  let finish!: { resolve: () => void; reject: (error: Error) => void };
  const f = await launch([], async () => true, () => new Promise((resolve, reject) => { finish = { resolve, reject }; }));
  let quit = 0; f.app.quit = () => { quit++; };
  const request = () => f.app.emit('before-quit', { preventDefault() {} });
  request(); await f.settle();
  assert.ok(f.calls.includes('browser-flush')); assert.ok(!f.calls.includes('board-close')); assert.equal(quit, 0);
  finish.reject(Error('fixture browser save failure')); await f.settle();
  assert.ok(!f.calls.includes('board-close')); assert.equal(quit, 0);
  request(); await f.settle();
  assert.equal(f.calls.filter(call => call === 'browser-flush').length, 2);
  finish.resolve(); await f.settle();
  assert.ok(f.calls.includes('board-close')); assert.equal(quit, 1);
});

function sessionFixture({ loveSpotApp = false } = {}) {
  class Window extends EventEmitter {
    constructor() {
      super(); this.text = 'First words'; this.saved = ''; this.saves = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setUserAgent() {}, webRequest: { onHeadersReceived() {}, onBeforeSendHeaders() {} } },
        setWindowOpenHandler() {},
        executeJavaScript: async () => {
          this.saves++;
          if (this.failure === 'throw') throw Error('Test disk unavailable');
          if (this.failure === 'refuse') return false;
          this.saved = this.text; return true;
        },
      });
    }
    isDestroyed() { return !!this.destroyed; }
    async loadURL(url: string) { this.url = url; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const noop = () => {};
  const stubs = {
    './browser-sessions.cts': { createBrowserSessions: () => ({ attach: () => ({ open: noop, setBackground: noop, dispose: noop }), drop: noop, flush: async () => {} }) },
    './state.cts': { registerState: () => noop }, './files.cts': { registerFiles: () => noop },
    './terminal.cts': { registerTerminal: () => noop }, './context-menu.cts': { attachContextMenu: () => noop },
    './theme.cts': { registerTheme: () => noop }, './improve.cts': { registerImprove: () => noop },
    './open-thread.cts': { createThreadOpener: () => ({ attach: () => noop }), createNewChatOpener: () => ({ attach: () => noop }) },
    './window-ipc.cts': { createWindowIpc: () => () => ({ handle: noop, removeHandler: noop }) },
    // Shared documents (84f35b9d4) attach to each window; these checks are about saving and closing.
    './documents.cts': { createDocuments: () => ({ attach: () => noop, call: async () => null }) },
  };
  const module = { exports: {} as { createSessionWindows: (options: unknown) => { open: () => Promise<Window>; openLoveSpot: () => Promise<Window>; flushText: () => Promise<boolean>; windows: Set<Window> } } };
  vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, 'session-windows.cts'), 'utf8')), {
    __dirname, module, console: { ...console, error: noop }, URL, require: (name: string) => (stubs as Record<string, unknown>)[name] ?? require(name),
  });
  return module.exports.createSessionWindows({ electron: { BrowserWindow: Window }, url: 'http://127.0.0.1:4000/',
    closeToTray: { hides: () => false, closed: noop }, mayClose: () => true, loveSpotApp });
}

for (const failure of ['refuse', 'throw']) test(`a partly failed quit still flushes later text when another window closes (${failure})`, async () => {
  const sessions = sessionFixture(), embedded = await sessions.open(), standalone = await sessions.openLoveSpot();
  standalone.failure = failure;
  if (failure === 'throw') await assert.rejects(sessions.flushText(), /Test disk unavailable/);
  else assert.equal(await sessions.flushText(), false);
  assert.equal(embedded.isDestroyed(), false);
  embedded.text = 'Final verdict after cancelled quit';
  embedded.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(embedded.saved, embedded.text, 'cancelled quit must not let the next close skip its new text');
  assert.equal(embedded.isDestroyed(), true);
  standalone.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(standalone.isDestroyed(), false, 'a refused save keeps its window and text');
  assert.equal(standalone.text, 'First words');
});

test('a completely successful quit closes both windows without duplicate flushes', async () => {
  const sessions = sessionFixture(), embedded = await sessions.open(), standalone = await sessions.openLoveSpot();
  assert.equal(await sessions.flushText(), true);
  embedded.close(); standalone.close();
  assert.equal(embedded.saved, embedded.text); assert.equal(standalone.saved, standalone.text);
  assert.equal(embedded.saves, 1); assert.equal(standalone.saves, 1);
  assert.equal(sessions.windows.size, 0);
});

test('cold --love-spot launch opens only the drawing window and carries the flag through the lock', async () => {
  const f = await launch(['--love-spot']);
  assert.equal(f.lock.loveSpot, true);
  assert.deepEqual(f.calls, ['quick-entry', 'love', 'tray']);
});

// Masih (18 Oct): the red M on his dock is his Love Spot. Inside Elpis's process its window groups under Elpis's icon,
// so the dock starts it as its own app: the dock's identity (excalidraw.desktop), its own profile and lock, and nothing
// of Elpis's (no Quick Entry shortcut, no second tray icon).
test('--love-spot-app is its own app under the Love Spot dock icon', async () => {
  const f = await launch(['--love-spot-app']);
  assert.equal(f.identity.desktop, 'excalidraw.desktop');
  assert.match(f.identity.userData, /Love Spot$/);
  assert.deepEqual(f.calls, ['love']);
  f.app.emit('second-instance', {}, ['electron', '--love-spot-app'], '', {}); await f.settle();
  f.app.emit('activate'); await f.settle();
  assert.deepEqual(f.calls, ['love', 'love', 'love'], 'every way back into it opens Love Spot');
});

// 7 Nov: a package's window must carry its own launcher's identity, or the dock shows a generic icon.
test('a packaged Love Spot names its own launcher', async (t: import('node:test').TestContext) => {
  t.after(() => { launchEnv = {}; });
  launchEnv = { LOVE_SPOT_DESKTOP: 'love-spot.desktop' };
  assert.equal((await launch(['--love-spot-app'])).identity.desktop, 'love-spot.desktop');
  launchEnv = { LOVE_SPOT_DESKTOP: 'love-spot_love-spot.desktop' };
  assert.equal((await launch(['--love-spot-app'])).identity.desktop, 'love-spot_love-spot.desktop');
});

test('--workflows-app is its own app under the Workflows dock icon', async () => {
  const f = await launch(['--workflows-app']);
  assert.equal(f.identity.desktop, 'elpis-workflows.desktop');
  assert.match(f.identity.userData, /Elpis Workflows$/);
  assert.deepEqual(f.calls, ['workflows']);
  f.app.emit('second-instance', {}, ['electron', '--workflows-app'], '', {}); await f.settle();
  f.app.emit('activate'); await f.settle();
  assert.deepEqual(f.calls, ['workflows', 'workflows', 'workflows'], 'every way back into it opens Workflows');
});

test('a running Elpis routes second-instance Love Spot launches separately from chat and openThread', async () => {
  const f = await launch([]);
  const windows = () => f.calls.filter(call => call !== 'quick-entry' && call !== 'tray');
  assert.deepEqual(windows(), ['chat']);
  f.app.emit('second-instance', {}, ['electron', '--love-spot'], '', {}); await f.settle();
  f.app.emit('second-instance', {}, [], '', { loveSpot: true }); await f.settle();
  assert.deepEqual(windows(), ['chat', 'love', 'love']);
  f.app.emit('second-instance', {}, ['electron', '--open-thread', 'chat-123'], '', {}); await f.settle();
  assert.deepEqual(f.calls.slice(-2), ['focus-chat', ['thread', 'chat-123']]);
});

test('dock preparation replaces both launch paths, preserves other actions, and can print an exact rollback', async () => {
  const { prepareDock, rollbackCommand } = await import('../scripts/point-love-dock.mjs');
  const old = '[Desktop Entry]\nName=Love Spot\nExec=old-app\nActions=new-page;other;\nStartupWMClass=excalidraw\n\n[Desktop Action new-page]\nName=New page\nExec=old-new-page\n\n[Desktop Action other]\nExec=keep-this\n';
  const next = prepareDock(old, '/tmp/a home');
  assert.equal(next.match(/Exec="\/tmp\/a home\/\.local\/bin\/elpis-app" --love-spot-app$/gm)?.length, 2);
  assert.match(next, /\[Desktop Action other\]\nExec=keep-this/);
  assert.equal(prepareDock(next, '/tmp/a home'), next, 'applying twice is harmless');
  assert.throws(() => prepareDock('[Desktop Entry]\nExec=x\n', '/tmp'), /new-page/);
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const root = createTestTempDir(path.join(os.tmpdir(), 'love-dock-rollback-'));
  try {
    const file = path.join(root, 'drawing.desktop'); fs.writeFileSync(file, next);
    const result = spawnSync('bash', ['-c', rollbackCommand(file, old)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(file, 'utf8'), old);
  } finally { removeTestTempDir(root); }
});


test('Restart refuses active work and a later idle retry preserves standalone Love Spot mode', async () => {
  let active = true;
  const f = await launch(['--love-spot-app'], async () => true, undefined, async () => !active);
  await assert.rejects(f.restart('/selected/new/launch'), /Wait for the voice call, Love Spot, Lab or workflow run in this window to finish/);
  assert.ok(!f.calls.includes('board-close'));
  active = false; assert.equal(await f.restart('/selected/new/launch'), true);
  assert.ok(f.calls.includes('board-close'));
  const relaunched = f.calls.find((call): call is ['relaunch', Relaunch] => Array.isArray(call) && call[0] === 'relaunch')![1];
  assert.equal(relaunched.execPath, '/selected/new/launch');
  assert.deepEqual(Array.from(relaunched.args), ['--love-spot-app']);
});

test('a refused final save does not schedule a relaunch or close the board', async () => {
  let saved = false;
  const f = await launch([], async () => saved);
  await assert.rejects(f.restart('/selected/new/launch'), /Text could not be saved/);
  assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'relaunch'));
  assert.ok(!f.calls.includes('board-close'));
  saved = true; assert.equal(await f.restart('/selected/new/launch'), true);
});


test('a Restart requested during an ordinary Quit is retained and schedules only one launch', async () => {
  let finish!: (value: boolean) => void;
  const f = await launch([], () => new Promise(resolve => { finish = resolve; }));
  f.app.emit('before-quit', { preventDefault() {} }); await f.settle();
  const restarting = f.restart('/selected/new/launch');
  finish(true); await restarting;
  const launches = f.calls.filter((call): call is ['relaunch', Relaunch] => Array.isArray(call) && call[0] === 'relaunch');
  assert.equal(launches.length, 1); assert.equal(launches[0]![1].execPath, '/selected/new/launch');
});

test('only the standalone Love Spot app opens its board marked as the app, which hides subscription routes', async () => {
  const inElpis = await sessionFixture().openLoveSpot();
  assert.equal(new URL(inElpis.url).searchParams.get('app'), null);
  const app = await sessionFixture({ loveSpotApp: true }).openLoveSpot();
  assert.equal(new URL(app.url).pathname, '/love-spot.html');
  assert.equal(new URL(app.url).searchParams.get('app'), 'love-spot');
});
