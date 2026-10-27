'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { trustedBrowserSender } = require('./browser-policy.cjs');

const documentTools = [
  { name: 'document_open', description: 'Open an existing local text file beside this chat. The user edits and saves the real file; unsaved changes are preserved.', inputSchema: {
    type: 'object', properties: { path: { type: 'string', description: 'Absolute local file path.' }, view: { type: 'string', enum: ['edit', 'preview'], default: 'edit' } }, required: ['path'], additionalProperties: false,
  } },
  { name: 'document_read', description: 'Read the exact saved text of a local document shared beside this chat, and report whether its editor has unsaved changes. Never reads an unsaved draft.', inputSchema: {
    type: 'object', properties: { path: { type: 'string', description: 'Absolute local file path.' } }, required: ['path'], additionalProperties: false,
  } },
];

function validate(threadId, name, args) {
  const schema = documentTools.find(tool => tool.name === name)?.inputSchema;
  if (!schema) throw Error('Unknown document tool.');
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(threadId)) throw Error('Invalid document session.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid document arguments.');
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties[key];
    if (!spec || typeof value !== spec.type || spec.enum && !spec.enum.includes(value)) throw Error(`Invalid ${key}.`);
  }
  if (typeof args.path !== 'string' || args.path.length > 4096 || !path.isAbsolute(args.path) || args.path.startsWith('//') || /[\x00-\x1f\x7f]/.test(args.path)) throw Error('Choose an absolute local file path.');
}

/** Resolve an exact existing file before using the Files pane reader; never guess a relative filename. */
async function savedDocument(target) {
  let real;
  try {
    real = await fs.realpath(target);
    if (!(await fs.stat(real)).isFile()) throw Error('Not a regular file.');
  } catch { throw Error('This document must be an existing regular file.'); }
  const { readFile } = await import('../bridge/files.mjs');
  const saved = await readFile(path.dirname(real), path.basename(real));
  if (saved.tooLarge || saved.preview === 'text') throw Error('This document exceeds the text editor size limit.');
  if (typeof saved.content !== 'string' || typeof saved.mtimeMs !== 'number') throw Error('This document is not a supported UTF-8 text file.');
  return { path: real, content: saved.content, mtimeMs: saved.mtimeMs };
}

function createDocuments() {
  const windows = new Set(), pending = new Map();
  let closed = false;
  const live = entry => !entry.disposed && !entry.host.isDestroyed() && !entry.host.webContents.isDestroyed();
  const matches = (entry, threadId) => live(entry) && entry.session() === threadId;
  function finish(id, error, result) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(result);
  }
  function attach({ host, origin, ipcMain, session }) {
    if (closed) throw Error('Document service is closed.');
    const entry = { host, session, disposed: false };
    function reply(event, value) {
      if (!trustedBrowserSender(event, host.webContents, origin)) return;
      const request = pending.get(value?.id);
      if (!request || request.entry !== entry) return;
      if (!matches(entry, request.threadId)) { finish(value.id, Error('This chat is no longer shown.')); return; }
      if (typeof value.error === 'string' && value.error) { finish(value.id, Error(value.error)); return; }
      if (typeof value.result?.unsavedChanges !== 'boolean') { finish(value.id, Error('Invalid document acknowledgment.')); return; }
      finish(value.id, null, { unsavedChanges: value.result.unsavedChanges });
    }
    windows.add(entry); ipcMain.on('elpis:document:reply', reply);
    entry.dispose = () => {
      if (entry.disposed) return;
      entry.disposed = true; windows.delete(entry); ipcMain.removeListener('elpis:document:reply', reply);
      for (const [id, request] of pending) if (request.entry === entry) finish(id, Error('This document window is closed.'));
    };
    return entry.dispose;
  }
  async function call(threadId, name, args) {
    if (closed) throw Error('Document service is closed.');
    validate(threadId, name, args);
    const initial = await savedDocument(args.path);
    if (closed) throw Error('Document service is closed.');
    const candidates = [...windows].filter(entry => matches(entry, threadId));
    const entry = candidates.find(candidate => candidate.host.isFocused()) ?? candidates[0];
    if (!entry) throw Error('Open this chat in an Elpis window to share its document.');
    const receipt = await new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => finish(id, Error('The document editor did not respond within ten seconds.')), 10000);
      pending.set(id, { entry, threadId, timer, resolve, reject });
      try { entry.host.webContents.send('elpis:document:request', { id, threadId, action: name === 'document_open' ? 'open' : 'read', path: initial.path, view: args.view ?? 'edit' }); }
      catch (error) { finish(id, error); }
    });
    if (closed || !matches(entry, threadId)) throw Error('This document chat is closed or no longer shown.');
    const saved = await savedDocument(initial.path);
    if (closed || !matches(entry, threadId)) throw Error('This document chat is closed or no longer shown.');
    return name === 'document_open'
      ? { opened: true, path: saved.path, unsavedChanges: receipt.unsavedChanges, mtimeMs: saved.mtimeMs }
      : { ...saved, unsavedChanges: receipt.unsavedChanges };
  }
  return { call, attach, close() { closed = true; for (const entry of windows) entry.dispose(); } };
}

module.exports = { documentTools, createDocuments };
