// Isolated test host with the production browser and preload; no installed app or engine.
const { preloadPath }: typeof import('../desktop/preload-path.cts') = require('../desktop/preload-path.cts');
const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, clipboard, dialog } = require('electron');
const path = require('node:path');
const { createBrowserSessions } = require('../desktop/browser-sessions.cts');
const { createStateStore, registerState }: typeof import('../desktop/state.cts') = require('../desktop/state.cts');
const profile = process.env.PREVIEW_TEST_PROFILE, url = process.env.PREVIEW_TEST_URL;
if (!profile || !url) throw new Error('PREVIEW_TEST_PROFILE and PREVIEW_TEST_URL are required');
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { preload: preloadPath('preload'), contextIsolation: true, sandbox: true } });
  const origin = new URL(url).origin, store = createStateStore(path.join(app.getPath('userData'), 'workspace.json'));
  const unregisterState = registerState({ host, origin, ipcMain, dialog, store });
  for (const channel of ['elpis:open-thread:take', 'elpis:new-chat:take']) ipcMain.handle(channel, () => null);
  const browsers = createBrowserSessions({ store });
  const browser = browsers.attach({ host, origin, WebContentsView, session, ipcMain, Menu, clipboard, openExternal: async () => {} });
  host.once('closed', () => { unregisterState(); browser.dispose(); });
  await host.loadURL(url);
});
app.on('window-all-closed', () => app.quit());
