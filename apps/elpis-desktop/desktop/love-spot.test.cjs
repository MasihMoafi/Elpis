'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

async function launch(args) {
  const app = new EventEmitter(); let ready, lock;
  Object.assign(app, { setName() {}, setPath() {}, getPath: () => '/tmp/love-dock-test',
    commandLine: { appendSwitch() {}, getSwitchValue: () => '' },
    requestSingleInstanceLock: data => { lock = data; return true; },
    whenReady: () => new Promise(resolve => { ready = resolve; }), quit() {} });
  const calls = [], host = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, focus: () => calls.push('focus-chat') };
  const openers = { threads: { queue: id => calls.push(['thread', id]) }, newChats: { queue() {} } };
  const sessions = { windows: new Set(), openersFor: () => openers,
    open: async () => { calls.push('chat'); return host; }, openLoveSpot: async () => { calls.push('love'); } };
  const electron = { app, Menu: { buildFromTemplate: x => x, setApplicationMenu() {} } };
  const context = vm.createContext({ __dirname, console, process: { argv: ['electron', 'app', ...args], env: {}, platform: 'linux' },
    sessions, openers, testStore: { get: () => null },
    require: name => name === 'electron' ? electron : name === './quick-entry.cjs' ? { startQuickEntry: () => ({ start: async () => {} }) }
      : name === './tray.cjs' ? { createCloseToTray: () => ({}), createTray: () => ({}) } : require(name) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context);
  vm.runInContext('server = {}; store = testStore; sessionWindows = sessions; primaryOpeners = openers;', context);
  ready();
  const settle = () => new Promise(resolve => setImmediate(resolve)); await settle();
  return { app, calls, lock, settle };
}

test('cold --love-spot launch opens only the drawing window and carries the flag through the lock', async () => {
  const f = await launch(['--love-spot']);
  assert.equal(f.lock.loveSpot, true);
  assert.deepEqual(f.calls, ['love']);
});

test('a running Elpis routes second-instance Love Spot launches separately from chat and openThread', async () => {
  const f = await launch([]);
  assert.deepEqual(f.calls, ['chat']);
  f.app.emit('second-instance', {}, ['electron', '--love-spot'], '', {}); await f.settle();
  f.app.emit('second-instance', {}, [], '', { loveSpot: true }); await f.settle();
  assert.deepEqual(f.calls, ['chat', 'love', 'love']);
  f.app.emit('second-instance', {}, ['electron', '--open-thread', 'chat-123'], '', {}); await f.settle();
  assert.deepEqual(f.calls.slice(-2), ['focus-chat', ['thread', 'chat-123']]);
});

test('dock preparation replaces both launch paths, preserves other actions, and can print an exact rollback', async () => {
  const { prepareDock, rollbackCommand } = await import('../scripts/point-love-dock.mjs');
  const old = '[Desktop Entry]\nName=Love Spot\nExec=old-app\nActions=new-page;other;\nStartupWMClass=excalidraw\n\n[Desktop Action new-page]\nName=New page\nExec=old-new-page\n\n[Desktop Action other]\nExec=keep-this\n';
  const next = prepareDock(old, '/tmp/a home');
  assert.equal(next.match(/Exec="\/tmp\/a home\/\.local\/bin\/elpis-app" --love-spot/g)?.length, 2);
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
