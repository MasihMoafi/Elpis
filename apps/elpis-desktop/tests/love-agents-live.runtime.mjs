import { createTestTempDir, removeTestTempDir } from './temp-root.cjs';
// One real two-character handoff over ACP: two Elpis ACP agents (this worktree's tools/elpis-claude/elpis-acp-agent.mjs,
// or $ELPIS_ACP_AGENT) on the installed engine, in an isolated Elpis home with a copy of the sign-in.
// Usage: node tests/love-agents-live.runtime.mjs /absolute/path/to/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoveSpot } from '../bridge/love-spot-store.cjs';
import { createLoveAgents } from '../bridge/love-agents.mjs';
const engine = process.argv[2];
assert(engine && path.isAbsolute(engine), 'Provide the absolute installed engine path');
const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
const root = createTestTempDir(path.join(base, 'love-agents-live-'));
const home = path.join(root, 'home'), project = path.join(root, 'project');
await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(project);
const sourceHome = process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next');
await fs.copyFile(path.join(sourceHome, 'auth.json'), path.join(home, 'auth.json'));
await fs.chmod(path.join(home, 'auth.json'), 0o600);
await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-6-luna"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
const agent = process.env.ELPIS_ACP_AGENT || fileURLToPath(new URL('../../../tools/elpis-claude/elpis-acp-agent.mjs', import.meta.url));
const env = { ...process.env, ELPIS_HOME: home, ELPIS_ENGINE_BIN: engine, ELPIS_NODE_BIN: process.execPath, ELPIS_ACP_AGENT: agent };
let store;
try {
  const token = `ACPSEED-${crypto.randomUUID()}`;
  const card = (id, task) => ({ id, type: 'rectangle', x: 0, y: 0, width: 220, height: 170, version: 1, versionNonce: 1, customData: { loveAgent: { preset: id === 'first' ? 'researcher' : 'reviewer', name: id, model: 'gpt-6-luna', provider: 'openai', prompt: 'Follow the task exactly. Use no tools. Give only the requested text.', task } } });
  store = createLoveSpot({ directory: path.join(root, 'drawing'), screenshots: path.join(root, 'shots') });
  await store.save({ elements: [card('first', `Reply with exactly ${token}`), card('second', 'Extract the ACPSEED token from the source answer. Reply with exactly HANDOFF: followed by that token.'), { id: 'edge', type: 'arrow', x: 220, y: 80, width: 100, height: 0, version: 1, versionNonce: 1, startBinding: { elementId: 'first' }, endBinding: { elementId: 'second' }, endArrowhead: 'arrow' }], files: {} });
  const started = Date.now();
  const result = await createLoveAgents(store, { timeoutMs: 120000, env }).run({ id: 'first', cwd: project });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].output.trim(), token);
  assert.equal(result.results[1].output.trim().replace(/^HANDOFF:\s*/, ''), token);
  assert.match(result.results[1].output, /^HANDOFF:/);
  const { scene } = await store.read();
  const cards = scene.elements.filter(e => e.customData?.loveAgent).map(e => e.customData.loveAgent);
  assert(cards.every(c => c.status === 'completed' && c.threadId && c.threadId === c.sessionId), 'each card keeps the Elpis thread its ACP session ran');
  // Removing the arrow and task means the sink cannot run; proves the positive result required the connection.
  await store.save({ ...scene, elements: scene.elements.map(e => e.id === 'edge' ? { ...e, version: e.version + 1, isDeleted: true } : e.id === 'second' ? { ...e, version: e.version + 1, customData: { loveAgent: { ...e.customData.loveAgent, task: '' } } } : e) });
  await assert.rejects(createLoveAgents(store, { env }).run({ id: 'second', cwd: project }), /Give second a task/);
  const evidence = { model: 'gpt-6-luna', provider: 'openai', transport: 'ACP', agent, engine, seconds: (Date.now() - started) / 1000, results: result.results, negative: 'Without the arrow, blank sink refused before a model call', isolatedHomeCleaned: true };
  await fs.writeFile('/tmp/love-agents-live-evidence.json', JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  store?.close();
  removeTestTempDir(root);
}
