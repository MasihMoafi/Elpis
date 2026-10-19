import { chooseOption, controlValue } from "./controls.cjs";
// APP-FIX-2 acceptance: real native runtime + real browser; only inference is a local fixture.
// Usage: ELPIS_PLAYWRIGHT_PACKAGE=... ELPIS_CHROMIUM=... node tests/app-fix-2.runtime.mjs /abs/elpis-next [--shots DIR]
// Each check runs independently and is reported; any failure exits non-zero.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../bridge/server.mjs';
import WebSocket from 'ws';
import { createTools } from '../bridge/tools.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'Provide an absolute Elpis executable');
const shots = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
const designOnly = process.argv.includes('--only-design');
const modelsOnly = process.argv.includes('--only-models');
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-app-fix-2-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'workspace'), agentCwd = path.join(root, 'agent-folder');
for (const dir of [home, cwd, agentCwd]) await fs.mkdir(dir);
delete process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY_COMPANY = 'company-key-not-shown';
const SECRET = 'sk-fixture-secret-4242';

// Inference fixture: routes root vs child requests, supports tool calls and hanging responses.
const message = text => ({ type: 'message', id: `msg_${Math.random().toString(36).slice(2)}`, role: 'assistant', content: [{ type: 'output_text', text }] });
const exec = (id, cmd, escalate = false) => request => {
  const tool = (request.tools || []).find(t => t.name === 'exec_command' || t.name === 'shell_command');
  assert(tool, 'runtime must advertise a command tool');
  return { type: 'function_call', id: `fc_${id}`, call_id: id, name: tool.name, arguments: JSON.stringify({ [tool.name === 'exec_command' ? 'cmd' : 'command']: cmd, ...(escalate ? { sandbox_permissions: 'require_escalated', justification: 'Fixture approval probe.' } : {}) }) };
};
const spawnChild = request => {
  const tools = (request.tools || []).flatMap(t => t.type === 'namespace' ? t.tools.map(c => ({ ...c, namespace: t.name })) : [t]);
  const tool = tools.find(t => t.name === 'spawn_agent'); assert(tool, 'native spawn_agent must be advertised');
  const item = { type: 'function_call', id: 'fc_spawn', call_id: 'spawn_fixture', name: tool.name, arguments: JSON.stringify({ task_name: 'failure_reporting', fork_turns: 'none', message: 'CHILD_TASK_4242: report failures. Read only.' }) };
  if (tool.namespace) item.namespace = tool.namespace;
  return item;
};
const HANG = { hang: true };
// Replies are keyed by the marker in the latest user message, so compaction or title requests cannot take them.
const fixture = { requests: [], keyed: new Map(), child: [], hanging: new Set(), titles: 0, error: null };
const roleOf = body => (body.input || []).some(i => i.type === 'agent_message' && String(i.recipient || '').startsWith('/root/')) ? 'child' : 'root';
const latestUser = body => { const users = (body.input || []).filter(i => i.type === 'message' && i.role === 'user'); return JSON.stringify(users.at(-1)?.content ?? ''); };
const reply = (marker, ...actions) => fixture.keyed.set(marker, actions);
const requestsWith = marker => fixture.requests.filter(r => r.latest.includes(marker));
const inferenceHandler = async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = item => {
      const id = `response_${fixture.requests.length}_${fixture.titles}`; const events = [{ type: 'response.created', response: { id } }];
      if (item.type === 'message') {
        events.push({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
        events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
      }
      events.push({ type: 'response.output_item.done', output_index: 0, item });
      events.push({ type: 'response.completed', response: { id, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } } });
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    };
    if (body.text?.format?.schema?.required?.includes('title')) {
      fixture.titles++;
      const first = JSON.stringify(body.input || []).match(/(SPAWN|AGENT_TASK|EXISTING|APPROVE)_4242/)?.[1] || 'Fixture';
      return send(message(JSON.stringify({ title: `${first.toLowerCase().replace('_', ' ')} task` })));
    }
    const role = roleOf(body), latest = latestUser(body); fixture.requests.push({ role, body, latest, authorization: req.headers.authorization, endpointPort: req.socket.localPort });
    if (JSON.stringify(body.input).includes('CONTEXT CHECKPOINT')) return send(message('The preceding fixture task completed. Continue with the latest user request.'));
    const marker = [...fixture.keyed.keys()].find(key => latest.includes(key) && fixture.keyed.get(key).length);
    let action = (marker ? fixture.keyed.get(marker) : role === 'child' ? fixture.child : []).shift() ?? message(`${role.toUpperCase()}_DEFAULT_REPLY`);
    if (['workflow/custom-a','workflow/custom-b'].includes(body.model)) {
      const source = JSON.stringify(body.input), graphId = source.match(/Graph ID: ([^\\\s"]+)/)?.[1], taskId = source.match(/Task ID: ([^\\\s"]+)/)?.[1];
      assert.ok(graphId && taskId, 'Inference must belong to an assigned workflow task');
      const evidence = `APP_WORKFLOW_ROUTE_EVIDENCE_${taskId}`;
      action = source.includes(evidence) ? message('Worker complete') : { type: 'function_call', call_id: `report_${taskId}`, name: 'report_agent_work_task', arguments: JSON.stringify({ graph_id: graphId, task_id: taskId, outcome: 'succeeded', summary: `Completed ${taskId} local route`, changed_files: [], checks: ['Checked assigned local fixture route'], evidence: [evidence], risks: [], edge_cases_considered: ['Provider-specific bearer and custom model'], open_questions: [], what_i_did_not_check: ['Paid provider inference'] }) };
    }
    if (action.hang) { fixture.hanging.add(res); res.on('close', () => fixture.hanging.delete(res)); return; }
    if (action.gate) { fixture.gated = true; await action.gate; return send(action.item); }
    send(typeof action === 'function' ? action(body) : action);
  } catch (error) { fixture.error ??= error; res.writeHead(500); res.end(String(error.message)); }
};
const server = http.createServer(inferenceHandler), workflowServer = http.createServer(inferenceHandler);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
workflowServer.listen(0, '127.0.0.1'); await once(workflowServer, 'listening');
const providerUrl = `http://127.0.0.1:${server.address().port}/v1`;
const workflowProviderUrl = `http://127.0.0.1:${workflowServer.address().port}/v1`;

const catalog = require('../../../codex-rs/models-manager/models.json');
const models = ['gpt-5.5', 'gpt-6-luna'].map(slug => ({ ...structuredClone(catalog.models.find(m => m.slug === slug)), multi_agent_version: 'v2' }));
await fs.writeFile(path.join(home, 'models.json'), JSON.stringify({ models }));
await fs.writeFile(path.join(home, 'hooks.json'), '{}');
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"
model_provider="fixture"
model_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}
approval_policy="on-request"
sandbox_mode="workspace-write"
[features]
code_mode=false
multi_agent=true
multi_agent_v2=true
worktrees=false
automatic_context_pruning=false
[agents]
max_threads=3
[model_providers.fixture]
name="Local app fixture"
base_url=${JSON.stringify(providerUrl)}
wire_api="responses"
requires_openai_auth=false
[model_providers.workflow-a]
name="Workflow endpoint A"
base_url=${JSON.stringify(providerUrl)}
wire_api="responses"
requires_openai_auth=false
experimental_bearer_token="fixture-workflow-a-4242"
[model_providers.workflow-b]
name="Workflow endpoint B"
base_url=${JSON.stringify(workflowProviderUrl)}
wire_api="responses"
requires_openai_auth=false
experimental_bearer_token="fixture-workflow-b-4242"
[model_providers.openrouter]
name="OpenRouter"
base_url="https://openrouter.ai/api/v1"
env_key="OPENROUTER_API_KEY"
wire_api="responses"
[model_providers.local-lm]
name="LM Studio"
base_url="http://127.0.0.1:1234/v1"
wire_api="responses"
requires_openai_auth=false
[mcp_servers.rag]
command="/bin/true"
args=["rag-mcp-fixture"]
enabled=false
[mcp_servers.rag.env]
RAG_MCP_BACKEND="lancedb"
RAG_MCP_MAX_TOKENS="1234"
OPENROUTER_API_KEY=${JSON.stringify(SECRET)}
[mcp_servers.whispertype]
command="/bin/true"
enabled=false
env_vars=["OPENROUTER_API_KEY_COMPANY"]
[mcp_servers.whispertype.env]
WHISPERTYPE_BACKEND="openrouter"
WHISPERTYPE_CLOUD_MODEL="openai/gpt-4o-mini-transcribe"
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
[projects.${JSON.stringify(agentCwd)}]
trust_level="trusted"
`);
// The rag CLI is Masih's real tool; the app reaches it through createTools, so stub only that process.
const ragCalls = [];
const fakeRun = async (command, args) => {
  ragCalls.push([command, ...args]);
  const key = `${command} ${args.join(' ')}`;
  if (key === 'rag capabilities --json') return JSON.stringify({ stages: [
    { stage: 'embedding', provider: 'openai_compatible', model: 'qwen/qwen3-embedding-4b', location: 'api', required_credential: 'openrouter_key' },
    { stage: 'reranking', provider: 'openrouter', model: 'cohere/rerank-4-fast', location: 'api', required_credential: 'openrouter_key' },
    { stage: 'generation', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', location: 'api', required_credential: 'openrouter_key' }] });
  if (key === 'rag doctor --json') return JSON.stringify({ detected: { api_keys: ['openrouter'], ollama: { running: false } }, embedding: { provider: 'openai_compatible', model: 'qwen/qwen3-embedding-4b' } });
  if (command === 'rag' && args[0] === 'config') return 'ok\n';
  throw new Error(`Unexpected CLI call in fixture: ${key}`);
};

const socketPath = path.join(root, 'runtime.sock');
const child = spawn(binary, ['app-server', '--listen', `unix://${socketPath}`], { cwd,
  env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', app, browser, page;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const exited = once(child, 'exit');
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(100); }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, run) {
  if (modelsOnly && !/^(child approval|titles-not-nicknames|writable child chat|existing chat|a chat working|model and effort change)/.test(name)) return;
  if (designOnly && !/^(child approval|titles-not-nicknames)/.test(name)) return;
  try { await run(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) {
    results.push({ name, ok: false, error: String(error.message).split('\n')[0] }); console.log(`FAIL ${name}: ${String(error.message).split('\n')[0]}`);
    await page?.screenshot({ path: path.join(root, `failed-${results.length}.png`) }).catch(() => {});
    await page?.keyboard.press('Escape').catch(() => {});
  }
}
async function shoot(name, { mobileSidebar = false } = {}) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  // The app's own theme button is used; with a modal dialog open its classes are set directly instead.
  const theme = async dark => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' }); await wait(150);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), dark, 'app follows the system theme');
  };
  for (const variant of ['light', 'dark']) {
    await theme(variant === 'dark'); await wait(250);
    await page.screenshot({ path: path.join(shots, `${name}-desktop-${variant}.png`) });
    await page.setViewportSize({ width: 390, height: 844 }); await wait(300);
    if (mobileSidebar) await page.getByRole('button', { name: 'Open sidebar' }).click();
    await wait(200);
    await page.screenshot({ path: path.join(shots, `${name}-mobile-${variant}.png`) });
    if (mobileSidebar) await page.getByRole('button', { name: 'Close sidebar' }).click();
  }
  await theme(false); await wait(150);
}
const api = (url, body) => page.evaluate(async ({ url, body }) => {
  const response = await fetch(`/api${url}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}, { url, body });
const composer = () => page.getByLabel('Message Elpis', { exact: true });
async function send(text) { await composer().fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
const requestsOf = role => fixture.requests.filter(r => r.role === role);
// Settings is in the account menu at the sidebar's bottom (Claude's account row), not a button of its own.
const nav = name => name === 'Settings'
  ? { click: async () => { await page.locator('aside.sidebar .account-row').click(); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); } }
  : page.locator('aside.sidebar').getByRole('button', { name, exact: true });
const childTitleFor = approval => approval.thread ? (approval.thread.name || approval.thread.preview || humanTask(approval.thread.source?.subAgent?.thread_spawn?.agent_path)) : '';
const humanTask = agentPath => { const task = String(agentPath || '').split('/').filter(Boolean).at(-1)?.replace(/[_-]+/g, ' ') || ''; return task ? task[0].toUpperCase() + task.slice(1) : ''; };

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Runtime exited: ' + logs);
    try { await fs.stat(socketPath); break; } catch {}
    await wait(100);
  }
  await fs.chmod(socketPath, 0o600);
  const startApp = async () => startDesktopServer({ staticDir: path.join(appRoot, 'out'), socketPath: await fs.realpath(socketPath), tools: createTools({ run: fakeRun }) });
  app = await startApp();
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] }); page.setDefaultTimeout(12000); page.setDefaultTimeout(12000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  let loads = 0; page.on('load', () => { loads++; });
  await page.goto(app.url); await page.getByText('Local workspace', { exact: true }).waitFor();

  // Setup: one root conversation that spawns one real multi-agent v2 child.
  const marker = path.join(root, 'child-approved.txt');
  reply('SPAWN_4242', spawnChild, message('ROOT_SPAWN_DONE_4242'));
  fixture.child.push(exec('child_approval', `printf approved > '${marker}'`, true), exec('child_sleep', 'sleep 8'), HANG);
  await send('SPAWN_4242 spawn the fixture child');
  await page.getByText('ROOT_SPAWN_DONE_4242', { exact: true }).waitFor({ timeout: 30000 });
  await until(() => requestsOf('child').length >= 1, 'child started', 30000);
  const roots = (await api('/threads?limit=20')).body.data;
  const rootThread = roots.find(t => t.preview?.includes('SPAWN_4242'));
  assert(rootThread, 'root conversation listed');
  let childThread;
  await until(async () => { childThread = (await api(`/threads?ancestorThreadId=${rootThread.id}&limit=20`)).body.data?.[0]; return !!childThread; }, 'child listed');
  assert(childThread.agentNickname, 'native child has a nickname');
  const childTitle = childThread.name || childThread.preview || humanTask(childThread.source?.subAgent?.thread_spawn?.agent_path);
  assert.equal(childTitle, 'Failure reporting');

  await check('child approval is answered from the app (expanded, with session option)', async () => {
    await page.getByRole('button', { name: /^Needs input \(1\)$/ }).click();
    const panel = page.locator('.approval').filter({ hasText: 'printf approved' });
    await panel.waitFor({ timeout: 15000 });
    assert.match(await panel.locator('pre').innerText(), /printf approved/, 'command is visible without expanding');
    // Every decision Elpis offers is a button: never "allow once" only when more is offered.
    const pending = await page.evaluate(() => new Promise(resolve => { const events = new EventSource('/api/events'); events.addEventListener('approval', event => { events.close(); resolve(JSON.parse(event.data)); }); }));
    const offered = pending.params.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
    console.log('offered decisions:', JSON.stringify(offered));
    assert.equal(await panel.getByRole('button').count(), offered.length, 'one button per offered decision');
    assert.equal(await panel.getByRole('button', { name: /^Always allow|Allow for this session/ }).count(), offered.filter(d => d === 'acceptForSession' || typeof d === 'object').length);
    assert.equal(await page.locator('.pending-input-panel').getByText(childTitleFor(pending), { exact: true }).count() > 0, true, 'requester named by its task');
    await shoot('approval');
    await panel.getByRole('button', { name: 'Allow once', exact: true }).click();
    await until(async () => (await fs.readFile(marker, 'utf8').catch(() => '')) === 'approved', 'approved command ran');
  });

  await check('titles-not-nicknames (sidebar)', async () => {
    const rootRow = page.locator(`.thread-row[data-thread-id="${rootThread.id}"]`);
    // A chat's agents are shown from its row menu (the row's hover shows only Pin and Archive, as in the ChatGPT app).
    await rootRow.first().getByRole('button', { name: /^Actions for / }).click();
    const agentsItem = page.getByRole('menuitem', { name: /^(Show|Hide) agents$/ });
    if ((await agentsItem.innerText()).startsWith('Show')) await agentsItem.click(); else await page.keyboard.press('Escape');
    const sideChild = page.locator(`.thread-row[data-thread-id="${childThread.id}"]`);
    await sideChild.waitFor({ timeout: 10000 });
    assert.equal((await sideChild.locator('.thread-title').innerText()).trim(), childTitle);
    assert.equal(await sideChild.locator('.thread-nickname').count(), 0, 'Sidebar task title is shown without an arbitrary nickname');
    await shoot('sidebar', { mobileSidebar: true });
  });

  await api(`/threads/${childThread.id}/interrupt`, {});
  await until(() => fixture.hanging.size === 0, 'child fixture stopped');
  await check('writable child chat sends exactly one fixture request', async () => {
    await page.locator(`.thread-row[data-thread-id="${childThread.id}"] .thread-link`).click();
    await page.getByRole('heading', { level: 1, name: childTitle }).waitFor();
    await page.getByRole('button', { name: `Open parent: ${(await api(`/threads/${rootThread.id}?limit=1`)).body.thread.name || rootThread.preview}` }).waitFor();
    assert.equal(await page.getByText(/controlled by its parent/i).count(), 0);
    assert.equal(await page.getByText('Read-only conversation').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Continue here' }).count(), 0);
    assert.equal(await composer().isEnabled(), true);
    await shoot('child-chat');
    const before = fixture.requests.length;
    reply('CHILD_FOLLOWUP_4242', message('CHILD_CONTINUED_4242'));
    await send('CHILD_FOLLOWUP_4242');
    await page.getByText('CHILD_CONTINUED_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(500);
    assert.equal(fixture.requests.length, before + 1, 'exactly one inference request');
    assert.equal(requestsWith('CHILD_FOLLOWUP_4242').length, 1);
    const sent = JSON.stringify(fixture.requests.at(-1).body.input);
    assert.match(sent, /CHILD_TASK_4242/, 'continues the child history');
    assert.equal(fixture.requests.at(-1).body.model, childThread.model, 'recorded model kept');
  });

  await check('existing chat is writable after reconnect without Continue here', async () => {
    await app.close(); app = await startApp(); await page.goto(app.url);
    await page.locator(`.thread-row[data-thread-id="${rootThread.id}"] .thread-link`).click();
    await composer().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue here' }).count(), 0);
    const before = fixture.requests.length;
    reply('EXISTING_4242', message('EXISTING_REPLY_4242'));
    await send('EXISTING_4242');
    await page.getByText('EXISTING_REPLY_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(300);
    assert.equal(fixture.requests.length, before + 1);
    assert.match(JSON.stringify(fixture.requests.at(-1).body.input), /SPAWN_4242.*EXISTING_4242/s);
  });

  await check('a chat working in another client opens live and streams its reply', async () => {
    // Another client (as the terminal would) starts a turn whose reply is held by the fixture.
    const other = new WebSocket(`ws+unix://${await fs.realpath(socketPath)}:/`); await once(other, 'open');
    let next = 0; const waiting = new Map(); other.on('message', raw => { const m = JSON.parse(raw); if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
    const rpc = (method, params) => new Promise(resolve => { const id = ++next; waiting.set(id, resolve); other.send(JSON.stringify({ id, method, params })); });
    await rpc('initialize', { clientInfo: { name: 'other-client', title: 'Other', version: '0' }, capabilities: { experimentalApi: true } }); other.send(JSON.stringify({ method: 'initialized', params: {} }));
    let release; reply('ELSEWHERE_4242', { gate: new Promise(resolve => { release = resolve; }), item: message('ELSEWHERE_REPLY_4242') });
    const started = (await rpc('thread/start', {})).result.thread;
    await rpc('turn/start', { threadId: started.id, input: [{ type: 'text', text: 'ELSEWHERE_4242 work in the terminal', text_elements: [] }] });
    await until(() => fixture.gated, 'turn reached inference');
    await page.locator(`.thread-row[data-thread-id="${started.id}"] .thread-link`).click({ timeout: 15000 });
    await page.getByText('Working…', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Stop response' }).isVisible(), 'its running turn can be stopped from here');
    const loadsBefore = loads; release();
    await page.getByText('ELSEWHERE_REPLY_4242', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(loads, loadsBefore, 'streamed without reload');
    other.close();
  });

  let agentThread;
  agentThread = (await api('/threads', { model: 'gpt-6-luna', cwd: agentCwd })).body.thread;
  await api(`/threads/${agentThread.id}/rename`, { name: 'Docs reviewer 4242' });
  await page.reload();
  await page.locator(`.thread-row[data-thread-id="${agentThread.id}"] .thread-link`).click();

  await check('model and effort change is shown and reaches the next request', async () => {
    await chooseOption(page.getByLabel('Model', { exact: true }), 'gpt-5.5');
    await chooseOption(page.getByLabel('Reasoning effort', { exact: true }), 'high');
    await page.getByLabel('Model', { exact: true }).filter({ hasText: /GPT-5\.5/i }).waitFor();
    await page.locator('[aria-label="Reasoning effort"][data-value="high"]').waitFor();
    reply('SETTINGS_4242', message('SETTINGS_REPLY_4242'));
    await send('SETTINGS_4242');
    await page.getByText('SETTINGS_REPLY_4242', { exact: true }).waitFor({ timeout: 30000 });
    // Switching models may make Elpis compact first; the turn's own request is the one that carries the message.
    const [turn] = requestsWith('SETTINGS_4242').filter(r => !JSON.stringify(r.body.input).includes('CONTEXT CHECKPOINT'));
    assert(turn, 'the turn reached inference');
    assert.equal(turn.body.model, 'gpt-5.5');
    assert.equal(turn.body.reasoning?.effort, 'high');
    await page.locator('.thread-meta').filter({ hasText: /GPT-5\.5/i }).filter({ hasText: 'high' }).waitFor();
  });

  await check('delete removes the chat everywhere (cancel keeps it)', async () => {
    const row = () => page.locator(`.thread-row[data-thread-id="${agentThread.id}"]`);
    await row().getByRole('button', { name: 'Actions for Docs reviewer 4242' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('Delete “Docs reviewer 4242”?').waitFor();
    await shoot('delete-confirm');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await wait(300);
    assert.equal(await row().count(), 1, 'cancel keeps the chat');
    await row().getByRole('button', { name: 'Actions for Docs reviewer 4242' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await until(async () => await row().count() === 0, 'row removed from sidebar');
    assert.equal((await api('/threads?limit=50')).body.data.some(t => t.id === agentThread.id), false, 'native list no longer has it');
    // A root with an agent and a continued agent chat: every piece disappears.
    const rootRow = page.locator(`.thread-row[data-thread-id="${rootThread.id}"]`);
    await rootRow.getByRole('button', { name: /^Actions for / }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await until(async () => await page.locator(`[data-thread-id="${rootThread.id}"], [data-thread-id="${childThread.id}"]`).count() === 0, 'root and agent removed');
    const remaining = (await api('/threads?limit=50')).body.data;
    assert.equal(remaining.some(t => t.id === rootThread.id || t.forkedFromId === childThread.id), false, 'root and continuation deleted natively');
    await until(async () => !(await api('/threads?limit=100')).body.data.some(t => t.id === childThread.id), 'its agent is deleted natively too');
    await wait(1500);
    assert.equal(await page.locator(`[data-thread-id="${childThread.id}"]`).count(), 0, 'the agent does not come back');
  });

  await check('MCP servers page: real config, no secrets, writes', async () => {
    await nav('Settings').click();
    await page.getByRole('tab', { name: 'MCP servers' }).click();
    const rag = page.locator('.mcp-server[data-name="rag"]'), whisper = page.locator('.mcp-server[data-name="whispertype"]');
    await rag.waitFor(); await whisper.waitFor();
    await rag.locator('.key-state code').filter({hasText:'OPENROUTER_API_KEY'}).waitFor();
    assert.equal(await page.getByLabel('rag RAG_MCP_MAX_TOKENS',{exact:true}).count(),0,'token budget is not an API-key field');
    assert.match(await rag.innerText(), /OPENROUTER_API_KEY\s*·?\s*set/i);
    assert.match(await rag.innerText(), /deepseek\/deepseek-v4\.1-flash/);
    assert.match(await whisper.innerText(), /OPENROUTER_API_KEY_COMPANY\s*·?\s*set/i);
    const raw = JSON.stringify((await api('/mcp')).body) + await page.content();
    assert.equal(raw.includes(SECRET), false, 'secret never reaches the renderer');
    assert.equal(raw.includes('company-key-not-shown'), false, 'environment secret never reaches the renderer');
    const ragKey = 'fixture-rag-key-replaced-4242';
    await page.getByLabel('rag OPENROUTER_API_KEY',{exact:true}).fill(ragKey);
    await rag.locator('form[aria-label="API keys for rag"]').getByRole('button',{name:'Save API keys',exact:true}).click();
    await rag.getByRole('status').filter({hasText:'API keys saved.'}).waitFor();
    assert.equal(await controlValue(page.getByLabel('rag OPENROUTER_API_KEY',{exact:true})),'');
    await until(async () => (await fs.readFile(path.join(home,'config.toml'),'utf8')).includes(ragKey),'RAG key saved');
    assert(!JSON.stringify((await api('/mcp')).body).includes(ragKey),'saved key is redacted');
    assert(!(await page.content()).includes(ragKey),'saved key never redisplayed');
    const whisperKey = 'fixture-whisper-key-replaced-4242';
    await page.getByLabel('whispertype OPENROUTER_API_KEY_COMPANY',{exact:true}).fill(whisperKey);
    await whisper.locator('form[aria-label="API keys for whispertype"]').getByRole('button',{name:'Save API keys',exact:true}).click();
    await whisper.getByRole('status').filter({hasText:'API keys saved.'}).waitFor();
    await until(async () => (await fs.readFile(path.join(home,'config.toml'),'utf8')).includes(whisperKey),'WhisperType key saved');
    assert(!JSON.stringify((await api('/mcp')).body).includes(whisperKey),'WhisperType key is redacted');
    await shoot('mcp');
    // The transcription route moved to Settings → Voice; it still writes WhisperType's MCP env.
    await whisper.getByRole('button', { name: 'Open Voice settings', exact: true }).click();
    const voice = page.getByRole('tabpanel', { name: 'Voice', exact: true });
    await chooseOption(voice.getByLabel('Fallback transcription engine', { exact: true }), 'local');
    await voice.getByRole('button', { name: 'Save transcription settings' }).click();
    await until(async () => /WHISPERTYPE_BACKEND\s*=\s*"local"/.test(await fs.readFile(path.join(home, 'config.toml'), 'utf8')), 'whispertype provider written');
    await page.getByRole('tab', { name: 'MCP servers', exact: true }).click();
    await page.getByRole('button', { name: 'Add MCP server' }).click();
    await page.getByLabel('Server name').fill('fixture-extra');
    await page.getByLabel('Command').fill('/bin/true');
    await page.getByRole('button', { name: 'Save server' }).click();
    await page.locator('.mcp-server[data-name="fixture-extra"]').waitFor();
    assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), /\[mcp_servers\.fixture-extra\]/);
    await page.locator('.mcp-server[data-name="fixture-extra"]').getByRole('button', { name: 'Remove fixture-extra' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await until(async () => await page.locator('.mcp-server[data-name="fixture-extra"]').count() === 0, 'server removed');
    assert.doesNotMatch(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), /fixture-extra/);
  });

  await check('Providers page: separate auth and usage per provider', async () => {
    await page.getByRole('tab', { name: 'Models & accounts' }).click();
    const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
    await card('openai').waitFor();
    assert.match(await card('openai').innerText(), /Not signed in/);
    assert(await card('openai').getByRole('button', { name: 'Sign in with ChatGPT' }).isVisible());
    assert.match(await card('claude').innerText(), /Not connected/);
    assert.match(await card('openrouter').innerText(), /OPENROUTER_API_KEY\s*·?\s*not set/i);
    assert.match(await card('local').innerText(), /LM Studio/);
    await shoot('providers');
  });

  await check('native API provider can be configured in the app and selected for real runtime inference', async () => {
    await nav('Settings').click(); await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
    await page.getByText('Advanced API connections',{exact:true}).click();
    await page.getByRole('button',{name:'Add API provider',exact:true}).click();
    await page.getByLabel('Provider ID',{exact:true}).fill('app-native-provider');
    await page.getByLabel('Provider display name',{exact:true}).fill('Fixture native API');
    await page.getByLabel('API endpoint',{exact:true}).fill(providerUrl);
    await chooseOption(page.getByLabel('API key action',{exact:true}), 'replace');
    const apiKey='fixture-native-api-key-4242';
    await page.getByLabel('Provider API key',{exact:true}).fill(apiKey);
    await shoot('native-api-provider-form');
    await page.getByRole('button',{name:'Save provider',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
    assert(!(await page.content()).includes(apiKey),'saved provider secret is never redisplayed');
    assert(!JSON.stringify((await api('/providers/settings')).body).includes(apiKey),'provider snapshot is redacted');
    assert((await api('/settings')).body.providers.some(provider=>provider.id==='app-native-provider'),'provider appears immediately in native settings');
    await nav('New chat').click();
    await page.getByLabel('Model',{exact:true}).click();
    await page.getByText('Configured API model…',{exact:true}).click();
    await chooseOption(page.getByLabel('Provider',{exact:true}), 'app-native-provider');
    await page.getByLabel('Model ID',{exact:true}).fill('fixture/custom-model');
    await page.getByRole('button',{name:'Use model',exact:true}).click();
    const before=fixture.requests.length;reply('PROVIDER_4242',message('PROVIDER_REPLY_4242'));
    await send('PROVIDER_4242');await page.getByText('PROVIDER_REPLY_4242',{exact:true}).waitFor({timeout:30000});
    assert.equal(fixture.requests.length,before+1,'exactly one local fixture request');
    assert.equal(fixture.requests.at(-1).authorization,`Bearer ${apiKey}`,'stored native key reaches the request');
    assert.equal(fixture.requests.at(-1).body.model,'fixture/custom-model');
    const thread=(await api('/threads?limit=50')).body.data.find(thread=>thread.preview?.includes('PROVIDER_4242'));
    assert.equal(thread?.modelProvider,'app-native-provider');
    assert.equal(thread.model,'fixture/custom-model');
    reply('PROVIDER_KEEP_4242',message('PROVIDER_KEEP_REPLY_4242'));
    await send('PROVIDER_KEEP_4242');await page.getByText('PROVIDER_KEEP_REPLY_4242',{exact:true}).waitFor({timeout:30000});
    assert.equal(fixture.requests.length,before+2,'second send preserves the native route');
    assert.equal(fixture.requests.at(-1).authorization,`Bearer ${apiKey}`);
    assert.equal(fixture.requests.at(-1).body.model,'fixture/custom-model');
    await nav('Settings').click();await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
    await page.getByRole('button',{name:'Edit Fixture native API',exact:true}).click();
    await chooseOption(page.getByLabel('API key action',{exact:true}), 'clear');
    await page.getByRole('button',{name:'Save provider',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Saved for new conversations'}).waitFor();
    const provider=(await api('/providers/settings')).body.providers.find(provider=>provider.id==='app-native-provider');
    assert.equal(provider.auth.keySet,false,'explicit clear removes saved credential');
    await nav('New chat').click();
    await page.getByLabel('Model',{exact:true}).click();
    await page.getByText('Configured API model…',{exact:true}).click();
    await chooseOption(page.getByLabel('Provider',{exact:true}), 'app-native-provider');
    await page.getByLabel('Model ID',{exact:true}).fill('fixture/custom-model');
    await page.getByRole('button',{name:'Use model',exact:true}).click();
    reply('PROVIDER_CLEAR_4242',message('PROVIDER_CLEAR_REPLY_4242'));
    await send('PROVIDER_CLEAR_4242');await page.getByText('PROVIDER_CLEAR_REPLY_4242',{exact:true}).waitFor({timeout:30000});
    assert.equal(fixture.requests.length,before+3,'new conversation after clear uses the same provider without the cleared credential');
    assert.equal(fixture.requests.at(-1).authorization,undefined,'cleared secret is not used');
    assert.equal(fixture.requests.at(-1).body.model,'fixture/custom-model');
    await nav('Settings').click();await page.getByRole('tab',{name:'Models & accounts',exact:true}).click();
    await shoot('native-api-provider');
  });

  // APP-FIX-3: ChatGPT/Claude parity. Each check plants a marker only the feature can move.
  const row = id => page.locator(`.thread-row[data-thread-id="${id}"]`);
  const rowMenu = async (id, item) => { await row(id).getByRole('button', { name: /^Actions for / }).click(); await page.getByRole('menuitem', { name: item, exact: true }).click(); };
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  let parity;
  await check('markdown renders tables, copyable code and external links', async () => {
    await nav('New chat').click();
    reply('PARITY_A_4242', message('| Col | Val |\n| --- | --- |\n| MD_CELL_4242 | 1 |\n\n```js\nconst CODE_4242 = 1;\n```\n\nSee [the docs](https://example.com/docs) for REPLY_A_4242.'));
    await send('PARITY_A_4242 first prompt');
    await page.getByText('REPLY_A_4242', { exact: false }).waitFor({ timeout: 30000 });
    parity = (await api('/threads?limit=20')).body.data.find(t => t.preview?.includes('PARITY_A_4242'));
    assert(parity, 'parity chat listed');
    assert.equal(await page.locator('.markdown table td').filter({ hasText: 'MD_CELL_4242' }).count(), 1, 'table rendered as a table');
    assert.equal(await page.getByText('| Col | Val |').count(), 0, 'no raw markdown table source');
    const link = page.locator('.markdown a', { hasText: 'the docs' });
    assert.equal(await link.getAttribute('target'), '_blank', 'links leave the app');
    await page.locator('.code-block').getByRole('button', { name: 'Copy code' }).click();
    assert.equal((await clipboard()).trim(), 'const CODE_4242 = 1;');
    await shoot('markdown');
  });

  await check('copy a sent message', async () => {
    await page.locator('.user-turn').filter({ hasText: 'PARITY_A_4242' }).getByRole('button', { name: 'Copy message' }).click();
    assert.equal(await clipboard(), 'PARITY_A_4242 first prompt');
  });

  await check('regenerate re-runs the last prompt once and replaces the reply', async () => {
    reply('PARITY_A_4242', message('REGENERATED_4242'));
    const before = fixture.requests.length;
    await page.getByRole('button', { name: 'Regenerate reply' }).last().click();
    await page.getByText('REGENERATED_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(400);
    assert.equal(fixture.requests.length, before + 1, 'exactly one inference request');
    assert.equal(await page.getByText('REPLY_A_4242', { exact: false }).count(), 0, 'old reply is gone');
    assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1).body.input), /REPLY_A_4242/, 'old reply is not in the new request');
  });

  await check('edit an earlier prompt replaces it and every later turn', async () => {
    reply('PARITY_B_4242', message('REPLY_B_4242'));
    await send('PARITY_B_4242 second prompt');
    await page.getByText('REPLY_B_4242', { exact: true }).waitFor({ timeout: 30000 });
    const first = page.locator('.user-turn').filter({ hasText: 'PARITY_A_4242' });
    await first.getByRole('button', { name: 'Edit message' }).click();
    await page.getByLabel('Edited message').fill('PARITY_C_4242 edited prompt');
    await shoot('edit-message');
    reply('PARITY_C_4242', message('REPLY_C_4242'));
    const before = fixture.requests.length;
    await page.getByRole('form', { name: 'Edit message' }).getByRole('button', { name: 'Send' }).click();
    await page.getByText('REPLY_C_4242', { exact: true }).waitFor({ timeout: 30000 });
    await wait(400);
    assert.equal(fixture.requests.length, before + 1, 'exactly one inference request');
    const sent = JSON.stringify(fixture.requests.at(-1).body.input);
    assert.match(sent, /PARITY_C_4242/);
    assert.doesNotMatch(sent, /PARITY_A_4242|PARITY_B_4242|REPLY_B_4242/, 'replaced turns are not sent');
    assert.equal(await page.getByText('REPLY_B_4242', { exact: true }).count(), 0, 'later turns removed from the chat');
    const history = JSON.stringify((await api(`/threads/${parity.id}?limit=100`)).body.data);
    assert.doesNotMatch(history, /PARITY_B_4242/, 'native history no longer has the later turn');
  });

  await check('Ctrl+Shift+K focuses chat search and filters the sidebar', async () => {
    const name = (await row(parity.id).locator('.thread-title').innerText()).trim();
    const listed = await page.locator('.thread-row').count();
    assert(listed > 1, 'several chats are listed');
    await page.locator('.chat-scroll').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+Shift+K');
    const search = page.getByLabel('Search conversations');
    assert.equal(await search.evaluate(element => element === document.activeElement), true, 'search is focused');
    try {
      await page.keyboard.type(name);
      await until(async () => await row(parity.id).count() === 1 && await page.locator('.thread-row').count() < listed, 'other chats hidden');
      await shoot('search');
      await search.fill(`${name} no-such-chat-4242`);
      await until(async () => await row(parity.id).count() === 0, 'a non-matching query hides it too');
    } finally { await search.fill(''); }
  });

  await check('rename from the row menu is saved in Elpis', async () => {
    await rowMenu(parity.id, 'Rename');
    const field = page.getByLabel('Conversation name');
    await field.fill('Renamed parity 4242');
    await shoot('rename');
    await page.getByRole('form', { name: 'Rename conversation' }).getByRole('button', { name: 'Save' }).click();
    await row(parity.id).locator('.thread-title').filter({ hasText: 'Renamed parity 4242' }).waitFor();
    assert.equal((await api(`/threads/${parity.id}?limit=1`)).body.thread.name, 'Renamed parity 4242');
    await rowMenu(parity.id, 'Rename');
    await page.getByLabel('Conversation name').fill('Discarded name 4242');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await wait(300);
    assert.equal((await api(`/threads/${parity.id}?limit=1`)).body.thread.name, 'Renamed parity 4242', 'cancel keeps the name');
  });

  await check('archive hides a chat; the Archived view restores it', async () => {
    await rowMenu(parity.id, 'Archive');
    await until(async () => await row(parity.id).count() === 0, 'row removed from sidebar');
    assert.equal((await api('/threads?limit=100')).body.data.some(t => t.id === parity.id), false, 'native list no longer has it');
    assert.equal((await api('/threads?limit=100&archived=true')).body.data.some(t => t.id === parity.id), true, 'native archive has it');
    await nav('Settings').click(); await page.getByRole('tab', { name: 'Archived chats' }).click();
    const archived = page.locator(`.archived-row[data-thread-id="${parity.id}"]`);
    await archived.waitFor();
    await shoot('archived');
    await archived.getByRole('button', { name: 'Unarchive Renamed parity 4242' }).click();
    await row(parity.id).waitFor();
    assert.equal((await api('/threads?limit=100')).body.data.some(t => t.id === parity.id), true, 'restored natively');
  });

  await check('theme follows Settings → Appearance: System, Light, Dark', async () => {
    await nav('Settings').click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    const group = page.getByRole('radiogroup', { name: 'Theme' });
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    await group.getByRole('radio', { name: 'Dark' }).click(); assert.equal(await isDark(), true);
    await group.getByRole('radio', { name: 'Light' }).click(); assert.equal(await isDark(), false);
    await group.getByRole('radio', { name: 'System' }).click();
    await page.emulateMedia({ colorScheme: 'dark' }); await until(isDark, 'system dark followed');
    await page.emulateMedia({ colorScheme: 'light' }); await until(async () => !(await isDark()), 'system light followed');
    await page.reload(); await page.getByText('Local workspace', { exact: true }).waitFor();
    await nav('Settings').click(); await page.getByRole('tab', { name: 'Appearance' }).click();
    assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }).getAttribute('aria-checked'), 'true', 'choice persists');
    await shoot('theme-settings');
  });

  await check('sidebar usage card names each provider state and never shows unreported use as 0%', async () => {
    const panel = page.locator('details.usage-panel');
    await panel.locator('summary').click();
    await panel.getByRole('region', { name: 'Claude usage' }).waitFor();
    const body = await panel.innerText();
    assert.match(body, /OpenAI \/ ChatGPT[\s\S]*Sign in with ChatGPT to see ChatGPT usage\./, 'signed-out ChatGPT says so');
    assert.match(body, /Claude[\s\S]*Sign in with Claude Code to see Claude usage\./);
    assert.match(body, /Gemini \(Antigravity\)[\s\S]*Sign in to Antigravity to see Gemini usage\./);
    assert.doesNotMatch(body, /\b0% used/, 'no invented zero');
    await shoot('usage-panel');
    await panel.locator('summary').click();
  });

  await check('header shows the Elpis mark', async () => {
    const mark = page.locator('.brand img[alt="Elpis"]');
    await mark.waitFor();
    assert(await mark.evaluate(img => img.complete && img.naturalWidth > 0), 'logo loaded');
    const icon = await page.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute('href'));
    assert.equal(String(icon), '/branding/favicon-amber.svg');
    await nav('New chat').click();
    await shoot('header-logo');
  });
  assert.deepEqual(pageErrors, []);
} catch (error) {
  results.push({ name: 'setup', ok: false, error: String(error.stack || error.message).split('\n').slice(0, 3).join(' | ') });
  console.log(`FAIL setup: ${error.message}`);
} finally {
  await browser?.close(); await app?.close(); server.close(); workflowServer.close();
  for (const response of fixture.hanging) response.destroy();
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), wait(5000).then(() => false)]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  await fs.writeFile(path.join(root, 'runtime.log'), logs);
  if (fixture.error) console.error('fixture error:', fixture.error.message);
  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({ status: failed.length ? 'failed' : 'passed', root, passed: results.length - failed.length, failed: failed.map(f => `${f.name}: ${f.error}`) }));
  process.exitCode = failed.length ? 1 : 0;
}
