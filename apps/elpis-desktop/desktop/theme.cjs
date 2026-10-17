'use strict';

// The app's page reports its theme over 'elpis:theme': whether it is dark, which choice the person made (System, Light
// or Dark) and its own background colour (the --background token). Main colours the window buttons with it, sets
// nativeTheme to the choice so web pages in the browser follow prefers-color-scheme (System hands it back to the
// operating system, which the app's page reads for its own system mode), and paints the browser's blank pages.
const CHOICES = ['system', 'light', 'dark'];
// Only a plain colour reaches Electron: what getComputedStyle gives for the token, or a hex value.
const COLOR = /^(?:#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;

function registerTheme({ host, ipcMain, nativeTheme, titleBar, browser, onDark }) {
  const report = (event, dark, details) => {
    if (event.sender !== host.webContents || event.senderFrame !== host.webContents.mainFrame || host.isDestroyed()) return;
    onDark(dark === true); host.setTitleBarOverlay(titleBar[dark === true ? 'dark' : 'light']);
    if (CHOICES.includes(details?.source)) nativeTheme.themeSource = details.source;
    if (typeof details?.background === 'string' && COLOR.test(details.background)) browser.setBackground(details.background);
  };
  ipcMain.on('elpis:theme', report);
  return () => ipcMain.removeListener('elpis:theme', report);
}

module.exports = { registerTheme };
