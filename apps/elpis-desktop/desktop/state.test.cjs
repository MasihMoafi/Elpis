'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore, registerState } = require('./state.cjs');

test('desktop state survives a new process store, preserves exact drafts and uses private files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-'));
  const file = path.join(dir, 'profile', 'workspace.json');
  const store = createStateStore(file);
  const draft = 'Review this\n\nمتن فارسی';
  await Promise.all([store.set('elpis-draft-v1:chat-1', draft), store.set('elpis-draft-v1:recovery-chat-1', 'Unsent edited message'), store.set('elpis-theme', 'dark'), store.set('elpis-workflow-draft-v1', '{"workflow":"exact draft"}')]);
  const reopened = createStateStore(file);
  assert.equal(reopened.read()['elpis-draft-v1:chat-1'], draft);
  assert.equal(reopened.read()['elpis-draft-v1:recovery-chat-1'], 'Unsent edited message', 'a failed replacement is saved separately from the current composer draft');
  assert.equal(reopened.read()['elpis-theme'], 'dark');
  assert.equal(reopened.read()['elpis-workflow-draft-v1'], '{"workflow":"exact draft"}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  await reopened.set('elpis-draft-v1:chat-1', null);
  assert.equal(createStateStore(file).read()['elpis-draft-v1:chat-1'], undefined);
  assert.equal(createStateStore(file).read()['elpis-draft-v1:recovery-chat-1'], 'Unsent edited message');
  await assert.rejects(() => reopened.set('elpis-draft-v1:recovery:chat-1', 'unsupported old namespace'), /Unsupported/);
  await assert.rejects(() => reopened.set('../config.toml', 'x'), /Unsupported/);
  await assert.rejects(() => reopened.set('elpis-theme', 'x'.repeat(1_000_001)), /large/);
});

test('corrupt state is reported and preserved, rather than silently overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-invalid-'));
  const file = path.join(dir, 'workspace.json');
  fs.writeFileSync(file, '{broken');
  const store = createStateStore(file);
  assert.match(store.read().error, /read/);
  await assert.rejects(() => store.set('elpis-theme', 'light'), /read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('pinned chats and terminal height persist across a desktop restart, with unknown keys still rejected', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-ux-state-')), 'workspace.json');
  const store = createStateStore(file), pins = JSON.stringify(['chat-1', 'chat-2']);
  await store.set('elpis-pinned-chats-v1', pins);
  await store.set('elpis-terminal-height', '360');
  const reopened = createStateStore(file);
  assert.equal(reopened.read()['elpis-pinned-chats-v1'], pins);
  assert.equal(reopened.read()['elpis-terminal-height'], '360');
  await assert.rejects(store.set('elpis-pinned-chats-v2', pins), /Unsupported/);
  await assert.rejects(store.set('elpis-terminal-height:other', '360'), /Unsupported/);
});

test('retrying the same value after an actual write failure really persists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-retry-'));
  const file = path.join(dir, 'workspace.json');
  const store = createStateStore(file);
  fs.mkdirSync(file);
  await assert.rejects(() => store.set('elpis-projects-v1', 'project input'), /Could not save/);
  assert.equal(store.read()['elpis-projects-v1'], undefined, 'failed changes must not appear saved or persist after cancellation');
  fs.renameSync(file, path.join(dir, 'unavailable-fixture'));
  await store.set('elpis-projects-v1', 'project input');
  assert.equal(createStateStore(file).read()['elpis-projects-v1'], 'project input');
});

test('only the app main frame can read state or choose a folder; cancel has no side effects', async () => {
  const handlers = new Map(), listeners = new Map();
  const ipcMain = { handle: (key, value) => handlers.set(key, value), on: (key, value) => listeners.set(key, value), removeHandler: key => handlers.delete(key), removeListener: key => listeners.delete(key) };
  const mainFrame = { url: 'http://127.0.0.1:45001/' }, webContents = { mainFrame };
  const host = { webContents };
  let dialogs = 0;
  const dialog = { showOpenDialog: async () => { dialogs++; return { canceled: true, filePaths: [] }; } };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-state-ipc-')), 'workspace.json');
  const dispose = registerState({ host, origin: 'http://127.0.0.1:45001', ipcMain, dialog, store: createStateStore(file) });
  const foreign = { sender: {}, senderFrame: { url: 'https://example.com' } };
  await assert.rejects(() => handlers.get('elpis:folder')(foreign), /application/);
  const own = { sender: webContents, senderFrame: mainFrame };
  assert.equal(await handlers.get('elpis:folder')(own), null);
  assert.equal(dialogs, 1);
  const dir = path.dirname(file);
  assert.equal(await handlers.get('elpis:folder:resolve')(own, dir), fs.realpathSync(dir));
  await assert.rejects(() => handlers.get('elpis:folder:resolve')(own, file), /folder/);
  await assert.rejects(() => handlers.get('elpis:folder:resolve')(own, 'relative'), /absolute/);
  dispose();
  assert.equal(handlers.size, 0);
});

test('attachment drafts persist through the real private store with separate file and total limits', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-attachment-state-')), 'workspace.json');
  const store = createStateStore(file), key = 'elpis-attachments-v1:chat-1';
  const value = JSON.stringify([{id:'image',name:'image.png',type:'image',mimeType:'image/png',dataUrl:'data:image/png;base64,'+'A'.repeat(1500000)}]);
  await store.set(key, value);
  assert.equal(createStateStore(file).read()[key], value);
  await assert.rejects(store.set('elpis-theme', value), /large/);
  await assert.rejects(store.set('elpis-attachments-v1:oversized', 'x'.repeat(6*1024*1024+1)), /large/);
  await assert.rejects(store.set('elpis-attachments-v1:bad:key', value), /Unsupported/);
  const large='x'.repeat(5*1024*1024);await store.set('elpis-attachments-v1:chat-2',large);
  await assert.rejects(store.set('elpis-attachments-v1:chat-3',large), /drafts are too large/);
  assert.equal(createStateStore(file).read()['elpis-attachments-v1:chat-2'],large);
  assert.equal(createStateStore(file).read()['elpis-attachments-v1:chat-3'],undefined);
  await store.set(key,null);assert.equal(createStateStore(file).read()[key],undefined);
});
