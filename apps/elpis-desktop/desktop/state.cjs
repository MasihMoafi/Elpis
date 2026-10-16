'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const allowed = key => typeof key === 'string' && /^(elpis-theme|elpis-projects-v1|elpis-last-chat|elpis-workflow-draft-v1|(?:elpis-draft-v1|elpis-attachments-v1):[A-Za-z0-9_-]{1,200})$/.test(key);

// App-owned preferences live outside the changing loopback origin. No runtime
// configuration or conversation history is written through this interface.
function createStateStore(file) {
  let values = {}, error, timer, dirty = false, waiting = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error('too large');
    values = JSON.parse(raw);
    if (!values || Array.isArray(values) || typeof values !== 'object' || Object.entries(values).some(([key, value]) => !allowed(key) || typeof value !== 'string')) throw Error('invalid state');
  } catch (cause) {
    if (cause.code !== 'ENOENT') error = 'Could not read saved Elpis workspace. The original file has been preserved.';
  }
  let committed = { ...values };
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!waiting.length && !dirty) return;
    const pending = waiting; waiting = [];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.pending`;
      fs.writeFileSync(temp, JSON.stringify(values), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      committed = { ...values };
      dirty = false;
      pending.forEach(({ resolve }) => resolve());
    } catch {
      values = { ...committed }; dirty = false;
      pending.forEach(({ reject }) => reject(Error('Could not save Elpis workspace. Keep this window open or copy your unsent text.')));
    }
  }
  return {
    read: () => error ? { error } : { ...values },
    async set(key, value) {
      if (error) throw Error(error);
      if (!allowed(key) || (value !== null && typeof value !== 'string')) throw Error('Unsupported workspace value');
      if (!dirty && (values[key] === value || (value === null && values[key] === undefined))) return;
      if (typeof value === 'string' && Buffer.byteLength(value) > (key.startsWith('elpis-attachments-v1:') ? 6 * 1024 * 1024 : 1_000_000)) throw Error('Workspace value is too large');
      const next = { ...values };
      if (value === null) delete next[key]; else next[key] = value;
      if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024) throw Error('Saved drafts are too large. Copy or clear an older unsent draft.');
      values = next;
      dirty = true;
      clearTimeout(timer);
      const saved = new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      timer = setTimeout(flush, 60);
      return saved;
    },
    flush,
  };
}

function registerState({ host, origin, ipcMain, dialog, store }) {
  function authorize(event) {
    if (event.sender !== host.webContents || event.senderFrame !== host.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw Error('Elpis application frame required');
  }
  const read = event => { try { authorize(event); event.returnValue = store.read(); } catch { event.returnValue = { error: 'Elpis application frame required' }; } };
  ipcMain.on('elpis:state:read', read);
  ipcMain.handle('elpis:state:write', async (event, key, value) => { authorize(event); await store.set(key, value); });
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
    store.flush();
    ipcMain.removeListener('elpis:state:read', read);
    for (const channel of ['elpis:state:write', 'elpis:folder', 'elpis:folder:resolve']) ipcMain.removeHandler(channel);
  };
}
module.exports = { createStateStore, registerState };
