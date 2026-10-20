'use strict';
// Remote TUI and a private websocket app-server, with an isolated home and local Responses fixture.
// Usage: node scripts/terminal-input.test.cjs /absolute/path/to/elpis [--bridge | --launcher | --codex-reference]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync, spawn } = require('node:child_process');
const { Provider, message, call } = require('./lib/mock-provider.js');
const binary = process.argv[2];
const queueClaudeDelivery = process.argv.includes('--queue-claude-delivery');
const queueCodeModeDelivery = process.argv.includes('--queue-code-mode-delivery');
const queueEmptyEnter = process.argv.includes('--queue-empty-enter');
const nativeCodeMode = queueCodeModeDelivery || queueEmptyEnter;
const queueClaude = process.argv.includes('--queue-claude-recall') || queueClaudeDelivery;
const delayedRecall = process.argv.includes('--queue-delayed-recall');
const useBridge = process.argv.includes('--bridge') || queueClaude;
const useLauncher = process.argv.includes('--launcher');
const reference = process.argv.includes('--codex-reference');
assert([useBridge, useLauncher, reference].filter(Boolean).length <= 1, 'choose one connection mode');
assert(binary && path.isAbsolute(binary), 'provide the engine binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-terminal-input-'));
const userHome = path.join(root, 'home');
const home = path.join(userHome, reference ? '.codex' : '.elpis-next');
const cwd = path.join(userHome, 'long-project-directory-for-title-visibility');
const otherCwd = path.join(userHome, 'second-project');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd); fs.mkdirSync(otherCwd);
if (!reference) {
  const codexHome = path.join(userHome, '.codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="codex-user-sentinel"\n[otel]\nexporter="none"\n');
}
const socket = path.join(root, 'tmux.sock');
const provider = new Provider();
const checks = [];
let savedPermissions, releaseTool;
let appServer, appServerExit, appServerError;
let recallProxy, delayedRecallReply, releaseRecallReply;
let proxiedSubmissions = 0;
let appServerLog = '';
const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const capture = (target = 'test') => tmux('capture-pane', '-p', '-t', target);
const composer = screen => screen.slice(screen.lastIndexOf('\n› '));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function screenWhen(predicate, label, target = 'test') {
  const deadline = Date.now() + 20000;
  let screen = '';
  while (Date.now() < deadline) {
    screen = capture(target);
    if (predicate(screen)) { fs.writeFileSync(path.join(root, `${label}.txt`), screen); fs.writeFileSync(path.join(root, `${label}.ansi`), tmux('capture-pane', '-p', '-e', '-t', target)); return screen; }
    await pause(100);
  }
  fs.writeFileSync(path.join(root, `${label}.txt`), screen);
  throw Error(`Timed out: ${label}; evidence ${root}`);
}
const type = (text, target = 'test') => tmux('send-keys', '-t', target, '-l', text);
const key = (name, target = 'test') => tmux('send-keys', '-t', target, name);
function pass(label) { checks.push(label); console.log(`PASS ${label}`); }
async function checkLedgerShortcuts(draft, label) {
  const requests = provider.requests.length;
  // Give the focused Ledger enough rows to expose its controls and selected source.
  tmux('resize-window', '-t', 'test', '-x', '150', '-y', '90');
  type(draft); await pause(250);
  for (const [open, close] of [['C-x', 'M-c'], ['M-c', 'C-x'], ['Tab', 'Tab']]) {
    key(open);
    await screenWhen(s => s.includes('CONTEXT LEDGER') && s.includes('Space/Enter'), `${label}-${open}-focused`);
    key(close);
    await screenWhen(s => !s.includes('CONTEXT LEDGER') && s.includes(draft), `${label}-${close}-closed`);
  }
  assert.equal(provider.requests.length, requests, 'Ledger shortcuts must not submit the draft');
  tmux('resize-window', '-t', 'test', '-x', '80', '-y', '32');
  pass(`Tab, Ctrl+X and Alt+C open and close the Ledger ${label}, preserving the draft`);
}
function threadSettings() {
  const filename = fs.readdirSync(home).find(name => /^state_\d+\.sqlite$/.test(name));
  if (!filename) return [];
  const db = new DatabaseSync(path.join(home, filename), { readOnly: true });
  try { return db.prepare('SELECT id, name, cwd, model, sandbox_policy, approval_mode, rollout_path FROM threads').all(); }
  finally { db.close(); }
}
async function startAppServer(env) {
  const bridgeLog = path.join(root, 'bridge.log');
  appServer = useBridge
    ? spawn(process.execPath, [process.env.ELPIS_BRIDGE_ENTRY ?? path.resolve(__dirname, '../tools/elpis-claude/acp-bridge.mjs')], {
      cwd, env: { ...env, PORT: '0', ELPIS_ENGINE_BIN: binary, ELPIS_NO_AGY: '1', ACP_BRIDGE_LOG: bridgeLog,
        ACP_ADAPTER: path.resolve(__dirname, queueClaude ? 'queue-steer-cancel.test.cjs' : 'permissions-bridge.test.cjs'),
        PERMISSION_FIXTURE_ADAPTER: '1', ...(queueClaude ? { QUEUE_STEER_FIXTURE_ADAPTER: '1',
          QUEUE_STEER_FIXTURE_ROOT: root, QUEUE_STEER_FIXTURE_AUTO_FINISH: queueClaudeDelivery ? '0' : '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn(binary, ['app-server', '--listen', reference ? 'unix://' : 'ws://127.0.0.1:0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  appServerExit = new Promise(resolve => appServer.once('exit', (code, signal) => resolve({ code, signal })));
  appServer.on('error', error => { appServerError = error; });
  const log = chunk => {
    appServerLog += chunk;
    fs.appendFileSync(path.join(root, 'app-server.log'), chunk);
  };
  appServer.stdout.on('data', log);
  appServer.stderr.on('data', log);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (appServerError) throw appServerError;
    if (appServer.exitCode !== null || appServer.signalCode !== null) throw Error(`App-server exited before startup; evidence ${root}`);
    const bridgePort = useBridge && fs.existsSync(bridgeLog)
      ? fs.readFileSync(bridgeLog, 'utf8').match(/LISTENING (\d+)/)?.[1] : null;
    const address = bridgePort ? `ws://127.0.0.1:${bridgePort}` : appServerLog.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (reference && fs.existsSync(path.join(home, 'app-server-control', 'app-server-control.sock'))) return 'unix://';
    if (address) return address;
    await pause(100);
  }
  throw Error(`Timed out: app-server startup; evidence ${root}`);
}
async function stopAppServer() {
  if (recallProxy) {
    for (const client of recallProxy.clients) client.terminate();
    await new Promise(resolve => recallProxy.close(resolve));
  }
  if (!appServer || appServerError) return;
  if (appServer.exitCode === null && appServer.signalCode === null) appServer.kill('SIGTERM');
  if (!await Promise.race([appServerExit, pause(5000).then(() => false)])) {
    appServer.kill('SIGKILL');
    await appServerExit;
  }
}
(async () => {
  await provider.start();
  if (process.argv.includes('--automatic-name')) {
    const serve = provider.server.listeners('request')[0];
    provider.server.removeAllListeners('request');
    provider.server.on('request', (req, res) => {
      if (req.url.includes('/unavailable-background/')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Fixture background provider is unavailable' } }));
      } else {
        serve(req, res);
      }
    });
  }
  const catalog = require('../codex-rs/models-manager/models.json');
  const model = catalog.models.find(model => model.slug === (nativeCodeMode ? 'gpt-6-astra' : 'gpt-5.5'));
  const otherModel = catalog.models.find(model => model.slug === 'gpt-6.1-sol');
  assert(model && otherModel, 'fixture models must exist');
  model.experimental_supported_tools = [...(model.experimental_supported_tools ?? []), 'request_user_input_async'];
  const catalogPath = path.join(home, 'models.json');
  fs.writeFileSync(catalogPath, JSON.stringify({ models: [model, otherModel] }));
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_reasoning_effort="medium"\nmodel_catalog_json=${JSON.stringify(catalogPath)}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Terminal fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[tui]\nanimations=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
  fs.appendFileSync(path.join(home, 'config.toml'), `[projects.${JSON.stringify(otherCwd)}]\ntrust_level="trusted"\n`);
  fs.appendFileSync(path.join(home, 'config.toml'), `[projects.${JSON.stringify(userHome)}]\ntrust_level="trusted"\n`);
  if (nativeCodeMode) {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('model="gpt-5.5"', 'model="gpt-6-astra"').replace('code_mode=false', queueCodeModeDelivery ? 'code_mode=true' : 'code_mode=false'));
  }
  if (process.argv.includes('--automatic-name')) {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, 'background_model="fixture-background"\nbackground_provider="unavailable-background"\n'
      + fs.readFileSync(configPath, 'utf8')
      + '\n[model_providers.unavailable-background]\nname="Unavailable local background fixture"\nbase_url='
      + JSON.stringify(provider.url + '/unavailable-background')
      + '\nwire_api="responses"\nrequires_openai_auth=false\n');
  }
  const isolatedEnv = { ...process.env, HOME: userHome, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home,
    ELPIS_SHARED_BRIDGE: '', ELPIS_BRIDGE_SOCKET: '', TERM: 'xterm-256color' };
  let remote = useLauncher ? null : await startAppServer(isolatedEnv);
  if (delayedRecall) {
    assert.ok(remote?.startsWith('ws://'), 'Delayed recall requires the private websocket fixture');
    const WebSocket = require('../tools/elpis-claude/node_modules/ws');
    const upstreamAddress = remote;
    recallProxy = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => recallProxy.once('listening', resolve));
    remote = `ws://127.0.0.1:${recallProxy.address().port}`;
    recallProxy.on('connection', downstream => {
      const upstream = new WebSocket(upstreamAddress);
      const queued = [];
      const recallIds = new Set();
      upstream.on('open', () => { for (const data of queued) upstream.send(data); });
      downstream.on('message', data => {
        data = data.toString();
        const message = JSON.parse(data.toString());
        if (message.method === 'turn/steer' || message.method === 'turn/start') proxiedSubmissions++;
        if (message.method === 'turn/steer/cancel') recallIds.add(message.id);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else queued.push(data);
      });
      upstream.on('message', data => {
        data = data.toString();
        const message = JSON.parse(data.toString());
        if (recallIds.delete(message.id) && !delayedRecallReply) {
          delayedRecallReply = message;
          releaseRecallReply = () => downstream.send(data);
        } else if (downstream.readyState === WebSocket.OPEN) downstream.send(data);
      });
      upstream.on('error', error => { appServerError = error; downstream.close(); });
      downstream.on('close', () => upstream.terminate());
    });
  }
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const command = (directory, selectedModel) => ['env', `HOME=${userHome}`, `CODEX_HOME=${home}`, `ELPIS_HOME=${home}`, `CODEX_AUTH_HOME=${home}`, 'ELPIS_SHARED_BRIDGE=', 'ELPIS_BRIDGE_SOCKET=', 'TERM=xterm-256color', ...(useLauncher ? [`ELPIS_ENGINE_BIN=${binary}`, 'ELPIS_NO_AGY=1', 'PERMISSION_FIXTURE_ADAPTER=1', `ACP_ADAPTER=${path.resolve(__dirname, 'permissions-bridge.test.cjs')}`, process.env.ELPIS_LAUNCHER ?? path.resolve(__dirname, '../tools/elpis-claude/elpis-claude')] : [binary]), ...(reference || useLauncher ? [] : ['--remote', remote]), '--no-alt-screen', '-C', directory, ...(selectedModel ? ['--model', selectedModel] : [])].map(quote).join(' ');
  tmux('new-session', '-d', '-s', 'test', '-x', '80', '-y', '32', command(cwd, queueClaude ? 'claude/haiku' : undefined));
  await screenWhen(s => {
    if (s.includes('Hooks need review')) { key('Escape'); return false; }
    return s.includes(reference ? 'Codex' : 'Elpis') && (queueClaude ? /haiku/i.test(s) : nativeCodeMode ? /gpt-6-astra/i.test(s) : /gpt-5[.]5/i.test(s));
  }, 'startup');
  provider.actions.push(message('PERMISSION_FIXTURE_READY'));
  type('Create this isolated fixture thread.'); await pause(250); key('Enter');
  await screenWhen(s => {
    const threads = threadSettings();
    if (queueClaude) return s.includes('PERMISSION_FIXTURE_READY') && !s.includes('esc to interrupt');
    if (threads.length !== 1 || s.includes('esc to interrupt')) return false;
    // The ledger can push a short completed reply above a 32-row viewport.
    return fs.readFileSync(threads[0].rollout_path, 'utf8').trim().split('\n')
      .some(line => { const item = JSON.parse(line); return item.type === 'event_msg' && item.payload?.type === 'task_complete'; });
  }, 'permissions-initial-thread');
  await screenWhen(() => threadSettings().some(thread => thread.name === 'Editor test session'), 'automatic-title-saved');
  if (!queueClaude) assert.equal(provider.titleRequests.length, 1, 'first task should generate one session name');
  assert(tmux('display-message', '-p', '-t', 'test', '#{pane_title}').includes('Editor test session'), 'generated name must reach the terminal title');
  if (!reference) {
    await screenWhen(s => s.includes('Editor test session'), 'automatic-title-visible-80');
    pass('automatic session name is saved and visible at 80 columns beside a long project path');
  }
  const initialPermissions = threadSettings();
  if (!reference) {
    key('Left');
    await screenWhen(s => s.includes('Agent command center') && s.includes('Editor test session'), 'automatic-title-agents');
    key('Escape');
    pass('generated conversation name appears in the agents view before any manual rename');
  }
  if (process.argv.includes('--automatic-name')) return;
  assert.equal(initialPermissions.length, 1);
  if (!queueClaude) assert.equal(initialPermissions[0].model, nativeCodeMode ? 'gpt-6-astra' : 'gpt-5.5', 'separate Codex user config must not override the model');
  assert(!tmux('capture-pane', '-p', '-S', '-', '-t', 'test').includes('Ignored unsupported project-local config keys'), 'Codex user config must not cause project warnings');
  assert.equal(initialPermissions[0].approval_mode, 'on-request');
  assert.notEqual(JSON.parse(initialPermissions[0].sandbox_policy).type, 'disabled');
  fs.writeFileSync(path.join(root, 'initial-permissions.json'), JSON.stringify(initialPermissions, null, 2));
  if (queueEmptyEnter) {
    let delivered;
    const ready = path.join(cwd, 'empty-enter-tool-ready');
    const release = path.join(cwd, 'empty-enter-tool-release');
    releaseTool = release;
    provider.actions.push(call('empty_enter_tool', 'exec_command', {
      cmd: `touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.05; done`, yield_time_ms: 30000,
    }), request => {
      delivered = request.input.filter(item => item.role === 'user').map(item => JSON.stringify(item.content));
      return message('EMPTY_ENTER_SENT_ONCE');
    });
    type('Hold this native tool.'); await pause(250); key('Enter');
    await screenWhen(() => fs.existsSync(ready), 'empty-enter-held-native-tool');
    type('EMPTY_ENTER_PENDING_93f'); await pause(250); key('Enter');
    await screenWhen(s => s.includes('Messages to be submitted after next tool call')
      && s.includes('EMPTY_ENTER_PENDING_93f') && !composer(s).includes('EMPTY_ENTER_PENDING_93f'), 'empty-enter-original-waiting');
    const requests = provider.requests.length;
    await pause(1000);
    assert.equal(provider.requests.length, requests, 'Steer remains waiting while the tool is held');
    assert(capture().includes('Messages to be submitted after next tool call'), 'Pending steer remains visible before empty Enter');
    if (process.argv.includes('--queue-escape-control')) key('Escape');
    else { key('Enter'); key('Enter'); }
    await screenWhen(s => s.includes('EMPTY_ENTER_SENT_ONCE')
      && !s.includes('Messages to be submitted after next tool call'), 'empty-enter-interrupts-and-delivers');
    assert.equal(provider.requests.length, requests + 1, 'Repeated empty Enter starts exactly one replacement turn');
    assert.equal(delivered.filter(item => item.includes('EMPTY_ENTER_PENDING_93f')).length, 1, 'Waiting input reaches inference exactly once');
    assert(!provider.error, provider.error?.message);
    pass(`${process.argv.includes('--queue-escape-control') ? 'Escape control' : 'Repeated empty Enter'} interrupts a held GPT-6-Astra native tool and delivers its waiting input exactly once`);
    return;
  }
  if (process.argv.includes('--queue-recall') || process.argv.includes('--queue-enter-recall') || queueClaude || queueCodeModeDelivery) {
    const queueWithEnter = process.argv.includes('--queue-enter-recall') || queueClaude || queueCodeModeDelivery;
    const waitingHeader = queueWithEnter
      ? 'Messages to be submitted after next tool call' : 'Queued follow-up inputs';
    const ready = queueClaude ? path.join(root, 'ready') : path.join(cwd, 'queue-tool-ready');
    const release = queueClaude ? path.join(root, 'release') : path.join(cwd, 'queue-tool-release');
    releaseTool = release;
    let delivered;
    const requestsBeforeRecall = provider.requests.length;
    key('Up');
    await screenWhen(s => composer(s).includes('Create this isolated fixture thread.'), 'queue-empty-history-recall');
    assert.equal(provider.requests.length, requestsBeforeRecall, 'Up without waiting inputs must not submit a message');
    key('C-u');
    const heldCommand = { cmd: `touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.05; done`, yield_time_ms: 30000 };
    if (!queueClaude) provider.actions.push(
      queueCodeModeDelivery ? { type: 'custom_tool_call', call_id: 'queue_tool', name: 'exec',
        input: `// @exec: {"yield_time_ms": 30000}\ntext(await tools.exec_command(${JSON.stringify(heldCommand)}));` } : call('queue_tool', 'exec_command', heldCommand),
      request => {
        delivered = request.input.filter(item => item.role === 'user').map(item => JSON.stringify(item.content));
        return message('QUEUE_SENT_ONCE');
      },
    );
    type('Keep this turn running.'); await pause(250); key('Enter');
    await screenWhen(() => fs.existsSync(ready), 'queue-running');
    const originalMessages = queueCodeModeDelivery ? ['QUEUE_FIRST_28c'] : ['QUEUE_FIRST_28c', 'QUEUE_SECOND_91b'];
    for (const text of originalMessages) {
      type(text); await pause(250); key(queueWithEnter ? 'Enter' : 'Tab');
      await screenWhen(s => s.includes(text) && s.includes(waitingHeader), 'queue-added-' + text);
    }
    type('CURRENT_DRAFT_62a'); await pause(250);
    if (queueCodeModeDelivery) {
      fs.writeFileSync(release, 'done');
      await screenWhen(s => s.includes('QUEUE_SENT_ONCE') && !s.includes('esc to interrupt'), 'ordinary-code-mode-enter-turn-completed');
      assert(delivered, 'Native inference must receive the original Enter messages');
      for (const text of originalMessages)
        assert.equal(delivered.filter(item => item.includes(text)).length, 1, `Original message consumed once: ${text}`);
      assert(delivered.every(item => !item.includes('CURRENT_DRAFT_62a')), 'Unsent composer draft must stay local');
      await screenWhen(s => !s.includes(waitingHeader) && composer(s).includes('CURRENT_DRAFT_62a'), 'ordinary-code-mode-enter-preview-cleared');
      assert(provider.requests.some(request => request.body.input.some(item => item.type === 'custom_tool_call_output'
        && item.call_id === 'queue_tool' && /Script running with cell ID/.test(item.output))), 'Real native code-mode execution must produce a cell receipt');
      pass('GPT-6-Astra code-mode Enter reaches the next native inference and clears its pending preview without recalling or submitting the draft');
      return;
    }
    if (queueClaudeDelivery) {
      fs.writeFileSync(release, 'done');
      const steeringPrompts = () => fs.readFileSync(path.join(root, 'provider-inputs.jsonl'), 'utf8').trim().split('\n')
        .map(JSON.parse).filter(row => row.method === '_session/steering').map(row => JSON.stringify(row.params.prompt));
      const deadline = Date.now() + 20_000;
      while (steeringPrompts().length < 2 && Date.now() < deadline) await pause(100);
      const prompts = steeringPrompts();
      assert.equal(prompts.length, 2, `Both original Enter messages must reach ACP; evidence ${root}`);
      assert.equal(prompts.filter(text => text.includes('QUEUE_FIRST_28c')).length, 1);
      assert.equal(prompts.filter(text => text.includes('QUEUE_SECOND_91b')).length, 1);
      assert(prompts.every(text => !text.includes('CURRENT_DRAFT_62a')), 'Unsent composer draft must stay local');
      await screenWhen(s => !s.includes(waitingHeader) && !s.includes('Queued follow-up inputs')
        && composer(s).includes('CURRENT_DRAFT_62a'), 'ordinary-enter-delivered-preview-cleared');
      fs.writeFileSync(path.join(root, 'finish'), 'done');
      await screenWhen(s => s.includes('QUEUE_FIXTURE_COMPLETE') && !s.includes('esc to interrupt'), 'ordinary-enter-turn-completed');
      pass('Ordinary Enter delivers both original Claude steers and clears their pending preview without recalling or submitting the draft');
      return;
    }
    key('Up');
    const editedDraft = delayedRecall ? 'CURRENT_DRAFT_62a_WHILE_ACK_PENDING_EDITED' : 'CURRENT_DRAFT_62a_EDITED';
    if (delayedRecall) {
      const deadline = Date.now() + 20000;
      while (!delayedRecallReply && Date.now() < deadline) await pause(100);
      assert.ok(delayedRecallReply, 'Cancellation acknowledgment reached the isolated proxy');
      assert.equal(delayedRecallReply.result.cancelledClientUserMessageIds.length, 2, 'Both pending inputs canceled before delayed acknowledgment');
      type('_WHILE_ACK_PENDING'); await pause(250);
      await screenWhen(s => composer(s).includes('CURRENT_DRAFT_62a_WHILE_ACK_PENDING') && !composer(s).includes('QUEUE_FIRST_28c'), 'queue-draft-edited-before-ack');
      const submissionsBeforeEarlyEnter = proxiedSubmissions;
      key('Enter'); key('Tab');
      await screenWhen(s => s.includes('Recalling waiting messages')
        && composer(s).includes('CURRENT_DRAFT_62a_WHILE_ACK_PENDING'), 'queue-early-enter-preserves-draft');
      assert.equal(proxiedSubmissions, submissionsBeforeEarlyEnter, 'Enter and Tab before recall acknowledgment must not submit separately');
      releaseRecallReply();
    }
    await screenWhen(s => !s.includes('Queued follow-up inputs') && !s.includes(waitingHeader)
      && ['QUEUE_FIRST_28c', 'QUEUE_SECOND_91b', 'CURRENT_DRAFT_62a'].every(text => composer(s).includes(text)), 'queue-recalled-together');
    key('End'); type('_EDITED'); await pause(250);
    if (!queueWithEnter) {
      key('Tab');
      const screen = await screenWhen(s => s.includes('Queued follow-up inputs')
        && s.includes(editedDraft), 'queue-replaced');
      for (const text of ['QUEUE_FIRST_28c', 'QUEUE_SECOND_91b']) {
        assert.equal(screen.split(text).length - 1, 1, 'requeue must not retain original: ' + text);
      }
      key('Up');
    }
    key('Enter'); await pause(400);
    fs.writeFileSync(release, 'done');
    await screenWhen(s => s.includes('QUEUE_SENT_ONCE') && !s.includes('esc to interrupt'), 'queue-delivered');
    if (queueClaude) {
      delivered = fs.readFileSync(path.join(root, 'provider-inputs.jsonl'), 'utf8').trim().split('\n')
        .map(JSON.parse).filter(row => row.method === '_session/steering')
        .map(row => JSON.stringify(row.params.prompt));
      assert.equal(delivered.length, 1, 'Claude must receive exactly one edited steering prompt');
    }
    for (const text of ['QUEUE_FIRST_28c', 'QUEUE_SECOND_91b', editedDraft]) {
      assert.equal(delivered.join('\n').split(text).length - 1, 1, 'model must receive each edited part exactly once');
    }
    assert(delivered.some(text => text.includes('QUEUE_FIRST_28c') && text.includes('QUEUE_SECOND_91b')
      && text.includes(editedDraft)), 'model must receive one combined edited message');
    pass('Up moves all queued inputs and the draft into one editable message without duplicates');
    return;
  }
  if (!reference) {
    await checkLedgerShortcuts('LEDGER_IDLE_DRAFT_x7', 'idle');
    key('C-u');
  }
  if (reference) { type('/permissions'); await pause(250); key('Enter'); }
  else { key('BTab'); }
  let permissionsScreen = await screenWhen(s => s.includes('Update Model Permissions') && s.includes('Full Access'), 'permissions-picker');
  if (reference) {
    for (let move = 0; move < 5 && !permissionsScreen.split('\n').some(line => /^\s*›.*Full Access/.test(line)); move++) {
      key('Down'); await pause(150); permissionsScreen = capture();
    }
    assert(permissionsScreen.split('\n').some(line => /^\s*›.*Full Access/.test(line)), permissionsScreen);
    key('Enter');
  } else {
    key('Escape');
    await screenWhen(s => !s.includes('Update Model Permissions'), 'permissions-picker-cancelled');
    key('BTab');
    await screenWhen(s => s.includes('Permissions updated to Approve for me'), 'shift-tab-auto-review');
    key('BTab');
    await screenWhen(s => s.includes('Enable full access?'), 'shift-tab-full-access-cancel');
    key('Escape');
    await screenWhen(s => !s.includes('Enable full access?'), 'shift-tab-confirmation-cancelled');
    const cancelled = threadSettings()[0];
    assert.equal(cancelled.approval_mode, 'on-request', 'cancelling Full Access must preserve approval');
    assert.notEqual(JSON.parse(cancelled.sandbox_policy).type, 'disabled', 'cancelling Full Access must preserve the sandbox');
    key('BTab');
    pass('Shift+Tab visibly cycles permissions; cancelling Full Access preserves restrictions and releases the shortcut');
  }
  let confirmation = await screenWhen(s => s.includes('Enable full access?') && s.includes('Yes, continue anyway'), 'full-access-confirmation');
  for (let move = 0; move < 3 && !confirmation.split('\n').some(line => /^\s*›.*Yes, continue anyway/.test(line)); move++) {
    key('Down'); await pause(150); confirmation = capture();
  }
  assert(confirmation.split('\n').some(line => /^\s*›.*Yes, continue anyway/.test(line)), confirmation);
  key('Enter');
  await screenWhen(s => {
    savedPermissions = threadSettings();
    return savedPermissions.length === 1 && savedPermissions[0].approval_mode === 'never' && JSON.parse(savedPermissions[0].sandbox_policy).type === 'disabled'
      && (reference || s.includes('Permissions updated to Full Access'));
  }, 'full-access-applied');
  fs.writeFileSync(path.join(root, 'saved-permissions.json'), JSON.stringify(savedPermissions, null, 2));
  pass(`${reference ? '/permissions' : 'Shift+Tab'} Full Access saves disabled sandbox and never approval in the engine thread`);
  const ready = path.join(cwd, 'tool-ready'), release = path.join(cwd, 'tool-release');
  releaseTool = release;
  const protectedDir = path.join(cwd, '.git');
  fs.mkdirSync(protectedDir);
  const protectedSentinel = path.join(protectedDir, 'full-access-sentinel');
  const steering = 'STEER_BOUNDARY_d128';
  let deliveredAtBoundary;
  provider.actions.push(
    call('running_tool_fixture', 'exec_command', { cmd: `printf 'full-access' > '${protectedSentinel}'; touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.05; done`, ...(reference ? {} : { sandbox_permissions: 'require_escalated', justification: 'Fixture checks the selected Full Access mode.' }), yield_time_ms: 10000 }),
    request => {
      deliveredAtBoundary = request.input.some(item => item.role === 'user' && JSON.stringify(item.content).includes(steering));
      return call('question_fixture', 'request_user_input_async', { questions: [{ title: 'Choose a fixture color', options: ['Amber', 'Blue'] }] });
    },
    { hang: true },
  );
  type('Ask the fixture question.'); await pause(250); key('Enter');
  await screenWhen(() => fs.existsSync(ready), 'running-tool');
  assert.equal(fs.readFileSync(protectedSentinel, 'utf8'), 'full-access');
  const rollout = fs.readFileSync(savedPermissions[0].rollout_path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const turnContext = rollout.findLast(item => item.type === 'turn_context')?.payload;
  assert.equal(turnContext?.approval_policy, 'never', 'the actual tool turn must use never approval');
  assert.equal(turnContext?.sandbox_policy?.type, 'danger-full-access', 'the actual tool turn must use Full Access');
  assert(!capture().includes('Would you like to run'), 'redundant escalation under Full Access must not show an approval popup');
  pass('Full Access reaches the actual tool turn and writes protected workspace metadata without approval');
  if (!reference) await checkLedgerShortcuts(steering, 'during-tool');
  else { type(steering); await pause(250); }
  key('Enter'); await pause(400);
  fs.writeFileSync(path.join(root, 'steering-during-tool.txt'), capture());
  fs.writeFileSync(release, 'continue');
  let screen = await screenWhen(s => s.includes('to answer'), 'collapsed-question');
  assert.equal(deliveredAtBoundary, true, 'Enter must reach the next inference request after the tool finishes');
  await screenWhen(s => !s.includes('Messages to be submitted after next tool call')
    && s.split(steering).length - 1 === 1 && !composer(s).includes(steering), 'ordinary-enter-native-preview-cleared');
  pass('Enter delivers steering at the next tool boundary');
  assert(screen.includes('shift+← to answer'), screen);
  key('S-Left');
  screen = await screenWhen(s => s.includes('main prompt') && s.includes('Choose a fixture color'), 'expanded-question');
  pass('Codex Shift+Left opens the question');
  key('S-Right'); key('Escape');
  await screenWhen(s => !s.includes('esc to interrupt'), 'interrupted');
  type('/rename Visible session sentinel'); await pause(250); key('Enter');
  await screenWhen(s => threadSettings().some(thread => thread.name === 'Visible session sentinel')
    && !s.includes('/rename Visible session sentinel'), 'renamed-title-80');
  await screenWhen(() => fs.readFileSync(savedPermissions[0].rollout_path, 'utf8').split('\n').slice(0, -1)
    .some(line => { const item = JSON.parse(line); return item.type === 'event_msg' && item.payload?.type === 'turn_aborted'; }), 'first-turn-aborted');
  // Interrupt may precede the follow-up inference request. Discard responses reserved for that turn.
  provider.actions.length = 0;
  // A later session in another folder proves grouping, ordering, and per-row models.
  provider.actions.push(message('SECOND_FOLDER_READY'));
  tmux('new-session', '-d', '-s', 'second', '-x', '80', '-y', '32', command(otherCwd, otherModel.slug));
  await screenWhen(s => {
    if (s.includes('Hooks need review')) { key('Escape', 'second'); return false; }
    return s.includes(otherModel.display_name);
  }, 'second-startup', 'second');
  type('Create the second folder fixture.', 'second'); await pause(250); key('Enter', 'second');
  await screenWhen(s => s.includes('SECOND_FOLDER_READY') && !s.includes('esc to interrupt'), 'second-complete', 'second');
  type('/rename Second folder sentinel', 'second'); await pause(250); key('Enter', 'second');
  await screenWhen(s => threadSettings().some(thread => thread.name === 'Second folder sentinel')
    && !s.includes('/rename Second folder sentinel'), 'second-renamed', 'second');
  key('Left');
  const firstTitlePrefix = 'Visible session';
  screen = await screenWhen(s => s.includes('Agent command center') && s.includes(firstTitlePrefix) && s.includes('Second folder sentinel'), 'agents-80');
  assert(screen.includes('Group: Project'), screen);
  const lines = screen.split('\n');
  const secondGroup = lines.findIndex(line => line.includes('second-project'));
  const firstGroup = lines.findIndex(line => line.includes(path.basename(cwd)));
  const secondTask = lines.findIndex(line => line.includes('Second folder sentinel'));
  const firstTask = lines.findIndex(line => line.includes(firstTitlePrefix));
  assert(firstGroup >= 0 && firstGroup < firstTask && firstTask < secondGroup && secondGroup < secondTask, screen);
  if (!reference) {
    assert(lines[firstTask].includes('GPT-5.5'), screen);
    assert(lines[secondTask].includes(otherModel.display_name), screen);
  }
  pass('Left lists tasks beneath their folders, in Codex project order');
  if (!reference) pass('each task retains its own selected model');
  tmux('resize-window', '-t', 'test', '-x', '40', '-y', '32');
  screen = await screenWhen(s => s.includes('Agent command center') && (reference ? s.includes('Visible') : s.includes('GPT-5.5')), 'agents-40');
  assert(screen.includes('Visible'), 'the task title stays visible beside its model');
  pass(reference ? 'task name remains visible at 40 columns' : 'model and task name remain visible at 40 columns');
  tmux('resize-window', '-t', 'test', '-x', '80', '-y', '32');
  key('?');
  screen = await screenWhen(s => s.includes('Rename') && s.includes('Delete'), 'agents-help');
  pass('native agents help exposes rename and delete shortcuts');
  key('Escape'); key('BSpace');
  await screenWhen(s => s.includes('Permanently delete'), 'delete-confirmation');
  key('Escape');
  await screenWhen(s => s.includes(firstTitlePrefix), 'delete-cancelled');
  assert(threadSettings().some(thread => thread.id === savedPermissions[0].id && thread.name === 'Visible session sentinel'));
  pass('cancelling task deletion preserves the fixture session');
  if (!reference) {
    // Exercise the actual /resume picker, not the separate Left-arrow agents view.
    const disposable = threadSettings().find(thread => thread.name === 'Second folder sentinel');
    assert(disposable, 'isolated second session exists before deletion');
    tmux('kill-session', '-t', 'second');
    key('Escape');
    type('/resume'); await pause(250); key('Enter');
    await screenWhen(s => s.includes('Resume') && s.includes('Visible session sentinel'), 'resume-picker');
    key('Right'); // Filter toolbar starts focused; toggle Cwd to All.
    await screenWhen(s => s.includes('Second folder sentinel'), 'resume-all-folders');
    type('Second folder sentinel'); await pause(400);
    await screenWhen(s => s.includes('Second folder sentinel') && !s.includes('Visible session sentinel'), 'resume-search');
    key('BSpace'); await pause(250);
    assert(!capture().includes('Delete session?'), 'Backspace must edit a nonempty search');
    tmux('send-keys', '-t', 'test', '-N', String('Second folder sentinel'.length - 1), 'BSpace');
    await pause(400);
    await screenWhen(s => s.includes('Second folder sentinel') && s.includes('Visible session sentinel'), 'resume-search-cleared');
    // Native updated-at ordering may change while a fixture closes. Select by title.
    for (let move = 0; move < 3 && !capture().split('\n').some(line => /^\s*›.*Second folder sentinel/.test(line)); move++) {
      key('Down'); await pause(150);
    }
    assert(capture().split('\n').some(line => /^\s*›.*Second folder sentinel/.test(line)), capture());
    const requests = provider.requests.length;
    key('BSpace');
    await screenWhen(s => s.includes('Delete session?') && s.includes('Second folder sentinel'), 'resume-delete-confirmation');
    key('Escape');
    await screenWhen(s => !s.includes('Delete session?') && s.includes('Second folder sentinel'), 'resume-delete-cancelled');
    assert(threadSettings().some(thread => thread.id === disposable.id), 'cancel preserves saved chat');
    assert(fs.existsSync(disposable.rollout_path), 'cancel preserves saved history');
    pass('/resume Backspace edits search; empty-search delete confirmation can be cancelled');
    key('BSpace');
    await screenWhen(s => s.includes('Delete session?'), 'resume-delete-confirm-again');
    key('y');
    await screenWhen(s => !s.includes('Delete session?') && !s.includes('Second folder sentinel')
      && s.includes('Visible session sentinel'), 'resume-delete-complete');
    assert(!threadSettings().some(thread => thread.id === disposable.id), 'confirmed delete removes only target index row');
    assert(!fs.existsSync(disposable.rollout_path), 'confirmed delete removes target saved history');
    assert(threadSettings().some(thread => thread.id === savedPermissions[0].id), 'other session survives');
    assert.equal(provider.requests.length, requests, 'picker deletion makes no inference requests');
    pass('/resume confirmed deletion removes isolated saved chat and preserves the other session');
  }
  assert(!provider.error, provider.error?.message);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (releaseTool) fs.writeFileSync(releaseTool, 'cleanup');
  try { tmux('kill-server'); } catch {}
  await stopAppServer();
  if (useLauncher) {
    const { runtimeDir, startToken } = await import('../tools/elpis-claude/shared-runtime.mjs');
    const stateFile = runtimeDir(home).state;
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (startToken(state.pid) === state.token) process.kill(state.pid, 'SIGTERM');
    }
  }
  provider.close();
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ useBridge, reference, checks, savedPermissions, requests: provider.requests, titleRequests: provider.titleRequests, appServerExit: appServer && !appServerError ? await appServerExit : null }, null, 2));
  console.log(`Evidence: ${root}`);
});
