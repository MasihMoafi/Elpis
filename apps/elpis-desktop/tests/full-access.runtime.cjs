// Packaged app + installed native engine, local Responses model and ACP fixture only.
// ELPIS_TEST_APP=/package ELPIS_TEST_ENGINE=/engine ELPIS_PLAYWRIGHT_PACKAGE=/playwright node --test tests/full-access.runtime.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');
const run = promisify(execFile);
const repo = path.resolve(__dirname, '../../..');
const ready = process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE;

test('inherited permissions follow Settings across restart; explicit Ask stays; GPT, Claude and helpers never ask by default', { skip: !ready, timeout: 300000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/full-access-'));
  const mock = spawn(process.execPath, [path.join(repo, 'tools/elpis-claude/test/mock-responses.mjs'), '0', root], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let app;
  t.after(async () => { await stopApp(app); mock.kill('SIGTERM'); await run('gio', ['trash', root]); });
  let output = ''; mock.stdout.on('data', b => { output += b; });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('mock did not start')), 10000); mock.stdout.on('data', () => { if (/listening (\d+)/.test(output)) { clearTimeout(timer); resolve(); } }); });
  const mockPort = /listening (\d+)/.exec(output)[1];
  // The mock prints its actual port, including when the OS allocates it.
  const seed = path.join(root, 'seed'), work = path.join(root, 'work');
  await fs.mkdir(seed); await fs.mkdir(work);
  await fs.writeFile(path.join(seed, 'config.toml'), `model="gpt-5.5"\nmodel_provider="mock"\ndefault_permissions=":danger-full-access"\n[model_providers.mock]\nname="Mock"\nbase_url="http://127.0.0.1:${mockPort}/v1"\nwire_api="responses"\n`);
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: seed, CODEX_HOME: seed, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_RUNTIME_DIR: root };
  const seeding = run(process.env.ELPIS_TEST_ENGINE, ['exec', '--skip-git-repo-check', '-C', work, '-s', 'danger-full-access', '-c', 'approval_policy="on-request"', '--json', 'legacy TUI permission seed'], { env, timeout: 45000, maxBuffer: 2e6 });
  seeding.child.stdin.end();
  const seedRun = await seeding;
  const id = seedRun.stdout.split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(row => row.type === 'thread.started')?.thread_id;
  assert.ok(id, seedRun.stdout);
  const { DatabaseSync } = require('node:sqlite');
  const appHome = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  await fs.mkdir(path.join(appHome, 'elpis'));
  for (const name of await fs.readdir(seed)) if (/^state_.*\.sqlite$/.test(name)) {
    const db = new DatabaseSync(path.join(seed, name));
    db.prepare('UPDATE threads SET source = ?, originator = ?, rollout_path = replace(rollout_path, ?, ?) WHERE id = ?').run('cli', 'codex-tui', seed, path.join(appHome, 'elpis'), id); db.close();
  }
  for (const file of await fs.readdir(path.join(seed, 'sessions'), { recursive: true })) if (file.endsWith(`${id}.jsonl`)) {
    const filePath = path.join(seed, 'sessions', file), rows = (await fs.readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
    const meta = rows.find(row => row.type === 'session_meta'); meta.payload.source = 'cli'; meta.payload.originator = 'codex-tui';
    for (const row of rows) if (row.type === 'turn_context') { row.payload.approval_policy = 'on-request'; row.payload.active_permission_profile = { id: ':danger-full-access' }; }
    await fs.writeFile(filePath, rows.map(JSON.stringify).join('\n') + '\n');
  }
  const extra = { ELPIS_E2E_HOME: appHome, ACP_ADAPTER: path.join(repo, 'tools/elpis-claude/test/fake-acp-agent.mjs'), ELPIS_NO_AGY: '1', FAKE_ACP_MODELS: 'haiku', FAKE_ACP_LOG: path.join(root, 'acp.jsonl') };
  app = await startApp({ app: process.env.ELPIS_TEST_APP, engine: process.env.ELPIS_TEST_ENGINE, port: Number(process.env.ELPIS_TEST_PORT || 9732), seed, env: extra });
  let page = app.page;
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 }); await skipFirstRun(page);
  const select = async tid => { await page.locator(`.thread-row[data-thread-id="${tid}"]`).first().click(); await page.getByLabel('Message Elpis', { exact: true }).waitFor(); };
  const mode = () => page.getByRole('button', { name: 'Change permissions', exact: true });
  const choose = async label => { await mode().click(); await page.getByRole('menuitem').filter({ hasText: label }).first().click(); await page.waitForFunction(label => document.querySelector('[aria-label="Change permissions"]')?.getAttribute('aria-description') === label, label); };
  const deny = () => page.getByRole('button').filter({ hasText: /^\s*\d*\s*Deny/ }).first();
  const released = async (file, label) => {
    const deadline = Date.now() + 30000;
    while (!await fs.stat(file).then(() => true, () => false)) { assert.ok(Date.now() < deadline, `${label}: Full access releases the pending command`); await new Promise(r => setTimeout(r, 50)); }
    await deny().waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
  };
  const command = async (tag, asks = false, claude = false, options = {}) => {
    const file = path.join(root, tag);
    const text = `${claude ? '[permission] ' : ''}PERMISSION_FILE:${file}`;
    await page.getByLabel('Message Elpis', { exact: true }).fill(text); await page.getByLabel('Message Elpis', { exact: true }).press('Enter');
    if (asks) {
      const deadline = Date.now() + 30000;
      while (!await deny().isVisible()) {
        assert.equal(await fs.stat(file).then(() => true, () => false), false, `${tag}: command ran before approval`);
        assert.ok(Date.now() < deadline, `${tag}: approval was shown`);
        await new Promise(r => setTimeout(r, 50));
      }
      await assert.rejects(fs.stat(file));
      if (options.hold) return file;
      await deny().click();
    }
    else if (claude) { await page.getByText(new RegExp(`permission: allow_once[\\s\\S]*${tag}`)).last().waitFor({ timeout: 30000 }); assert.equal(await deny().count(), 0); assert.equal(await fs.readFile(file, 'utf8'), 'permission-ran'); }
    else { await page.waitForFunction(async tag => { const r = await fetch('/api/threads?limit=100'); return r.ok; }, tag); const end = Date.now() + 45000; for (;;) { if (await fs.stat(file).then(() => true, () => false)) break; assert.equal(await deny().count(), 0, `${tag}: inherited Full access asked for approval`); assert.ok(Date.now() < end, `${tag}: command did not run`); await new Promise(r => setTimeout(r, 50)); } }
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
    if (!claude) {
      const chatId = await page.locator('.thread-row.active').first().getAttribute('data-thread-id');
      const sessions = path.join(app.home, 'elpis/sessions');
      const rollout = (await fs.readdir(sessions, { recursive: true })).find(name => name.endsWith(`${chatId}.jsonl`));
      assert.ok(rollout, `${tag}: the engine saved the chat`);
      const rows = (await fs.readFile(path.join(sessions, rollout), 'utf8')).trim().split('\n').map(JSON.parse);
      const context = rows.filter(row => row.type === 'turn_context').at(-1)?.payload;
      assert.equal(context.approval_policy, asks ? 'on-request' : 'never', `${tag}: the engine's actual approval policy`);
      assert.equal(context.active_permission_profile?.id, asks ? ':workspace' : ':danger-full-access', `${tag}: Full access is not Bypass`);
    }
    t.diagnostic(`${tag}: ${asks ? 'approval shown; command held' : 'command ran; no approval'}`);
  };
  await select(id);
  await command('legacy-full');
  assert.equal(await mode().getAttribute('aria-description'), 'Full access');
  await page.keyboard.press('Control+n'); await command('gui-full');
  const normal = await page.locator('.thread-row[aria-current="page"],.thread-row[aria-selected="true"],.thread-row.active').first().getAttribute('data-thread-id');
  await choose('Ask for approval'); await command('explicit-ask', true);
  const ownHeld = await command('explicit-pending', true, false, { hold: true });
  const setDefault = async label => { await openSettings(page, 'Configuration'); await chooseOption(page.getByLabel('Default permissions', { exact: true }), { label }); await page.getByText('Default permissions saved.', { exact: false }).waitFor(); await leaveSettings(page); };
  await setDefault('Ask for approval'); await select(id); const held = await command('inherited-ask', true, false, { hold: true });
  await setDefault('Full access'); await select(id);
  await released(held, 'inherited pending approval');
  t.diagnostic('pending inherited approval: Full access released the command');
  await command('inherited-full-again');
  await select(normal); assert.equal(await fs.stat(ownHeld).then(() => true, () => false), false);
  await deny().waitFor(); await deny().click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
  t.diagnostic('pending explicit Ask: stayed held after the default changed');
  await select(normal); await command('explicit-ask-kept', true);
  await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 });
  await select(normal); await command('reload-explicit-ask', true);
  await select(id); await command('reload-inherited-full');
  const { connectAppServer } = await import(path.join(repo, 'tools/elpis-claude/app-server-connection.mjs'));
  const { existingSocket } = await import(path.join(repo, 'apps/elpis-desktop/bridge/client.mjs'));
  const socket = existingSocket(undefined, { ELPIS_HOME: path.join(app.home, 'elpis'), XDG_RUNTIME_DIR: path.join(app.home, 'run') });
  const helper = connectAppServer({ url: `ws+unix://${socket}:/`, name: 'elpis-agents' });
  t.after(() => helper.close()); await helper.ready;
  const started = await helper.call('thread/start', { model: 'gpt-5.5', modelProvider: 'mock', cwd: work, elpisParentThreadId: id });
  assert.equal(started.approvalPolicy, 'never');
  assert.equal(started.sandbox.type, 'dangerFullAccess');
  assert.notEqual(started.activePermissionProfile?.id, ':bypass-permissions');
  await setDefault('Ask for approval');
  const helperAskDefault = await helper.call('thread/resume', { threadId: started.thread.id, excludeTurns: true });
  assert.equal(helperAskDefault.approvalPolicy, 'never', 'automatic helpers never ask under the Ask default');
  assert.equal(helperAskDefault.activePermissionProfile?.id, ':workspace', 'an existing helper follows the configured default scope');
  await setDefault('Full access');
  const helperFullDefault = await helper.call('thread/resume', { threadId: started.thread.id, excludeTurns: true });
  assert.equal(helperFullDefault.approvalPolicy, 'never');
  assert.equal(helperFullDefault.activePermissionProfile?.id, ':danger-full-access', 'the same helper follows Full access again');
  t.diagnostic('existing automatic helper: Ask scope then Full scope applied; approval stayed never');
  const helperCommand = async (connection, tag) => {
    const helperFile = path.join(root, tag), requests = [];
    const listener = message => { if (message.id !== undefined && message.method) requests.push(message); };
    connection.listeners.add(listener);
    try {
      await connection.call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: `PERMISSION_FILE:${helperFile}`, text_elements: [] }] });
      const deadline = Date.now() + 30000;
      while (!await fs.stat(helperFile).then(() => true, () => false)) { assert.equal(requests.length, 0, 'automatic helper never asks'); assert.ok(Date.now() < deadline, 'helper command ran'); await new Promise(r => setTimeout(r, 50)); }
      assert.equal(requests.length, 0);
    } finally { connection.listeners.delete(listener); }
    t.diagnostic(`${tag}: command ran; no approval request`);
  };
  await helperCommand(helper, 'helper-full');
  await page.keyboard.press('Control+n');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option').filter({ hasText: /haiku/i }).first().click();
  await command('claude-full', false, true);
  const claudeId = await page.locator('.thread-row.active').first().getAttribute('data-thread-id');
  await setDefault('Ask for approval'); await select(claudeId); const claudeHeld = await command('claude-inherited-ask', true, true, { hold: true });
  await setDefault('Full access'); await select(claudeId);
  await released(claudeHeld, 'Claude pending approval');
  t.diagnostic('pending Claude approval: Full access released the command through its normal permission hook');
  await command('claude-inherited-full', false, true);
  const modes = (await fs.readFile(path.join(root, 'acp.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(x => x.method === 'session/set_mode');
  assert.ok(modes.some(x => x.params.modeId === 'default'), 'Full access uses Claude permission checks with automatic answers');
  assert.equal(modes.some(x => x.params.modeId === 'bypassPermissions'), false, 'Full access never selects Bypass');
  const { createLoveAgents, loveNodeSpec } = await import(path.join(process.env.ELPIS_TEST_APP, 'app/bridge/love-agents.mjs'));
  for (const [tag, model, provider] of [['love-gpt', 'gpt-5.5', 'mock'], ['love-claude', 'claude/haiku', 'claude']]) {
    const file = path.join(root, tag);
    const card = { id: tag, type: 'rectangle', customData: { loveAgent: { name: tag, prompt: 'Run the requested command.', model, provider, task: `${provider === 'claude' ? '[permission] ' : ''}PERMISSION_FILE:${file}` } } };
    let scene = { elements: [card], files: {}, appState: {} };
    const runner = createLoveAgents({ read: async () => ({ scene }), save: async value => { scene = value; } }, {
      env: { ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE, ELPIS_HOME: path.join(app.home, 'elpis'), ELPIS_NODE_BIN: process.execPath },
      nodeSpec: (node, env) => { const spec = loveNodeSpec(node, env); return { ...spec, env: { ...spec.env, HOME: app.home, CODEX_HOME: path.join(app.home, 'elpis'), ELPIS_APP_BRIDGE_SOCKET: socket, XDG_RUNTIME_DIR: path.join(app.home, 'run') } }; },
    });
    try { await runner.run({ id: tag, cwd: work }); assert.equal(await fs.readFile(file, 'utf8'), 'permission-ran'); }
    finally { await runner.close(); }
    assert.equal(scene.elements[0].customData.loveAgent.permission, null);
    t.diagnostic(`${tag}: packaged Love Spot controller and provider ran the command without a question`);
  }
  const oldHome = app.home; await stopApp(app);
  app = await startApp({ app: process.env.ELPIS_TEST_APP, engine: process.env.ELPIS_TEST_ENGINE, port: Number(process.env.ELPIS_TEST_PORT || 9732), env: { ...extra, ELPIS_E2E_HOME: oldHome } });
  page = app.page; await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 });
  await select(id); await command('restart-inherited'); await select(normal); await command('restart-explicit-ask', true);
  await select(claudeId); await command('restart-claude', false, true);
  await select(normal); const restartOwnHeld = await command('restart-explicit-pending', true, false, { hold: true });
  await setDefault('Ask for approval'); await select(id); const restartHeld = await command('restart-inherited-pending', true, false, { hold: true });
  await setDefault('Full access'); await select(id); await released(restartHeld, 'restarted inherited pending approval');
  await select(normal); assert.equal(await fs.stat(restartOwnHeld).then(() => true, () => false), false);
  await deny().waitFor(); await deny().click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
  t.diagnostic('after restart: Full access released inherited approval; explicit Ask stayed held');
  await setDefault('Ask for approval'); await select(claudeId); const restartClaudeHeld = await command('restart-claude-pending', true, true, { hold: true });
  await setDefault('Full access'); await select(claudeId); await released(restartClaudeHeld, 'restarted Claude pending approval');
  t.diagnostic('after restart: Full access released the pending Claude approval');
  await setDefault('Ask for approval');
  const WebSocket = require('ws'), peer = new WebSocket(`ws+unix://${socket}:/`), peerPending = new Map(), peerRequests = [];
  t.after(() => peer.close());
  let peerSequence = 0;
  peer.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.method && message.id !== undefined) peerRequests.push(message);
    else if (peerPending.has(message.id)) { const pending = peerPending.get(message.id); peerPending.delete(message.id); message.error ? pending.reject(message.error) : pending.resolve(message.result); }
  });
  await once(peer, 'open');
  const peerCall = (method, params) => new Promise((resolve, reject) => { const requestId = `peer-${++peerSequence}`; peerPending.set(requestId, { resolve, reject }); peer.send(JSON.stringify({ id: requestId, method, params })); });
  await peerCall('initialize', { clientInfo: { name: 'elpis-native-permissions-test', version: '1' }, capabilities: { experimentalApi: true } });
  peer.send(JSON.stringify({ method: 'initialized' }));
  const peerStarted = await peerCall('thread/start', { model: 'gpt-5.5', modelProvider: 'mock', cwd: work });
  const peerFile = path.join(root, 'other-window-inherited-pending');
  await peerCall('turn/start', { threadId: peerStarted.thread.id, input: [{ type: 'text', text: `PERMISSION_FILE:${peerFile}`, text_elements: [] }] });
  const peerDeadline = Date.now() + 30000;
  while (!peerRequests.some(message => message.params?.threadId === peerStarted.thread.id)) { assert.equal(await fs.stat(peerFile).then(() => true, () => false), false); assert.ok(Date.now() < peerDeadline, 'the second native connection asks before its command'); await new Promise(r => setTimeout(r, 50)); }
  await setDefault('Full access');
  const peerReleased = Date.now() + 30000;
  while (!await fs.stat(peerFile).then(() => true, () => false)) { assert.ok(Date.now() < peerReleased, 'Full access releases inherited approval in another open native connection'); await new Promise(r => setTimeout(r, 50)); }
  t.diagnostic('another open native connection: Full access released its pending approval');
  const restartedHelper = connectAppServer({ url: `ws+unix://${socket}:/`, name: 'elpis-agents' });
  t.after(() => restartedHelper.close()); await restartedHelper.ready;
  const resumedHelper = await restartedHelper.call('thread/resume', { threadId: started.thread.id, excludeTurns: true });
  assert.deepEqual([resumedHelper.approvalPolicy, resumedHelper.activePermissionProfile?.id], ['never', ':danger-full-access']);
  await helperCommand(restartedHelper, 'restart-helper-full');
});
