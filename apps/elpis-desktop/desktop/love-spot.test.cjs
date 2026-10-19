const { createTestTempDir, removeTestTempDir } = require('../tests/temp-root.cjs');
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

async function launch(args, flushText, flushBrowsers, canRestart = async () => true) {
  const app = new EventEmitter(); let ready, lock;
  const identity = {};
  Object.assign(app, { setName: name => { identity.name = name; }, setPath: (key, value) => { identity[key] = value; },
    setDesktopName: name => { identity.desktop = name; }, getPath: () => '/tmp/love-dock-test',
    commandLine: { appendSwitch() {}, getSwitchValue: () => '' },
    requestSingleInstanceLock: data => { lock = data; return true; },
    whenReady: () => new Promise(resolve => { ready = resolve; }), quit() {}, relaunch: value => calls.push(['relaunch', value]) });
  const calls = [], host = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, focus: () => calls.push('focus-chat') };
  const openers = { threads: { queue: id => calls.push(['thread', id]) }, newChats: { queue() {} } };
  const sessions = { windows: new Set(), flushText, flushBrowsers: async () => { calls.push('browser-flush'); await flushBrowsers?.(); }, openersFor: () => openers,
    open: async () => { calls.push('chat'); return host; }, openLoveSpot: async () => { calls.push('love'); } };
  const electron = { app, dialog: { showErrorBox() {} }, Menu: { buildFromTemplate: x => x, setApplicationMenu() {} } };
  const context = vm.createContext({ __dirname, console, process: { argv: ['electron', 'app', ...args], env: {}, platform: 'linux' },
    sessions, openers, testStore: { get: () => null, flush: async () => calls.push('workspace-flush') }, testServer: { canRestart, close: async () => calls.push('board-close') },
    require: name => name === './app-updates.cjs' ? { executableLauncher: file => file, createAppUpdates: () => ({ setRunningEngine() {} }) } : name === 'electron' ? electron : name === './quick-entry.cjs' ? { startQuickEntry: () => { calls.push('quick-entry'); return { start: async () => {} }; } }
      : name === './tray.cjs' ? { createCloseToTray: () => ({}), createTray: () => { calls.push('tray'); return { destroy() {} }; } } : require(name) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context);
  vm.runInContext('server = testServer; store = testStore; sessionWindows = sessions; primaryOpeners = openers;', context);
  ready();
  const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
  return { app, calls, lock, settle, identity, restart: target => vm.runInContext('quitApp', context)(target) };
}

test('app quit waits for live text before closing the board server; a failure permits retry', async () => {
  let release, saves = 0;
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
  let finish;
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

function sessionFixture() {
  class Window extends EventEmitter {
    constructor() {
      super(); this.text = 'First words'; this.saved = ''; this.saves = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
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
    async loadURL(url) { this.url = url; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const noop = () => {};
  const stubs = {
    './browser-sessions.cjs': { createBrowserSessions: () => ({ attach: () => ({ open: noop, setBackground: noop, dispose: noop }), drop: noop, flush: async () => {} }) },
    './state.cjs': { registerState: () => noop }, './files.cjs': { registerFiles: () => noop },
    './terminal.cjs': { registerTerminal: () => noop }, './context-menu.cjs': { attachContextMenu: () => noop },
    './theme.cjs': { registerTheme: () => noop }, './improve.cjs': { registerImprove: () => noop },
    './open-thread.cjs': { createThreadOpener: () => ({ attach: () => noop }), createNewChatOpener: () => ({ attach: () => noop }) },
    './window-ipc.cjs': { createWindowIpc: () => () => ({ handle: noop, removeHandler: noop }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'session-windows.cjs'), 'utf8'), {
    __dirname, module, console: { ...console, error: noop }, URL, require: name => stubs[name] ?? require(name),
  });
  return module.exports.createSessionWindows({ electron: { BrowserWindow: Window }, url: 'http://127.0.0.1:4000/',
    closeToTray: { hides: () => false, closed: noop }, mayClose: () => true });
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
  await assert.rejects(f.restart('/selected/new/launch'), /running chats/);
  assert.ok(!f.calls.includes('board-close'));
  active = false; assert.equal(await f.restart('/selected/new/launch'), true);
  assert.ok(f.calls.includes('board-close'));
  const relaunched = f.calls.find(call => Array.isArray(call) && call[0] === 'relaunch')[1];
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
  let finish;
  const f = await launch([], () => new Promise(resolve => { finish = resolve; }));
  f.app.emit('before-quit', { preventDefault() {} }); await f.settle();
  const restarting = f.restart('/selected/new/launch');
  finish(true); await restarting;
  const launches = f.calls.filter(call => Array.isArray(call) && call[0] === 'relaunch');
  assert.equal(launches.length, 1); assert.equal(launches[0][1].execPath, '/selected/new/launch');
});
