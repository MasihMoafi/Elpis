// One real two-character handoff, through the installed provider bridge and this worktree's runner.
// Usage: node tests/love-agents-live.runtime.mjs /absolute/path/to/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { DesktopClient } from '../bridge/client.mjs';
import { createLoveSpot } from '../bridge/love-spot-store.cjs';
import { createLoveAgents } from '../bridge/love-agents.mjs';
const exec = promisify(execFile);
const engine = process.argv[2];
assert(engine && path.isAbsolute(engine), 'Provide the absolute installed engine path');
const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, 'love-agents-live-'));
const home = path.join(root, 'home'), project = path.join(root, 'project');
await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(project);
const sourceHome = process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next');
await fs.copyFile(path.join(sourceHome, 'auth.json'), path.join(home, 'auth.json'));
await fs.chmod(path.join(home, 'auth.json'), 0o600);
await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-6-luna"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
// The client also keeps rewind/connector state; isolate that along with the child runtime.
process.env.ELPIS_HOME = home;
const runtime = path.join(root, 'rt'); await fs.mkdir(runtime, { mode: 0o700 });
const socketPath = path.join(runtime, 'bridge.sock');
const bridgeScript = path.join(path.dirname(engine), 'tools/elpis-claude/acp-bridge.mjs');
const log = await fs.open(path.join(root, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [bridgeScript], { cwd: project, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELPIS_HOME: home, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: path.join(root, 'acp.log'), NODE_USE_ENV_PROXY: '1' } });
const exited = once(bridge, 'exit');
let client, store;
try {
  for (let attempt = 0; ; attempt++) {
    if (bridge.exitCode !== null) throw Error(`Provider bridge exited: ${await fs.readFile(path.join(root, 'bridge.log'), 'utf8')}`);
    try { if ((await fs.stat(socketPath)).isSocket()) break; } catch {}
    if (attempt > 200) throw Error('Bridge did not listen');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  client = await DesktopClient.connect({ socketPath });
  const token = `ACPSEED-${crypto.randomUUID()}`;
  const card = (id, task) => ({ id, type: 'rectangle', x: 0, y: 0, width: 220, height: 170, version: 1, versionNonce: 1, customData: { loveAgent: { preset: id === 'first' ? 'researcher' : 'reviewer', name: id, model: 'gpt-6-luna', provider: 'openai', prompt: 'Follow the task exactly. Use no tools. Give only the requested text.', task } } });
  store = createLoveSpot({ directory: path.join(root, 'drawing'), screenshots: path.join(root, 'shots') });
  await store.save({ elements: [card('first', `Reply with exactly ${token}`), card('second', 'Extract the ACPSEED token from the source answer. Reply with exactly HANDOFF: followed by that token.'), { id: 'edge', type: 'arrow', x: 220, y: 80, width: 100, height: 0, version: 1, versionNonce: 1, startBinding: { elementId: 'first' }, endBinding: { elementId: 'second' }, endArrowhead: 'arrow' }], files: {} });
  const started = Date.now();
  const result = await createLoveAgents(client, store, { timeoutMs: 120000 }).run({ id: 'first', cwd: project });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].output.trim(), token);
  assert.equal(result.results[1].output.trim().replace(/^HANDOFF:\s*/, ''), token);
  assert.match(result.results[1].output, /^HANDOFF:/);
  const { scene } = await store.read();
  assert(scene.elements.filter(e => e.customData?.loveAgent).every(e => e.customData.loveAgent.status === 'completed'));
  // Removing the arrow and task means the sink cannot run; proves the positive result required the connection.
  await store.save({ ...scene, elements: scene.elements.map(e => e.id === 'edge' ? { ...e, version: e.version + 1, isDeleted: true } : e.id === 'second' ? { ...e, version: e.version + 1, customData: { loveAgent: { ...e.customData.loveAgent, task: '' } } } : e) });
  await assert.rejects(createLoveAgents(client, store).run({ id: 'second', cwd: project }), /Give second a task/);
  const evidence = { model: 'gpt-6-luna', provider: 'openai', bridge: bridgeScript, seconds: (Date.now() - started) / 1000, results: result.results, negative: 'Without the arrow, blank sink refused before a model call', isolatedHomeCleaned: true };
  await fs.writeFile('/tmp/love-agents-live-evidence.json', JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  store?.close(); client?.close(); bridge.kill('SIGTERM');
  const fallback = setTimeout(() => bridge.kill('SIGKILL'), 5000);
  await exited; clearTimeout(fallback); await log.close();
  await exec('gio', ['trash', root]);
}
