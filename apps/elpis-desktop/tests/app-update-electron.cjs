// Run only through app-update-native.test.cjs: real Electron lifecycle, private backend/profile.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = process.env.APP_UPDATE_TEST_ROOT;
if (!root || !process.env.DBUS_SESSION_BUS_ADDRESS || !process.env.DISPLAY || process.env.WAYLAND_DISPLAY) throw Error('Private root, D-Bus and X11 are required');
os.homedir = () => root;
const reopened = process.env.APP_UPDATE_REOPENED === '1';
const stage = reopened ? 'reopened' : 'initial';
const log = value => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ stage, pid: process.pid, ...value }) + '\n');
const control = { failWrites: false, failWorkflowWrites: false, canRestart: true, errors: [], trayMenu: null };
const appDirectory = path.resolve(__dirname, '..');
const mainFile = path.join(appDirectory, 'desktop/main.cjs');
const localRequire = createRequire(mainFile);
const fakeDirectory = path.join(root, 'versions', reopened ? 'two' : 'one', 'app/desktop');
fs.mkdirSync(fakeDirectory, { recursive: true });
fs.copyFileSync(path.join(appDirectory, 'desktop/elpis-icon.png'), path.join(fakeDirectory, 'elpis-icon.png'));
let releaseReady;
const ready = new Promise(resolve => { releaseReady = resolve; });
const app = new Proxy(electron.app, { get(target, key) {
  if (key === 'whenReady') return () => ready;
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
} });
function Tray(...args) {
  const tray = new electron.Tray(...args), setMenu = tray.setContextMenu.bind(tray);
  tray.setContextMenu = menu => { control.trayMenu = menu; setMenu(menu); };
  return tray;
}
const facade = { ...electron, app, Tray, dialog: { ...electron.dialog,
  showErrorBox: (title, message) => { control.errors.push({ title, message }); log({ type: 'error', title, message }); },
} };
const state = localRequire('./state.cjs');
const load = name => {
  if (name === 'electron') return facade;
  if (name === './state.cjs') return { ...state, createStateStore(file) {
    const store = state.createStateStore(file), patch = store.patch;
    store.patch = async (...args) => {
      if (control.failWrites && args[0]?.key?.startsWith('elpis-draft-v1:')) throw Error('Private workspace save refused');
      if (control.failWorkflowWrites && args[0]?.key === 'elpis-workflow-draft-v1') throw Error('Private workflow save refused');
      return patch(...args);
    };
    control.store = store; return store;
  } };
  return localRequire(name);
};
const context = vm.createContext({ __dirname: fakeDirectory, console, process, require: load,
  testServer: { url: process.env.SESSION_WINDOW_URL, canRestart: async () => control.canRestart,
    close: async () => log({ type: 'server-close', values: control.store.read() }) },
});
vm.runInContext(fs.readFileSync(mainFile, 'utf8'), context, { filename: mainFile });
vm.runInContext('server = testServer;', context);
global.updateTest = {
  control,
  openLoveSpot: () => vm.runInContext('sessionWindows.openLoveSpot()', context),
  capture: async (id, file) => fs.writeFileSync(file, (await electron.BrowserWindow.fromId(id).capturePage()).toPNG()),
  quitFromTray: () => {
    const item = control.trayMenu?.items.find(item => item.label === 'Quit');
    if (!item) throw Error('Native tray menu unavailable');
    log({ type: 'tray-quit-callback' }); item.click();
  },
};
electron.app.on('will-quit', () => log({ type: 'will-quit' }));
const until = async check => {
  const end = Date.now() + 15000; let lastError;
  for (;;) { try { const value = await check(); if (value) return value; } catch (error) { lastError = error; } if (Date.now() > end) throw Error(`Reopened renderer did not settle: ${lastError?.message || 'condition false'}`); await new Promise(resolve => setTimeout(resolve, 40)); }
};
electron.app.whenReady().then(async () => {
  releaseReady();
  if (!reopened) return;
  log({ type: 'launch', mode: process.argv.includes('--love-spot-app') ? 'love-spot' : 'main' });
  const host = await until(() => [...electron.BrowserWindow.getAllWindows()].find(host => host.webContents.getURL().startsWith(process.env.SESSION_WINDOW_URL.split('#')[0])));
  const settled = () => !document.querySelector('.startup-splash') && !!document.querySelector('.excalidraw canvas, textarea[aria-label="Message Elpis"]');
  const readComposer = () => document.querySelector('textarea[aria-label="Message Elpis"]')?.value ?? null;
  await until(() => host.webContents.executeJavaScript(`(${settled.toString()})()`));
  const composer = await host.webContents.executeJavaScript(`(${readComposer.toString()})()`);
  let quickEntry = null;
  if (!process.argv.includes('--love-spot-app')) await until(() => control.trayMenu);
  if (control.trayMenu) {
    control.trayMenu.items.find(item => item.label === 'Open Quick Entry').click();
    const quick = await until(() => electron.BrowserWindow.getAllWindows().find(host => host.webContents.getURL().includes('quick-entry.html')));
    quickEntry = await until(() => quick.webContents.executeJavaScript('document.querySelector("textarea")?.value || null'));
  }
  const love = await global.updateTest.openLoveSpot();
  await until(() => love.webContents.executeJavaScript('!!document.querySelector(".excalidraw canvas")'));
  const drawing = await love.webContents.executeJavaScript('fetch("/api/love-spot").then(r => r.json())');
  log({ type: 'restored', composer, quickEntry, texts: drawing.scene.elements.filter(item => !item.isDeleted && item.type === 'text').map(item => item.text), mode: process.argv.includes('--love-spot-app') ? 'love-spot' : 'main' });
  fs.writeFileSync(path.join(root, 'reopened.png'), (await love.capturePage()).toPNG());
  if (control.trayMenu) global.updateTest.quitFromTray();
  else electron.app.quit();
}).catch(error => { log({ type: 'fatal', message: error.stack }); electron.app.exit(1); });
process.on('uncaughtException', error => { log({ type: 'fatal', message: error.stack }); electron.app.exit(1); });
process.on('unhandledRejection', error => { log({ type: 'fatal', message: String(error?.stack || error) }); electron.app.exit(1); });
