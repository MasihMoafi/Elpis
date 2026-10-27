'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { createDocuments } = require('./documents.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-documents-'));
  const file = path.join(root, 'گزارش with spaces.md');
  await fs.writeFile(file, '# Draft\nA saved paragraph.\n');
  const documents = createDocuments();
  t.after(() => documents.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  function windowFor(threadId, focused = false) {
    let current = threadId;
    const ipc = new EventEmitter(), requests = [], sent = new EventEmitter();
    const mainFrame = { url: 'http://127.0.0.1:45001/' };
    const webContents = { mainFrame, isDestroyed: () => false, send(channel, request) {
      assert.equal(channel, 'elpis:document:request'); requests.push(request); sent.emit('request');
    } };
    const host = { webContents, isDestroyed: () => false, isFocused: () => focused };
    const event = { sender: webContents, senderFrame: mainFrame };
    const dispose = documents.attach({ host, origin: 'http://127.0.0.1:45001', ipcMain: ipc, session: () => current });
    return { requests, host, event, dispose, listeners: () => ipc.listenerCount('elpis:document:reply'), session(value) { current = value; },
      async next(index = 0) { while (!requests[index]) await once(sent, 'request'); return requests[index]; },
      reply(value, sender = event) { ipc.emit('elpis:document:reply', sender, value); },
    };
  }
  return { root, file, documents, windowFor };
}

test('opening uses the canonical real file in the focused matching chat, and waits for its editor receipt', async t => {
  const f = await fixture(t), other = f.windowFor('other', true), background = f.windowFor('chat'), active = f.windowFor('chat', true);
  const link = path.join(f.root, 'linked.md'); await fs.symlink(f.file, link);
  let settled = false;
  const opened = f.documents.call('chat', 'document_open', { path: link }).then(result => { settled = true; return result; });
  const request = await active.next();
  assert.equal(other.requests.length, 0); assert.equal(background.requests.length, 0);
  assert.deepEqual({ ...request, id: undefined }, { id: undefined, threadId: 'chat', action: 'open', path: f.file, view: 'edit' });
  await new Promise(setImmediate); assert.equal(settled, false, 'sending a request is not evidence that a document opened');
  active.reply({ id: request.id, result: { unsavedChanges: true } });
  assert.deepEqual(await opened, { opened: true, path: f.file, unsavedChanges: true, mtimeMs: (await fs.stat(f.file)).mtimeMs });
  assert.equal(await fs.readFile(f.file, 'utf8'), '# Draft\nA saved paragraph.\n');
});

test('read obtains the exact saved Unicode revision after the editor acknowledges, never its unsaved draft', async t => {
  const f = await fixture(t), window = f.windowFor('chat');
  const reading = f.documents.call('chat', 'document_read', { path: f.file });
  const request = await window.next(); assert.equal(request.action, 'read');
  const content = '# نجات\nSaved after the request — 保持文字.\n';
  await fs.writeFile(f.file, content);
  window.reply({ id: request.id, result: { unsavedChanges: true } });
  assert.deepEqual(await reading, { path: f.file, content, mtimeMs: (await fs.stat(f.file)).mtimeMs, unsavedChanges: true });
});

test('another window, an iframe and a foreign app origin cannot acknowledge a document', async t => {
  const f = await fixture(t), owner = f.windowFor('chat'), other = f.windowFor('other');
  let settled = false;
  const opening = f.documents.call('chat', 'document_open', { path: f.file, view: 'preview' }).then(value => { settled = true; return value; });
  const request = await owner.next(); assert.equal(request.view, 'preview');
  const receipt = { id: request.id, result: { unsavedChanges: false } };
  other.reply(receipt);
  owner.reply(receipt, { sender: owner.host.webContents, senderFrame: { url: owner.event.senderFrame.url } });
  const original = owner.event.senderFrame.url;
  owner.event.senderFrame.url = 'https://example.invalid/'; owner.reply(receipt); owner.event.senderFrame.url = original;
  owner.reply({ ...receipt, id: 'unknown-request' });
  await new Promise(setImmediate); assert.equal(settled, false);
  owner.reply(receipt); assert.equal((await opening).opened, true);
});

test('a changed chat cannot acknowledge or consume another chat document request', async t => {
  const f = await fixture(t), window = f.windowFor('chat');
  await assert.rejects(f.documents.call('other', 'document_open', { path: f.file }), /chat|session|window/i);
  const opening = f.documents.call('chat', 'document_open', { path: f.file });
  const request = await window.next(); window.session('other');
  window.reply({ id: request.id, result: { unsavedChanges: false } });
  await assert.rejects(opening, /chat|session/i);
});

test('renderer errors and invalid receipts reject instead of claiming the document opened', async t => {
  const f = await fixture(t), window = f.windowFor('chat');
  const refused = f.documents.call('chat', 'document_open', { path: f.file });
  const first = await window.next(); window.reply({ id: first.id, error: 'The file could not be loaded.' });
  await assert.rejects(refused, /could not be loaded/);
  const invalid = f.documents.call('chat', 'document_read', { path: f.file });
  const second = await window.next(1); window.reply({ id: second.id, result: { unsavedChanges: 'yes' } });
  await assert.rejects(invalid, /receipt|reply|acknowledg/i);
});

test('missing acknowledgments time out after ten seconds and late replies cannot report success', async t => {
  const f = await fixture(t), window = f.windowFor('chat');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = f.documents.call('chat', 'document_open', { path: f.file });
  const request = await window.next();
  const rejection = assert.rejects(opening, /timed out|did not respond/i);
  t.mock.timers.tick(10000); await rejection;
  window.reply({ id: request.id, result: { unsavedChanges: false } });
});

test('disposing a window and closing the service reject pending work and release reply listeners', async t => {
  const f = await fixture(t), window = f.windowFor('chat');
  const first = f.documents.call('chat', 'document_open', { path: f.file }); await window.next();
  window.dispose(); await assert.rejects(first, /closed|unavailable|disposed/i);
  assert.equal(window.listeners(), 0);
  const next = f.windowFor('chat');
  const second = f.documents.call('chat', 'document_read', { path: f.file }); await next.next();
  f.documents.close(); await assert.rejects(second, /closed/i);
  assert.equal(next.listeners(), 0);
  await assert.rejects(f.documents.call('chat', 'document_open', { path: f.file }), /closed/i);
});

test('invalid inputs, missing exact paths and unsupported files fail without opening the editor', async t => {
  const f = await fixture(t), window = f.windowFor('chat');
  for (const [name, args] of [
    ['document_write', { path: f.file }], ['document_open', { path: 'relative.md' }],
    ['document_open', { path: f.file, threadId: 'other' }], ['document_read', { path: f.file, cwd: f.root }],
    ['document_open', { path: f.file, view: 'source' }], ['document_read', { path: f.file, view: 'edit' }],
    ['document_open', { path: 1 }], ['document_open', null], ['document_open', { path: f.file + '\0' }],
  ]) await assert.rejects(f.documents.call('chat', name, args), /unknown|invalid|path|arguments|view|absolute/i);
  const nested = path.join(f.root, 'nested'); await fs.mkdir(nested); await fs.writeFile(path.join(nested, 'guess.md'), 'never guess this file');
  const binary = path.join(f.root, 'binary.txt'), large = path.join(f.root, 'large.txt'), pdf = path.join(f.root, 'report.pdf');
  await fs.writeFile(binary, Buffer.from([0xff, 0xfe, 0x00]));
  await fs.writeFile(large, 'x'.repeat(512 * 1024 + 1)); await fs.writeFile(pdf, '%PDF-1.7\n');
  for (const file of [f.root, path.join(f.root, 'guess.md'), binary, large, pdf]) {
    await assert.rejects(f.documents.call('chat', 'document_open', { path: file }), /file|text|large|limit|exist/i);
  }
  assert.equal(window.requests.length, 0);
});
