'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { trustedBrowserSender } = require('./browser-policy.cjs');

/** A second process owns the candidate build, its own Electron state and its own Elpis runtime. */
async function tryImprovement(row, { executable = process.execPath, env = process.env, launch = spawn } = {}) {
  const candidate = path.join(row.cwd, 'apps/elpis-desktop');
  await fs.access(path.join(candidate, 'out/index.html'));
  const cache = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
  const profile = await fs.mkdtemp(path.join(cache, 'improve-preview-'));
  const home = path.join(profile, 'runtime'); await fs.mkdir(home, { mode: 0o700 });
  const auth = path.join(env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'), 'auth.json');
  try { await fs.copyFile(auth, path.join(home, 'auth.json')); await fs.chmod(path.join(home, 'auth.json'), 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const childEnv = { ...env, ELPIS_HOME: home, ELPIS_DESKTOP_PROFILE: path.join(profile, 'desktop'), ELPIS_IMPROVE_HOME: path.join(profile, 'changes'), ELPIS_SOURCE_REPO: row.cwd };
  for (const key of ['ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELPIS_SHARED_BRIDGE', 'ACP_BRIDGE_STORE', 'ELECTRON_RUN_AS_NODE']) delete childEnv[key];
  const child = launch(executable, [candidate], { cwd: candidate, env: childEnv, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  // The private bridge exits after 30 seconds idle. Let it close before trashing its isolated store and credentials.
  child.once('exit', () => { setTimeout(() => { const trash = spawn('gio', ['trash', profile], { stdio: 'ignore' }); trash.on('error', () => {}); }, 35000).unref(); });
  child.unref();
  return { opened: true };
}
function regionRect(bounds, viewport) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw Error('Choose a visible region');
  const x = Math.max(0, Math.floor(bounds.x)), y = Math.max(0, Math.floor(bounds.y));
  const width = Math.min(Math.ceil(bounds.width), viewport.width - x), height = Math.min(Math.ceil(bounds.height), viewport.height - y);
  if (width < 1 || height < 1 || bounds.width < 1 || bounds.height < 1) throw Error('Choose a visible region');
  return { x, y, width, height };
}
function registerImprove({ host, origin, ipcMain, improvements }) {
  const guard = event => { if (!trustedBrowserSender(event, host.webContents, origin)) throw Error('Elpis application frame required'); };
  ipcMain.handle('elpis:improve:capture', async (event, bounds) => {
    guard(event);
    // DOM rectangles are CSS pixels; capturePage takes device-independent window pixels, including zoom.
    const zoom = host.webContents.getZoomFactor();
    const rect = regionRect(Object.fromEntries(Object.entries(bounds ?? {}).map(([key, value]) => [key, value * zoom])), host.getContentBounds());
    return { image: (await host.webContents.capturePage(rect)).toDataURL() };
  });
  ipcMain.handle('elpis:improve:try', async (event, id) => { guard(event); return tryImprovement(await (await improvements()).verified(id)); });
  return () => { ipcMain.removeHandler('elpis:improve:capture'); ipcMain.removeHandler('elpis:improve:try'); };
}
module.exports = { registerImprove, tryImprovement, regionRect };
