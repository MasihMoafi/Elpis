'use strict';
// The tray and Close to tray, as Claude's desktop app has them on Linux, against a fake Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { trayMenu, createTray, createCloseToTray } = require('./tray.cjs');

function actions() {
  const calls = [];
  return { calls, actions: { open: () => calls.push('open'), newChat: () => calls.push('newChat'), quickEntry: () => calls.push('quickEntry'), quit: () => calls.push('quit') } };
}

test("the tray menu has Claude's items where Elpis has them: Open Elpis, New chat, Open Quick Entry, then Quit", () => {
  const { calls, actions: handlers } = actions();
  const items = trayMenu(handlers);
  assert.deepEqual(items.map(item => item.type === 'separator' ? '|' : item.label), ['Open Elpis', 'New chat', 'Open Quick Entry', '|', 'Quit']);
  for (const item of items) item.click?.();
  assert.deepEqual(calls, ['open', 'newChat', 'quickEntry', 'quit']);
});

test('the tray shows the Elpis logo, named Elpis, with that menu', () => {
  const made = {};
  class Tray { constructor(image) { made.image = image; made.tray = this; } setToolTip(text) { made.tooltip = text; } setContextMenu(menu) { made.menu = menu; } destroy() { made.destroyed = true; } }
  const nativeImage = { createFromPath: file => ({ file, resize: size => ({ file, size }) }) };
  const Menu = { buildFromTemplate: template => ({ template }) };
  const icon = path.join(__dirname, 'elpis-icon.png');
  const tray = createTray({ Tray, Menu, nativeImage, icon, actions: actions().actions });
  assert.equal(tray, made.tray);
  assert.deepEqual(made.image, { file: icon, size: { width: 64, height: 64 } }, "Claude's tray icon is 64 pixels");
  assert.equal(made.tooltip, 'Elpis');
  assert.deepEqual(made.menu.template.map(item => item.label ?? '|'), ['Open Elpis', 'New chat', 'Open Quick Entry', '|', 'Quit']);
});

function closingWith({ enabled, quitting = false }) {
  const app = new EventEmitter(); app.quits = 0; app.quit = () => { app.quits++; };
  const window = new EventEmitter(); window.hidden = 0; window.hide = () => { window.hidden++; };
  const state = { enabled, quitting };
  const closing = createCloseToTray({ app, enabled: () => state.enabled, quitting: () => state.quitting, platform: 'linux' });
  // What desktop/main.cjs does on the window's close: hidden to the tray, or closed for good. Quick Entry's own window
  // may still exist (hidden), so quitting must not wait for every window to close.
  const close = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    if (!closing.hides(event, window) && !event.prevented) closing.closed();
    return event;
  };
  return { app, window, state, close };
}

test('with Close to tray off (the default), closing the window quits Elpis, as before', () => {
  const { app, window, close } = closingWith({ enabled: false });
  assert.equal(close().prevented, false);
  assert.equal(window.hidden, 0);
  assert.equal(app.quits, 1);
});

test('with Close to tray on, closing hides the window and Elpis keeps running; Quit still quits', () => {
  const { app, window, state, close } = closingWith({ enabled: true });
  assert.equal(close().prevented, true);
  assert.equal(window.hidden, 1);
  assert.equal(app.quits, 0, 'nothing quits while the window is in the tray');
  state.quitting = true; // the tray's Quit, or File > Quit
  assert.equal(close().prevented, false, 'quitting closes the window instead of hiding it');
  assert.equal(window.hidden, 1);
  assert.equal(app.quits, 1);
});
