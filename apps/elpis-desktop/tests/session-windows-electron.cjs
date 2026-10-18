// Production window factory and preload, on a local fixture bridge and a throwaway profile.
const electron = require('electron');
const path = require('node:path');
const { app, Menu } = electron;
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const { createSessionWindows, sessionWindowMenu } = require('../desktop/session-windows.cjs');
const { createStateStore } = require('../desktop/state.cjs');
const { startQuickEntry } = require('../desktop/quick-entry.cjs');
app.setPath('userData', process.env.SESSION_WINDOW_PROFILE);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const store = createStateStore(path.join(app.getPath('userData'), 'workspace.json'));
  await store.set('elpis-preferences-v1', JSON.stringify({ confirmClose: false }));
  const quickEntry = startQuickEntry({ ...electron, dark: () => false, onSubmit: () => {} });
  global.sessionWindows = createSessionWindows({ electron, quickEntry, url: process.env.SESSION_WINDOW_URL, store,
    closeToTray: { hides: () => false, closed: () => {} }, mayClose: () => true, onDark: () => {} });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [sessionWindowMenu(() => global.sessionWindows.open({ newSession: true }))] }]));
  if (process.argv.includes('--love-spot')) await global.sessionWindows.openLoveSpot();
  else await global.sessionWindows.open();
});
app.on('window-all-closed', () => app.quit());
