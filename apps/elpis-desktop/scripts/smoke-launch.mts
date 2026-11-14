#!/usr/bin/env node
// smoke-launch.mts PACKAGE_DIR: opens an installed package for real, with its own launcher, a throwaway Elpis home and profile and a
// virtual screen, and waits until its window shows the app, connected to its engine. The install runs this before it switches
// `elpis-app` to a new package (22 Oct: two installs shipped a package Elpis could not open; no test started the real thing).
// The desktop packages workflow (.github/workflows/desktop-packages.yml) runs it on the built AppImage and .deb:
//   node scripts/smoke-launch.mts --launcher=FILE [--evidence=DIR] [--sandbox] [--timeout=S]
// --launcher starts FILE instead of PACKAGE_DIR/launch; --evidence saves a screenshot of the window, its text, the app's
// output and its Elpis home there; --sandbox keeps Chromium's sandbox on, as a user's start does.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const wsModule = 'ws';
const { default: WebSocket } = await import(wsModule);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise<number>((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('No TCP address')); return; } server.close(() => resolve(address.port)); }); });

/** What the page says about itself: loading, the start-up screen still up, the app up but not connected, or ready. */
const STATE = `(() => {
  if (!document.querySelector('aside.sidebar')) return 'loading';
  if (document.querySelector('.startup-splash')) return 'starting';
  // The banner of the AppImage catalog's test of v0.5.3 ("Elpis is disconnected. Reconnecting to Elpis…"): never ready while it shows.
  if (/Elpis is disconnected/.test(document.body.innerText)) return 'not connected';
  return document.querySelector('.status-dot.connected') ? 'ready' : 'not connected';
})()`;

const within = <T,>(ms: number, work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

/** What a DevTools call answers: a screenshot (data) or an evaluated value (result.value). */
type DevtoolsResult = { data?: string; result?: { value?: unknown } };

/** One DevTools call on the app's page; undefined while there is no page. */
async function pageCall(port: number, method: string, params: object, ms = 3000): Promise<DevtoolsResult | undefined> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url));
  if (!page) return undefined;
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await within(2000, new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }));
    return await within(ms, new Promise<DevtoolsResult>((resolve, reject) => {
      socket.once('message', (data: Buffer) => { const reply = JSON.parse(data.toString()); if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result); });
      socket.send(JSON.stringify({ id: 1, method, params }));
    }));
  } finally { socket.terminate(); }
}

async function pageState(port: number) {
  const reply = await pageCall(port, 'Runtime.evaluate', { expression: STATE, returnByValue: true });
  if (!reply) return 'no window';
  const value = reply.result?.value;
  return typeof value === 'string' ? value : 'unknown';
}

/** The window as the person sees it, its text, the app's output and its Elpis home, saved in DIR; never fails the check. */
async function saveEvidence(dir: string, port: number | undefined, output: string, home: string, state: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.txt'), `${state}\n`);
    fs.writeFileSync(path.join(dir, 'app-output.txt'), output);
    if (port) {
      const shot = await pageCall(port, 'Page.captureScreenshot', { format: 'png' }, 10_000).catch(() => undefined);
      if (shot?.data) fs.writeFileSync(path.join(dir, 'window.png'), Buffer.from(shot.data, 'base64'));
      const text = await pageCall(port, 'Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }).catch(() => undefined);
      if (typeof text?.result?.value === 'string') fs.writeFileSync(path.join(dir, 'window.txt'), text.result.value);
    }
    if (fs.existsSync(home)) fs.cpSync(home, path.join(dir, 'elpis-home'), { recursive: true, filter: source => !fs.lstatSync(source).isSocket() });
  } catch (error) { console.error(`smoke-launch: evidence incomplete: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Resolves when the package's window is ready; rejects with what the app printed if it exits, or never gets there. */
export async function smokeLaunch(packageDir: string, { timeoutMs = 90_000, launcher = path.join(packageDir, 'launch'), evidence = '', sandbox = false } = {}) {
  if (!fs.existsSync(launcher)) throw new Error(`${launcher} does not exist.`);
  // In the home cache, not /tmp: gio trash refuses folders on /tmp here (2 Nov).
  const cache = path.join(os.homedir(), '.cache', 'elpis-smoke'); fs.mkdirSync(cache, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(cache, 'run-'));
  const home = path.join(scratch, 'home');
  const screen = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  let app: ReturnType<typeof spawn> | undefined, output = '', port: number | undefined, last = 'no window';
  try {
    const display = await new Promise<string>((resolve, reject) => { screen.stdio[3]!.once('data', data => resolve(`:${data.toString().trim()}`)); screen.once('error', () => reject(new Error('Xvfb is needed for the launch check and could not start.'))); screen.once('exit', code => reject(new Error(`Xvfb exited ${code}`))); });
    port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: display, XDG_SESSION_TYPE: 'x11', ELECTRON_OZONE_PLATFORM_HINT: 'x11', ELPIS_HOME: home, ELPIS_DESKTOP_PROFILE: path.join(scratch, 'profile') };
    delete env.WAYLAND_DISPLAY;
    app = spawn(launcher, [...(sandbox ? [] : ['--no-sandbox']), '--ozone-platform=x11', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    for (const stream of [app.stdout, app.stderr]) stream!.on('data', chunk => { output = (output + chunk).slice(-3000); });
    let exited: number | null = null; app.once('exit', code => { exited = code; });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (exited !== null) throw new Error(`The app exited with code ${exited} before it opened.\n${output.trim()}`);
      if (/Elpis startup failed|Elpis could not open/.test(output)) throw new Error(`The app reports it could not start.\n${output.trim()}`);
      last = await pageState(port).catch(() => 'no window');
      if (last === 'ready') {
        // Connected once is not enough: an engine that dies at once brings the banner back a moment later.
        await sleep(5000);
        last = await pageState(port).catch(() => 'no window');
        if (last === 'ready') return;
      }
      await sleep(500);
    }
    throw new Error(`The app did not reach a connected window in ${timeoutMs / 1000} s (last state: ${last}).\n${output.trim()}`);
  } finally {
    if (evidence) await saveEvidence(evidence, port, output, home, last);
    if (app?.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    screen.kill();
    // GitHub's runners may lack gio; their scratch goes with the runner.
    try { execFileSync('gio', ['trash', scratch], { stdio: 'ignore' }); } catch { /* Left in ~/.cache/elpis-smoke. */ }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) try {
  const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const wait = flag('timeout'), launcher = flag('launcher'), evidence = flag('evidence');
  const packageDir = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (!packageDir && !launcher) throw new Error('usage: node scripts/smoke-launch.mts PACKAGE_DIR | --launcher=FILE [--evidence=DIR] [--sandbox] [--timeout=S]');
  await smokeLaunch(path.resolve(packageDir ?? path.dirname(launcher!)), {
    ...(wait ? { timeoutMs: Number(wait) * 1000 } : {}),
    ...(launcher ? { launcher: path.resolve(launcher) } : {}),
    ...(evidence ? { evidence: path.resolve(evidence) } : {}),
    sandbox: process.argv.includes('--sandbox'),
  });
  console.log('The package opens and connects.');
} catch (error) {
  console.error(`smoke-launch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
