// Real installed engine + production Claude bridge + desktop HTTP routes. Inference stays local and scripted.
// ELPIS_GOAL_ENGINE=/absolute/engine node --test tests/goal.runtime.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import provider from '../../../scripts/lib/mock-provider.js';
import { DesktopClient } from '../bridge/client.mjs';
import { startDesktopServer } from '../bridge/server.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function until(check, label, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(30)) if (await check()) return;
  throw Error(`Timed out: ${label}`);
}
test('real engine and Claude adapter goal set/get/clear through authenticated desktop HTTP', { skip: !process.env.ELPIS_GOAL_ENGINE, timeout: 60000 }, async t => {
  const scratch = path.join(os.homedir(), '.cache/elpis-briefs/cc'); await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'g-')), home = path.join(root, 'home'), project = path.join(root, 'project');
  await fs.mkdir(home); await fs.mkdir(project);
  const homes = { ELPIS_HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home, ELPIS_CONFIG_DIR: home };
  const previous = Object.fromEntries(Object.keys(homes).map(key => [key, process.env[key]])); Object.assign(process.env, homes);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const carrier = new provider.Provider(); await carrier.start(); t.after(() => carrier.close());
  carrier.actions.push(provider.message('Seed ready.'), { hang: true });
  await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-6-luna"\nmodel_provider="openai"\nopenai_base_url=${JSON.stringify(carrier.url)}\nmodel_catalog_json=${JSON.stringify(path.join(repo, 'codex-rs/models-manager/models.json'))}\n[features]\ncode_mode=false\ngoals=true\n`);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'Keep this isolated goal test brief.');
  const socketPath = path.join(root, 'b.sock'), release = path.join(root, 'release');
  const log = await fs.open(path.join(root, 'bridge.log'), 'a');
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, CODEX_SQLITE_HOME: home,
    XDG_CONFIG_HOME: root, XDG_RUNTIME_DIR: root, TMPDIR: root, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath,
    ELPIS_ENGINE_BIN: process.env.ELPIS_GOAL_ENGINE, ACP_ADAPTER: path.join(repo, 'tools/elpis-claude/test/fake-acp-agent.mjs'),
    ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: path.join(root, 'adapter.log'), ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1',
    OPENAI_API_KEY: 'local-protocol-fixture', FAKE_ACP_LOG: path.join(root, 'acp.jsonl'), FAKE_ACP_MODELS: 'sonnet', FAKE_ACP_RELEASE: release };
  const bridge = spawn(process.execPath, [path.join(repo, 'tools/elpis-claude/acp-bridge.mjs')], { env, cwd: project, detached: true, stdio: ['ignore', log.fd, log.fd] });
  t.after(async () => { if (bridge.exitCode === null && bridge.signalCode === null) { const ended = once(bridge, 'exit'); bridge.kill('SIGTERM'); await ended; } try { process.kill(-bridge.pid, 'SIGKILL'); } catch {} await log.close(); });
  await until(async () => { try { await fs.stat(socketPath); return true; } catch { return false; } }, 'isolated bridge socket');
  const client = await DesktopClient.connect({ socketPath, appHome: root });
  const events = []; client.on('event', event => { if (event.type === 'message') events.push(event.data); });
  await client.models();
  const app = await startDesktopServer({ client, elpisHome: home, loveSpot: { directory: path.join(root, 'drawing') } }); t.after(() => app.close());
  const url = new URL(app.url), login = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get('token') }) });
  const headers = { Origin: url.origin, Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const evidence = [], threads = [];
  for (const model of ['gpt-6-luna', 'claude/sonnet']) {
    const { thread } = await client.createThread({ cwd: project, model, permissions: 'full', name: `Goal ${model}` });
    threads.push({ id: thread.id, model });
    assert.ok(thread?.id);
    if (model === 'gpt-6-luna') {
      await client.send(thread.id, { text: 'Seed this goal test.' });
      await until(() => events.some(e => e.method === 'turn/completed' && e.params.threadId === thread.id), 'native seed turn');
    }
    const endpoint = `${url.origin}/api/threads/${thread.id}/goal`;
    const read = () => fetch(endpoint, { headers }).then(r => r.json());
    const write = body => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.deepEqual(await read(), { goal: null });
    const objective = `Keep the ${model} goal visible. [wait]`;
    const set = await write({ objective }); assert.equal(set.status, 200, await set.text());
    assert.equal((await read()).goal.objective, objective);
    assert.equal((await write({ objective: ' ' })).status, 400); assert.equal((await read()).goal.objective, objective);
    const context = await fetch(`${url.origin}/api/threads/${thread.id}/session-context`, { headers });
    assert.equal(context.status, 200, await context.clone().text());
    assert.equal((await context.json()).goal.objective, objective);
    assert.equal((await write({ clear: true })).status, 200); assert.deepEqual(await read(), { goal: null });
    evidence.push(`${model}: set/get/context/clear and rejected empty objective`);
  }
  await fs.writeFile(release, 'done');
  if (process.env.ELPIS_GOAL_APP) {
    const { _electron } = createRequire(import.meta.url)(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
    const packaged = path.resolve(process.env.ELPIS_GOAL_APP);
    const electron = await _electron.launch({ executablePath: path.join(packaged, 'runtime/electron/electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.join(packaged, 'app')],
      env: { ...env, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELPIS_DESKTOP_PROFILE: path.join(root, 'desktop'), ELPIS_NODE_BIN: process.execPath, ELPIS_APP_BRIDGE_SOCKET: socketPath } });
    let electronClosed = false; t.after(() => electronClosed ? undefined : electron.close());
    const page = await electron.firstWindow(); page.setDefaultTimeout(15000); await page.setViewportSize({ width: 1440, height: 900 });
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    const panel = page.getByRole('region', { name: 'Side panel', exact: true });
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    for (const thread of threads) {
      await page.locator(`.thread-row[data-thread-id="${thread.id}"] .thread-link`).first().click();
      await composer.fill(`/goal Packaged ${thread.model} condition`); await composer.press('Enter');
      await panel.getByText(`Packaged ${thread.model} condition`, { exact: true }).waitFor();
      assert.equal((await client.goal(thread.id)).goal.objective, `Packaged ${thread.model} condition`);
      await panel.getByRole('button', { name: 'Clear goal', exact: true }).click(); await panel.getByText('No goal set.', { exact: true }).waitFor();
      assert.equal((await client.goal(thread.id)).goal, null);
      await composer.fill('/goal'); await composer.press('Enter'); await panel.getByText('No goal set.', { exact: true }).waitFor();
      evidence.push(`${thread.model}: packaged Electron keyboard /goal set/read and real Clear click`);
    }
    await panel.getByRole('button', { name: 'Create ES.md', exact: true }).click();
    await panel.getByRole('button', { name: 'Source', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: 'Contents of ES.md', exact: true });
    await editor.fill('# Packaged session intent'); await editor.press('Control+s');
    await until(async () => (await fs.readFile(path.join(project, 'ES.md'), 'utf8')) === '# Packaged session intent', 'packaged file edit saved');
    await panel.getByRole('tab', { name: 'Context', exact: true }).click();
    for (const colorScheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme }); await page.screenshot({ path: path.join(os.homedir(), `.cache/elpis-shots/goal-packaged-${colorScheme}.png`) }); }
    evidence.push('packaged Electron creates project ES.md and saves an edit with Ctrl+S');
    await electron.close(); electronClosed = true;
  }
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ engine: process.env.ELPIS_GOAL_ENGINE, evidence, inference: 'scripted local providers', liveSubscription: 'UNVERIFIED' }, null, 2));
  console.log(JSON.stringify({ root, evidence, inference: 'scripted local providers' }));
});

test('native Claude reports loaded project instructions and excludes unrelated files', { skip: !process.env.ELPIS_GOAL_CLAUDE, timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-')), project = path.join(root, 'project'), config = path.join(root, '.claude');
  await fs.mkdir(project); await fs.mkdir(config);
  const projectFile = path.join(project, 'CLAUDE.md'), unrelated = path.join(project, 'NOT-LOADED.md');
  await fs.writeFile(projectFile, 'Project instructions for the context manifest.'); await fs.writeFile(unrelated, 'This unrelated file must be excluded.');
  const adapter = process.env.ELPIS_CONTEXT_ADAPTER ?? path.join(repo, 'tools/elpis-claude/context-agent.mjs');
  const child = spawn(process.execPath, [adapter], { cwd: project, env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: config, TMPDIR: root,
    CLAUDE_CODE_EXECUTABLE: process.env.ELPIS_GOAL_CLAUDE, ANTHROPIC_API_KEY: 'local-context-test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), pause(3000)]); try { process.kill(-child.pid, 'SIGKILL'); } catch {} await fs.writeFile(path.join(root, 'adapter.log'), errors); });
  const pending = new Map(); let sequence = 0, buffer = '';
  child.on('exit', code => { for (const request of pending.values()) request.reject(Error(`Context adapter exited (${code}): ${errors.slice(-2000)}`)); pending.clear(); });
  child.stdout.on('data', chunk => { buffer += chunk; for (;;) { const at = buffer.indexOf('\n'); if (at < 0) return; const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1); let msg; try { msg = JSON.parse(raw); } catch { continue; } const request = pending.get(msg.id); if (!request) continue; pending.delete(msg.id); msg.error ? request.reject(Error(JSON.stringify(msg.error))) : request.resolve(msg.result); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'goal-context-check', version: '1' } });
  const { sessionId } = await rpc('session/new', { cwd: project, mcpServers: [], _meta: { claudeCode: { options: { settingSources: ['project', 'local'] } } } });
  const { files } = await rpc('_elpis/contextFiles', { sessionId });
  assert.ok(files.some(file => file.path === projectFile), 'the SDK must report its project CLAUDE.md');
  assert.equal(files.some(file => file.path === unrelated), false, 'an unrelated file is absent');
  console.log(JSON.stringify({ root, checks: ['native Claude CLAUDE.md included', 'unrelated file excluded'], inference: 'none' }));
});
