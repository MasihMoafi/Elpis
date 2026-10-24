// Runs only a copy of the bridge with an isolated synthetic home and deterministic native engine.
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const root = process.env.ELPIS_SPEED_ROOT || path.join(os.homedir(), '.cache/elpis-briefs/cc');
const source = process.env.ELPIS_SPEED_BRIDGE_SOURCE || fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(source, 'package.json'));
const WebSocket = require('ws');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const thread = { id: 'speed-chat', name: 'Synthetic large Claude chat', cwd: root, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, source: 'cli', modelProvider: 'openai' };

if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line), send = value => process.stdout.write(JSON.stringify(value) + '\n');
    if (msg.id === undefined) return;
    if (msg.method === 'fixture/deltas') {
      for (let i = 0; i < msg.params.count; i++) send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: 'live', itemId: 'reply', delta: `token-${i} ` } });
    }
    let result = {};
    if (['thread/read', 'thread/resume'].includes(msg.method)) result = { thread: { ...thread, turns: [] }, approvalPolicy: 'on-request', model: 'gpt-5.5' };
    if (['thread/items/list', 'thread/turns/list'].includes(msg.method)) result = { data: [], nextCursor: null, backwardsCursor: null };
    if (msg.method === 'thread/list') result = { data: [thread], nextCursor: null };
    if (msg.method === 'config/read') result = { config: { features: { multi_agent: false } } };
    send({ id: msg.id, result });
  });
} else test('large bridge store reads stay cheap and observe replacement, concurrent saves and corruption', { timeout: 90000 }, async t => {
  const label = process.env.ELPIS_SPEED_LABEL || 'bridge-baseline';
  fs.mkdirSync(path.join(root, 'speed-evidence'), { recursive: true });
  const home = fs.mkdtempSync(path.join(root, `speed-bridge-${label}-`)), bundle = path.join(home, 'bundle');
  fs.mkdirSync(bundle, { recursive: true });
  for (const file of fs.readdirSync(source).filter(f => f.endsWith('.mjs') || f === 'package.json')) fs.copyFileSync(path.join(source, file), path.join(bundle, file));
  if (!fs.existsSync(path.join(bundle, 'node_modules'))) fs.symlinkSync(path.join(source, 'node_modules'), path.join(bundle, 'node_modules'));
  const engine = path.join(home, 'engine.mjs');
  fs.writeFileSync(engine, `#!${process.execPath}\nimport ${JSON.stringify(import.meta.url)};\n`, { mode: 0o755 });
  const store = path.join(home, 'sessions.json');
  const turns = Array.from({ length: 600 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', startedAt: i + 1, items: [
    { id: `user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${i}: ` + 'Explain parser positions and Unicode behavior. '.repeat(100) }] },
    { id: `reason-${i}`, type: 'reasoning', summary: ['Check boundaries and malformed input. '.repeat(200)] },
    { id: `tool-${i}`, type: 'commandExecution', status: 'completed', aggregatedOutput: 'PASS src/parser.test.ts nested expressions\n'.repeat(1200) },
    { id: `diff-${i}`, type: 'fileChange', status: 'completed', changes: [{ path: 'src/parser.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n'.repeat(100) }] },
    { id: `reply-${i}`, type: 'agentMessage', text: `Answer ${i}: ` + 'The parser preserves Unicode offsets and incomplete source. '.repeat(500) },
  ] }));
  fs.writeFileSync(store, JSON.stringify({ [thread.id]: { model: 'claude/haiku', providerHistory: true, thread, turns } }));
  const child = spawn(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${path.join(root, 'speed-evidence')}`, `--cpu-prof-name=${label}.cpuprofile`, path.join(bundle, 'acp-bridge.mjs')], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home,
      CODEX_AUTH_HOME: home, XDG_RUNTIME_DIR: home, TMPDIR: home, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: store,
      ACP_BRIDGE_LOG: path.join(home, 'bridge.log'), PORT: '0', ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1' },
  });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
    await stopped; clearTimeout(timer);
  });
  const deadline = Date.now() + 15000;
  const log = path.join(home, 'bridge.log');
  while ((!fs.existsSync(log) || !/LISTENING/.test(fs.readFileSync(log, 'utf8'))) && Date.now() < deadline) await pause(20);
  if (!fs.existsSync(log)) throw Error(stderr);
  const port = fs.readFileSync(log, 'utf8').match(/LISTENING (\d+)/)?.[1];
  if (!port) throw Error(fs.readFileSync(log, 'utf8') + stderr);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 100 * 1024 * 1024 });
  await once(socket, 'open');
  const pending = new Map(); let sequence = 0, deltas = 0;
  socket.on('message', wire => { const msg = JSON.parse(String(wire)); if (msg.method === 'item/agentMessage/delta') deltas++; const next = pending.get(msg.id); if (next) { pending.delete(msg.id); clearTimeout(next.timer); next.resolve(msg); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error(`Timeout: ${method}`)), 15000);
    pending.set(id, { resolve, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
  const cpu = () => { const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(stat[11]) + Number(stat[12])) * 1000 / ticksPerSecond; };
  const report = { label, bytes: fs.statSync(store).size, pid: child.pid, phases: {} };
  const phase = async (name, action) => { const at = performance.now(), before = cpu(); await action(); const ms = performance.now() - at; report.phases[name] = { ms, cpuMs: cpu() - before }; console.log(name, JSON.stringify(report.phases[name])); };
  try {
    await call('initialize', { clientInfo: { name: 'isolated-speed-profile', version: '1' }, capabilities: {} });
    await phase('resume', () => call('thread/resume', { threadId: thread.id, excludeTurns: true }));
    await phase('reads', async () => { for (let i = 0; i < 20; i++) await call('thread/read', { threadId: thread.id, includeTurns: false }); });
    await phase('pages', async () => { for (let i = 0; i < 20; i++) await call('thread/items/list', { threadId: thread.id, limit: 100, sortDirection: 'desc' }); });
    await phase('lists', async () => { for (let i = 0; i < 20; i++) await call('thread/list', { limit: 100 }); });
    await phase('deltas', () => call('fixture/deltas', { count: 1000 }));
    report.deltas = deltas;
    await phase('saves', async () => {
      for (let i = 0; i < 3; i++) await call('config/batchWrite', { edits: [{ keyPath: 'model', value: 'claude/haiku' }, { keyPath: 'model_reasoning_effort', value: i % 2 ? 'low' : 'high' }] });
      await call('thread/items/list', { threadId: thread.id, limit: 1 }); // wait for queued saves to finish
    });
    await phase('idle', () => pause(10_000));
    report.idleCpuPercent = report.phases.idle.cpuMs / report.phases.idle.ms * 100;
    assert.equal(deltas, 1000, 'all delta notifications are forwarded');
    // An independent writer replaces the file; a warm cache must not serve the removed history.
    fs.writeFileSync(store + '.replacement', JSON.stringify({ [thread.id]: { model: 'claude/haiku', providerHistory: true, thread, turns: [] }, outside: { note: 'preserve independently saved data' } }));
    fs.renameSync(store + '.replacement', store);
    const empty = await call('thread/items/list', { threadId: thread.id, limit: 100 });
    assert.deepEqual(empty.result.data, [], 'file replacement invalidates cached history');
    await Promise.all([
      call('config/batchWrite', { edits: [{ keyPath: 'model', value: 'claude/haiku' }] }),
      call('config/batchWrite', { edits: [{ keyPath: 'model', value: 'claude/sonnet' }, { keyPath: 'model_reasoning_effort', value: 'high' }] }),
    ]);
    await call('thread/items/list', { threadId: thread.id, limit: 100 }); // waits for the store queue
    assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).outside.note, 'preserve independently saved data');
    assert.equal(JSON.parse(fs.readFileSync(store, 'utf8'))._default.model, 'claude/sonnet');
    fs.writeFileSync(store, 'not valid json');
    const corrupt = await call('thread/items/list', { threadId: thread.id, limit: 100 });
    assert.ok(corrupt.error, 'corruption must not be hidden by a stale snapshot');
    await t.test('repeated read CPU budget', () => assert.ok(report.phases.reads.cpuMs < 500, `${report.phases.reads.cpuMs} ms CPU >= 500 ms`));
    await t.test('repeated item-page CPU budget', () => assert.ok(report.phases.pages.cpuMs < 1000, `${report.phases.pages.cpuMs} ms CPU >= 1000 ms`));
    await t.test('repeated list CPU budget', () => assert.ok(report.phases.lists.cpuMs < 500, `${report.phases.lists.cpuMs} ms CPU >= 500 ms`));
  } finally {
    socket.close(); child.kill('SIGTERM'); await once(child, 'exit');
    report.stderr = stderr;
    fs.writeFileSync(path.join(root, 'speed-evidence', `${label}.json`), JSON.stringify(report, null, 2));
    console.log('BRIDGE', JSON.stringify(report));
  }
});
