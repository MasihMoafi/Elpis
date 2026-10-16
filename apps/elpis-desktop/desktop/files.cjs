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

/** A project's folder: a plain absolute path, as saved in the project list. */
function localFolderPath(target) {
  if (typeof target !== 'string' || target.length > 4096 || !path.isAbsolute(target) || target.startsWith('//') || /[\x00-\x1f\x7f]/.test(target)) {
    throw Error('Choose an absolute local folder path.');
  }
  return target;
}

function registerFiles({ host, origin, ipcMain, shell }) {
  const opener = (kind, toPath) => async (event, target) => {
    if (!trustedBrowserSender(event, host.webContents, origin)) throw Error('Elpis application frame required');
    try {
      let file = toPath(target);
      try {
        file = await fs.realpath(file);
        const stat = await fs.stat(file);
        if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw Error(`Not a ${kind}`);
      } catch { throw Error(`This ${kind} is unavailable. Choose an existing local ${kind}.`); }
      const error = await shell.openPath(file);
      if (error) throw Error(`Could not open this ${kind}: ${error}`);
      return { opened: true };
    } catch (error) { return { error: error.message || `Could not open this ${kind}.` }; }
  };
  ipcMain.handle('elpis:file:open', opener('file', localFilePath));
  ipcMain.handle('elpis:folder:open', opener('folder', localFolderPath));
  return () => { ipcMain.removeHandler('elpis:file:open'); ipcMain.removeHandler('elpis:folder:open'); };
}

module.exports = { registerFiles };
