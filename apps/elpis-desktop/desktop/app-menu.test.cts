'use strict';
const { preloadPath }: typeof import('./preload-path.cts') = require('./preload-path.cts');
import type { EventEmitter as Emitter } from 'node:events';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAppMenu }: typeof import('./app-menu.cts') = require('./app-menu.cts');

function fixture() {
  const calls: unknown[][] = [], handlers = new Map<string, (event: unknown, command: unknown) => Promise<unknown>>(), mainFrame = { url: 'http://127.0.0.1:45001/' };
  const webContents = { mainFrame, send: (...args: unknown[]) => calls.push(['send', ...args]), focus: () => calls.push(['focus']),
    getZoomFactor: () => 1, setZoomFactor: (value: number) => calls.push(['zoom', value]) };
  for (const command of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) (webContents as unknown as Record<string, () => number>)[command] = () => calls.push([command]);
  const host = { webContents, isDestroyed: () => false, close: () => calls.push(['close']), isFullScreen: () => false, setFullScreen: (value: boolean) => calls.push(['fullscreen', value]) };
  const ipcMain = { handle: (name: string, handler: (event: unknown, command: unknown) => Promise<unknown>) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) };
  const appMenu = createAppMenu({ ipcMain, windows: () => [host], origin: () => 'http://127.0.0.1:45001',
    newWindow: async () => calls.push(['new-window']), quit: async () => calls.push(['quit']) } as unknown as Parameters<typeof createAppMenu>[0]);
  return { appMenu, calls, host, handlers, event: { sender: webContents, senderFrame: mainFrame },
    command(command: unknown, event: unknown = { sender: webContents, senderFrame: mainFrame }) { return handlers.get('elpis:menu:command')!(event, command); } };
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
  const f = fixture(), template = f.appMenu.template() as unknown as { label: string; submenu: { label?: string; role?: string; accelerator?: string; click: (item: object, host: object) => void }[] }[];
  assert.deepEqual(template.map(group => group.label), ['File', 'Edit', 'View', 'Help']);
  const file = template[0]!.submenu;
  file.find(item => item.label === 'Settings')!.click({}, f.host);
  assert.deepEqual(f.calls.at(-1), ['send', 'elpis:menu:requested', 'settings']);
  assert.equal(file.find(item => item.label === 'New chat')!.accelerator, undefined, 'renderer owns customizable shortcuts');
  assert.equal(template[1]!.submenu.find(item => item.label === 'Paste')!.role, 'paste');
});

test('preload exposes only the native menu command channel and unsubscribes app-menu events', async () => {
  const renderer = new EventEmitter() as Emitter & { sendSync: () => object; invoke: (...args: unknown[]) => Promise<{ performed: boolean }> }, invoked: unknown[][] = []; let api: { menu: { command: (action: string) => Promise<unknown>; subscribe: (listener: (action: string) => void) => () => void } } | undefined;
  renderer.sendSync = () => ({}); renderer.invoke = async (...args: unknown[]) => { invoked.push(args); return { performed: true }; };
  vm.runInNewContext(fs.readFileSync(preloadPath('preload'), 'utf8'), { require: () => ({ ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (_name: string, value: typeof api) => { api = value; } } }) });
  assert.ok(api); await api!.menu.command('paste'); assert.deepEqual(invoked, [['elpis:menu:command', 'paste']]);
  const heard: string[] = [], stop = api!.menu.subscribe((action: string) => heard.push(action));
  renderer.emit('elpis:menu:requested', {}, 'settings'); stop(); renderer.emit('elpis:menu:requested', {}, 'shortcuts');
  assert.deepEqual(heard, ['settings']);
});
