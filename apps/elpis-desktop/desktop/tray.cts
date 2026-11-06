'use strict';

import type { MenuItemConstructorOptions, Tray as ElectronTray, Menu as ElectronMenu, NativeImage } from 'electron';
type Actions = { open: () => void; newChat: () => void; quickEntry: () => void; quit: () => void };
type TrayOptions = { Tray: typeof ElectronTray; Menu: typeof ElectronMenu; nativeImage: { createFromPath: (path: string) => NativeImage }; icon: string; actions: Actions };
type CloseOptions = { app: { quit: () => void }; enabled: () => boolean; quitting: () => boolean; platform?: NodeJS.Platform };
// The tray icon and Close to tray, after Claude's desktop app on Linux. Claude's tray menu is Show App, Open Quick Entry,
// then Quit; with its System tray setting off, closing the window quits. Elpis shows its tray while the app runs, and
// closing hides the window only when Settings → General → Close to tray is on. That setting is off by default, so
// nothing keeps running after the window closes unless it is chosen.

/** Claude's tray items where Elpis has them, plus New chat. */
function trayMenuImpl({ open, newChat, quickEntry, quit }: Actions): MenuItemConstructorOptions[] {
  return [
    { label: 'Open Elpis', click: open },
    { label: 'New chat', click: newChat },
    { label: 'Open Quick Entry', click: quickEntry },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  ];
}

/** The Elpis logo in the tray, at the 64 pixels of Claude's Linux tray icon. Claude's tray has a menu and no click action. */
function createTrayImpl({ Tray, Menu, nativeImage, icon, actions }: TrayOptions) {
  const tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 64, height: 64 }));
  tray.setToolTip('Elpis');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuImpl(actions)));
  return tray;
}

/** What closing the window does. `hides` runs first in the window's close handler: true when the window went to the tray
 * instead. Otherwise the window closes and `closed` quits Elpis, as Claude's app does when its tray is off; the hidden
 * Quick Entry window does not keep it running. Quitting always closes the window. */
function createCloseToTrayImpl({ app, enabled, quitting, platform = process.platform }: CloseOptions) {
  return {
    hides(event: { preventDefault: () => void }, window: { hide: () => void }) {
      if (quitting() || !enabled()) return false;
      event.preventDefault(); window.hide();
      return true;
    },
    closed() { if (platform !== 'darwin') app.quit(); },
  };
}

export declare const trayMenu: typeof trayMenuImpl;
export declare const createTray: typeof createTrayImpl;
export declare const createCloseToTray: typeof createCloseToTrayImpl;
module.exports = { trayMenu: trayMenuImpl, createTray: createTrayImpl, createCloseToTray: createCloseToTrayImpl };
