// Isolated test host with the production browser and preload; no installed app or engine.
const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, clipboard } = require('electron');
const path = require('node:path');
const { createBrowser } = require('../desktop/browser.cjs');
app.setPath('userData', process.env.PREVIEW_TEST_PROFILE);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { preload: path.resolve(__dirname, '../desktop/preload.cjs'), contextIsolation: true, sandbox: true } });
  ipcMain.on('elpis:state:read', event => { event.returnValue = {}; });
  ipcMain.handle('elpis:state:write', () => {});
  ipcMain.handle('elpis:folder:resolve', (_event, value) => value);
  for (const channel of ['elpis:open-thread:take', 'elpis:new-chat:take']) ipcMain.handle(channel, () => null);
  createBrowser({ host, origin: new URL(process.env.PREVIEW_TEST_URL).origin, WebContentsView, session, ipcMain, Menu, clipboard, openExternal: async () => {} });
  await host.loadURL(process.env.PREVIEW_TEST_URL);
});
app.on('window-all-closed', () => app.quit());
