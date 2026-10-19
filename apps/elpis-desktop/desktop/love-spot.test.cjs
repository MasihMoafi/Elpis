'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

async function launch(args, flushText, flushBrowsers) {
  const app = new EventEmitter(); let ready, lock;
  const identity = {};
  Object.assign(app, { setName: name => { identity.name = name; }, setPath: (key, value) => { identity[key] = value; },
    setDesktopName: name => { identity.desktop = name; }, getPath: () => '/tmp/love-dock-test',
    commandLine: { appendSwitch() {}, getSwitchValue: () => '' },
    requestSingleInstanceLock: data => { lock = data; return true; },
    whenReady: () => new Promise(resolve => { ready = resolve; }), quit() {} });
  const calls = [], host = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, focus: () => calls.push('focus-chat') };
  const openers = { threads: { queue: id => calls.push(['thread', id]) }, newChats: { queue() {} } };
  const sessions = { windows: new Set(), flushText, flushBrowsers: async () => { calls.push('browser-flush'); await flushBrowsers?.(); }, openersFor: () => openers,
    open: async () => { calls.push('chat'); return host; }, openLoveSpot: async () => { calls.push('love'); } };
  const electron = { app, Menu: { buildFromTemplate: x => x, setApplicationMenu() {} } };
  const context = vm.createContext({ __dirname, console, process: { argv: ['electron', 'app', ...args], env: {}, platform: 'linux' },
    sessions, openers, testStore: { get: () => null, flush: async () => calls.push('workspace-flush') }, testServer: { close: async () => calls.push('board-close') },
    require: name => name === 'electron' ? electron : name === './quick-entry.cjs' ? { startQuickEntry: () => { calls.push('quick-entry'); return { start: async () => {} }; } }
      : name === './tray.cjs' ? { createCloseToTray: () => ({}), createTray: () => { calls.push('tray'); return {}; } } : require(name) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context);
  vm.runInContext('server = testServer; store = testStore; sessionWindows = sessions; primaryOpeners = openers;', context);
  ready();
  const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
  return { app, calls, lock, settle, identity };
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'love-dock-rollback-'));
  try {
    const file = path.join(root, 'drawing.desktop'); fs.writeFileSync(file, next);
    const result = spawnSync('bash', ['-c', rollbackCommand(file, old)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(file, 'utf8'), old);
  } finally { spawnSync('gio', ['trash', root]); }
});
