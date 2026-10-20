// Excalidraw as a desktop window. The drawing is ~/.local/share/excalidraw-local/scene.excalidraw (saved as you draw)
// with view.png beside it (a picture of the whole drawing). Additions dropped into inbox/ as .json files
// ({ elements, files }, the .excalidraw shape) are merged into the drawing and the file is removed.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { createLoveSpot } = require('./love-spot-store.cjs');

const DIR = process.env.EXCALIDRAW_LOCAL_DIR || path.join(app.getPath('home'), '.local/share/excalidraw-local');
const INBOX = path.join(DIR, 'inbox');
let win = null;

app.setName('Excalidraw');
// The window's id on the desktop is the launcher's, so the dock shows it as Excalidraw and it can be pinned.
app.setDesktopName('excalidraw.desktop');
app.commandLine.appendSwitch('class', 'excalidraw');
// Clicking the launcher while the app runs: the running window gives way to the new one, which GNOME brings to the
// front (on Wayland a running window may not raise itself). The pause lets the page's last save land first.
app.on('second-instance', () => setTimeout(() => app.quit(), 600));
app.on('window-all-closed', () => app.quit());
const start = () => {
  fs.mkdirSync(INBOX, { recursive: true });
  const board = createLoveSpot({ directory: DIR, screenshots: path.join(app.getPath('pictures'), 'Screenshots') });
  ipcMain.handle('load', async () => { const data = await board.read(); return JSON.stringify({ ...data.scene, revision: data.revision }); });
  ipcMain.handle('save', (_event, text) => board.save(JSON.parse(text)));
  ipcMain.handle('view', (_event, bytes, revision) => board.picture({ revision, png: Buffer.from(bytes).toString('base64') }));
  app.on('before-quit', () => board.close());
  win = new BrowserWindow({ width: 1400, height: 900, title: 'Love Spot', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // The page's warnings and errors go to app.log, so a failed merge can be read afterwards.
  win.webContents.on('console-message', ({ level, message }) => { if (level !== 'info' && level !== 'debug') fs.appendFileSync(path.join(DIR, 'app.log'), `${new Date().toISOString()} ${level} ${message}\n`); });
  win.loadFile(path.join(__dirname, 'dist/index.html'));
  win.webContents.once('did-finish-load', () => board.watch(value => {
    if (value.type === 'scene') win?.webContents.send('incoming', { ...value.scene, revision: value.revision });
    // New screenshots wait in Elpis's Love Spot tray; this window shows only the drawing.
    else if (value.type === 'error') console.error(value.message);
  }));
};
(async () => {
  for (let tries = 0; !app.requestSingleInstanceLock(); tries++) {
    if (tries > 40) return app.quit();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await app.whenReady();
  start();
})();
