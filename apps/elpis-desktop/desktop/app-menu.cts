'use strict';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MenuItem } from 'electron';
const { APP_MENUS }: typeof import('../lib/app-menu-commands.cts') = require('../lib/app-menu-commands.cts');
const { trustedBrowserSender, zoomStep }: typeof import('./browser-policy.cts') = require('./browser-policy.cts');
const commands = APP_MENUS.flatMap(group => group.items as readonly unknown[]).filter((item): item is { id: string; target: string } => 'id' in (item as object));
const nativeCommands = new Set(commands.filter(item => item.target === 'native').map(item => item.id));

/** A fixed native command surface; no role, script, path or clipboard data comes from the renderer. */
function createAppMenuImpl({ ipcMain, windows, origin, newWindow, quit }: { ipcMain: IpcMain; windows: () => BrowserWindow[]; origin: () => string; newWindow: () => unknown; quit: () => unknown }) {
  async function execute(command: string, host: BrowserWindow) {
    if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(command)) { host.webContents.focus(); host.webContents[command as 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'](); }
    else if (command === 'new-window') await newWindow();
    else if (command === 'close-window') host.close(); // session-windows owns confirmation and unsaved-text guards.
    else if (command === 'quit') await quit(); // main.quitApp owns all-window flush and quit guards.
    else if (command === 'fullscreen') host.setFullScreen(!host.isFullScreen());
    else if (command === 'zoomIn' || command === 'zoomOut' || command === 'resetZoom') host.webContents.setZoomFactor(zoomStep(host.webContents.getZoomFactor(), command === 'zoomIn' ? 'in' : command === 'zoomOut' ? 'out' : 'reset')!);
    return { performed: true };
  }
  ipcMain.handle('elpis:menu:command', async (event: IpcMainInvokeEvent, command: unknown) => {
    const host = [...windows()].find(host => !host.isDestroyed() && host.webContents === event.sender);
    if (!host || !trustedBrowserSender(event, host.webContents, origin())) throw Error('Elpis application frame required');
    if (typeof command !== 'string' || !nativeCommands.has(command)) throw Error('Unknown native menu command');
    return execute(command, host);
  });
  const report = (error: unknown) => console.error('Could not perform menu action:', error);
  return {
    template: () => APP_MENUS.map(group => ({ label: group.label, submenu: group.items.map(item => {
      if ('separator' in item) return { type: 'separator' };
      if ('role' in item) return { label: item.label, role: item.role };
      return { label: item.label, ...('accelerator' in item ? { accelerator: item.accelerator } : {}), click: (_item: MenuItem, focusedWindow: BrowserWindow | undefined) => {
        const host = focusedWindow && [...windows()].includes(focusedWindow) ? focusedWindow : [...windows()].find(host => !host.isDestroyed());
        if (!host || host.isDestroyed()) return;
        if (item.target === 'renderer') host.webContents.send('elpis:menu:requested', item.id);
        else void execute(item.id, host).catch(report);
      } };
    }) })),
    dispose: () => ipcMain.removeHandler('elpis:menu:command'),
  };
}
export declare const createAppMenu: typeof createAppMenuImpl;
module.exports = { createAppMenu: createAppMenuImpl };
