import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DesktopClient } from '../bridge/client.mjs';

// Explicit opt-in: an isolated real engine, no installed app, auth, model turn, or user's profile.
test('real engine records a shell command and keeps an ephemeral side fork out of the saved session list', { skip: !process.env.ELPIS_TEST_ENGINE, timeout: 45000 }, async t => {
  await fs.mkdir(path.resolve('.tmp'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.tmp/composer-engine-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await fs.mkdir(home); await fs.mkdir(cwd);
  const child = spawn(process.env.ELPIS_TEST_ENGINE, ['app-server', '--listen', 'stdio://'], {
    cwd,
    env: { ...process.env, ELPIS_HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_RUNTIME_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const socket = new EventEmitter(), messages = []; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  socket.send = raw => child.stdin.write(raw + '\n');
  socket.close = () => child.stdin.end();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { messages.push(JSON.parse(line)); socket.emit('message', line); } catch {} });
  child.on('exit', () => socket.emit('close'));
  const client = new DesktopClient(socket, { timeoutMs: 15000 });
  const events = []; client.on('event', event => events.push(event));
  t.after(async () => {
    client.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    lines.close(); await fs.writeFile(path.join(root, 'engine.log'), stderr);
  });
  await client.initialize();
  const created = await client.createThread({ cwd });
  const id = created.thread.id;
  await client.shellCommand(id, { command: "printf 'COMPOSER_REAL_SHELL_731\\n'" });
  const end = Date.now() + 12000;
  while (!messages.some(message => message.method === 'turn/completed' && message.params?.threadId === id)) {
    if (Date.now() > end) throw new Error('The engine did not finish the shell command.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const transcript = await client.readThread(id, {});
  assert.ok(transcript.data.some(entry => entry.item.type === 'commandExecution' && entry.item.source === 'userShell' && entry.item.aggregatedOutput?.includes('COMPOSER_REAL_SHELL_731')), 'recorded native user-shell output');
  const side = await client.createSideChat(id, {});
  assert.notEqual(side.threadId, id);
  assert.ok(!events.some(event => event.type === 'message' && (event.data.params?.threadId ?? event.data.params?.thread?.id) === side.threadId), 'ephemeral lifecycle events do not leak into the main UI');
  const listed = await client.listThreads({});
  assert.ok(!listed.data.some(thread => thread.id === side.threadId), 'the ephemeral fork is not a saved conversation');
  await client.closeSideChat(side.threadId, {});
  const after = await client.readThread(id, {});
  assert.deepEqual(after.data, transcript.data, 'the parent transcript is unchanged by side-chat creation and cleanup');
  await client.shellCommand(id, { command: "sleep 0.2; printf 'COMPOSER_ACTIVE_SHELL_732\\n'" });
  const activeSide = await client.createSideChat(id, {});
  await client.closeSideChat(activeSide.threadId, {});
  const activeEnd = Date.now() + 5000;
  while (!messages.some(message => message.method === 'item/completed' && message.params?.threadId === id && message.params.item?.aggregatedOutput?.includes('COMPOSER_ACTIVE_SHELL_732'))) {
    if (Date.now() > activeEnd) throw new Error('Opening side chat interfered with the running parent shell.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  t.diagnostic(`Isolated evidence: ${root}`);
});
