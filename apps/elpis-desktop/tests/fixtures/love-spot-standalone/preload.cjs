// What the page may ask of the app: the saved drawing, saving it, its picture, and additions from the inbox.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('board', {
  load: () => ipcRenderer.invoke('load'),
  save: text => ipcRenderer.invoke('save', text),
  view: (bytes, revision) => ipcRenderer.invoke('view', bytes, revision),
  onIncoming: listen => ipcRenderer.on('incoming', (_event, data) => listen(data)),
  onScreenshot: listen => ipcRenderer.on('screenshot', (_event, shot) => listen(shot)),
});
