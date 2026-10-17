// An isolated Electron host with the production preload and file IPC. No engine, installed profile or inference.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { registerFiles } = require('../desktop/files.cjs');
app.setPath('userData', process.env.CODE_OPEN_PROFILE);
app.commandLine.appendSwitch('disable-gpu');
global.fileOpens = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { preload: path.resolve(__dirname, '../desktop/preload.cjs'), contextIsolation: true, sandbox: true } });
  ipcMain.on('elpis:state:read', event => { event.returnValue = {}; });
  ipcMain.handle('elpis:state:write', () => {});
  ipcMain.handle('elpis:folder:resolve', (_event, value) => value);
  ipcMain.handle('elpis:browser', () => ({ tabs: [], visible: false }));
  for (const channel of ['elpis:open-thread:take', 'elpis:new-chat:take']) ipcMain.handle(channel, () => null);
  registerFiles({ host: win, origin: new URL(process.env.CODE_OPEN_URL).origin, ipcMain, shell: { openPath: async file => { global.fileOpens.push(file); return ''; } }, env: { PATH: '' } });
  await win.loadURL(process.env.CODE_OPEN_URL);
});
app.on('window-all-closed', () => app.quit());
