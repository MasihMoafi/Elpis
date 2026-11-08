'use strict';
// Actual PTY and native history: delivered steers require an explicit whole-turn rewind.
import type { ChildProcessByStdio } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import type { ProviderApi } from './lib/mock-provider.cts';

type Socket = {
  readyState: number;
  once(event: 'open', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'open' | 'close', listener: () => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
};
type SocketServer = {
  once(event: 'listening', listener: () => void): void;
  on(event: 'connection', listener: (socket: Socket) => void): void;
  address(): AddressInfo | string | null;
  close(): void;
};
type SocketModule = { new (address: string): Socket; WebSocketServer: new (options: { host: string; port: number }) => SocketServer };
type Request = { id?: number; method?: string; error?: { message: string }; result?: unknown; params: { threadId: string } };
type Waiter = { resolve: (result: unknown) => void; reject: (error: Error) => void };
type Turn = { status: string; items: { type: string; content: { type: string; text: string }[] }[] };
type TurnPage = { data: Turn[] };
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawn, execFileSync }: typeof import('node:child_process') = require('node:child_process');
const WebSocket: SocketModule = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message, call }: ProviderApi = require('./lib/mock-provider.cts');
const binaryArg = process.argv[2];
assert(binaryArg && path.isAbsolute(binaryArg), 'absolute native binary required');
const binary = binaryArg;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-steer-rewind-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'work');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const socket = `rewind-${path.basename(root)}`;
const tm = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${String(value).replaceAll("'", "'\\''")}'`;
const capture = () => tm('capture-pane', '-p', '-t', 'test');
const shot = (name: string) => { const value = capture(); fs.writeFileSync(path.join(root, `${name}.txt`), value); return value; };
const key = (value: string) => tm('send-keys', '-t', 'test', value);
const type = (value: string) => tm('send-keys', '-t', 'test', '-l', value);
const composer = (screen: string) => screen.slice(screen.lastIndexOf('\n› ')).trimEnd();
async function waitFor<T>(check: () => T | Promise<T>, label: string, timeout = 20000): Promise<Exclude<Awaited<T>, false | null | undefined>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value as Exclude<Awaited<T>, false | null | undefined>; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
const provider = new Provider();
let server: ChildProcessByStdio<null, Readable, Readable> | undefined, proxy: SocketServer, observer: Socket;
const connections = new Set<Socket>(), requests: Request[] = [], checks: string[] = [];
const initial = 'INITIAL_REWIND_INSTRUCTION_7b1', steer = 'DELIVERED_STEER_INSTRUCTION_8c2';
function pass(name: string) { checks.push(name); console.log(`PASS ${name}`); }
async function main() {
  await provider.start();
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Local rewind fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  const env = { ...process.env, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, TERM: 'xterm-256color' };
  server = spawn(binary, ['app-server', '--listen', 'ws://127.0.0.1:0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const output = (chunk: Buffer) => { log += chunk; fs.appendFileSync(path.join(root, 'server.log'), chunk); };
  server.stdout.on('data', output); server.stderr.on('data', output);
  const remote = await waitFor(() => log.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0], 'native server address');
  observer = new WebSocket(remote); await new Promise<void>((resolve, reject) => { observer.once('open', resolve); observer.once('error', reject); });
  let serial = 0; const pending = new Map<number | undefined, Waiter>();
  observer.on('message', raw => { const msg: Request = JSON.parse(String(raw)), entry = pending.get(msg.id); if (entry) { pending.delete(msg.id); msg.error ? entry.reject(Error(msg.error.message)) : entry.resolve(msg.result); } });
  const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); observer.send(JSON.stringify({ id, method, params })); });
  await rpc('initialize', { clientInfo: { name: 'rewind-evidence', version: '1' }, capabilities: { experimentalApi: true } });
  observer.send(JSON.stringify({ method: 'initialized' }));
  proxy = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => proxy.once('listening', resolve));
  proxy.on('connection', downstream => {
    const upstream = new WebSocket(remote), queue: string[] = []; connections.add(downstream); connections.add(upstream);
    upstream.on('open', () => queue.splice(0).forEach(value => upstream.send(value)));
    downstream.on('message', raw => { const value = String(raw); requests.push(JSON.parse(value)); upstream.readyState === 1 ? upstream.send(value) : queue.push(value); });
    upstream.on('message', raw => { if (downstream.readyState === 1) downstream.send(String(raw)); });
    downstream.on('close', () => upstream.close());
  });
  const command = ['env', `HOME=${home}`, `ELPIS_HOME=${home}`, `CODEX_HOME=${home}`, `CODEX_AUTH_HOME=${home}`, 'TERM=xterm-256color', binary, '--remote', `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}`, '--no-alt-screen', '-C', cwd].map(quote).join(' ');
  tm('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '110', '-y', '38', command);
  await waitFor(() => {
    const screen = capture();
    if (screen.includes('Hooks need review')) { key('Escape'); return false; }
    return /gpt-5[.]5/i.test(screen) && screen.includes('› ');
  }, 'TUI startup');
  shot('startup');
  const ready = path.join(root, 'held-ready'), release = path.join(root, 'held-release');
  const python = `from pathlib import Path; import time; Path(${JSON.stringify(ready)}).write_text('ready')\nwhile not Path(${JSON.stringify(release)}).exists(): time.sleep(.02)`;
  provider.actions.push(call('rewind-held-tool', 'exec_command', { cmd: `python3 -c ${quote(python)}`, yield_time_ms: 10000 }), message('REWIND_COMPLETED_REPLY_9d3'));
  type(initial); await pause(250); key('Enter');
  await waitFor(() => fs.existsSync(ready), 'native tool is held');
  type(steer); await pause(250); key('Enter');
  await waitFor(() => requests.some(req => req.method === 'turn/steer' && JSON.stringify(req.params).includes(steer)), 'steer accepted through native RPC');
  shot('pending-steer'); fs.writeFileSync(release, 'release');
  await waitFor(() => capture().includes('REWIND_COMPLETED_REPLY_9d3') && !capture().includes('esc to interrupt'), 'turn completion');
  const tid = (requests.find(req => req.method === 'turn/start') as Request).params.threadId;
  const page = (await rpc('thread/turns/list', { threadId: tid, limit: 10, sortDirection: 'desc', itemsView: 'full' })) as TurnPage;
  fs.writeFileSync(path.join(root, 'persisted-turns-before.json'), JSON.stringify(page, null, 2));
  const users = (turn: Turn) => turn.items.filter(item => item.type === 'userMessage').map(item => item.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
  const owning = page.data.find(turn => users(turn).includes(initial) && users(turn).includes(steer));
  assert(owning && owning.status !== 'inProgress', 'initial prompt and delivered steer must be in ONE completed persisted turn');
  pass('persisted initial prompt and delivered steer belong to the same completed native turn');
  const openChoice = async () => {
    key('Escape'); await pause(150); key('Escape'); await pause(250); key('Enter');
    const screen = await waitFor(() => { const value = capture(); return /Rewind this entire turn\?|cannot be edited independently/.test(value) && value; }, 'whole-turn choice or explicit existing steer rejection');
    shot('rewind-choice');
    assert(!screen.includes('cannot be edited independently'), 'observed existing steer rejection instead of explicit whole-turn choice');
    assert(screen.includes('Rewind this entire turn?'), 'explicit whole-turn choice required');
  };
  const beforeDraft = composer(shot('before-rewind'));
  const beforeReverts = requests.filter(req => req.method === 'thread/revert').length;
  const beforeStarts = requests.filter(req => req.method === 'turn/start' && req.params?.threadId === tid).length;
  const beforeProviderRequests = provider.requests.length;
  await openChoice(); key('Escape'); await pause(400);
  assert.equal(requests.filter(req => req.method === 'thread/revert').length, beforeReverts, 'cancel issues no revert RPC');
  assert.equal(composer(shot('cancelled-rewind')), beforeDraft, 'cancel preserves the composer');
  const afterCancel = await rpc('thread/turns/list', { threadId: tid, limit: 10, sortDirection: 'desc', itemsView: 'full' });
  assert.deepEqual(afterCancel, page, 'cancel preserves persisted history');
  pass('cancel leaves history and draft unchanged and issues no revert RPC');
  await openChoice(); key('Down'); await pause(150); key('Enter');
  await waitFor(() => { const text = composer(capture()); return text.includes(initial) && text.includes(steer); }, 'merged whole-turn editable draft');
  shot('accepted-rewind');
  assert.equal(requests.filter(req => req.method === 'thread/revert').length, beforeReverts + 1, 'accept uses one native revert RPC');
  assert.equal(requests.filter(req => req.method === 'turn/start' && req.params?.threadId === tid).length, beforeStarts, 'accepted rewind does not start a new conversation turn');
  assert.equal(provider.requests.length, beforeProviderRequests, 'accepted rewind does not send the restored draft');
  pass('accepted whole-turn rewind restores both user instructions as an editable draft without sending');
}
main().then(() => { console.log(`Evidence: ${root}`); }).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { shot('final-screen'); } catch {}
  fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(root, 'provider-requests.json'), JSON.stringify(provider.requests, null, 2));
  fs.writeFileSync(path.join(root, 'checks.json'), JSON.stringify({ root, binary, checks, exitCode: process.exitCode ?? 0 }, null, 2));
  console.log(`Evidence: ${root}`);
  try { tm('kill-server'); } catch {}
  observer?.terminate(); for (const socket of connections) socket.terminate(); proxy?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); const running = server; await Promise.race([new Promise<void>(resolve => running.once('exit', () => resolve())), pause(3000).then(() => running.kill('SIGKILL'))]); }
  provider.close();
});
