import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../bridge/server.mts';
import { createTools } from '../bridge/tools.mts';
import type { Browser, Page } from 'playwright-core';
import type { Controls } from './controls.cts';

export type Socket = EventEmitter & { send(data: string, ...args: unknown[]): void; close(): void };
export type WireRequest = { method: string; params?: { threadId?: string } };
export type Tool = { name: string; type?: string; tools: Tool[]; namespace?: string };
export type InferenceRequest = { tools?: Tool[]; input?: { type: string; role?: string; recipient?: string; content?: unknown }[]; model?: string; reasoning?: { effort?: string }; text?: { format?: { schema?: { required?: string[] } } } };
export type Message = { type: 'message'; id: string; role: 'assistant'; content: [{ type: 'output_text'; text: string }] };
export type FunctionCall = { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string; namespace?: string };
export type Item = Message | FunctionCall;
export type Action = Item | ((request: InferenceRequest) => Item) | { hang: true } | { gate: Promise<void>; item: Item };
export type RecordedRequest = { role: string; body: InferenceRequest; latest: string; authorization: string | undefined; endpointPort: number | undefined };
export type Thread = { id: string; name?: string; preview?: string; model?: string; modelProvider?: string; agentNickname?: string; forkedFromId?: string; source?: { subAgent?: { thread_spawn?: { agent_path?: string } } } };
export type ApiBody = { data: Thread[]; thread: Thread; providers: { id: string; auth: { keySet: boolean } }[] };
export type Approval = { params: { availableDecisions?: unknown[] }; thread?: Thread };
export type Fixture = { requests: RecordedRequest[]; keyed: Map<string, Action[]>; child: Action[]; hanging: Set<http.ServerResponse>; titles: number; error: Error | null; gated?: boolean };

export const require = createRequire(import.meta.url);
export const { chromium }: typeof import('playwright-core') = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
export const { chooseOption, controlValue }: Controls = require('./controls.cts');
export const WebSocket: { new (url: string): Socket; prototype: Socket } = require('ws');
export const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), 'Provide an absolute Elpis executable');
export const shotsArg = process.argv[process.argv.indexOf('--shots') + 1];
if (process.argv.includes('--shots')) assert(shotsArg);
export const shots = shotsArg && process.argv.includes('--shots') ? path.resolve(shotsArg) : null;
export const designOnly = process.argv.includes('--only-design');
export const modelsOnly = process.argv.includes('--only-models');
export const followOnly = process.argv.includes('--only-follow');
export const wireRequests: WireRequest[] = [];
export const originalWebSocketSend = WebSocket.prototype.send;
if (followOnly) WebSocket.prototype.send = function (data, ...args) {
  try { wireRequests.push(JSON.parse(typeof data === 'string' ? data : Buffer.from(/** @type {ArrayBuffer} */ (data)).toString('utf8'))); } catch {}
  return originalWebSocketSend.call(this, data, ...args);
};
export const appRoot = fileURLToPath(new URL('..', import.meta.url));
export const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-app-fix-2-'));
export const home = path.join(root, 'home'), cwd = path.join(root, 'workspace'), agentCwd = path.join(root, 'agent-folder');
for (const dir of [home, cwd, agentCwd]) await fs.mkdir(dir);
delete process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY_COMPANY = 'company-key-not-shown';
export const SECRET = 'sk-fixture-secret-4242';

// Inference fixture: routes root vs child requests, supports tool calls and hanging responses.
export const message = (text: string): Message => ({ type: 'message', id: `msg_${Math.random().toString(36).slice(2)}`, role: 'assistant', content: [{ type: 'output_text', text }] });
export const exec = (id: string, cmd: string, escalate = false) => (request: InferenceRequest): FunctionCall => {
  const tool = (request.tools || []).find(t => t.name === 'exec_command' || t.name === 'shell_command');
  assert(tool, 'runtime must advertise a command tool');
  return { type: 'function_call', id: `fc_${id}`, call_id: id, name: tool.name, arguments: JSON.stringify({ [tool.name === 'exec_command' ? 'cmd' : 'command']: cmd, ...(escalate ? { sandbox_permissions: 'require_escalated', justification: 'Fixture approval probe.' } : {}) }) };
};
export const spawnChild = (request: InferenceRequest): FunctionCall => {
  const tools = (request.tools || []).flatMap(t => t.type === 'namespace' ? t.tools.map(c => ({ ...c, namespace: t.name })) : [t]);
  const tool = tools.find(t => t.name === 'spawn_agent'); assert(tool, 'native spawn_agent must be advertised');
  const item: FunctionCall = { type: 'function_call', id: 'fc_spawn', call_id: 'spawn_fixture', name: tool.name, arguments: JSON.stringify({ task_name: 'failure_reporting', fork_turns: 'none', message: 'CHILD_TASK_4242: report failures. Read only.' }) };
  if (tool.namespace) item.namespace = tool.namespace;
  return item;
};
export const HANG = { hang: true } as const;
// Replies are keyed by the marker in the latest user message, so compaction or title requests cannot take them.
export const fixture: Fixture = { requests: [], keyed: new Map(), child: [], hanging: new Set(), titles: 0, error: null };
export let releaseFollow: (() => void) | undefined;
export const roleOf = (body: InferenceRequest) => (body.input || []).some(i => i.type === 'agent_message' && String(i.recipient || '').startsWith('/root/')) ? 'child' : 'root';
export const latestUser = (body: InferenceRequest) => { const users = (body.input || []).filter(i => i.type === 'message' && i.role === 'user'); return JSON.stringify(users.at(-1)?.content ?? ''); };
export const reply = (marker: string, ...actions: Action[]) => fixture.keyed.set(marker, actions);
export const requestsWith = (marker: string) => fixture.requests.filter(r => r.latest.includes(marker));
export const inferenceHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body: InferenceRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const send = (item: Item) => {
      const id = `response_${fixture.requests.length}_${fixture.titles}`; const events: { type: string; [key: string]: unknown }[] = [{ type: 'response.created', response: { id } }];
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
    const marker = [...fixture.keyed.keys()].find(key => latest.includes(key) && fixture.keyed.get(key)?.length);
    let action = (marker ? fixture.keyed.get(marker) : role === 'child' ? fixture.child : [])?.shift() ?? message(`${role.toUpperCase()}_DEFAULT_REPLY`);
    if (body.model && ['workflow/custom-a','workflow/custom-b'].includes(body.model)) {
      const source = JSON.stringify(body.input), graphId = source.match(/Graph ID: ([^\\\s"]+)/)?.[1], taskId = source.match(/Task ID: ([^\\\s"]+)/)?.[1];
      assert.ok(graphId && taskId, 'Inference must belong to an assigned workflow task');
      const evidence = `APP_WORKFLOW_ROUTE_EVIDENCE_${taskId}`;
      action = source.includes(evidence) ? message('Worker complete') : { type: 'function_call', call_id: `report_${taskId}`, name: 'report_agent_work_task', arguments: JSON.stringify({ graph_id: graphId, task_id: taskId, outcome: 'succeeded', summary: `Completed ${taskId} local route`, changed_files: [], checks: ['Checked assigned local fixture route'], evidence: [evidence], risks: [], edge_cases_considered: ['Provider-specific bearer and custom model'], open_questions: [], what_i_did_not_check: ['Paid provider inference'] }) };
    }
    if (typeof action === 'object' && 'hang' in action) { fixture.hanging.add(res); res.on('close', () => fixture.hanging.delete(res)); return; }
    if (typeof action === 'object' && 'gate' in action) { fixture.gated = true; await action.gate; return send(action.item); }
    send(typeof action === 'function' ? action(body) : action);
  } catch (error) { const caught = error instanceof Error ? error : new Error(String(error)); fixture.error ??= caught; res.writeHead(500); res.end(String(caught.message)); }
};
export const server = http.createServer((req, res) => { void inferenceHandler(req, res); }), workflowServer = http.createServer((req, res) => { void inferenceHandler(req, res); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
workflowServer.listen(0, '127.0.0.1'); await once(workflowServer, 'listening');
export const address = server.address(), workflowAddress = workflowServer.address();
assert(address && typeof address !== 'string' && workflowAddress && typeof workflowAddress !== 'string');
export const providerUrl = `http://127.0.0.1:${address.port}/v1`;
export const workflowProviderUrl = `http://127.0.0.1:${workflowAddress.port}/v1`;

export const catalog: { models: { slug: string; [key: string]: unknown }[] } = require('../../../codex-rs/models-manager/models.json');
export const models = ['gpt-5.5', 'gpt-6-luna'].map(slug => ({ ...structuredClone(catalog.models.find(m => m.slug === slug)), multi_agent_version: 'v2' }));
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
export const ragCalls: string[][] = [];
export const fakeRun = async (command: string, args: string[]) => {
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

export const socketPath = path.join(root, 'runtime.sock');
export const bridgeLog = path.join(root, 'bridge.log');
export const bridgeScript = fileURLToPath(new URL('../../../tools/elpis-claude/acp-bridge.mts', import.meta.url));
export const child = spawn(followOnly ? process.execPath : binary, followOnly ? [bridgeScript] : ['app-server', '--listen', `unix://${socketPath}`], { cwd,
  env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home, LANG: 'C.UTF-8',
    ...(followOnly ? { ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: binary, ACP_BRIDGE_LOG: bridgeLog } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
export let logs = '';
export let app: Awaited<ReturnType<typeof startDesktopServer>>, browser: Browser, page: Page;
export const cleanup: { app?: Awaited<ReturnType<typeof startDesktopServer>>; browser?: Browser } = {};
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
export const exited = once(child, 'exit');
export const results: { name: string; ok: boolean; error?: string | undefined }[] = [];
export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function until(predicate: () => boolean | undefined | Promise<boolean | undefined>, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(100); }
  throw new Error(`Timed out: ${label}`);
}
export async function check(name: string, run: () => Promise<void>) {
  if (modelsOnly && !/^(child approval|titles-not-nicknames|writable child chat|existing chat|a chat working|model and effort change)/.test(name)) return;
  if (designOnly && !/^(child approval|titles-not-nicknames)/.test(name)) return;
  try { await run(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, error: String(message).split('\n')[0] }); console.log(`FAIL ${name}: ${String(message).split('\n')[0]}`);
    await page?.screenshot({ path: path.join(root, `failed-${results.length}.png`) }).catch(() => {});
    await page?.keyboard.press('Escape').catch(() => {});
  }
}
export async function shoot(name: string, { mobileSidebar = false } = {}) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  // The app's own theme button is used; with a modal dialog open its classes are set directly instead.
  const theme = async (dark: boolean) => {
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
export const api = (url: string, body?: unknown) => page.evaluate(async ({ url, body }) => {
  const response = await fetch(`/api${url}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result: ApiBody = await response.json();
  return { status: response.status, body: result };
}, { url, body });
export const composer = () => page.getByLabel('Message Elpis', { exact: true });
export async function send(text: string) { await composer().fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
export const requestsOf = (role: string) => fixture.requests.filter(r => r.role === role);
export const lastRequest = () => { const request = fixture.requests.at(-1); assert(request); return request; };
// Settings is in the account menu at the sidebar's bottom (Claude's account row), not a button of its own.
export const nav = (name: string) => name === 'Settings'
  ? { click: async () => { await page.locator('aside.sidebar .account-row').click(); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); } }
  : page.locator('aside.sidebar').getByRole('button', { name, exact: true });
export const childTitleFor = (approval: Approval) => approval.thread ? (approval.thread.name || approval.thread.preview || humanTask(approval.thread.source?.subAgent?.thread_spawn?.agent_path)) : '';
export const humanTask = (agentPath?: string) => { const task = String(agentPath || '').split('/').filter(Boolean).at(-1)?.replace(/[_-]+/g, ' ') || ''; return task ? task.charAt(0).toUpperCase() + task.slice(1) : ''; };
export const startApp = async (port?: number) => startDesktopServer({ staticDir: path.join(appRoot, 'out'), socketPath: await fs.realpath(socketPath), elpisHome: home, codexHome: home,
  loveSpot: { directory: path.join(root, 'love-spot'), screenshots: path.join(root, 'screenshots') }, tools: createTools({ run: fakeRun }), ...(port ? { port } : {}) });
export async function startRuntime() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Runtime exited: ' + logs);
    try { await fs.stat(socketPath); break; } catch {}
    await wait(100);
  }
  await fs.chmod(socketPath, 0o600);
  cleanup.app = app = await startApp();
  cleanup.browser = browser = await chromium.launch({ ...(process.env.ELPIS_CHROMIUM ? { executablePath: process.env.ELPIS_CHROMIUM } : {}), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] }); page.setDefaultTimeout(12000); page.setDefaultTimeout(12000);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const loaded = { count: 0 }; page.on('load', () => { loaded.count++; });
  await page.goto(app.url); await page.getByText('Local workspace', { exact: true }).waitFor();
  return { pageErrors, loaded };
}
export async function finishRun() {
  releaseFollow?.();
  await cleanup.browser?.close(); await cleanup.app?.close(); server.close(); workflowServer.close();
  WebSocket.prototype.send = originalWebSocketSend;
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
export const setApp = (next: typeof app) => {
  cleanup.app = app = next;
};
export const followGate = (done: () => void) => { releaseFollow = done; };
