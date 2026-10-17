'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { openThreadArgument, createThreadOpener, createNewChatOpener } = require('./open-thread.cjs');

const id = '019a3b2c-1111-7222-8333-444455556666';

test('the TUI names a chat with --open-thread; anything else is ignored', () => {
  assert.equal(openThreadArgument(['/opt/electron', '/opt/app', '--open-thread', id]), id);
  assert.equal(openThreadArgument(['/opt/electron', `--open-thread=${id}`]), id);
  assert.equal(openThreadArgument(['/opt/electron', '/opt/app']), null);
  assert.equal(openThreadArgument(['--open-thread', '../../etc/passwd']), null);
  assert.equal(openThreadArgument(['--open-thread']), null);
});

function host() {
  const mainFrame = { url: 'http://127.0.0.1:45001/' }, sent = [];
  const webContents = { mainFrame, isDestroyed: () => false, send: (...args) => sent.push(args) };
  return { host: { webContents, isDestroyed: () => false }, event: { sender: webContents, senderFrame: mainFrame }, sent };
}

test('a chat named at start-up or by a second launch opens once in the running window', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const threads = createThreadOpener(id);
  const window = host();
  const dispose = threads.attach({ host: window.host, origin: 'http://127.0.0.1:45001', ipcMain });
  const take = handlers.get('elpis:open-thread:take');
  assert.equal(await take(window.event), id, 'the start-up chat waits for the page');
  assert.equal(await take(window.event), null, 'and opens once');
  threads.queue('second-chat');
  assert.deepEqual(window.sent, [['elpis:open-thread']]);
  assert.equal(await take({ sender: {}, senderFrame: {} }), null, 'another page cannot read it');
  assert.equal(await take(window.event), 'second-chat');
  threads.queue('bad id; rm');
  assert.equal(window.sent.length, 1);
  dispose();
  assert.equal(handlers.size, 0);
});

test('the preload hands the page each chat to open, including one queued before it loaded', async () => {
  const queue = [id], listeners = new Map();
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { sendSync: () => ({}), invoke: async channel => channel === 'elpis:open-thread:take' ? queue.shift() ?? null : undefined,
      on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => electron });
  const opened = [];
  const stop = api.onOpenThread(thread => opened.push(thread));
  await new Promise(resolve => setTimeout(resolve, 10));
  queue.push('second-chat');
  listeners.get('elpis:open-thread')();
  await new Promise(resolve => setTimeout(resolve, 10));
  stop();
  assert.deepEqual(opened, [id, 'second-chat']);
  assert.equal(listeners.size, 0);
});

test('Quick Entry and the tray hand the page a new chat to open, with its text or none', async () => {
  const queue = ['Summarise the README'], listeners = new Map();
  let api;
  const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: { sendSync: () => ({}), invoke: async channel => channel === 'elpis:new-chat:take' ? queue.shift() ?? null : undefined,
      on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), { require: () => electron });
  const opened = [];
  const stop = api.onNewChat(text => opened.push(text));
  await new Promise(resolve => setTimeout(resolve, 10));
  queue.push('');
  listeners.get('elpis:new-chat')();
  await new Promise(resolve => setTimeout(resolve, 10));
  stop();
  assert.deepEqual(opened, ['Summarise the README', ''], "the tray's New chat opens one without text");
  assert.equal(listeners.size, 0);
});

test('a new chat waits in the main process until the page takes it; only text the composer could hold is kept', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const chats = createNewChatOpener(), window = host();
  chats.queue('before the window');
  chats.attach({ host: window.host, origin: 'http://127.0.0.1:45001', ipcMain });
  const take = handlers.get('elpis:new-chat:take');
  assert.equal(await take(window.event), 'before the window');
  chats.queue(''); chats.queue(42); chats.queue('x'.repeat(16385));
  assert.deepEqual(window.sent, [['elpis:new-chat']]);
  assert.equal(await take(window.event), '');
  assert.equal(await take({ sender: {}, senderFrame: {} }), null);
});
