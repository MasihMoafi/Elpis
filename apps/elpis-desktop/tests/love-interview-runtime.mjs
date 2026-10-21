// Scripted engine behind the real desktop client and Elpis ACP adapter. No model calls.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import syncFs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DesktopClient } from '../bridge/client.mjs';
import { createLoveAgents } from '../bridge/love-agents.mjs';
import { createLoveSpot } from '../bridge/love-spot-store.cjs';

export async function interviewRuntime({ toolsDirectory = fileURLToPath(new URL('../../../tools/elpis-claude/', import.meta.url)), seed = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'li-'));
  const socketPath = path.join(root, 'bridge.sock');
  const controlFile = path.join(root, 'control.json'), requestsFile = path.join(root, 'requests.jsonl');
  const control = { answer: '{"question":"What would you like to write?"}', failure: null, hold: false };
  const update = change => { Object.assign(control, change); syncFs.writeFileSync(`${controlFile}.next`, JSON.stringify(control)); syncFs.renameSync(`${controlFile}.next`, controlFile); };
  update({});
  const engine = path.join(root, 'engine');
  await fs.writeFile(engine, `#!/bin/sh\nexec '${process.execPath}' '${fileURLToPath(new URL('./love-interview-engine.mjs', import.meta.url))}' "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: root, ELPIS_HOME: path.join(root, 'elpis'), CODEX_HOME: path.join(root, 'codex'), TMPDIR: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: path.join(root, '.config'), XDG_CACHE_HOME: path.join(root, '.cache'), XDG_STATE_HOME: path.join(root, '.local/state'), XDG_DATA_HOME: path.join(root, '.local/share'), ELPIS_APP_BRIDGE_SOCKET: '', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_SHARED_BRIDGE: '1', ELPIS_ENGINE_BIN: engine, ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1', ACP_BRIDGE_LOG: path.join(root, 'bridge.log'), INTERVIEW_CONTROL: controlFile, INTERVIEW_REQUESTS: requestsFile };
  const bridge = spawn(process.execPath, [path.join(toolsDirectory, 'acp-bridge.mjs')], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; bridge.stderr.on('data', data => { stderr += data; });
  const until = async check => { for (const deadline = Date.now() + 10000; Date.now() < deadline;) { if (check()) return; if (bridge.exitCode !== null) throw new Error(stderr); await new Promise(r => setTimeout(r, 20)); } throw new Error(`Interview bridge timed out: ${stderr}`); };
  const stop = async () => {
    if (bridge.exitCode !== null || bridge.signalCode !== null) return;
    const exited = once(bridge, 'exit'); bridge.kill('SIGTERM');
    const timer = setTimeout(() => bridge.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  let client;
  try {
    await until(() => { const stat = syncFs.statSync(socketPath, { throwIfNoEntry: false }); return stat?.isSocket() && !(stat.mode & 0o077); });
    client = await DesktopClient.connect({ socketPath, rewindHome: path.join(root, 'rewind'), archiveDirectory: path.join(root, 'archives') });
  } catch (error) { await stop(); throw error; }
  const visible = [];
  client.on('event', event => { if (event.type === 'message') visible.push(event.data); });
  const store = createLoveSpot({ directory: path.join(root, 'drawing'), screenshots: path.join(root, 'shots') });
  const card = { id: 'writer', type: 'rectangle', x: 0, y: 0, width: 220, height: 170, version: 1, versionNonce: 1, customData: { loveAgent: { preset: 'writer', name: 'Writer', prompt: 'You are a careful writer.', task: '', model: 'gpt-6-luna', provider: 'openai', interview: { messages: [] } } } };
  if (seed) await store.save({ elements: [card], files: {}, appState: {} });
  const nodeSpec = node => ({ name: node.name, command: process.execPath,
    args: [path.join(toolsDirectory, 'elpis-acp-agent.mjs'), '--model', node.model],
    env: { ELPIS_HOME: path.join(root, 'elpis'), ELPIS_APP_BRIDGE_SOCKET: socketPath },
    instructions: node.prompt, meta: { elpis: { name: `Love Spot · ${node.name}` } }, elpis: true });
  const runner = createLoveAgents(store, { nodeSpec, timeoutMs: 5000 });
  const agent = async () => (await store.read()).scene.elements[0].customData.loveAgent;
  return { root, socketPath, engine, env, client, store, runner, nodeSpec, visible, agent,
    get requests() { return syncFs.existsSync(requestsFile) ? syncFs.readFileSync(requestsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; },
    answer(value) { update({ answer: value, failure: null }); }, fail(value) { update({ failure: value }); },
    hold() { update({ hold: true }); }, resume() { update({ hold: false }); },
    async close() {
      await runner.close(); store.close(); client.close();
      await stop();
      // Owned short socket/home fixtures are left for boot cleanup.
    },
  };
}
