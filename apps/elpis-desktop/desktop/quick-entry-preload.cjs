'use strict';
// Quick Entry's page (quick-entry.html) may only send its text, close itself, and hear that it was shown.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('elpisQuickEntry', {
  submit: text => ipcRenderer.send('elpis:quick-entry:submit', String(text)),
  dismiss: () => ipcRenderer.send('elpis:quick-entry:dismiss'),
  onShow: callback => { ipcRenderer.on('elpis:quick-entry:show', (_event, state) => callback({ dark: state?.dark === true })); },
});
