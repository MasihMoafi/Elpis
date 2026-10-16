'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { trustedBrowserSender } = require('./browser-policy.cjs');

function localFilePath(target) {
  if (typeof target !== 'string' || target.length > 4096 || !target.startsWith('/') || target.startsWith('//')) {
    throw Error('Choose an absolute local file path.');
  }
  let file;
  try { file = decodeURIComponent(target); }
  catch { throw Error('This file path is not valid.'); }
  if (!path.isAbsolute(file) || file.startsWith('//') || /[\x00-\x1f\x7f]/.test(file)) throw Error('This file path is not valid.');
  const line = file.match(/:(\d+)$/);
  if (line) {
    if (!Number.isSafeInteger(Number(line[1])) || Number(line[1]) < 1) throw Error('This file link has an invalid line number.');
    file = file.slice(0, -line[0].length);
  }
  return file;
}

function registerFiles({ host, origin, ipcMain, shell }) {
  ipcMain.handle('elpis:file:open', async (event, target) => {
    if (!trustedBrowserSender(event, host.webContents, origin)) throw Error('Elpis application frame required');
    try {
      let file = localFilePath(target);
      try {
        file = await fs.realpath(file);
        if (!(await fs.stat(file)).isFile()) throw Error('Not a regular file');
      } catch { throw Error('This file is unavailable. Choose an existing local file.'); }
      const error = await shell.openPath(file);
      if (error) throw Error(`Could not open this file: ${error}`);
      return { opened: true };
    } catch (error) { return { error: error.message || 'Could not open this file.' }; }
  });
  return () => ipcMain.removeHandler('elpis:file:open');
}

module.exports = { registerFiles };
