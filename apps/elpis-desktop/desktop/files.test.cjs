'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function preload(invoke) {
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { sendSync: () => ({}), invoke, on: () => {}, removeListener: () => {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => electron });
  return api;
}

function setup(openPath = async () => '') {
  const { registerFiles } = require('./files.cjs');
  const handlers = new Map();
  const mainFrame = { url: 'http://127.0.0.1:45001/' };
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame };
  const dispose = registerFiles({ host: { webContents }, origin: 'http://127.0.0.1:45001',
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    shell: { openPath } });
  return { handlers, event, webContents, dispose, open: async (target, sender = event) => {
    const result = await handlers.get('elpis:file:open')(sender, target);
    if (result.error) throw Error(result.error);
    return result;
  } };
}

test('the app preload offers a narrow local-file API and reports a native failure', async () => {
  let call;
  const api = preload(async (...args) => { call = args; throw Error('No application can open this file.'); });
  assert.equal(typeof api.openFile, 'function');
  await assert.rejects(api.openFile('/tmp/report.md:12'), /No application can open this file/);
  assert.deepEqual(call, ['elpis:file:open', '/tmp/report.md:12']);
  await assert.rejects(preload(async () => ({ error: 'This file is unavailable.' })).openFile('/tmp/report.md'), /unavailable/);
  await assert.rejects(preload(async () => undefined).openFile('/tmp/report.md'), /Could not open/);
});

test('a clicked local file reaches OS association as an existing path with the line suffix removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-file-link-'));
  const file = path.join(root, 'گزارش with spaces.md');
  fs.writeFileSync(file, 'fixture');
  const opened = [];
  const context = setup(async target => { opened.push(target); return ''; });
  const api = preload((channel, target) => {
    assert.equal(channel, 'elpis:file:open');
    return context.open(target);
  });
  await api.openFile(`${encodeURI(file)}:12`);
  assert.deepEqual(opened, [fs.realpathSync(file)]);
  context.dispose();
  assert.equal(context.handlers.size, 0);
});

test('missing files, folders and OS association failures reject without silently succeeding', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-file-error-'));
  const file = path.join(root, 'report.md'); fs.writeFileSync(file, 'fixture');
  let calls = 0;
  const context = setup(async () => { calls++; return 'No application is associated with this file.'; });
  await assert.rejects(context.open(path.join(root, 'missing.md')), /unavailable|existing local file/i);
  await assert.rejects(context.open(root), /regular file|existing local file|unavailable/i);
  assert.equal(calls, 0);
  await assert.rejects(context.open(file), /No application is associated/);
  assert.equal(calls, 1);
  context.dispose();
});

test('only absolute file paths with well-formed optional line numbers are accepted', async () => {
  let calls = 0;
  const context = setup(async () => { calls++; return ''; });
  for (const target of [null, {}, '', 'relative.md', 'https://example.com/a.md', 'file:///tmp/a.md',
    '//example.com/a.md', '/%2Fexample.com/a.md', '/tmp/a%00.md', '/tmp/a\n.md', '/tmp/%ZZ.md',
    '/tmp/a.md:0', '/tmp/a.md:999999999999999999999', `/${'x'.repeat(4096)}`]) {
    await assert.rejects(context.open(target), /absolute|valid|line|path/i, String(target));
  }
  assert.equal(calls, 0);
  context.dispose();
});

test('websites, subframes and a navigated app frame cannot open local files', async () => {
  let calls = 0;
  const context = setup(async () => { calls++; return ''; });
  const { webContents } = context;
  for (const event of [
    { sender: {}, senderFrame: webContents.mainFrame },
    { sender: webContents, senderFrame: { url: webContents.mainFrame.url } },
    { sender: {}, senderFrame: { url: 'https://example.com' } },
  ]) await assert.rejects(context.open('/tmp/file.md', event), /application frame/);
  webContents.mainFrame.url = 'https://example.com/';
  await assert.rejects(context.open('/tmp/file.md'), /application frame/);
  webContents.mainFrame.url = 'not a URL';
  await assert.rejects(context.open('/tmp/file.md'), /application frame/);
  assert.equal(calls, 0);
  context.dispose();
});

test('a project folder opens in the file manager; files, missing and relative paths are refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-folder-open-'));
  const file = path.join(root, 'notes.md');
  fs.writeFileSync(file, 'fixture');
  const opened = [];
  const { handlers, event } = setup(async target => { opened.push(target); return ''; });
  const api = preload((channel, target) => handlers.get(channel)(event, target));
  await api.openFolder(root);
  assert.deepEqual(opened, [fs.realpathSync(root)]);
  await assert.rejects(api.openFolder(file), /folder is unavailable/);
  await assert.rejects(api.openFolder(path.join(root, 'missing')), /folder is unavailable/);
  await assert.rejects(api.openFolder('relative/path'), /absolute local folder/);
  assert.equal(opened.length, 1);
});
