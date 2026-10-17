'use strict';
// The integrated terminal, as in the ChatGPT app's Codex mode: one shell per terminal tab, started in the folder
// the tab was opened for, kept while the panel is hidden and ended when its tab or the window closes. The page sees only this IPC.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { trustedBrowserSender } = require('./browser-policy.cjs');
const { threadId } = require('./open-thread.cjs');

/** What a reloaded window replays of a shell's output. */
const KEEP = 512 * 1024;
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 4200 && !/[\x00-\x1f\x7f]/.test(key);
const size = (value, fallback) => Number.isInteger(value) && value >= 2 && value <= 1000 ? value : fallback;
const quote = word => /^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** The app's environment for programs started in the terminal: ~/.local/bin first and loopback unproxied (bridge/tools.mjs). */
const childEnv = env => import(pathToFileURL(path.join(__dirname, '../bridge/tools.mjs')).href).then(tools => tools.childEnv(env));

function directory(cwd, home) {
  try { if (typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory()) return cwd; } catch { /* use home */ }
  return home;
}

/** The installed Elpis TUI: ELPIS_TUI_BIN, else `elpis` on the shell's PATH. */
function tuiCommand(env) {
  if (env.ELPIS_TUI_BIN) return quote(env.ELPIS_TUI_BIN);
  for (const folder of String(env.PATH || '').split(':')) {
    try { if (folder && (fs.statSync(path.join(folder, 'elpis')).mode & 0o111)) return 'elpis'; } catch { /* next folder */ }
  }
  return null;
}

function registerTerminal({ host, origin, ipcMain, clipboard, env = process.env, home = os.homedir(), spawn, prepareEnv = childEnv }) {
  const sessions = new Map();
  let started = 0;
  const trusted = event => trustedBrowserSender(event, host.webContents, origin);
  const send = (...args) => { if (!host.webContents.isDestroyed?.()) host.webContents.send(...args); };
  let shellEnv;
  const environment = async () => {
    if (!shellEnv) {
      const next = { ...await prepareEnv({ ...env }) };
      for (const name of Object.keys(next)) if (name.startsWith('ELECTRON_')) delete next[name];
      shellEnv = Object.assign(next, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Elpis' });
    }
    return shellEnv;
  };

  function flush(session) {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    if (session.batch) { send('elpis:terminal:data', session.key, session.id, session.end, session.batch); session.batch = ''; }
  }

  async function start(key, { cwd, cols, rows }) {
    const spawnPty = spawn ?? require('node-pty').spawn;
    const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/bash';
    const pty = spawnPty(shell, [], { name: 'xterm-256color', cwd: directory(cwd, home), cols: size(cols, 80), rows: size(rows, 24), env: await environment() });
    // `end` counts every character the shell printed, so the page can drop what a replay already showed.
    const session = { key, id: ++started, pty, shell, output: '', end: 0, batch: '', timer: null, exited: null, tui: null };
    const previous = sessions.get(key);
    sessions.set(key, session);
    if (previous) { clearTimeout(previous.timer); previous.pty.kill(); }
    pty.onData(data => {
      if (sessions.get(key) !== session) return;
      session.output = (session.output + data).slice(-KEEP); session.end += data.length;
      session.batch += data;
      session.timer ??= setTimeout(() => flush(session), 5);
    });
    pty.onExit(({ exitCode }) => {
      if (sessions.get(key) !== session) return;
      flush(session); session.exited = exitCode ?? 0;
      send('elpis:terminal:exit', key, session.id, session.exited);
    });
    return session;
  }

  const view = session => { flush(session); return { id: session.id, end: session.end, shell: path.basename(session.shell), output: session.output, exited: session.exited }; };
  const guarded = handler => async (event, request) => {
    if (!trusted(event)) return { error: 'Elpis application frame required' };
    if (!validKey(request?.key)) return { error: 'This terminal is not valid.' };
    try { return await handler(request); }
    catch (error) { return { error: `The terminal could not start: ${error.message || error}` }; }
  };

  ipcMain.handle('elpis:terminal:open', guarded(async request => view(sessions.get(request.key) ?? await start(request.key, request))));
  ipcMain.handle('elpis:terminal:restart', guarded(async request => view(await start(request.key, request))));
  // A closed terminal tab ends its shell; the key is forgotten, so a later open starts fresh.
  ipcMain.handle('elpis:terminal:close', guarded(async request => {
    const session = sessions.get(request.key);
    if (session) { sessions.delete(request.key); if (session.timer) clearTimeout(session.timer); session.pty.kill(); }
    return {};
  }));
  // Types `elpis resume <id>` at the chat's shell prompt; a busy shell is left alone.
  ipcMain.handle('elpis:terminal:tui', guarded(async request => {
    const id = threadId(request.threadId);
    if (!id) return { error: 'This is not a chat id Elpis can resume.' };
    const command = tuiCommand(await environment());
    if (!command) return { error: 'The Elpis TUI (elpis) was not found. Install Elpis, or set ELPIS_TUI_BIN to its path.' };
    let session = sessions.get(request.key);
    if (!session || session.exited !== null) session = await start(request.key, request);
    if (path.basename(session.pty.process || session.shell) !== path.basename(session.shell)) {
      if (session.tui === id) return { running: true };
      return { error: 'This chat’s terminal is running a command. Finish it or press Ctrl+C, then try again.' };
    }
    session.tui = id;
    session.pty.write(`\x05\x15${command} resume ${id}\r`);
    return { started: true };
  }));
  ipcMain.handle('elpis:terminal:clipboard', async (event, text) => {
    if (!trusted(event)) return { error: 'Elpis application frame required' };
    if (typeof text === 'string') { await clipboard.writeText(text); return {}; }
    // Electron 44's main-process clipboard answers with a promise.
    return { text: String(await clipboard.readText() ?? '') };
  });
  const input = (event, key, data) => { if (trusted(event) && typeof data === 'string') sessions.get(key)?.pty.write(data); };
  const resize = (event, key, cols, rows) => {
    const session = sessions.get(key);
    if (trusted(event) && session && session.exited === null) session.pty.resize(size(cols, 80), size(rows, 24));
  };
  ipcMain.on('elpis:terminal:input', input);
  ipcMain.on('elpis:terminal:resize', resize);
  return () => {
    for (const name of ['open', 'restart', 'close', 'tui', 'clipboard']) ipcMain.removeHandler(`elpis:terminal:${name}`);
    ipcMain.removeListener('elpis:terminal:input', input);
    ipcMain.removeListener('elpis:terminal:resize', resize);
    const all = [...sessions.values()]; sessions.clear();
    for (const session of all) { if (session.timer) clearTimeout(session.timer); session.pty.kill(); }
  };
}

module.exports = { registerTerminal };
