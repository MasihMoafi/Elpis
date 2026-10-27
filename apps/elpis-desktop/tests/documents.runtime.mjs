// Real packaged Electron main/preload/renderer and engine, with no model turn or user profile.
// node tests/documents.runtime.mjs /absolute/package/app /absolute/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { DesktopClient } from '../bridge/client.mjs';
import { callBrowser } from '../bridge/browser-mcp.mjs';

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, openSettings } = require('./controls.cjs');
const appRoot = process.argv[2], binary = process.argv[3];
assert(appRoot && path.isAbsolute(appRoot) && binary && path.isAbsolute(binary), 'Give the packaged app directory and real engine executable.');
const evidenceBase = path.join(os.homedir(), '.cache/elpis-tests');
await fs.mkdir(evidenceBase, { recursive: true });
const evidence = process.env.ELPIS_DOCUMENT_EVIDENCE || await fs.mkdtemp(path.join(evidenceBase, 'documents-runtime-'));
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eldoc-'));
const home = path.join(root, 'home'), config = path.join(root, 'config'), profile = path.join(config, 'Elpis');
const folder = path.join(root, 'Project with spaces'), otherFolder = path.join(root, 'Other project');
for (const directory of [home, config, folder, otherFolder]) await fs.mkdir(directory);
const file = path.join(folder, 'shared notes.md'), original = '# Shared notes\nOriginal saved text.\n';
await fs.writeFile(file, original);
await fs.copyFile(new URL('../../../codex-rs/models-manager/models.json', import.meta.url), path.join(home, 'models.json'));
await fs.writeFile(path.join(home, 'hooks.json'), '{}');
let inferenceRequests = 0;
const provider = http.createServer((_request, response) => { inferenceRequests++; response.writeHead(503); response.end('No inference is allowed in this document journey.'); });
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="never"\nsandbox_mode="danger-full-access"\ncheck_for_update_on_startup=false\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Offline document check"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(folder)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(otherFolder)}]\ntrust_level="trusted"\n`);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch (error) { if (Date.now() >= deadline) throw error; }
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`);
    await wait(75);
  }
}
async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode) return;
  const exited = once(process, 'exit').catch(() => {});
  process.kill('SIGTERM');
  await Promise.race([exited, wait(1500)]);
  if (process.exitCode === null && !process.signalCode) { process.kill('SIGKILL'); await exited; }
}
const socket = path.join(root, 'runtime.sock');
const environment = { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, LANG: 'C.UTF-8', XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state') };
let runtime, xvfb, client, desktop, page, engineRpcSocket, display, engineLogs = '', displayLogs = '', failed;
const enginePending = new Map();
const checks = [], pageErrors = [];
const check = async (name, operation) => { await operation(); checks.push(name); console.log(`PASS ${name}`); };
// CDP screenshots crop Electron's 1.1 zoom to CSS pixels. Capture the actual private display instead.
const screenshot = async name => {
  const { x, y, width, height } = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.isDestroyed()).getContentBounds());
  await wait(150);
  execFileSync('python3', ['-c', `from PIL import ImageGrab; ImageGrab.grab(xdisplay=${JSON.stringify(display)}).crop((${x},${y},${x + width},${y + height})).save(${JSON.stringify(path.join(evidence, `${name}.png`))})`]);
};
try {
  runtime = spawn(binary, ['app-server', '--listen', `unix://${socket}`], { cwd: folder, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  runtime.stdout.on('data', chunk => { engineLogs += chunk; }); runtime.stderr.on('data', chunk => { engineLogs += chunk; });
  await until(async () => { if (runtime.exitCode !== null) throw Error(engineLogs || `Engine exited ${runtime.exitCode}`); return fs.stat(socket); }, 'real engine socket');
  await fs.chmod(socket, 0o600);
  const engineSocket = await fs.realpath(socket);
  client = await DesktopClient.connect({ socketPath: engineSocket, home });
  const first = (await client.createThread({ cwd: folder, name: 'Document check A' })).thread;
  const second = (await client.createThread({ cwd: otherFolder, name: 'Document check B' })).thread;
  client.close(); client = null;

  xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  xvfb.stderr.on('data', chunk => { displayLogs += chunk; });
  display = await new Promise((resolve, reject) => {
    let value = ''; const timer = setTimeout(() => reject(Error('Private display startup timed out.')), 10000);
    xvfb.once('error', error => { clearTimeout(timer); reject(error); });
    xvfb.once('exit', code => { clearTimeout(timer); reject(Error(`Private display exited ${code}: ${displayLogs}`)); });
    xvfb.stdio[3].on('data', chunk => { value += chunk; if (value.includes('\n')) { clearTimeout(timer); resolve(`:${value.trim()}`); } });
  });
  desktop = await _electron.launch({ executablePath: path.resolve(appRoot, '../runtime/electron/electron'), args: [appRoot, '--disable-gpu', '--ozone-platform=x11', '--open-thread', first.id], cwd: appRoot,
    env: { ...environment, DISPLAY: display, TMPDIR: root, ELPIS_DESKTOP_PROFILE: profile, ELPIS_NODE_BIN: process.execPath, ELPIS_APP_BRIDGE_SOCKET: engineSocket }, timeout: 30000 });
  page = await desktop.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 15000 });
  const profilePrompt = page.getByRole('button', { name: 'Not now', exact: true });
  await profilePrompt.waitFor(); await profilePrompt.click(); await profilePrompt.waitFor({ state: 'hidden' });
  const connectionFile = path.join(profile, 'browser-connection.json');
  let connection, capability;
  await until(async () => {
    connection = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
    capability = Object.keys(connection.scopes).find(token => connection.scopes[token] === first.id);
    return capability;
  }, 'thread-scoped native tool capability');
  const tool = (name, args, threadId = first.id) => callBrowser(connection.socketPath, name, args, capability, threadId);
  const editor = () => page.locator('.files-pane textarea.fe-text');
  const activeThread = id => until(async () => (await page.evaluate(() => window.elpisDesktop.browser.command('state'))).sessionId === id, 'native selected chat');
  await activeThread(first.id);

  const WebSocket = require('ws'); let rpcId = 0;
  engineRpcSocket = new WebSocket(`ws+unix://${engineSocket}:/`);
  await new Promise((resolve, reject) => { engineRpcSocket.once('open', resolve); engineRpcSocket.once('error', reject); });
  engineRpcSocket.on('message', raw => {
    const message = JSON.parse(raw), handler = enginePending.get(message.id);
    if (handler) { enginePending.delete(message.id); message.error ? handler.reject(Error(message.error.message)) : handler.resolve(message.result); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++rpcId, timer = setTimeout(() => { enginePending.delete(id); reject(Error(`Timed out: ${method}`)); }, 35000);
    enginePending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    engineRpcSocket.send(JSON.stringify({ id, method, params }));
  });
  await rpc('initialize', { clientInfo: { name: 'documents-runtime-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  engineRpcSocket.send(JSON.stringify({ method: 'initialized', params: {} }));
  const agentTool = async (name, args) => {
    const result = await rpc('mcpServer/tool/call', { threadId: first.id, server: 'elpis_browser', tool: name, arguments: args });
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  await check('the real engine discovers both shared document MCP tools for the visible chat', async () => {
    const listed = await rpc('mcpServerStatus/list', { threadId: first.id, serverName: 'elpis_browser' });
    const server = listed.data.find(server => server.name === 'elpis_browser');
    assert(server?.tools.document_open, 'document_open is advertised to the engine');
    assert(server?.tools.document_read, 'document_read is advertised to the engine');
  });

  await check('native document tool opens the real file in the packaged editor', async () => {
    const result = await agentTool('document_open', { path: file });
    assert.equal(result.opened, true); assert.equal(result.path, file); assert.equal(result.unsavedChanges, false);
    await editor().waitFor(); assert.equal(await editor().inputValue(), original);
  });
  const saved = '# Elpis to the rescue\nSaved revision — متن فارسی و 保持文字.\n';
  await check('user save reaches disk and the agent reads the exact saved Unicode revision', async () => {
    await editor().fill(saved); await editor().press('Control+s');
    await until(async () => (await fs.readFile(file, 'utf8')) === saved, 'real editor save');
    await page.locator('.files-pane button[title="Save (Ctrl+S)"]').waitFor({ state: 'detached' });
    const result = await agentTool('document_read', { path: file });
    assert.equal(result.content, saved); assert.equal(result.unsavedChanges, false);
  });
  const draft = `${saved}\nUnfinished user revision — هنوز ذخیره نشده.\n`;
  await check('agent reopen preserves an unfinished draft and reads only the saved file', async () => {
    await editor().fill(draft);
    const opened = await tool('document_open', { path: file }); assert.equal(opened.unsavedChanges, true);
    assert.equal(await editor().inputValue(), draft);
    const read = await tool('document_read', { path: file }); assert.equal(read.content, saved); assert.equal(read.unsavedChanges, true);
    assert.equal(await fs.readFile(file, 'utf8'), saved);
  });
  await check('another chat folder shares the same real document draft and dirty status', async () => {
    // Empty native threads may be absent from Recents. Use the app's existing TUI/open-thread
    // entry point to select one without a model turn or reloading the renderer and its draft.
    await desktop.evaluate(({ app }, id) => app.emit('second-instance', {}, ['elpis', '--open-thread', id], '', { openThread: id }), second.id);
    await activeThread(second.id);
    const read = await tool('document_read', { path: file }, second.id); assert.equal(read.content, saved); assert.equal(read.unsavedChanges, true);
    assert.equal((await tool('document_open', { path: file }, second.id)).unsavedChanges, true);
    assert.equal(await editor().inputValue(), draft);
  });
  await check('a document request in Settings shows the chat or fails without claiming it opened', async () => {
    await openSettings(page); await page.getByRole('button', { name: 'Back to app', exact: true }).waitFor();
    let result;
    try { result = await tool('document_open', { path: file }, second.id); }
    catch (error) {
      assert.match(error.message, /visible|open.*chat|editor|shown/i);
      await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    }
    if (result) { assert.equal(result.opened, true); assert.equal(await editor().isVisible(), true); }
    assert.equal(await editor().inputValue(), draft);
  });
  await check('the shared document fits light, dark and a narrow packaged window', async () => {
    for (const theme of ['light', 'dark']) {
      const toggle = page.locator('aside.sidebar').getByRole('button', { name: `Use ${theme} theme`, exact: true });
      if (await toggle.count()) await chooseTheme(page, theme);
      assert.equal(await editor().isVisible(), true); await screenshot(`documents-${theme}`);
    }
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.isDestroyed()).setSize(820, 900));
    const closeSidebar = page.getByRole('button', { name: 'Close sidebar', exact: true });
    if (await closeSidebar.isVisible()) await closeSidebar.click();
    await editor().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the document must stay inside the narrow window');
    await screenshot('documents-dark-820');
    const openSidebar = page.getByRole('button', { name: 'Open sidebar', exact: true });
    if (await openSidebar.first().isVisible()) await openSidebar.first().click();
    await chooseTheme(page, 'light');
    if (await closeSidebar.isVisible()) await closeSidebar.click();
    await editor().waitFor(); await screenshot('documents-light-820');
  });
  await check('stale saves preserve user text and never overwrite an external saved revision', async () => {
    const external = '# External saved revision\nKept on disk.\n';
    await fs.writeFile(file, external); await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    await editor().press('Control+s');
    await page.locator('.files-pane').getByRole('alert').filter({ hasText: /changed on disk/ }).waitFor();
    assert.equal(await editor().inputValue(), draft); assert.equal(await fs.readFile(file, 'utf8'), external);
    const read = await tool('document_read', { path: file }, second.id);
    assert.equal(read.content, external); assert.equal(read.unsavedChanges, true);
    await screenshot('documents-stale-save');
  });
  await check('missing files and nonvisible chat requests fail without switching chats or losing edits', async () => {
    await assert.rejects(tool('document_open', { path: path.join(folder, 'missing.md') }, second.id), /existing|unavailable|file/i);
    await assert.rejects(tool('document_open', { path: file }, first.id), /open.*chat|window|shown/i);
    await activeThread(second.id);
    assert.equal(await editor().inputValue(), draft);
    assert.equal(inferenceRequests, 0, 'document tools must not start a model request');
    assert.deepEqual(pageErrors, []);
  });
} catch (error) {
  failed = error; console.error(`FAIL after ${checks.length} checks: ${error.stack || error}`);
  if (page) await screenshot('documents-failure').catch(() => {});
} finally {
  client?.close();
  for (const handler of enginePending.values()) handler.reject(Error('Document journey closed.'));
  enginePending.clear(); engineRpcSocket?.terminate();
  await stop(desktop?.process()); await desktop?.close().catch(() => {});
  await stop(runtime); await stop(xvfb);
  await new Promise(resolve => provider.close(resolve));
  await fs.writeFile(path.join(evidence, 'engine.log'), engineLogs);
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, error: failed?.message, pageErrors, inferenceRequests, appRoot, binary, root }, null, 2));
}
console.log(`${checks.length} checks passed; evidence ${evidence}; isolated profile ${root}`);
process.exitCode = failed ? 1 : 0;
