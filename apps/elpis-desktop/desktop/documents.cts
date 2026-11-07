'use strict';
import type { BrowserWindow, IpcMainEvent } from 'electron';
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
const { randomUUID }: typeof import('node:crypto') = require('node:crypto');
const { trustedBrowserSender }: typeof import('./browser-policy.cts') = require('./browser-policy.cts');

const documentToolsImpl = [
  { name: 'document_open', description: 'Open an existing local text file beside this chat. The user edits and saves the real file; unsaved changes are preserved.', inputSchema: {
    type: 'object', properties: { path: { type: 'string', description: 'Absolute local file path.' }, view: { type: 'string', enum: ['edit', 'preview'], default: 'edit' } }, required: ['path'], additionalProperties: false,
  } },
  { name: 'document_read', description: 'Read the exact saved text of a local document shared beside this chat, and report whether its editor has unsaved changes. Never reads an unsaved draft.', inputSchema: {
    type: 'object', properties: { path: { type: 'string', description: 'Absolute local file path.' } }, required: ['path'], additionalProperties: false,
  } },
];

type DocumentArgs = { path: string; view?: string };
function validate(threadId: unknown, name: unknown, args: unknown): asserts args is DocumentArgs {
  const schema = documentToolsImpl.find(tool => tool.name === name)?.inputSchema;
  if (!schema) throw Error('Unknown document tool.');
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(threadId)) throw Error('Invalid document session.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid document arguments.');
  for (const [key, value] of Object.entries(args)) {
    const spec = (schema.properties as Record<string, { type: string; enum?: string[] }>)[key];
    if (!spec || typeof value !== spec.type || spec.enum && !spec.enum.includes(value as string)) throw Error(`Invalid ${key}.`);
  }
  if (typeof (args as Record<string, unknown>).path !== 'string' || (args as DocumentArgs).path.length > 4096 || !path.isAbsolute((args as DocumentArgs).path) || (args as DocumentArgs).path.startsWith('//') || /[\x00-\x1f\x7f]/.test((args as DocumentArgs).path)) throw Error('Choose an absolute local file path.');
}

/** Resolve an exact existing file before using the Files pane reader; never guess a relative filename. */
async function savedDocument(target: string) {
  let real;
  try {
    real = await fs.realpath(target);
    if (!(await fs.stat(real)).isFile()) throw Error('Not a regular file.');
  } catch { throw Error('This document must be an existing regular file.'); }
  const { readFile } = await import('../bridge/files.mts');
  const saved = await readFile(path.dirname(real), path.basename(real));
  if (saved.tooLarge || saved.preview === 'text') throw Error('This document exceeds the text editor size limit.');
  if (!('content' in saved) || typeof saved.content !== 'string' || !('mtimeMs' in saved) || typeof saved.mtimeMs !== 'number') throw Error('This document is not a supported UTF-8 text file.');
  return { path: real, content: saved.content, mtimeMs: saved.mtimeMs };
}

function createDocumentsImpl() {
  type Entry = { host: BrowserWindow; session: () => string | null; disposed: boolean; dispose: () => void };
  type Receipt = { unsavedChanges: boolean };
  type Pending = { entry: Entry; threadId: unknown; timer: NodeJS.Timeout; resolve: (value: Receipt) => void; reject: (error: unknown) => void };
  const windows = new Set<Entry>(), pending = new Map<string, Pending>();
  let closed = false;
  const live = (entry: Entry) => !entry.disposed && !entry.host.isDestroyed() && !entry.host.webContents.isDestroyed();
  const matches = (entry: Entry, threadId: unknown) => live(entry) && entry.session() === threadId;
  function finish(id: string, error: unknown, result?: Receipt) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(result!);
  }
  function attach({ host, origin, ipcMain, session }: { host: BrowserWindow; origin: string; ipcMain: { on: (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => void; removeListener: (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => void }; session: () => string | null }) {
    if (closed) throw Error('Document service is closed.');
    const entry = { host, session, disposed: false } as Entry;
    function reply(event: IpcMainEvent, raw: unknown) {
      const value = raw as { id?: string; error?: unknown; result?: { unsavedChanges?: unknown } } | null;
      if (!trustedBrowserSender(event, host.webContents, origin)) return;
      const request = pending.get(value?.id ?? '');
      if (!value?.id || !request || request.entry !== entry) return;
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
  async function call(threadId: unknown, name: unknown, args: unknown) {
    if (closed) throw Error('Document service is closed.');
    validate(threadId, name, args);
    const initial = await savedDocument(args.path);
    if (closed) throw Error('Document service is closed.');
    const candidates = [...windows].filter(entry => matches(entry, threadId));
    const entry = candidates.find(candidate => candidate.host.isFocused()) ?? candidates[0];
    if (!entry) throw Error('Open this chat in an Elpis window to share its document.');
    const receipt = await new Promise<Receipt>((resolve, reject) => {
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

export declare const createDocuments: typeof createDocumentsImpl;
export declare const documentTools: typeof documentToolsImpl;
module.exports = { documentTools: documentToolsImpl, createDocuments: createDocumentsImpl };
