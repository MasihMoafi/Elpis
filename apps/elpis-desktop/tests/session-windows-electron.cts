// Production window factory and preload, on a local fixture bridge and a throwaway profile.
const electron = require('electron');
const path = require('node:path');
const { app, Menu } = electron;
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const { createSessionWindows, sessionWindowMenu } = require('../desktop/session-windows.cts');
const { createStateStore } = require('../desktop/state.cts');
const { startQuickEntry } = require('../desktop/quick-entry.cts');
app.setPath('userData', process.env.SESSION_WINDOW_PROFILE);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const store = createStateStore(path.join(app.getPath('userData'), 'workspace.json'));
  await store.set('elpis-preferences-v1', JSON.stringify({ confirmClose: false }));
  const quickEntry = startQuickEntry({ ...electron, dark: () => false, onSubmit: () => {} });
  const browserSocket = process.env.SESSION_BROWSER_TOOLS ? await require('../desktop/browser-agent.cts').startBrowserAgentSocket() : undefined;
  if (browserSocket) Object.assign(global, { browserSocket });
  const sessionWindows = createSessionWindows({ electron, quickEntry, browserAgentSocket: browserSocket, url: process.env.SESSION_WINDOW_URL, store,
    closeToTray: { hides: () => false, closed: () => {} }, mayClose: () => true, onDark: () => {} });
  Object.assign(global, { sessionWindows });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [sessionWindowMenu(() => sessionWindows.open({ newSession: true }))] }]));
  if (process.argv.includes('--love-spot')) await sessionWindows.openLoveSpot();
  else await sessionWindows.open();
});
app.on('window-all-closed', () => app.quit());
