'use strict';
// Quick Entry and its global shortcut, as Claude's desktop app has them on Linux, against a fake Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DEFAULT_SHORTCUT, validAccelerator, shortcutSupport, createShortcut, createQuickEntry, startQuickEntry } = require('./quick-entry.cjs');
const { createNewChatOpener } = require('./open-thread.cjs');

function fakeShortcuts({ refuse = [] } = {}) {
  const registered = new Map(), log = [];
  return {
    registered, log,
    register(accelerator, callback) { log.push(['register', accelerator]); if (refuse.includes(accelerator)) return false; registered.set(accelerator, callback); return true; },
    unregister(accelerator) { log.push(['unregister', accelerator]); registered.delete(accelerator); },
  };
}

test("Claude's Linux shortcut, Ctrl+Alt+Space, is the default; a shortcut needs a modifier or a function key", () => {
  assert.equal(DEFAULT_SHORTCUT, 'Ctrl+Alt+Space');
  for (const good of ['Ctrl+Alt+Space', 'Super+E', 'Ctrl+Shift+K', 'F9', 'Alt+F4', 'Ctrl+1']) assert.equal(validAccelerator(good), true, good);
  for (const bad of ['', 'Space', 'K', 'Ctrl+', 'Ctrl+ArrowUp', 'Ctrl+Alt+Space; rm', 'x'.repeat(200)]) assert.equal(validAccelerator(bad), false, bad);
});

test('the shortcut registers at start, swaps on change, keeps the old one when the new one is taken, and is released on quit', () => {
  const app = new EventEmitter(), globalShortcut = fakeShortcuts({ refuse: ['Ctrl+Alt+K'] });
  let pressed = 0;
  const shortcut = createShortcut({ app, globalShortcut, onPress: () => pressed++ });
  assert.equal(shortcut.set(DEFAULT_SHORTCUT), null);
  assert.deepEqual([...globalShortcut.registered.keys()], ['Ctrl+Alt+Space']);
  globalShortcut.registered.get('Ctrl+Alt+Space')();
  assert.equal(pressed, 1, 'pressing it opens Quick Entry');
  assert.equal(shortcut.set('Ctrl+Alt+K'), 'in-use', 'another app holds it');
  assert.equal(shortcut.current(), 'Ctrl+Alt+Space', 'the previous shortcut keeps working');
  assert.deepEqual([...globalShortcut.registered.keys()], ['Ctrl+Alt+Space']);
  assert.equal(shortcut.set('K'), 'invalid');
  assert.equal(shortcut.current(), 'Ctrl+Alt+Space');
  assert.equal(shortcut.set('Super+E'), null);
  assert.deepEqual([...globalShortcut.registered.keys()], ['Super+E']);
  assert.equal(shortcut.set(''), null, 'an empty shortcut turns it off');
  assert.equal(globalShortcut.registered.size, 0);
  shortcut.set('Super+E');
  app.emit('will-quit');
  assert.equal(globalShortcut.registered.size, 0, 'quitting releases the shortcut');
  assert.deepEqual(globalShortcut.log.at(-1), ['unregister', 'Super+E']);
});

test('on Wayland, a global shortcut needs the GlobalShortcuts portal; without it Elpis says so', async () => {
  const asked = [];
  const busctl = answer => async args => { asked.push(args); if (answer instanceof Error) throw answer; return answer; };
  assert.deepEqual(await shortcutSupport({ env: { XDG_SESSION_TYPE: 'x11' }, busctl: busctl('') }), { supported: true });
  assert.equal(asked.length, 0, 'X11 needs no portal');
  assert.deepEqual(await shortcutSupport({ env: { XDG_SESSION_TYPE: 'wayland' }, busctl: busctl('u 1\n') }), { supported: true });
  assert.deepEqual(asked[0].slice(-4), ['org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.GlobalShortcuts', 'version']);
  const missing = await shortcutSupport({ env: { WAYLAND_DISPLAY: 'wayland-0' }, busctl: busctl(new Error('Unknown interface')) });
  assert.equal(missing.supported, false);
  assert.match(missing.reason, /GlobalShortcuts desktop portal.*Wayland session/);
});

function fakeElectron() {
  const windows = [], channels = new Map();
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; this.destroyed = false; this.focused = 0; this.position = [options.x, options.y]; this.top = null;
      this.webContents = Object.assign(new EventEmitter(), { sent: [], send: (...args) => this.webContents.sent.push(args), setWindowOpenHandler: handler => { this.webContents.openHandler = handler; } });
      windows.push(this);
    }
    loadFile(file, options) { this.loaded = { file, options }; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve(); }
    setAlwaysOnTop(flag, level) { this.top = [flag, level]; }
    setPosition(x, y) { this.position = [x, y]; }
    getPosition() { return this.position; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; this.emit('show'); }
    hide() { if (!this.visible) return; this.visible = false; this.emit('hide'); }
    focus() { this.focused++; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = { on: (name, listener) => channels.set(name, listener), removeListener: name => channels.delete(name) };
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 32, width: 1920, height: 1048 } }) };
  return { BrowserWindow, ipcMain, screen, windows, channels };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Quick Entry is Claude's floating prompt: 606 by 470, frameless, on top, centred, and the shortcut toggles it", async () => {
  const electron = fakeElectron();
  const quick = createQuickEntry({ ...electron, dark: () => true, onSubmit: () => {} });
  await quick.toggle(); await tick();
  const [window] = electron.windows;
  assert.equal(electron.windows.length, 1);
  const { options } = window;
  assert.deepEqual([options.width, options.height, options.frame, options.transparent, options.resizable, options.skipTaskbar, options.show], [606, 470, false, true, false, true, false]);
  assert.deepEqual([options.webPreferences.contextIsolation, options.webPreferences.sandbox, options.webPreferences.nodeIntegration], [true, true, false]);
  assert.equal(options.webPreferences.preload, path.join(__dirname, 'quick-entry-preload.cjs'));
  assert.equal(window.loaded.file, path.join(__dirname, 'quick-entry.html'));
  assert.deepEqual(window.loaded.options, { query: { theme: 'dark' } });
  assert.deepEqual(window.top, [true, 'pop-up-menu']);
  assert.deepEqual(window.position, [657, 321], 'centred in the main display');
  assert.equal(window.visible, true); assert.ok(window.focused > 0);
  window.setPosition(100, 200); // dragged by its bar
  await quick.toggle();
  assert.equal(window.visible, false, 'the shortcut again closes it');
  await quick.toggle();
  assert.deepEqual(window.position, [100, 200], 'it reopens where it was left, as in Claude');
  assert.equal(electron.windows.length, 1, 'one window, reused');
  assert.deepEqual(window.webContents.sent.at(-1), ['elpis:quick-entry:show', { dark: true }]);
  window.emit('blur');
  assert.equal(window.visible, false, 'clicking elsewhere dismisses it');
});

test('Enter in Quick Entry opens a new chat in the main window with the text; Esc, short text and other pages send nothing', async () => {
  const electron = fakeElectron(), opened = [];
  // As desktop/main.cjs: the text waits for the main window, which takes it from elpis:new-chat:take and sends it.
  const newChats = createNewChatOpener();
  const main = { webContents: { sent: [], mainFrame: { url: 'http://127.0.0.1:45001/' }, send: (...args) => main.webContents.sent.push(args) }, isDestroyed: () => false };
  const handlers = new Map();
  newChats.attach({ host: main, origin: 'http://127.0.0.1:45001', ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) } });
  const quick = createQuickEntry({ ...electron, dark: () => false, onSubmit: text => { newChats.queue(text); opened.push(text); } });
  await quick.toggle(); await tick();
  const [window] = electron.windows, from = { sender: window.webContents };
  electron.channels.get('elpis:quick-entry:submit')(from, 'Summarise the README');
  assert.equal(window.visible, false, 'it closes on Enter');
  assert.deepEqual(opened, ['Summarise the README']);
  assert.deepEqual(main.webContents.sent, [['elpis:new-chat']], 'the main window is told a new chat waits');
  const take = handlers.get('elpis:new-chat:take'), page = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  assert.equal(await take(page), 'Summarise the README');
  assert.equal(await take(page), null, 'once');
  await quick.toggle();
  electron.channels.get('elpis:quick-entry:submit')(from, ' hi ');
  assert.equal(window.visible, false);
  assert.deepEqual(opened, ['Summarise the README'], "as in Claude, text of two characters or fewer is not sent");
  await quick.toggle();
  electron.channels.get('elpis:quick-entry:dismiss')(from);
  assert.equal(window.visible, false, 'Esc closes it');
  await quick.toggle();
  electron.channels.get('elpis:quick-entry:submit')({ sender: {} }, 'from another page');
  assert.equal(window.visible, true, 'another page cannot submit');
  assert.deepEqual(opened, ['Summarise the README']);
  quick.dispose();
  assert.equal(electron.channels.size, 0);
  assert.equal(window.destroyed, true);
});

test('Settings learns why the shortcut does not work: no portal on Wayland, or another app holding it', async () => {
  const start = async (support, refuse = []) => {
    const electron = fakeElectron(), app = new EventEmitter(), globalShortcut = fakeShortcuts({ refuse });
    const quick = startQuickEntry({ ...electron, app, globalShortcut, dark: () => false, onSubmit: () => {}, support: Promise.resolve(support) });
    await quick.start(DEFAULT_SHORTCUT);
    return { quick, globalShortcut };
  };
  const wayland = await start({ supported: false, reason: 'Global keyboard shortcuts need the GlobalShortcuts desktop portal, which this Wayland session does not provide.' });
  assert.equal(wayland.globalShortcut.log.length, 0, 'nothing is registered');
  assert.deepEqual(await wayland.quick.status(), { supported: false, reason: 'Global keyboard shortcuts need the GlobalShortcuts desktop portal, which this Wayland session does not provide.', shortcut: '', problem: 'Global keyboard shortcuts need the GlobalShortcuts desktop portal, which this Wayland session does not provide.' });
  assert.match((await wayland.quick.change('Super+E')).error, /portal/);
  const taken = await start({ supported: true }, ['Ctrl+Alt+Space']);
  assert.deepEqual(await taken.quick.status(), { supported: true, shortcut: '', problem: 'This shortcut is already in use by another app. Try a different combination.' });
  assert.deepEqual(await taken.quick.change('Super+E'), { shortcut: 'Super+E' });
  assert.deepEqual(await taken.quick.status(), { supported: true, shortcut: 'Super+E', problem: null });
  assert.deepEqual(await taken.quick.change('Ctrl+'), { error: 'This shortcut combination isn’t supported. Try a different combination.' });
});


test('hidden Quick Entry text is saved before Quit and restored only on the first show after reopening', async () => {
  const electron = fakeElectron(); let saved = 'Recovered Quick Entry draft', value = 'Final hidden Quick Entry words', reject = true;
  const drafts = { read: () => saved, save: async text => { if (reject) throw Error('Private Quick Entry disk unavailable'); saved = text; } };
  const quick = createQuickEntry({ ...electron, drafts, dark: () => false, onSubmit() {} });
  await quick.toggle(); const [window] = electron.windows;
  assert.equal(window.webContents.sent.at(-1)[1].draft, saved);
  await quick.toggle();
  window.webContents.executeJavaScript = async () => value;
  await assert.rejects(quick.flush(), /disk unavailable/);
  assert.equal(window.isDestroyed(), false);
  reject = false; await quick.cancelQuit(); await quick.flush();
  assert.equal(saved, value); quick.dispose();
  const reopened = fakeElectron(), next = createQuickEntry({ ...reopened, drafts, dark: () => false, onSubmit() {} });
  await next.toggle(); assert.equal(reopened.windows[0].webContents.sent.at(-1)[1].draft, value);
  await next.toggle(); await next.toggle();
  assert.equal('draft' in reopened.windows[0].webContents.sent.at(-1)[1], false, 'later shows preserve current textarea instead of restoring stale saved text');
  next.dispose();
});
