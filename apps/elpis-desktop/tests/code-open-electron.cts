// An isolated Electron host with the production preload and file IPC. No engine, installed profile or inference.
const { preloadPath }: typeof import('../desktop/preload-path.cts') = require('../desktop/preload-path.cts');
const { app, BrowserWindow, ipcMain } = require('electron');
const { registerFiles } = require('../desktop/files.cts');
const profile = process.env.CODE_OPEN_PROFILE, url = process.env.CODE_OPEN_URL;
if (!profile || !url) throw new Error('CODE_OPEN_PROFILE and CODE_OPEN_URL are required');
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
const fileOpens: string[] = [];
Object.assign(global, { fileOpens });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { preload: preloadPath('preload'), contextIsolation: true, sandbox: true } });
  ipcMain.on('elpis:state:read', (event: import('electron').IpcMainEvent) => { event.returnValue = {}; });
  ipcMain.handle('elpis:state:write', () => {});
  ipcMain.handle('elpis:folder:resolve', (_event: import('electron').IpcMainInvokeEvent, value: unknown) => value);
  ipcMain.handle('elpis:browser', () => ({ tabs: [], visible: false }));
  for (const channel of ['elpis:open-thread:take', 'elpis:new-chat:take']) ipcMain.handle(channel, () => null);
  registerFiles({ host: win, origin: new URL(url).origin, ipcMain, shell: { openPath: async (file: string) => { fileOpens.push(file); return ''; } }, env: { PATH: '' } });
  await win.loadURL(url);
});
app.on('window-all-closed', () => app.quit());
