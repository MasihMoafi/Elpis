'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trustedBrowserSender } = require('./browser-policy.cjs');

const resolved = file => { try { return fs.realpathSync(file); } catch { return null; } };
function executableLauncher(file) {
  const target = resolved(file);
  if (!target) throw Error('The installed Elpis launcher is unavailable. Keep this window open and retry after installation.');
  if (!fs.statSync(target).isFile()) throw Error('The installed Elpis launcher must be an executable file. Keep this window open and retry after installation.');
  fs.accessSync(target, fs.constants.X_OK);
  return target;
}

/** Installed selections are symlinks. Watch their directory so an atomic replacement stays observable. */
function createAppUpdates({ app, desktopLauncher = path.join(os.homedir(), '.local/bin/elpis-app'),
  engineLauncher = process.env.ELPIS_ENGINE_BIN || path.join(os.homedir(), '.local/bin/elpis-next'),
  runningApp = app.getAppPath(), runningEngine = resolved(engineLauncher), restart }) {
  const appRoot = resolved(runningApp) ?? runningApp;
  let engine = runningEngine, state, pending, scheduled = false, disposed = false;
  const listeners = new Set(), watchers = [];
  function refresh(extra = {}) {
    if (disposed) return state;
    const desktop = resolved(desktopLauncher), selectedEngine = resolved(engineLauncher);
    const desktopChanged = !!desktop && path.join(path.dirname(desktop), 'app') !== appRoot;
    const engineChanged = !!engine && !!selectedEngine && selectedEngine !== engine;
    const next = { available: desktopChanged || engineChanged, desktop: desktopChanged, engine: engineChanged,
      restarting: state?.restarting ?? false, error: state?.error ?? null, ...extra };
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      for (const listener of listeners) listener({ ...state });
    }
    return { ...state };
  }
  refresh();
  for (const directory of new Set([desktopLauncher, engineLauncher].map(file => path.dirname(file)))) {
    try {
      const names = new Set([desktopLauncher, engineLauncher].filter(file => path.dirname(file) === directory).map(file => path.basename(file)));
      const watcher = fs.watch(directory, { persistent: false }, (_event, name) => { if (!name || names.has(String(name))) refresh(); });
      watcher.on('error', () => {}); watchers.push(watcher);
    } catch { /* A source checkout or private test profile need not have installed launchers. */ }
  }
  async function requestRestart() {
    if (pending) return pending;
    if (scheduled) return;
    pending = (async () => {
      if (!refresh().available) return;
      const target = executableLauncher(desktopLauncher);
      refresh({ restarting: true, error: null });
      try {
        await restart(target);
        scheduled = true;
      } catch (error) {
        refresh({ restarting: false, error: error.message || String(error) });
        throw error;
      }
    })();
    try { await pending; }
    catch (error) { refresh({ restarting: false, error: error.message || String(error) }); throw error; }
    finally { pending = null; }
  }
  function dispose() {
    disposed = true;
    for (const watcher of watchers) watcher.close();
    listeners.clear(); app.removeListener('will-quit', dispose);
  }
  app.on('will-quit', dispose);
  return {
    status: () => refresh(), restart: requestRestart,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setRunningEngine(value) { if (value) engine = value; refresh(); },
    attach({ host, origin, ipcMain }) {
      const trusted = event => trustedBrowserSender(event, host.webContents, origin);
      ipcMain.handle('elpis:updates:status', event => trusted(event) ? refresh() : { error: 'Elpis application frame required' });
      ipcMain.handle('elpis:updates:restart', async event => {
        if (!trusted(event)) return { error: 'Elpis application frame required' };
        try { await requestRestart(); return { restarting: scheduled }; }
        catch (error) { return { error: error.message || String(error) }; }
      });
      const off = this.subscribe(state => {
        if (!host.webContents.isDestroyed()) host.webContents.send('elpis:updates:changed', state);
      });
      return () => { off(); ipcMain.removeHandler('elpis:updates:status'); ipcMain.removeHandler('elpis:updates:restart'); };
    },
    dispose,
  };
}

module.exports = { createAppUpdates, executableLauncher };
