'use strict';
const { APP_MENUS } = require('../lib/app-menu-commands.cjs');
const { trustedBrowserSender, zoomStep } = require('./browser-policy.cjs');
const commands = APP_MENUS.flatMap(group => group.items).filter(item => 'id' in item);
const nativeCommands = new Set(commands.filter(item => item.target === 'native').map(item => item.id));

/** A fixed native command surface; no role, script, path or clipboard data comes from the renderer. */
function createAppMenu({ ipcMain, windows, origin, newWindow, quit }) {
  async function execute(command, host) {
    if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(command)) { host.webContents.focus(); host.webContents[command](); }
    else if (command === 'new-window') await newWindow();
    else if (command === 'close-window') host.close(); // session-windows owns confirmation and unsaved-text guards.
    else if (command === 'quit') await quit(); // main.quitApp owns all-window flush and quit guards.
    else if (command === 'fullscreen') host.setFullScreen(!host.isFullScreen());
    else if (command === 'zoomIn' || command === 'zoomOut' || command === 'resetZoom') host.webContents.setZoomFactor(zoomStep(host.webContents.getZoomFactor(), command === 'zoomIn' ? 'in' : command === 'zoomOut' ? 'out' : 'reset'));
    return { performed: true };
  }
  ipcMain.handle('elpis:menu:command', async (event, command) => {
    const host = [...windows()].find(host => !host.isDestroyed() && host.webContents === event.sender);
    if (!host || !trustedBrowserSender(event, host.webContents, origin())) throw Error('Elpis application frame required');
    if (typeof command !== 'string' || !nativeCommands.has(command)) throw Error('Unknown native menu command');
    return execute(command, host);
  });
  const report = error => console.error('Could not perform menu action:', error);
  return {
    template: () => APP_MENUS.map(group => ({ label: group.label, submenu: group.items.map(item => {
      if ('separator' in item) return { type: 'separator' };
      if ('role' in item) return { label: item.label, role: item.role };
      return { label: item.label, ...('accelerator' in item ? { accelerator: item.accelerator } : {}), click: (_item, focusedWindow) => {
        const host = focusedWindow && [...windows()].includes(focusedWindow) ? focusedWindow : [...windows()].find(host => !host.isDestroyed());
        if (!host || host.isDestroyed()) return;
        if (item.target === 'renderer') host.webContents.send('elpis:menu:requested', item.id);
        else void execute(item.id, host).catch(report);
      } };
    }) })),
    dispose: () => ipcMain.removeHandler('elpis:menu:command'),
  };
}
module.exports = { createAppMenu };
