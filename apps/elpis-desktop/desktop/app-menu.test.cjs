'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAppMenu } = require('./app-menu.cjs');

function fixture() {
  const calls = [], handlers = new Map(), mainFrame = { url: 'http://127.0.0.1:45001/' };
  const webContents = { mainFrame, send: (...args) => calls.push(['send', ...args]), focus: () => calls.push(['focus']),
    getZoomFactor: () => 1, setZoomFactor: value => calls.push(['zoom', value]) };
  for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) webContents[command] = () => calls.push([command]);
  const host = { webContents, isDestroyed: () => false, close: () => calls.push(['close']), isFullScreen: () => false, setFullScreen: value => calls.push(['fullscreen', value]) };
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const appMenu = createAppMenu({ ipcMain, windows: () => [host], origin: () => 'http://127.0.0.1:45001',
    newWindow: async () => calls.push(['new-window']), quit: async () => calls.push(['quit']) });
  return { appMenu, calls, host, handlers, event: { sender: webContents, senderFrame: mainFrame },
    command(command, event = this.event) { return handlers.get('elpis:menu:command')(event, command); } };
}

test('native menu commands use the owning window and preserve guarded close/quit entry points', async () => {
  const f = fixture();
  for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'zoomIn', 'zoomOut', 'resetZoom', 'fullscreen', 'new-window', 'close-window', 'quit']) await f.command(command);
  for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'new-window', 'close', 'quit']) assert.ok(f.calls.some(call => call[0] === command), command);
  assert.deepEqual(f.calls.filter(call => call[0] === 'zoom').map(call => call[1]), [1.1, 0.9, 1]);
  assert.ok(f.calls.some(call => call[0] === 'fullscreen' && call[1] === true));
  f.appMenu.dispose(); assert.equal(f.handlers.size, 0);
});

test('menu IPC rejects remote frames, subframes, foreign windows and unknown actions before doing work', async () => {
  const f = fixture();
  for (const event of [{ sender: {}, senderFrame: f.host.webContents.mainFrame }, { sender: f.host.webContents, senderFrame: { url: f.host.webContents.mainFrame.url } }]) await assert.rejects(f.command('paste', event), /application frame/i);
  for (const action of ['new-chat', 'open-folder', 'executeJavaScript', { action: 'paste' }, null]) await assert.rejects(f.command(action), /menu command/i);
  f.host.webContents.mainFrame.url = 'https://example.com/';
  await assert.rejects(f.command('quit'), /application frame/i);
  assert.deepEqual(f.calls, []);
});

test('native File/Edit/View/Help menus use the shared commands and dispatch app actions to the focused window', async () => {
  const f = fixture(), template = f.appMenu.template();
  assert.deepEqual(template.map(group => group.label), ['File', 'Edit', 'View', 'Help']);
  const file = template[0].submenu;
  file.find(item => item.label === 'Settings').click({}, f.host);
  assert.deepEqual(f.calls.at(-1), ['send', 'elpis:menu:requested', 'settings']);
  assert.equal(file.find(item => item.label === 'New chat').accelerator, undefined, 'renderer owns customizable shortcuts');
  assert.equal(template[1].submenu.find(item => item.label === 'Paste').role, 'paste');
});

test('preload exposes only the native menu command channel and unsubscribes app-menu events', async () => {
  const renderer = new EventEmitter(), invoked = []; let api;
  renderer.sendSync = () => ({}); renderer.invoke = async (...args) => { invoked.push(args); return { performed: true }; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => ({ ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } } }) });
  await api.menu.command('paste'); assert.deepEqual(invoked, [['elpis:menu:command', 'paste']]);
  const heard = [], stop = api.menu.subscribe(action => heard.push(action));
  renderer.emit('elpis:menu:requested', {}, 'settings'); stop(); renderer.emit('elpis:menu:requested', {}, 'shortcuts');
  assert.deepEqual(heard, ['settings']);
});
