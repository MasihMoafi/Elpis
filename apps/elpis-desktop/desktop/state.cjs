'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** The keys the renderer may keep in the desktop store; anything else is refused (tests/controls.cjs guards stubs with it). */
const STORE_KEYS = /^(elpis-theme|elpis-chat-tabs-v1|elpis-browser-sessions-v1|elpis-sidebar-width|elpis-preferences-v1|elpis-projects-v1|elpis-project-chats-v1|elpis-pinned-chats-v1|elpis-terminal-height|elpis-last-chat|elpis-workflow-draft-v1|elpis-editor-v1|elpis-chat-attention-v1|elpis-chat-groups-v1|elpis-canvas-panel|elpis-canvas-auto|(?:elpis-draft-v1|elpis-attachments-v1):[A-Za-z0-9_-]{1,200})$/;
const allowed = key => typeof key === 'string' && STORE_KEYS.test(key);
const PREFERENCES_KEY = 'elpis-preferences-v1';
const TEXT_JOURNAL_KEY = 'elpis-draft-v1:love-spot-text-journal';
const textJournalPatch = value => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value)
  .every(([id, entry]) => id.length > 0 && id.length < 500 && typeof entry === 'string');
const preferenceTypes = { defaultFolder: 'string', softWrap: 'boolean', sendShortcut: ['enter', 'modEnter'], followUp: ['steer', 'queue'], showContextUsage: 'boolean', showAgentRuns: 'boolean', confirmClose: 'boolean', closeToTray: 'boolean', quickEntryShortcut: 'string', confirmDeleteChats: 'boolean', turnNotifications: ['never', 'unfocused', 'always'], inputNotifications: 'boolean', notificationSound: 'boolean', transcriptSize: ['s', 'm', 'l'], transcriptWidth: ['s', 'm', 'l'], interfaceFont: ['sans', 'serif'], codeFont: 'string', chatFont: ['default', 'sans', 'serif', 'mono', 'system'], accent: ['amber', 'blue', 'teal', 'green', 'violet', 'rose', 'orange'], navOrder: 'string' };
function preferencePatch(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, item]) => {
    const type = Object.hasOwn(preferenceTypes, key) ? preferenceTypes[key] : null;
    return (Array.isArray(type) ? type.includes(item) : type && typeof item === type) && (key !== 'defaultFolder' || !item || item.startsWith('/'));
  });
}

// App-owned preferences live outside the changing loopback origin. No runtime
// configuration or conversation history is written through this interface.
function createStateStore(file) {
  let values = {}, error, revision = 0, queue = Promise.resolve();
  const listeners = new Set(), versions = new Map(), replacements = new Map(), fields = new Map();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error('too large');
    values = JSON.parse(raw);
    if (!values || Array.isArray(values) || typeof values !== 'object' || Object.entries(values).some(([key, value]) => !allowed(key) || typeof value !== 'string')) throw Error('invalid state');
  } catch (cause) {
    if (cause.code !== 'ENOENT') error = 'Could not read saved Elpis workspace. The original file has been preserved.';
  }
  const snapshot = () => error ? { error } : { values: { ...values }, revision };
  async function persist(next) {
    const temp = `${file}.${randomUUID()}.pending`;
    let handle;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      handle = await fs.promises.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next));
      await handle.sync(); await handle.close(); handle = undefined;
      await fs.promises.rename(temp, file);
      // Acknowledgement includes the rename's directory entry, not just file data.
      handle = await fs.promises.open(path.dirname(file), 'r');
      await handle.sync();
    } catch {
      throw Error('Could not save Elpis workspace. Keep this window open or copy your unsent text.');
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temp).catch(() => {});
    }
  }
  function patch(input, writer) {
    const run = async () => {
      if (error) throw Error(error);
      const { key, baseRevision, changes } = input ?? {};
      let value = input?.value;
      if (!allowed(key) || !Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision > revision ||
        (changes !== undefined ? value !== undefined || !(key === PREFERENCES_KEY ? preferencePatch(changes) : key === TEXT_JOURNAL_KEY && textJournalPatch(changes)) : value !== null && typeof value !== 'string')) throw Error('Unsupported workspace patch');
      let changedFields;
      if (changes !== undefined) {
        let current = {};
        try { const parsed = JSON.parse(values[key] || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed; } catch { /* Same defaults recovery as lib/preferences.ts. */ }
        changedFields = Object.keys(changes).filter(field => current[field] !== changes[field]);
        value = changedFields.length ? JSON.stringify({ ...current, ...changes }) : values[key] ?? null;
      }
      const rebased = baseRevision < revision;
      // Startup/restoration and two windows can submit the same saved value.
      // An acknowledgement that changes nothing cannot overwrite another writer.
      if (values[key] === value || (value === null && values[key] === undefined)) return { key, value, revision, rebased };
      // Ordered in-flight edits from one renderer may share a base revision.
      // Edits from another renderer always require an observed revision.
      const stale = version => version && version.revision > baseRevision && (writer === undefined || version.writer !== writer);
      const conflict = changes !== undefined
        ? stale(replacements.get(key)) || changedFields.some(field => stale(fields.get(field)))
        : stale(versions.get(key));
      if (conflict) throw Object.assign(Error('This setting or draft changed in another window. Your change was not saved. Check the current value and try again; copy unsent text before closing.'), { code: 'STATE_CONFLICT' });
      if (typeof value === 'string' && Buffer.byteLength(value) > (key.startsWith('elpis-attachments-v1:') ? 6 * 1024 * 1024 : 1_000_000)) throw Error('Workspace value is too large');
      const next = { ...values };
      if (value === null) delete next[key]; else next[key] = value;
      if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024) throw Error('Saved drafts are too large. Copy or clear an older unsent draft.');
      await persist(next);
      values = next; ++revision;
      const version = { revision, writer };
      versions.set(key, version);
      if (changes !== undefined) for (const field of changedFields) fields.set(field, version);
      else replacements.set(key, version);
      const change = { key, value, revision, rebased };
      for (const listener of listeners) { try { listener(change); } catch { /* A closed window cannot invalidate a durable save. */ } }
      return change;
    };
    const saved = queue.then(run);
    queue = saved.catch(() => {});
    return saved;
  }
  return {
    read: () => error ? { error } : { ...values },
    snapshot, patch,
    set: (key, value) => patch({ key, value, baseRevision: revision }, null),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    flush: () => queue,
  };
}

function registerState({ host, origin, ipcMain, dialog, store }) {
  function authorize(event) {
    if (event.sender !== host.webContents || event.senderFrame !== host.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw Error('Elpis application frame required');
  }
  const read = event => { try { authorize(event); event.returnValue = store.snapshot(); } catch { event.returnValue = { error: 'Elpis application frame required' }; } };
  ipcMain.on('elpis:state:read', read);
  ipcMain.handle('elpis:state:write', async (event, patch) => {
    authorize(event);
    try { return await store.patch(patch, host.webContents.id); }
    catch (error) { return { error: error.message, code: error.code ?? 'STATE_SAVE_FAILED', snapshot: store.snapshot() }; }
  });
  const unsubscribe = store.subscribe(change => {
    if (!host.webContents.isDestroyed() && new URL(host.webContents.mainFrame.url).origin === origin) host.webContents.send('elpis:state:changed', change);
  });
  ipcMain.handle('elpis:folder', async event => {
    authorize(event);
    const result = await dialog.showOpenDialog(host, { title: 'Choose project folder', properties: ['openDirectory'] });
    return result.canceled ? null : fs.realpathSync(result.filePaths[0]);
  });
  ipcMain.handle('elpis:folder:resolve', async (event, folder) => {
    authorize(event);
    if (typeof folder !== 'string' || folder.length > 4096 || !path.isAbsolute(folder)) throw Error('Choose an absolute folder path');
    try { const resolved = await fs.promises.realpath(folder); if (!(await fs.promises.stat(resolved)).isDirectory()) throw Error(); return resolved; }
    catch { throw Error('This folder is unavailable. Choose an existing local folder.'); }
  });
  return () => {
    unsubscribe();
    ipcMain.removeListener('elpis:state:read', read);
    for (const channel of ['elpis:state:write', 'elpis:folder', 'elpis:folder:resolve']) ipcMain.removeHandler(channel);
  };
}
module.exports = { STORE_KEYS, createStateStore, registerState };
