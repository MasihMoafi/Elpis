const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const changed = updates => new Promise(resolve => { const off = updates.subscribe(value => { off(); resolve(value); }); });
const { execFileSync } = require('node:child_process');
const { createAppUpdates } = require('./app-updates.cjs');

function fixture({ restart } = {}) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'app-updates-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const name of ['one', 'two']) {
    const dir = path.join(root, name); fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch'), '#!/bin/sh\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'engine'), name, { mode: 0o700 });
  }
  const desktop = path.join(bin, 'elpis-app'), engine = path.join(bin, 'elpis-next');
  fs.symlinkSync(path.join(root, 'one', 'launch'), desktop); fs.symlinkSync(path.join(root, 'one', 'engine'), engine);
  const select = (link, target) => { const temporary = `${link}.next`; fs.symlinkSync(path.join(root, 'two', target), temporary); fs.renameSync(temporary, link); };
  const app = new EventEmitter(), calls = [];
  const updates = createAppUpdates({ app, desktopLauncher: desktop, engineLauncher: engine, runningApp: path.join(root, 'one', 'app'), runningEngine: path.join(root, 'one', 'engine'), restart: async target => { calls.push(target); await restart?.(target); } });
  const close = () => { updates.dispose(); execFileSync('gio', ['trash', root]); };
  return { root, app, updates, calls, desktop, engine, select, close };
}

test('atomic desktop install notifies every subscribed window, then restarts through the selected launcher once', async () => {
  const f = fixture();
  try {
    assert.equal(f.updates.status().available, false);
    const changes = [], off = f.updates.subscribe(state => changes.push(state));
    const wait = changed(f.updates); f.select(f.desktop, 'launch'); await wait;
    assert.equal(changes.at(-1).desktop, true); assert.equal(changes.at(-1).engine, false);
    await Promise.all([f.updates.restart(), f.updates.restart()]);
    assert.deepEqual(f.calls, [path.join(f.root, 'two', 'launch')]); off();
  } finally { f.close(); }
});

test('an engine-only selection change is visible and uses the current desktop launcher', async () => {
  const f = fixture();
  try {
    const wait = changed(f.updates); f.select(f.engine, 'engine'); await wait;
    assert.equal(f.updates.status().desktop, false); assert.equal(f.updates.status().engine, true);
    await f.updates.restart(); assert.deepEqual(f.calls, [path.join(f.root, 'one', 'launch')]);
  } finally { f.close(); }
});


test('a refused save keeps every window open and permits one later restart', async () => {
  let refuse = true;
  const f = fixture({ restart: async () => { if (refuse) throw Error('Keep this window open: draft save failed'); } });
  try {
    const wait = changed(f.updates); f.select(f.desktop, 'launch'); await wait;
    await assert.rejects(f.updates.restart(), /draft save failed/);
    assert.equal(f.updates.status().restarting, false); assert.match(f.updates.status().error, /draft save failed/);
    refuse = false; await f.updates.restart(); await f.updates.restart();
    assert.equal(f.calls.length, 2, 'one refused attempt followed by one successful request, no duplicate relaunch');
  } finally { f.close(); }
});

test('an engine update cannot restart through a missing desktop launcher', async () => {
  const f = fixture();
  try {
    const wait = changed(f.updates); f.select(f.engine, 'engine'); await wait;
    fs.renameSync(f.desktop, `${f.desktop}.missing`);
    await assert.rejects(f.updates.restart(), /launcher is unavailable/);
    assert.equal(f.calls.length, 0); assert.equal(f.updates.status().restarting, false);
  } finally { f.close(); }
});


test('quit can await fire-and-forget draft writes and a refused save stays blocked until retry', async () => {
  const vm = require('node:vm'), ipc = new EventEmitter();
  const waiting = [];
  ipc.sendSync = () => ({ values: {}, revision: 0 });
  ipc.invoke = (_channel, patch) => new Promise(resolve => waiting.push({ patch, resolve }));
  const context = vm.createContext({ require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { context.api = value; } } }) });
  const source = process.env.ELPIS_A12_BASELINE ? execFileSync('git', ['show', `${process.env.ELPIS_A12_BASELINE}:apps/elpis-desktop/desktop/preload.cjs`], { encoding: 'utf8' }) : fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  vm.runInContext(source, context);
  const { storage } = context.api;
  storage.setItem('elpis-draft-v1:chat', 'Final words');
  let saved = false;
  const flush = storage.flush().then(() => { saved = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(saved, false);
  const first = waiting.shift(); first.resolve({ key: first.patch.key, value: first.patch.value, revision: 1 });
  await flush; assert.equal(saved, true);
  storage.setItem('elpis-draft-v1:chat', 'Changed words');
  const refused = storage.flush();
  waiting.shift().resolve({ error: 'Fixture disk unavailable' });
  await assert.rejects(refused, /disk unavailable/);
  await assert.rejects(storage.flush(), /disk unavailable/);
  storage.setItem('elpis-draft-v1:chat', 'Changed words');
  const retry = storage.flush(), last = waiting.shift(); last.resolve({ key: last.patch.key, value: last.patch.value, revision: 2 });
  await retry; assert.equal(storage.getItem('elpis-draft-v1:chat'), 'Changed words');
});


test('restart checks all thread pages including agents and refuses unknown or cyclic results', async () => {
  const { startDesktopServer } = await import('../bridge/server.mjs');
  const base = path.join(os.homedir(), '.cache/elpis-tests');
  const root = fs.mkdtempSync(path.join(base, 'app-restart-idle-'));
  let active = true, calls = [], mode = 'valid';
  const client = Object.assign(new EventEmitter(), { close() {}, listThreads: async request => {
    calls.push(request);
    if (mode === 'unknown') return {};
    if (mode === 'cycle') return { data: [], nextCursor: 'same' };
    return request.cursor ? { data: [{ status: { type: active ? 'active' : 'idle' } }], nextCursor: null } : { data: [], nextCursor: 'older' };
  } });
  const server = await startDesktopServer({ client, elpisHome: root, trashFile: path.join(root, 'trash.json'), loveSpot: { directory: path.join(root, 'drawing'), screenshots: path.join(root, 'screenshots') } });
  try {
    assert.equal(await server.canRestart(), false); assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.includeAgentRuns === true));
    active = false; assert.equal(await server.canRestart(), true);
    mode = 'unknown'; await assert.rejects(server.canRestart(), /confirm.*idle/);
    mode = 'cycle'; await assert.rejects(server.canRestart(), /confirm.*idle/);
  } finally { await server.close(); execFileSync('gio', ['trash', root]); }
});


test('a directory selected as launcher is refused before any app shutdown', async () => {
  const f = fixture();
  try {
    const wait = changed(f.updates);
    const temporary = `${f.desktop}.invalid`; fs.symlinkSync(path.join(f.root, 'two'), temporary); fs.renameSync(temporary, f.desktop); await wait;
    await assert.rejects(f.updates.restart(), /executable file/);
    assert.equal(f.calls.length, 0); assert.equal(f.updates.status().restarting, false);
  } finally { f.close(); }
});
