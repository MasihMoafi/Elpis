'use strict';
// "Open in editor": which editors the app offers and how it starts one. VS Code is prohibited on this machine, so no
// code path may start `code` (or a build or fork of VS Code), whatever is on the PATH and whatever the page asks for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { installedEditors, editorCommand, EDITORS } = require('./editors.cjs');

function binaries(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-editors-'));
  for (const name of names) { fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, name), 0o755); }
  return dir;
}

test('the editors found on the PATH are offered by name, sorted, and VS Code never is', () => {
  const dir = binaries(['zed', 'gedit', 'code', 'code-insiders', 'codium', 'vim']);
  assert.deepEqual(installedEditors({ PATH: dir, home: '/nonexistent' }), [{ id: 'gedit', name: 'gedit' }, { id: 'zed', name: 'Zed' }]);
  assert.deepEqual(installedEditors({ PATH: binaries(['code']), home: '/nonexistent' }), [], 'with only VS Code installed nothing is offered');
});

test('a command that is really VS Code under another name is not offered either', () => {
  const dir = binaries(['code']);
  fs.symlinkSync(path.join(dir, 'code'), path.join(dir, 'subl'));
  fs.symlinkSync(path.join(dir, 'code'), path.join(dir, 'zed'));
  assert.deepEqual(installedEditors({ PATH: dir, home: '/nonexistent' }), []);
});

test('~/.local/bin is searched as well as the PATH, a file that is not executable is not an editor, and the PATH wins', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-editors-home-'));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/zed'), '#!/bin/sh\n'); fs.chmodSync(path.join(home, '.local/bin/zed'), 0o755);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-editors-plain-'));
  fs.writeFileSync(path.join(plain, 'kate'), 'not executable'); fs.chmodSync(path.join(plain, 'kate'), 0o644);
  assert.deepEqual(installedEditors({ PATH: plain, home }), [{ id: 'zed', name: 'Zed' }]);
  const first = binaries(['zed']);
  assert.equal(editorCommand('zed', '/work/a.ts', 3, { PATH: first, home }).command, path.join(first, 'zed'));
});

test('each editor gets the file and the line the way it documents', () => {
  const dir = binaries(['zed', 'subl', 'gedit', 'kate', 'gnome-text-editor']);
  const run = (id, line) => { const { command, args } = editorCommand(id, '/work/a b.ts', line, { PATH: dir, home: '/nonexistent' }); return [path.basename(command), ...args]; };
  assert.deepEqual(run('zed', 12), ['zed', '/work/a b.ts:12']);
  assert.deepEqual(run('sublime', 12), ['subl', '/work/a b.ts:12']);
  assert.deepEqual(run('gedit', 12), ['gedit', '+12', '/work/a b.ts']);
  assert.deepEqual(run('kate', 12), ['kate', '-l', '12', '/work/a b.ts']);
  assert.deepEqual(run('gnome-text-editor', 12), ['gnome-text-editor', '/work/a b.ts']);
  assert.deepEqual(run('zed'), ['zed', '/work/a b.ts'], 'no line, no suffix');
  assert.deepEqual(run('zed', 0), ['zed', '/work/a b.ts'], 'a line below 1 is no line');
});

test('only an editor from the list can be started: not VS Code, not a command line, not one that is not installed', () => {
  const dir = binaries(['zed', 'code']);
  const env = { PATH: dir, home: '/nonexistent' };
  for (const id of ['code', 'vscode', 'codium', '../code', '/snap/bin/code', 'zed --reuse-window', 'gedit', '', null, 42]) {
    assert.throws(() => editorCommand(id, '/work/a.ts', 1, env), /not available/i, String(id));
  }
  assert.ok(EDITORS.every(editor => editor.commands.every(command => !/code|vscode/i.test(command))), 'no listed command is a VS Code command');
});

// The IPC around it: the page asks by editor id and file path; the main process starts the editor itself.
function preload(invoke) {
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { sendSync: () => ({}), invoke, on: () => {}, removeListener: () => {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => electron });
  return api;
}
function setup({ started = [], fail } = {}) {
  const { registerFiles } = require('./files.cjs');
  const handlers = new Map(), mainFrame = { url: 'http://127.0.0.1:45001/' }, webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame };
  const dir = binaries(['zed', 'code']);
  const dispose = registerFiles({ host: { webContents }, origin: 'http://127.0.0.1:45001', shell: { openPath: async () => '' },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    env: { PATH: dir, home: '/nonexistent' },
    spawn: (command, args) => { started.push([path.basename(command), ...args]); if (fail) throw Error(fail); return { unref() {}, once: (name, callback) => { if (name === 'spawn') setImmediate(callback); } }; } });
  const api = preload((channel, ...args) => handlers.get(channel)(event, ...args));
  return { api, handlers, event, webContents, dispose, started };
}

test('the page lists the installed editors and starts one on an existing file inside the app, with the line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-edit-')), file = path.join(root, 'a.ts');
  fs.writeFileSync(file, 'x');
  const context = setup();
  assert.deepEqual(await context.api.editors(), [{ id: 'zed', name: 'Zed' }]);
  await context.api.openInEditor(file, 'zed', 7);
  assert.deepEqual(context.started, [['zed', `${fs.realpathSync(file)}:7`]]);
  await assert.rejects(context.api.openInEditor(file, 'code', 7), /not available/i);
  await assert.rejects(context.api.openInEditor(path.join(root, 'missing.ts'), 'zed'), /unavailable/i);
  await assert.rejects(context.api.openInEditor(root, 'zed'), /unavailable/i);
  await assert.rejects(context.api.openInEditor('relative.ts', 'zed'), /absolute/i);
  assert.equal(context.started.length, 1, 'nothing else was started');
  context.dispose();
  assert.equal(context.handlers.size, 0);
});

test('a website or a navigated frame cannot start an editor, and a start that fails says so', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-edit-')), file = path.join(root, 'a.ts');
  fs.writeFileSync(file, 'x');
  const context = setup();
  const result = await context.handlers.get('elpis:file:edit')({ sender: {}, senderFrame: { url: 'https://example.com' } }, { target: file, editor: 'zed' });
  assert.match(result.error, /application frame/);
  assert.match((await context.handlers.get('elpis:editors:list')({ sender: {}, senderFrame: { url: 'https://example.com' } })).error, /application frame/);
  assert.equal(context.started.length, 0);
  const broken = setup({ fail: 'spawn zed ENOENT' });
  await assert.rejects(broken.api.openInEditor(file, 'zed'), /Could not start Zed/);
});
