'use strict';
const { randomUUID } = require('node:crypto');
const { createBrowser } = require('./browser.cjs');
const { trustedBrowserSender } = require('./browser-policy.cjs');

const KEY = 'elpis-browser-sessions-v1';
const valid = id => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,240}$/.test(id);

/** Pages belong to chats. A native page moves between windows showing the same chat. */
function createBrowserSessions({ store, browserAgentSocket }) {
  const entries = new Map(), windows = new Set();
  let saved = {}, timer, saving = Promise.resolve(), saveError = '', unreadable = false;
  try { const value = JSON.parse(store.read()[KEY] || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); saved = value; }
  catch { unreadable = true; saveError = 'Could not read saved session browsers. The saved workspace has been preserved.'; }
  function schedule() { clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}); }, 150); }
  function remember(id, entry) { const value = entry.browser.saved(); if (value.tabs.length) saved[id] = value; else delete saved[id]; }
  async function flush() {
    clearTimeout(timer);
    for (const [id, entry] of entries) if (entry.restored) remember(id, entry);
    const value = JSON.stringify(saved);
    const result = saving.then(() => { if (unreadable) throw Error(saveError); return store.set(KEY, value); }).then(() => { saveError = ''; });
    saving = result.catch(error => { saveError = error.message; for (const window of windows) window.notify(); });
    await result; await store.flush();
  }
  function entryFor(id, options) {
    if (!valid(id)) throw Error('Invalid browser session.');
    if (entries.has(id)) return entries.get(id);
    const handlers = new Map(), listeners = new Map();
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn), removeHandler: name => handlers.delete(name), removeListener: name => listeners.delete(name) };
    const entry = { handlers, listeners, owner: null, restored: false, host: options.host };
    entry.browser = createBrowser({ ...options, ipcMain, sessionId: id, presented: false, onChange: () => {
      if (entry.restored) schedule();
      for (const window of windows) if (window.entry === entry && entry.owner !== window) window.notify();
    } });
    entries.set(id, entry);
    entry.ready = entry.browser.restore(saved[id]).then(() => { entry.restored = true; });
    return entry;
  }
  async function agentFor(id) {
    let entry = entries.get(id);
    if (!entry) {
      const window = [...windows].find(window => !window.host.isDestroyed());
      if (!window) return null;
      entry = entryFor(id, window.options);
    }
    await entry.ready;
    return entries.get(id) === entry ? entry.browser.agent : null;
  }
  browserAgentSocket?.setResolver(agentFor);
  function drop(id) {
    const entry = entries.get(id);
    if (entry) { entries.delete(id); entry.browser.dispose(); }
    delete saved[id];
    for (const window of windows) if (window.id === id) { window.entry = null; window.notify(); }
    schedule();
  }
  function adopt(from, to) {
    if (!valid(from) || !valid(to) || !from.startsWith('draft:')) throw Error('Invalid browser draft.');
    if (entries.has(to) || saved[to]) return;
    const entry = entries.get(from);
    if (entry) saved[to] = entry.browser.saved();
    else if (saved[from]) saved[to] = saved[from];
    drop(from);
  }
  function attach(options) {
    const { host, origin, ipcMain } = options;
    const window = { host, options, id: `draft:${randomUUID()}`, entry: null, background: null, notify() {
      if (!host.webContents.isDestroyed()) host.webContents.send('elpis:browser:state', state());
    } };
    windows.add(window);
    function state() { return window.entry ? { ...window.entry.browser.snapshot(), sessionId: window.id, ...(saveError ? { error: saveError } : {}) } : { sessionId: window.id, visible: false, tabs: [], activeId: null, ...(saveError ? { error: saveError } : {}) }; }
    const trusted = event => { if (!trustedBrowserSender(event, host.webContents, origin)) throw Error('Elpis application frame required'); };
    async function activate(id = window.id) {
      if (!valid(id)) throw Error('Invalid browser session.');
      if (window.entry && window.id !== id && window.entry.owner === window) window.entry.browser.present(false);
      const entry = entryFor(id, options); window.id = id; window.entry = entry;
      await entry.ready;
      if (window.id !== id || window.entry !== entry || host.isDestroyed()) return;
      if (entry.owner && entry.owner !== window) entry.browser.present(false);
      entry.owner = window; entry.host = host; entry.browser.present(true, host);
      if (window.background) entry.browser.setBackground(window.background);
    }
    ipcMain.handle('elpis:browser', async (event, input) => {
      try {
        trusted(event);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid browser command.');
        const { sessionId, fromSessionId, ...command } = input;
        if (command.action === 'sessionClose') { drop(sessionId ?? window.id); return state(); }
        if (command.action === 'sessionAdopt') { adopt(fromSessionId, sessionId); return state(); }
        if (command.action === 'session') { await activate(sessionId); return state(); }
        if (sessionId !== undefined && sessionId !== window.id) throw Error('This browser session is no longer shown.');
        if (!window.entry) await activate();
        if (command.action === 'state') return state();
        return await window.entry.handlers.get('elpis:browser')(event, command);
      } catch (error) { return { error: error.message }; }
    });
    const layout = (event, input) => { try { trusted(event); if (input.sessionId !== undefined && input.sessionId !== window.id) return; if (window.entry?.owner === window) window.entry.listeners.get('elpis:browser:layout')?.(event, input); } catch {} };
    const pageMessage = (event, input) => { for (const entry of entries.values()) if (entry.host === host) entry.listeners.get('elpis:browser:page')?.(event, input); };
    const focus = () => { if (window.entry) void activate().catch(() => {}); };
    ipcMain.on('elpis:browser:layout', layout); ipcMain.on('elpis:browser:page', pageMessage); host.on('focus', focus);
    return { open(url) { if (window.entry) return window.entry.browser.open(url); void activate().then(() => window.entry?.browser.open(url)); },
      setBackground(color) { window.background = color; if (window.entry?.owner === window) window.entry.browser.setBackground(color); },
      dispose() {
        windows.delete(window); host.removeListener('focus', focus);
        ipcMain.removeHandler('elpis:browser'); ipcMain.removeListener('elpis:browser:layout', layout); ipcMain.removeListener('elpis:browser:page', pageMessage);
        for (const [id, entry] of entries) if (entry.host === host) {
          const other = [...windows].find(window => window.entry === entry && !window.host.isDestroyed());
          if (other) {
            entry.owner = other; entry.host = other.host; entry.browser.present(true, other.host);
            if (other.background) entry.browser.setBackground(other.background);
            continue;
          }
          remember(id, entry); entries.delete(id); entry.browser.dispose();
        }
        schedule();
      },
    };
  }
  return { attach, drop, flush };
}
module.exports = { createBrowserSessions };
