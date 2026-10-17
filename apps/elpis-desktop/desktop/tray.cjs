'use strict';
// The tray icon and Close to tray, after Claude's desktop app on Linux. Claude's tray menu is Show App, Open Quick Entry,
// then Quit; with its System tray setting off, closing the window quits. Elpis shows its tray while the app runs, and
// closing hides the window only when Settings → General → Close to tray is on. That setting is off by default, so
// nothing keeps running after the window closes unless it is chosen.

/** Claude's tray items where Elpis has them, plus New chat. */
function trayMenu({ open, newChat, quickEntry, quit }) {
  return [
    { label: 'Open Elpis', click: open },
    { label: 'New chat', click: newChat },
    { label: 'Open Quick Entry', click: quickEntry },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  ];
}

/** The Elpis logo in the tray, at the 64 pixels of Claude's Linux tray icon. Claude's tray has a menu and no click action. */
function createTray({ Tray, Menu, nativeImage, icon, actions }) {
  const tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 64, height: 64 }));
  tray.setToolTip('Elpis');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu(actions)));
  return tray;
}

/** What closing the window does. `hides` runs first in the window's close handler: true when the window went to the tray
 * instead. Otherwise the window closes and `closed` quits Elpis, as Claude's app does when its tray is off; the hidden
 * Quick Entry window does not keep it running. Quitting always closes the window. */
function createCloseToTray({ app, enabled, quitting, platform = process.platform }) {
  return {
    hides(event, window) {
      if (quitting() || !enabled()) return false;
      event.preventDefault(); window.hide();
      return true;
    },
    closed() { if (platform !== 'darwin') app.quit(); },
  };
}

module.exports = { trayMenu, createTray, createCloseToTray };
