'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { registerTerminal } = require('./terminal.cjs');

const tick = () => new Promise(resolve => setTimeout(resolve, 30));

/** A pseudo-terminal that records what the shell is sent; `fg` names its foreground process. */
function fakePty(file) {
  const data = [], exits = [];
  const pty = { written: '', size: null, killed: false, process: file,
    write: text => { pty.written += text; }, resize: (cols, rows) => { pty.size = [cols, rows]; },
    kill: () => { pty.killed = true; for (const exit of exits) exit({ exitCode: 0, signal: 1 }); },
    onData: callback => { data.push(callback); return { dispose() {} }; }, onExit: callback => { exits.push(callback); return { dispose() {} }; },
    emit: text => { for (const callback of data) callback(text); }, exit: exitCode => { for (const exit of exits) exit({ exitCode }); } };
  return pty;
}

function setup({ env = {}, bin, realEnv = false } = {}) {
  const handlers = new Map(), listeners = new Map(), sent = [], spawned = [], clip = { text: 'pasted text' };
  const mainFrame = { url: 'http://127.0.0.1:45001/' };
  const webContents = { mainFrame, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const event = { sender: webContents, senderFrame: mainFrame };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-terminal-home-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-terminal-bin-'));
  if (bin !== false) { fs.writeFileSync(path.join(binDir, 'elpis'), '#!/bin/sh\n', { mode: 0o755 }); }
  const dispose = registerTerminal({ host: { webContents }, origin: 'http://127.0.0.1:45001', home, ...(realEnv ? {} : { prepareEnv: value => value }),
    env: { PATH: `${binDir}:/usr/bin:/bin`, SHELL: '/bin/bash', ELECTRON_RUN_AS_NODE: '1', ...env },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name),
      on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name) },
    clipboard: { writeText: text => { clip.text = text; }, readText: () => clip.text },
    spawn: (file, args, options) => { const pty = fakePty(file); spawned.push({ file, args, options, pty }); return pty; } });
  const call = (name, ...args) => handlers.get(name)(event, ...args);
  const send = (name, ...args) => listeners.get(name)(event, ...args);
  return { handlers, listeners, sent, spawned, clip, home, binDir, event, webContents, dispose, call, send };
}

test('each chat gets one shell, started in its folder and kept while the panel closes and reopens', async () => {
  const t = setup({ realEnv: true }), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-chat-folder-'));
  const first = await t.call('elpis:terminal:open', { key: 'chat-a', cwd: folder, cols: 90, rows: 20 });
  assert.equal(first.error, undefined);
  assert.equal(t.spawned.length, 1);
  const [{ file, options, pty }] = t.spawned;
  assert.equal(file, '/bin/bash');
  assert.equal(options.cwd, folder);
  assert.deepEqual([options.cols, options.rows], [90, 20]);
  assert.equal(options.env.TERM, 'xterm-256color');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined, 'apps started in the terminal must not inherit Electron node mode');
  assert(options.env.PATH.startsWith(path.join(os.homedir(), '.local/bin')), 'the installed elpis and elpis-app are on the PATH');
  assert.equal(first.shell, 'bash');
  pty.emit('$ ');
  await tick();
  assert.deepEqual(t.sent.at(-1), ['elpis:terminal:data', 'chat-a', first.id, 2, '$ ']);
  const again = await t.call('elpis:terminal:open', { key: 'chat-a', cwd: folder, cols: 90, rows: 20 });
  assert.equal(t.spawned.length, 1, 'reopening must not start a second shell');
  assert.equal(again.output, '$ ', 'a reloaded window replays what the shell printed');
  assert.deepEqual([again.id, again.end], [first.id, 2]);
  await t.call('elpis:terminal:open', { key: 'chat-b', cwd: folder, cols: 90, rows: 20 });
  assert.equal(t.spawned.length, 2, 'another chat has its own shell');
});

test('typing and resizing reach the shell; a missing folder falls back to home; other pages are refused', async () => {
  const t = setup();
  await t.call('elpis:terminal:open', { key: 'chat-a', cwd: '/no/such/folder', cols: 80, rows: 24 });
  const { pty, options } = t.spawned[0];
  assert.equal(options.cwd, t.home);
  t.send('elpis:terminal:input', 'chat-a', 'ls\r');
  t.send('elpis:terminal:resize', 'chat-a', 120, 40);
  assert.equal(pty.written, 'ls\r');
  assert.deepEqual(pty.size, [120, 40]);
  const stranger = { sender: { mainFrame: {} }, senderFrame: {} };
  assert.match((await t.handlers.get('elpis:terminal:open')(stranger, { key: 'x', cwd: '/', cols: 80, rows: 24 })).error, /Elpis application frame/);
  t.listeners.get('elpis:terminal:input')(stranger, 'chat-a', 'rm -rf ~\r');
  assert.equal(pty.written, 'ls\r');
});

test('copy and paste use the system clipboard', async () => {
  const t = setup();
  await t.call('elpis:terminal:clipboard', 'copied from the terminal');
  assert.equal(t.clip.text, 'copied from the terminal');
  assert.deepEqual(await t.call('elpis:terminal:clipboard'), { text: 'copied from the terminal' });
});

test('Open in Elpis TUI resumes the chat in its idle shell, once, and never types into a busy one', async () => {
  const t = setup(), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-tui-folder-'));
  const id = '019a3b2c-1111-7222-8333-444455556666';
  assert.deepEqual(await t.call('elpis:terminal:tui', { key: id, cwd: folder, threadId: id, cols: 80, rows: 24 }), { started: true });
  const { pty } = t.spawned[0];
  assert.equal(pty.written, `\x05\x15elpis resume ${id}\r`);
  pty.process = 'elpis-next';
  assert.deepEqual(await t.call('elpis:terminal:tui', { key: id, cwd: folder, threadId: id, cols: 80, rows: 24 }), { running: true });
  assert.equal(pty.written, `\x05\x15elpis resume ${id}\r`, 'the running TUI is not typed into');
  pty.process = 'cargo';
  assert.match((await t.call('elpis:terminal:tui', { key: id, cwd: folder, threadId: 'other-chat', cols: 80, rows: 24 })).error, /running a command/);
  pty.process = '/bin/bash';
  assert.match((await t.call('elpis:terminal:tui', { key: id, cwd: folder, threadId: 'x; rm -rf ~', cols: 80, rows: 24 })).error, /not a chat id/);
  assert.equal(t.spawned.length, 1);
});

test('the TUI command is found on the shell path or named by ELPIS_TUI_BIN, and missing is reported', async () => {
  const missing = setup({ bin: false });
  assert.match((await missing.call('elpis:terminal:tui', { key: 'a', cwd: '/', threadId: 'a', cols: 80, rows: 24 })).error, /elpis.*not found/i);
  const named = setup({ bin: false, env: { ELPIS_TUI_BIN: '/opt/elpis builds/elpis' } });
  await named.call('elpis:terminal:tui', { key: 'a', cwd: '/', threadId: 'a', cols: 80, rows: 24 });
  assert.equal(named.spawned[0].pty.written, "\x05\x15'/opt/elpis builds/elpis' resume a\r");
});

test('an exited shell is reported once and restarts fresh; closing the window ends every shell', async () => {
  const t = setup();
  const opened = await t.call('elpis:terminal:open', { key: 'chat-a', cwd: '/', cols: 80, rows: 24 });
  const old = t.spawned[0].pty;
  old.exit(3);
  assert.deepEqual(t.sent.at(-1), ['elpis:terminal:exit', 'chat-a', opened.id, 3]);
  assert.equal((await t.call('elpis:terminal:open', { key: 'chat-a', cwd: '/', cols: 80, rows: 24 })).exited, 3);
  const restarted = await t.call('elpis:terminal:restart', { key: 'chat-a', cwd: '/', cols: 80, rows: 24 });
  assert.equal(restarted.exited, null);
  assert.notEqual(restarted.id, opened.id);
  assert.equal(t.spawned.length, 2);
  const live = t.spawned[1].pty;
  await t.call('elpis:terminal:restart', { key: 'chat-a', cwd: '/', cols: 80, rows: 24 });
  assert.equal(live.killed, true);
  assert.equal(t.sent.filter(([name]) => name === 'elpis:terminal:exit').length, 1, 'a replaced shell is not reported as the chat’s shell exiting');
  t.dispose();
  assert.equal(t.spawned[2].pty.killed, true);
  assert.equal(t.handlers.size + t.listeners.size, 0);
});

test('the preload gives the page a narrow terminal API', async () => {
  const calls = [], sends = [], events = new Map();
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { sendSync: () => ({}), invoke: async (...args) => { calls.push(args); return args[0] === 'elpis:terminal:clipboard' ? { text: 'x' } : { shell: 'bash', output: '', exited: null }; },
      send: (...args) => sends.push(args), on: (name, listener) => events.set(name, listener), removeListener: name => events.delete(name) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => electron });
  await api.terminal.open('k', '/tmp', 80, 24);
  api.terminal.input('k', 'a');
  api.terminal.resize('k', 100, 30);
  assert.equal(await api.terminal.paste(), 'x');
  const seen = [];
  const stop = api.terminal.subscribe((key, _id, _end, data) => seen.push([key, data]), (key, _id, code) => seen.push([key, code]));
  events.get('elpis:terminal:data')({}, 'k', 1, 3, 'out');
  events.get('elpis:terminal:exit')({}, 'k', 1, 0);
  stop();
  assert.deepEqual(seen, [['k', 'out'], ['k', 0]]);
  assert.equal(events.has('elpis:terminal:data'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['elpis:terminal:open', { key: 'k', cwd: '/tmp', cols: 80, rows: 24 }]);
  assert.deepEqual(sends, [['elpis:terminal:input', 'k', 'a'], ['elpis:terminal:resize', 'k', 100, 30]]);
});

test('a real shell runs in the chat folder through node-pty', async t => {
  let pty;
  try { pty = require('node-pty'); } catch (error) { t.skip(`node-pty is not installed: ${error.message}`); return; }
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-real-pty-')));
  const shell = pty.spawn('/bin/sh', [], { name: 'xterm-256color', cols: 80, rows: 24, cwd: folder, env: { PATH: '/usr/bin:/bin', PS1: '$ ' } });
  let output = '';
  shell.onData(data => { output += data; });
  shell.write('pwd; stty size; exit\r');
  await new Promise(resolve => shell.onExit(resolve));
  assert.match(output, new RegExp(`${folder}\\r?\\n`));
  assert.match(output, /24 80/);
});
