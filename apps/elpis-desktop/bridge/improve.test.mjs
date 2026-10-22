import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as exec } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { createImprovements } from './improve.mjs';
import { verifyImprovement } from './improve-check.mjs';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
const execFile = promisify(exec);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
const target = { id: 'button', label: 'Send', image: PNG };
const map = { button: { component: 'Composer', file: 'button.txt' } };
async function setup(t, checks = true) {
  const cache = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
  const root = createTestTempDir(path.join(cache, 'improve-'));
  t.after(async () => { removeTestTempDir(root); });
  const sourceRoot = path.join(root, 'source'); await fs.mkdir(sourceRoot);
  const git = (...args) => execFile('git', args, { cwd: sourceRoot });
  await git('init', '-q'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@invalid');
  await git('commit', '--allow-empty', '-qm', 'before desktop');
  await fs.mkdir(path.join(sourceRoot, 'apps/elpis-desktop'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'apps/elpis-desktop/package.json'), JSON.stringify({ name: 'elpis-desktop' }));
  await fs.writeFile(path.join(sourceRoot, 'button.txt'), 'Send\n'); await git('add', 'button.txt', 'apps/elpis-desktop/package.json'); await git('commit', '-qm', 'baseline');
  const client = new EventEmitter(); let created, sent;
  client.models = async () => ({ data: [{ model: 'gpt-6-luna' }] });
  client.createThread = async body => { created = body; return { thread: { id: 'fake-thread', cwd: body.cwd, status: { type: 'idle' } } }; };
  client.send = async (id, body) => { sent = { id, body }; return { turn: { id: 'turn' } }; };
  const store = path.join(root, 'state');
  const manager = await createImprovements({ client, sourceRoot, stateDir: store, sourceMap: map, verify: typeof checks === 'function' ? checks : async () => ({ passed: checks, commands: [{ command: 'fixture tests', code: checks ? 0 : 1, output: 'fixture result' }] }) });
  t.after(() => manager.close());
  return { manager, client, git, sourceRoot, store, created: () => created, sent: () => sent };
}
test('pointed request starts an ordinary chat in a fresh improve branch with native image and source provenance', async t => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.sourceRoot, 'button.txt'), 'open-tree edit\n');
  const row = await f.manager.start({ request: 'Rename Send to Go', target });
  assert.match(row.branch, /^improve\/\d{8}-rename-send-to-go-/);
  assert.notEqual(row.cwd, f.sourceRoot); assert.equal(await fs.readFile(path.join(row.cwd, 'button.txt'), 'utf8'), 'Send\n');
  assert.equal(f.created().cwd, row.cwd); assert.match(f.created().instructions, /tests first/i); assert.match(f.created().instructions, /commit/i);
  assert.match(f.sent().body.text, /Composer/); assert.match(f.sent().body.text, /button.txt/); assert.match(f.sent().body.text, /Rename Send to Go/);
  assert.equal(f.sent().body.attachments[0].dataUrl, PNG);
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'button.txt'), 'utf8'), 'open-tree edit\n');
});

test('source discovery uses the durable main checkout when installed from a throwaway worktree', async t => {
  const f = await setup(t), worktree = path.join(f.store, 'throwaway');
  await f.git('worktree', 'add', '--detach', worktree);
  const manager = await createImprovements({ client: f.client, sourceRoot: worktree, stateDir: path.join(f.store, 'durable'), sourceMap: map });
  t.after(() => manager.close());
  assert.deepEqual(await manager.source(), { path: f.sourceRoot, configured: true });
  await manager.setSource({ path: worktree });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.store, 'durable/source.json'), 'utf8')).path, f.sourceRoot);
});

test('an installed source record finds the checkout without choosing a folder and survives a stale saved source', async t => {
  const f = await setup(t), installation = path.join(f.store, 'installed');
  await fs.mkdir(path.join(installation, 'app'), { recursive: true });
  await fs.writeFile(path.join(installation, 'source.json'), JSON.stringify({ path: f.sourceRoot }));
  const stateDir = path.join(f.store, 'discovery'); await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, 'source.json'), JSON.stringify({ path: path.join(f.store, 'removed-worktree') }));
  const manager = await createImprovements({ client: f.client, appRoot: path.join(installation, 'app'), stateDir, sourceMap: map });
  t.after(() => manager.close());
  assert.deepEqual(await manager.source(), { path: f.sourceRoot, configured: true });
  const row = await manager.start({ request: 'Make this readable', target });
  assert.equal(row.status, 'working');
  assert.ok(f.created());
  await assert.rejects(manager.start({ request: '   ', target }), /Describe the change/);
});

test('installed source remains usable when the main checkout is on a pre-desktop branch and the install worktree is gone', async t => {
  const f = await setup(t), installation = path.join(f.store, 'older-main');
  const commit = (await f.git('rev-parse', 'HEAD')).stdout.trim();
  await fs.mkdir(path.join(installation, 'app'), { recursive: true });
  await fs.writeFile(path.join(installation, 'source.json'), JSON.stringify({ path: f.sourceRoot, commit }));
  await f.git('checkout', '--detach', 'HEAD~1');
  const manager = await createImprovements({ client: f.client, appRoot: path.join(installation, 'app'), stateDir: path.join(f.store, 'older-main-state'), sourceMap: map });
  t.after(() => manager.close());
  assert.deepEqual(await manager.source(), { path: f.sourceRoot, configured: true });
  assert.deepEqual(await manager.setSource({ path: f.sourceRoot }), { path: f.sourceRoot, configured: true });
  const row = await manager.start({ request: 'Fix the installed desktop', target });
  assert.equal(row.base, commit);
  assert.equal(JSON.parse(await fs.readFile(path.join(row.cwd, 'apps/elpis-desktop/package.json'), 'utf8')).name, 'elpis-desktop');
});

test('automatic discovery rejects an unrelated Git checkout as well as an invalid folder selection', async t => {
  const f = await setup(t), unrelated = path.join(f.store, 'unrelated'); await fs.mkdir(unrelated);
  await execFile('git', ['init', '-q', unrelated]);
  const manager = await createImprovements({ client: f.client, sourceRoot: unrelated, stateDir: path.join(f.store, 'invalid'), sourceMap: map });
  t.after(() => manager.close());
  assert.deepEqual(await manager.source(), { path: null, configured: false });
  await assert.rejects(manager.setSource({ path: unrelated }), /not an Elpis source checkout/);
  await assert.rejects(manager.start({ request: 'Readable', target }), /source folder/);
  assert.equal(f.created(), undefined);
});
test('review measures the committed diff and leaves the source tree alone', async t => {
  const f = await setup(t), row = await f.manager.start({ request: 'Rename Send to Go', target });
  await execFile('git', ['-C', row.cwd, 'config', 'user.name', 'Test']); await execFile('git', ['-C', row.cwd, 'config', 'user.email', 'test@invalid']);
  await fs.writeFile(path.join(row.cwd, 'button.txt'), 'Go\n');
  await execFile('git', ['-C', row.cwd, 'add', 'button.txt']); await execFile('git', ['-C', row.cwd, 'commit', '-qm', 'Rename button']);
  const review = await f.manager.check(row.id); assert.equal(review.checks.passed, true); assert.match(review.diff, /\+Go/); assert.match(review.diff, /-Send/);
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'button.txt'), 'utf8'), 'Send\n');
});
test('failed checks, missing source IDs and absent captures are reported, never silently sent', async t => {
  const f = await setup(t, false);
  await assert.rejects(f.manager.start({ request: 'x', target: { ...target, id: '../../secret' } }), /source|component/i);
  await assert.rejects(f.manager.start({ request: 'x', target: { ...target, image: null } }), /screenshot/i);
  const row = await f.manager.start({ request: 'Rename', target });
  await fs.writeFile(path.join(row.cwd, 'button.txt'), 'Go\n'); await execFile('git', ['-C', row.cwd, 'add', 'button.txt']); await execFile('git', ['-C', row.cwd, 'commit', '-qm', 'change']);
  assert.equal((await f.manager.check(row.id)).checks.passed, false);
});

async function checkFixture(t, scenario = {}) {
  const root = createTestTempDir(path.join(os.tmpdir(), 'improve-check-'));
  t.after(() => removeTestTempDir(root));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  const script = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
process.chdir(process.env.IMPROVE_CHECK_FIXTURE);
const step = path.basename(process.argv[1]) === 'npx' ? 'typecheck' : process.argv.at(-1);
const scenario = JSON.parse(fs.readFileSync('scenario.json'));
fs.appendFileSync('ran.txt', step + '\\n');
console.log('running ' + step);
if (step === scenario.fail) { console.error('planted assertion failed'); process.exit(7); }
if (step === scenario.hang) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 1600)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync('child.pid', String(child.pid));
  process.exit(0);
}
`;
  for (const name of ['npx', 'npm']) await fs.writeFile(path.join(bin, name), script, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'scenario.json'), JSON.stringify(scenario));
  return { root, env: { ...process.env, IMPROVE_CHECK_FIXTURE: root, PATH: `${bin}:${process.env.PATH}` } };
}
test('independent checks finish within the budget and preserve every required gate', async t => {
  const f = await checkFixture(t), started = performance.now();
  const result = await verifyImprovement(f.root, { timeoutMs: 5000, env: f.env });
  assert.equal(result.passed, true);
  assert.deepEqual((await fs.readFile(path.join(f.root, 'ran.txt'), 'utf8')).trim().split('\n'), ['typecheck', 'build', 'test:bridge', 'test:desktop']);
  assert.equal(result.commands.length, 4);
  assert.ok(result.commands.every(command => command.code === 0));
  assert.ok(performance.now() - started < 5000);
});
test('independent checks stop at a failure and retain its exit code and reason', async t => {
  const f = await checkFixture(t, { fail: 'test:bridge' });
  const result = await verifyImprovement(f.root, { timeoutMs: 5000, env: f.env });
  assert.equal(result.passed, false);
  assert.equal(result.commands.at(-1).command, 'npm run -s test:bridge');
  assert.equal(result.commands.at(-1).code, 7);
  assert.match(result.commands.at(-1).output, /planted assertion failed/);
  assert.doesNotMatch(await fs.readFile(path.join(f.root, 'ran.txt'), 'utf8'), /test:desktop/);
});
test('a child holding output open cannot outlive the verification budget or leave the change checking', async t => {
  const f = await checkFixture(t, { hang: 'test:bridge' });
  const change = await setup(t, cwd => verifyImprovement(cwd, { timeoutMs: 500, env: f.env }));
  const row = await change.manager.start({ request: 'Rename', target });
  await fs.mkdir(path.join(row.cwd, 'apps/elpis-desktop'), { recursive: true });
  await fs.writeFile(path.join(row.cwd, 'button.txt'), 'Go\n');
  await execFile('git', ['-C', row.cwd, 'add', 'button.txt']); await execFile('git', ['-C', row.cwd, 'commit', '-qm', 'change']);
  const started = performance.now();
  const review = await change.manager.check(row.id);
  assert.equal(review.status, 'checks-failed');
  assert.equal(review.checks.passed, false);
  assert.match(review.checks.commands.at(-1).output, /Timed out.*500/);
  assert.equal(review.checks.commands.at(-1).command, 'npm run -s test:bridge');
  assert.ok(performance.now() - started < 1200);
});

test('Improve links the existing ACP test dependencies into its isolated worktree', async t => {
  const f = await setup(t), deps = path.join(f.sourceRoot, 'tools/elpis-claude/node_modules');
  await fs.mkdir(path.join(deps, '@agentclientprotocol/sdk'), { recursive: true });
  await fs.writeFile(path.join(deps, '@agentclientprotocol/sdk/fixture'), 'existing dependency');
  await fs.writeFile(path.join(f.sourceRoot, 'tools/elpis-claude/.gitignore'), 'node_modules/\n');
  await fs.mkdir(path.join(f.sourceRoot, 'apps/elpis-desktop/node_modules/.bin'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'apps/elpis-desktop/.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(f.sourceRoot, 'apps/elpis-desktop/package.json'), JSON.stringify({ name: 'elpis-desktop' }));
  await f.git('add', 'tools/elpis-claude/.gitignore', 'apps/elpis-desktop/.gitignore', 'apps/elpis-desktop/package.json'); await f.git('commit', '-qm', 'ACP dependency boundary');
  const row = await f.manager.start({ request: 'Rename', target });
  const linked = path.join(row.cwd, 'tools/elpis-claude/node_modules/@agentclientprotocol');
  assert.equal(await fs.realpath(linked), path.join(deps, '@agentclientprotocol'));
  assert.equal(await fs.readFile(path.join(linked, 'sdk/fixture'), 'utf8'), 'existing dependency');
  assert.equal((await f.manager.get(row.id)).dirty, false);
  // An old Improve worktree may have been created before ACP packages were linked.
  await fs.rename(path.join(row.cwd, 'tools/elpis-claude/node_modules'), path.join(f.store, 'old-deps'));
  const moved = await setup(t);
  await fs.mkdir(path.join(moved.sourceRoot, 'apps/elpis-desktop'), { recursive: true });
  await fs.writeFile(path.join(moved.sourceRoot, 'apps/elpis-desktop/package.json'), JSON.stringify({ name: 'elpis-desktop' }));
  await f.manager.setSource({ path: moved.sourceRoot });
  await fs.writeFile(path.join(row.cwd, 'button.txt'), 'Go\n');
  await execFile('git', ['-C', row.cwd, 'add', 'button.txt']); await execFile('git', ['-C', row.cwd, 'commit', '-qm', 'change']);
  assert.equal((await f.manager.check(row.id)).checks.passed, true);
  assert.equal(await fs.realpath(linked), path.join(deps, '@agentclientprotocol'));
});

test('restart explains an interrupted check and persists a retryable state', async t => {
  const f = await setup(t), row = await f.manager.start({ request: 'Rename', target });
  await fs.writeFile(path.join(f.store, `${row.id}.json`), JSON.stringify({ ...row, status: 'checking' }));
  const manager = await createImprovements({ client: f.client, sourceRoot: f.sourceRoot, stateDir: f.store, sourceMap: map });
  t.after(() => manager.close());
  const restored = await manager.get(row.id);
  assert.equal(restored.status, 'needs-check');
  assert.match(restored.error, /interrupted.*run.*again/i);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.store, `${row.id}.json`), 'utf8')).status, 'needs-check');
});
test('authenticated HTTP flow reaches the fake engine with Luna, isolated cwd, instructions and native image input', async t => {
  const f = await setup(t), requests = [], threads = new Map();
  const socket = new EventEmitter(); socket.readyState = 1; socket.close = () => socket.emit('close');
  socket.send = raw => {
    const request = JSON.parse(raw); requests.push(request);
    if (request.id === undefined) return;
    let result = {};
    if (request.method === 'model/list') result = { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'Luna' }], nextCursor: null };
    if (request.method === 'thread/start') { result = { thread: { id: '11111111-1111-4111-8111-111111111111', cwd: request.params.cwd, model: request.params.model, modelProvider: 'openai', status: { type: 'idle' }, source: 'appServer' } }; threads.set(result.thread.id, result.thread); }
    if (request.method === 'thread/read') result = { thread: threads.get(request.params.threadId) };
    if (request.method === 'turn/start') result = { turn: { id: 'turn', status: 'inProgress' } };
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket, { rewindHome: path.join(f.store, 'rewind'), githubConnector: { instructions: async () => '' } }); await client.initialize();
  const app = await startDesktopServer({ client, trashFile: path.join(f.store, 'trash.json'), improvements: { sourceRoot: f.sourceRoot, stateDir: path.join(f.store, 'http'), sourceMap: map } });
  t.after(() => app.close());
  const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const sourceUrl = `${url.origin}/api/improvements/source`;
  const unauthenticated = await fetch(sourceUrl); assert.equal(unauthenticated.status, 401);
  const configured = await fetch(sourceUrl, { headers: { Cookie: cookie } });
  assert.deepEqual(await configured.json(), { path: f.sourceRoot, configured: true });
  await fs.mkdir(path.join(f.sourceRoot, 'apps/elpis-desktop'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'apps/elpis-desktop/package.json'), JSON.stringify({ name: 'elpis-desktop' }));
  const savedSource = await fetch(sourceUrl, { method: 'POST', headers: { Origin: url.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.sourceRoot }) });
  assert.equal(savedSource.status, 200); assert.equal((await savedSource.json()).path, f.sourceRoot);
  assert.equal(requests.some(request => request.method === 'thread/start'), false, 'choosing a source never starts an agent');
  const response = await fetch(`${url.origin}/api/improvements`, { method: 'POST', headers: { Origin: url.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ request: 'Rename Send to Go', target }) });
  const row = await response.json(); assert.equal(response.status, 201, JSON.stringify(row));
  assert.equal(row.error, undefined); assert.equal(row.status, 'working');
  const start = requests.find(request => request.method === 'thread/start');
  assert.equal(start.params.cwd, row.cwd); assert.equal(start.params.model, 'gpt-6-luna'); assert.match(start.params.developerInstructions, /Tests first/);
  const turn = requests.find(request => request.method === 'turn/start'); assert.ok(turn.params.input.some(input => input.type === 'image' && input.url === PNG));
});
test('an uncertain send retains its chat and worktree without retrying; completed turns trigger independent checks', async t => {
  const f = await setup(t); let sends = 0;
  f.client.send = async () => { sends++; throw Error('connection lost'); };
  const row = await f.manager.start({ request: 'Rename', target });
  assert.equal(row.status, 'send-error'); assert.equal(row.thread.id, 'fake-thread'); assert.equal(sends, 1); assert.match(row.error, /Inspect this chat/);
  await fs.writeFile(path.join(row.cwd, 'button.txt'), 'Go\n'); await execFile('git', ['-C', row.cwd, 'add', 'button.txt']); await execFile('git', ['-C', row.cwd, 'commit', '-qm', 'change']);
  f.client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: row.thread.id } } });
  for (let i = 0; i < 100; i++) { const next = await f.manager.get(row.id); if (next.status === 'review') { await f.manager.check(row.id); assert.equal(next.checks.passed, true); assert.equal(next.error, undefined); return; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('completed turn did not produce a measured review');
});

test('a saved source folder repairs packaged Change this, survives restart and rejects invalid folders without starting a chat', async t => {
  const f = await setup(t);
  const missing = path.join(f.store, 'packaged-app');
  const manager = await createImprovements({ client: f.client, sourceRoot: missing, stateDir: path.join(f.store, 'configured'), sourceMap: map }); t.after(() => manager.close());
  assert.equal((await manager.source()).configured, false);
  await assert.rejects(manager.start({ request: 'Rename', target }), /source folder/i);
  assert.equal(f.created(), undefined);
  await assert.rejects(manager.setSource({ path: missing }), /source|folder|checkout/i);
  await fs.mkdir(path.join(f.sourceRoot, 'apps/elpis-desktop'), { recursive: true });
  await fs.writeFile(path.join(f.sourceRoot, 'apps/elpis-desktop/package.json'), JSON.stringify({ name: 'elpis-desktop' }));
  const selected = await manager.setSource({ path: f.sourceRoot }); assert.equal(selected.path, f.sourceRoot);
  const restored = await createImprovements({ client: f.client, stateDir: path.join(f.store, 'configured'), sourceMap: map }); t.after(() => restored.close());
  assert.equal((await restored.source()).path, f.sourceRoot);
  await restored.start({ request: 'Rename', target }); assert.ok(f.created().cwd.includes('worktrees'));
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'button.txt'), 'utf8'), 'Send\n');
});
