'use strict';
// The screenshot thumbnail's page (screenshot-popup.html) may only open the screenshot, close itself, and hear what to show.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('elpisScreenshot', {
  choose: () => ipcRenderer.send('elpis:screenshot-popup:choose'),
  dismiss: () => ipcRenderer.send('elpis:screenshot-popup:dismiss'),
  onShow: callback => { ipcRenderer.on('elpis:screenshot-popup:show', (_event, shot) => callback({ image: String(shot?.image ?? ''), name: String(shot?.name ?? ''), dark: shot?.dark === true, count: Number.isInteger(shot?.count) && shot.count > 0 ? shot.count : 1 })); },
});
