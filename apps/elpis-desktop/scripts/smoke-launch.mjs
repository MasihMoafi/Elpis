#!/usr/bin/env node
// smoke-launch.mjs PACKAGE_DIR: opens an installed package for real, with its own launcher, a throwaway Elpis home and profile and a
// virtual screen, and waits until its window shows the app, connected to its engine. The install runs this before it switches
// `elpis-app` to a new package (22 Oct: two installs shipped a package Elpis could not open; no test started the real thing).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

/** What the page says about itself: loading, the start-up screen still up, the app up but not connected, or ready. */
const STATE = `(() => {
  if (!document.querySelector('aside.sidebar')) return 'loading';
  if (document.querySelector('.startup-splash')) return 'starting';
  return document.querySelector('.status-dot.connected') ? 'ready' : 'not connected';
})()`;

const within = (ms, work) => Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

async function pageState(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json());
  const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url));
  if (!page) return 'no window';
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await within(2000, new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }));
    return await within(3000, new Promise((resolve, reject) => {
      socket.once('message', data => { const reply = JSON.parse(data); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result?.result?.value ?? 'unknown'); });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: STATE, returnByValue: true } }));
    }));
  } finally { socket.terminate(); }
}

/** Resolves when the package's window is ready; rejects with what the app printed if it exits, or never gets there. */
export async function smokeLaunch(packageDir, { timeoutMs = 90_000 } = {}) {
  const launcher = path.join(packageDir, 'launch');
  if (!fs.existsSync(launcher)) throw new Error(`${launcher} does not exist.`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-smoke-'));
  const screen = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  let app, output = '';
  try {
    const display = await new Promise((resolve, reject) => { screen.stdio[3].once('data', data => resolve(`:${data.toString().trim()}`)); screen.once('error', () => reject(new Error('Xvfb is needed for the launch check and could not start.'))); screen.once('exit', code => reject(new Error(`Xvfb exited ${code}`))); });
    const port = await freePort();
    const env = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', ELPIS_HOME: path.join(scratch, 'home'), ELPIS_DESKTOP_PROFILE: path.join(scratch, 'profile') };
    delete env.WAYLAND_DISPLAY;
    app = spawn(launcher, ['--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    for (const stream of [app.stdout, app.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-3000); });
    let exited = null; app.once('exit', code => { exited = code; });
    const until = Date.now() + timeoutMs;
    let last = 'no window';
    while (Date.now() < until) {
      if (exited !== null) throw new Error(`The app exited with code ${exited} before it opened.\n${output.trim()}`);
      if (/Elpis startup failed|Elpis could not open/.test(output)) throw new Error(`The app reports it could not start.\n${output.trim()}`);
      last = await pageState(port).catch(() => 'no window');
      if (last === 'ready') return;
      await sleep(500);
    }
    throw new Error(`The app did not reach a connected window in ${timeoutMs / 1000} s (last state: ${last}).\n${output.trim()}`);
  } finally {
    if (app?.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    screen.kill();
    execFileSync('gio', ['trash', scratch], { stdio: 'ignore' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) try {
  if (!process.argv[2]) throw new Error('usage: node scripts/smoke-launch.mjs PACKAGE_DIR');
  const wait = process.argv.find(arg => arg.startsWith('--timeout='));
  await smokeLaunch(path.resolve(process.argv[2]), wait ? { timeoutMs: Number(wait.slice('--timeout='.length)) * 1000 } : {});
  console.log('The package opens and connects.');
} catch (error) {
  console.error(`smoke-launch: ${error.message}`);
  process.exitCode = 1;
}
