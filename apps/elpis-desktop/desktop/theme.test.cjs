'use strict';
// The app's theme report ('elpis:theme') in the Electron main process, with Electron replaced by fakes: the window
// buttons, nativeTheme (so web pages in the browser follow prefers-color-scheme) and the browser's page background.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TITLE_BAR = { dark: { color: '#0d0e11' }, light: { color: '#f2f2f1' } };

function setup() {
  const { registerTheme } = require('./theme.cjs');
  const listeners = new Map(), mainFrame = {}, webContents = { mainFrame }, overlays = [], backgrounds = [], darks = [];
  const nativeTheme = { themeSource: 'system' }, host = { webContents, isDestroyed: () => false, setTitleBarOverlay: value => overlays.push(value) };
  const dispose = registerTheme({ host, ipcMain: { on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } },
    nativeTheme, titleBar: TITLE_BAR, browser: { setBackground: color => backgrounds.push(color) }, onDark: dark => darks.push(dark) });
  const report = (...args) => listeners.get('elpis:theme')({ sender: webContents, senderFrame: mainFrame }, ...args);
  return { listeners, report, nativeTheme, overlays, backgrounds, darks, dispose, webContents, mainFrame };
}

test('the window buttons and Quick Entry follow the reported theme, as before', () => {
  const t = setup();
  t.report(false); t.report(true);
  assert.deepEqual(t.overlays, [TITLE_BAR.light, TITLE_BAR.dark]);
  assert.deepEqual(t.darks, [false, true]);
  t.report('yes');
  assert.equal(t.darks.at(-1), false, 'only a true boolean means dark');
});

test('nativeTheme follows the person\'s choice, so pages see prefers-color-scheme and the app keeps its own system mode', () => {
  const t = setup();
  t.report(true, { source: 'dark' });
  assert.equal(t.nativeTheme.themeSource, 'dark');
  t.report(false, { source: 'light' });
  assert.equal(t.nativeTheme.themeSource, 'light');
  t.report(true, { source: 'system' });
  assert.equal(t.nativeTheme.themeSource, 'system', 'System hands the choice back to the operating system, which the app\'s own page reads');
  t.report(true, { source: 'sepia' });
  t.report(false, {});
  t.report(true);
  assert.equal(t.nativeTheme.themeSource, 'system', 'a report without a valid choice leaves nativeTheme alone');
});

test('the browser gets the app\'s background colour, and only a plain colour', () => {
  const t = setup();
  t.report(true, { background: 'rgb(10, 11, 13)' });
  t.report(false, { background: '#fbfbfa' });
  for (const bad of ['url(https://example.invalid/x)', 'red; color: blue', 'rgb(1, 2, 3); x', '', 42, null, undefined, {}]) t.report(true, { background: bad });
  assert.deepEqual(t.backgrounds, ['rgb(10, 11, 13)', '#fbfbfa']);
});

test('only the app\'s own page may report a theme', () => {
  const t = setup();
  t.listeners.get('elpis:theme')({ sender: {}, senderFrame: t.mainFrame }, true, { source: 'dark', background: '#000000' });
  t.listeners.get('elpis:theme')({ sender: t.webContents, senderFrame: {} }, true, { source: 'dark', background: '#000000' });
  assert.deepEqual([t.overlays, t.backgrounds, t.nativeTheme.themeSource], [[], [], 'system']);
});

test('disposing stops listening', () => {
  const t = setup(); t.dispose();
  assert.equal(t.listeners.has('elpis:theme'), false);
});

test('the page\'s setTheme sends the dark flag, the choice and the background over the same channel', () => {
  const sent = []; let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { sendSync: () => ({}), send: (...args) => sent.push(args), invoke: async () => ({}), on: () => {}, removeListener: () => {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => electron });
  api.setTheme(true, { source: 'dark', background: 'rgb(10, 11, 13)', extra: 'dropped' });
  api.setTheme(false);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['elpis:theme', true, { source: 'dark', background: 'rgb(10, 11, 13)' }], ['elpis:theme', false, {}]]);
});
