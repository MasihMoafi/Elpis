'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const nodeSpawn = require('node:child_process').spawn;
const { trustedBrowserSender } = require('./browser-policy.cjs');
const { installedEditors, editorCommand } = require('./editors.cjs');

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

/** The line a clicked file link carries (`/path/a.ts:12`), if any. */
const lineOf = target => { const match = typeof target === 'string' ? target.match(/:(\d+)$/) : null; return match ? Number(match[1]) : undefined; };

/** Starts `command` apart from the app and waits until the system has started it (or refused). */
function start(spawn, { name, command, args }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { detached: true, stdio: 'ignore' }); } catch (error) { reject(Error(`Could not start ${name}: ${error.message}`)); return; }
    child.once('error', error => reject(Error(`Could not start ${name}: ${error.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function registerFiles({ host, origin, ipcMain, shell, env, spawn = nodeSpawn }) {
  const trusted = event => { if (!trustedBrowserSender(event, host.webContents, origin)) throw Error('Elpis application frame required'); };
  /** The real path of an existing local file or folder named by `toPath`, else an error the page can show. */
  const existing = async (kind, toPath, target) => {
    let file = toPath(target);
    try {
      file = await fs.realpath(file);
      const stat = await fs.stat(file);
      if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw Error(`Not a ${kind}`);
    } catch { throw Error(`This ${kind} is unavailable. Choose an existing local ${kind}.`); }
    return file;
  };
  const opener = (kind, toPath) => async (event, target) => {
    try {
      trusted(event);
      const error = await shell.openPath(await existing(kind, toPath, target));
      if (error) throw Error(`Could not open this ${kind}: ${error}`);
      return { opened: true };
    } catch (error) { return { error: error.message || `Could not open this ${kind}.` }; }
  };
  ipcMain.handle('elpis:file:open', opener('file', localFilePath));
  ipcMain.handle('elpis:folder:open', opener('folder', localFolderPath));
  ipcMain.handle('elpis:editors:list', async event => {
    try { trusted(event); return { editors: installedEditors(env) }; } catch (error) { return { error: error.message }; }
  });
  ipcMain.handle('elpis:file:edit', async (event, request) => {
    try {
      trusted(event);
      const { target, editor, line } = request ?? {};
      const file = await existing('file', localFilePath, target);
      await start(spawn, editorCommand(editor, file, Number.isInteger(line) ? line : lineOf(target), env));
      return { opened: true };
    } catch (error) { return { error: error.message || 'Could not start the editor.' }; }
  });
  return () => { for (const name of ['elpis:file:open', 'elpis:folder:open', 'elpis:editors:list', 'elpis:file:edit']) ipcMain.removeHandler(name); };
}

module.exports = { registerFiles };
