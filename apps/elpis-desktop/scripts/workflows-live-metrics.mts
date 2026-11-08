// Repeatable Workflows measurement on the built renderer and the real desktop workflow scheduler.
// Its ACP agents are local fixtures held in their turns, so no model, account or network service is used.
// Usage: node scripts/workflows-live-metrics.mts 3|10 [--output /abs/result.json] [--shots /abs/dir]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DesktopClient } from '../bridge/client.mts';
import { startDesktopServer } from '../bridge/server.mts';

type Request = { url(): string; method(): string };
type Response = { url(): string; request(): Request };
type Box = { x: number; y: number; width: number; height: number };
type Locator = {
  waitFor(options?: { state: string }): Promise<void>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  getByRole(role: string, options: { name: string; exact: boolean }): Locator;
  getByLabel(label: string, options: { exact: boolean }): Locator;
  locator(selector: string): Locator;
  first(): Locator;
  boundingBox(): Promise<Box | null>;
};
type Page = {
  setDefaultTimeout(ms: number): void;
  addInitScript<T>(fn: (arg: T) => void, arg: T): Promise<void>;
  on(event: 'request', listener: (request: Request) => void): void;
  goto(url: string): Promise<unknown>;
  locator(selector: string): Locator;
  getByRole(role: string, options: { name: string; exact: boolean }): Locator;
  waitForResponse(predicate: (response: Response) => boolean): Promise<Response>;
  waitForFunction(fn: () => boolean): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(x: number, y: number): Promise<void> };
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
  emulateMedia(options: { colorScheme: 'light' | 'dark' }): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
};
type Browser = { newPage(options: { viewport: { width: number; height: number }; colorScheme: 'light' }): Promise<Page>; close(): Promise<void> };
type ProcessRow = { pid: number; ppid: number; ticks: number; rssKb: number; command: string };
type MeasuredProcess = ProcessRow & { pssKb: number };
type Sample = { cpuPercent: number; rendererCpuPercent: number; pssMiB: number; rendererPssMiB: number; processes: number };
type RuntimeRequest = { id: number | string; method: string; params: { ancestorThreadId?: string; threadId: string; cwd?: string; model?: string; modelProvider?: string; name: string } };
type Thread = { id: string; cwd: string; name: string | null; preview: string; source: string; model: string; modelProvider: string; status: { type: string }; parentThreadId?: string };

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright') as { chromium: { launch(options: { headless: boolean; executablePath?: string }): Promise<Browser> } };
const { fakeDesktop } = require('../tests/fake-desktop.cjs') as { fakeDesktop: (arg: object) => void };
const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fakeAgent = path.resolve(appRoot, '../../tools/elpis-claude/test/fake-acp-agent.mjs');
const count = Number(process.argv[2]);
if (![3, 10].includes(count)) throw Error('Choose a 3-agent or 10-agent sample.');
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const output = option('--output'), shots = option('--shots');
for (const file of [output, shots]) if (file && !path.isAbsolute(file)) throw Error('Evidence paths must be absolute.');
const tickRate = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.homedir(), '.cache/elpis-tests/wf-perf-'));
const project = path.join(root, 'project'), profile = path.join(root, 'profile');
for (const directory of [project, profile, path.join(profile, 'rewind')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const graph = {
  name: `Performance ${count}`,
  request: `Measure ${count} independent agents.`,
  maxAgents: count,
  mother: { brief: 'Measure the fixed local workflow.', model: 'm-fast', provider: null },
  nodes: Array.from({ length: count }, (_, index) => ({
    id: `agent-${index + 1}`, type: 'agent', position: { x: 300 + index % 5 * 260, y: Math.floor(index / 5) * 160 },
    data: { title: `Agent ${index + 1}`, instruction: `Hold local task ${index + 1}.`, model: 'm-fast', provider: null, effort: null, writeScopes: [], acceptanceCriteria: [] },
  })),
  edges: [],
};

async function processRows() {
  const names = (await fsp.readdir('/proc')).filter(name => /^\d+$/.test(name));
  const rows: ProcessRow[] = [];
  await Promise.all(names.map(async name => {
    try {
      const stat = await fsp.readFile(`/proc/${name}/stat`, 'utf8'), close = stat.lastIndexOf(')'), fields = stat.slice(close + 2).split(' ');
      const status = await fsp.readFile(`/proc/${name}/status`, 'utf8');
      rows.push({ pid: Number(name), ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0), ticks: Number(fields[11]) + Number(fields[12]),
        rssKb: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0), command: (await fsp.readFile(`/proc/${name}/cmdline`)).toString().split('\0').filter(Boolean).join(' ') });
    } catch { /* A process can end during a /proc read. */ }
  }));
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...children.get(row.ppid) ?? [], row.pid]);
  const included = new Set([process.pid]), pending = [process.pid];
  while (pending.length) {
    const parent = pending.pop();
    if (parent === undefined) break;
    for (const child of children.get(parent) ?? []) if (!included.has(child)) { included.add(child); pending.push(child); }
  }
  return Promise.all(rows.filter(row => included.has(row.pid)).map(async row => {
    const rollup = await fsp.readFile(`/proc/${row.pid}/smaps_rollup`, 'utf8').catch(() => '');
    return { ...row, pssKb: Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0) };
  }));
}

function fakeRuntime() {
  const socket = Object.assign(new EventEmitter(), { close: () => {}, terminate: () => {}, send: (_raw: string) => {} });
  const threads = new Map<string, Thread>(), requests: { at: number; method: string }[] = [];
  const config = { model: 'm-fast', model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'danger-full-access', agents: { max_threads: 16 } };
  const configRead = { config, origins: {}, layers: [{ name: { type: 'user', file: path.join(profile, 'config.toml') }, version: 'perf-v1', config }] };
  const reply = (row: RuntimeRequest, result: Record<string, unknown> & { error?: unknown }) => queueMicrotask(() => socket.emit('message', JSON.stringify(result?.error ? { id: row.id, error: result.error } : { id: row.id, result })));
  socket.send = (raw: string) => {
    const row = JSON.parse(raw) as RuntimeRequest; if (row.id === undefined || !row.method) return;
    requests.push({ at: Date.now(), method: row.method });
    let result = {};
    if (row.method === 'initialize') result = { userAgent: 'workflow-performance-fixture' };
    else if (row.method === 'config/read') result = configRead;
    else if (row.method === 'configRequirements/read') result = { requirements: null };
    else if (row.method === 'pruner/read') return reply(row, { error: { code: -32601, message: 'Unknown method' } });
    else if (row.method === 'experimentalFeature/list') result = { data: [], nextCursor: null };
    else if (row.method === 'model/list') result = { data: [{ id: 'm-fast', model: 'm-fast', displayName: 'Local fixture', supportedReasoningEfforts: [] }], nextCursor: null };
    else if (row.method === 'thread/list') result = { data: [...threads.values()].filter(thread => !row.params?.ancestorThreadId || thread.parentThreadId === row.params.ancestorThreadId), nextCursor: null };
    else if (row.method === 'thread/start') {
      const id = randomUUID(), thread = { id, cwd: row.params.cwd ?? project, name: null, preview: '', source: 'appServer', model: row.params.model ?? 'm-fast', modelProvider: row.params.modelProvider ?? 'openai', status: { type: 'idle' } };
      threads.set(id, thread); result = { thread, model: thread.model, approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
    } else if (row.method === 'thread/name/set') { const thread = threads.get(row.params.threadId); if (thread) thread.name = row.params.name; result = {}; }
    else if (row.method === 'thread/read' || row.method === 'thread/resume') result = { thread: threads.get(row.params.threadId) };
    else if (row.method === 'workGraph/list') result = { data: [] };
    else if (row.method === 'account/read') result = { account: null };
    else if (row.method === 'account/rateLimits/read') result = {};
    reply(row, result);
  };
  return { socket, requests };
}

const runtime = fakeRuntime();
const client = new DesktopClient(runtime.socket, {
  appHome: profile, rewindHome: path.join(profile, 'rewind'), archiveDirectory: path.join(profile, 'archives'),
  spawnLinksFile: path.join(profile, 'spawn-links.json'), githubConnector: { instructions: () => Promise.resolve('') },
  workflowOptions: { stateDir: path.join(profile, 'workflow-state'), nodeSpec: (node: { name: string; prompt: string; model: string }) => ({
    name: node.name, instructions: node.prompt, command: process.execPath, args: [fakeAgent], model: node.model,
    env: { FAKE_ACP_NAME: node.name, FAKE_ACP_MODELS: 'm-fast', FAKE_ACP_HOLD_TURN: '1', FAKE_ACP_LOG: path.join(root, `${node.name}.jsonl`) },
  }) },
});
let server: Awaited<ReturnType<typeof startDesktopServer>> | undefined, browser: Browser | undefined;
try {
  await client.initialize();
  server = await startDesktopServer({ client, staticDir: path.join(appRoot, 'out'), elpisHome: profile, trashFile: path.join(profile, 'trash.json'), loveSpot: { directory: path.join(root, 'drawing') } });
  browser = await chromium.launch({ headless: true, ...(process.env.ELPIS_CHROMIUM ? { executablePath: process.env.ELPIS_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page.setDefaultTimeout(30_000);
  await page.addInitScript(fakeDesktop, {});
  await page.addInitScript(({ project, graph }) => {
    localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'p1', name: 'Performance project', cwd: project }], selectedId: 'p1' }));
    localStorage.setItem('elpis-workflow-draft-v1', JSON.stringify(graph));
    localStorage.setItem('elpis-canvas-auto', 'off');
  }, { project, graph });
  const requests: { at: number; method: string; path: string }[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) requests.push({ at: Date.now(), method: request.method(), path: url.pathname }); });
  await page.goto(server.url); await page.locator('.startup-splash').waitFor({ state: 'detached' });
  const navigationStarted = performance.now(); await page.locator('button[data-nav-page="canvas"]').click();
  const canvas = page.getByRole('region', { name: 'Workflows', exact: true }); await canvas.waitFor();
  const openWorkflowsMs = performance.now() - navigationStarted;
  await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
  await canvas.getByLabel('At once', { exact: true }).fill(String(count));
  const beforeRun = await processRows(), beforePids = new Set(beforeRun.map(row => row.pid));
  const runStarted = performance.now(), response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/workflows/run' && item.request().method() === 'POST');
  await canvas.getByRole('button', { name: 'Run graph', exact: true }).click(); await response;
  await page.waitForFunction(() => document.querySelectorAll('.agent-node[data-status="running"]').length > 0);
  const firstAgentVisibleMs = performance.now() - runStarted;
  await pause(3000);
  const samples: Sample[] = [];
  for (let index = 0; index < 10; index++) {
    const started = process.hrtime.bigint(), before = await processRows(); await pause(1000); const after = await processRows();
    const elapsed = Number(process.hrtime.bigint() - started) / 1e9, old = new Map(before.map(row => [row.pid, row.ticks]));
    const cpu = (rows: MeasuredProcess[]) => rows.reduce((sum, row) => sum + Math.max(0, row.ticks - (old.get(row.pid) ?? row.ticks)), 0) / tickRate / elapsed * 100;
    const renderer = after.filter(row => /--type=renderer\b/.test(row.command));
    samples.push({ cpuPercent: cpu(after), rendererCpuPercent: cpu(renderer), pssMiB: after.reduce((sum, row) => sum + row.pssKb, 0) / 1024,
      rendererPssMiB: renderer.reduce((sum, row) => sum + row.pssKb, 0) / 1024, processes: after.length });
  }
  const framePromise = page.evaluate(() => new Promise<number[]>(resolve => {
    const gaps: number[] = [], started = performance.now(); let previous = started;
    const frame = (now: number) => { gaps.push(now - previous); previous = now; if (now - started < 3500) requestAnimationFrame(frame); else resolve(gaps); }; requestAnimationFrame(frame);
  }));
  const firstAgent = canvas.locator('.react-flow__node-agent').first(), box = await firstAgent.boundingBox();
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 320, box.y + box.height / 2 + 120, { steps: 80 }); await page.mouse.up(); }
  const boardBox = await canvas.locator('.canvas-board').boundingBox();
  if (boardBox) { await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2); await page.keyboard.down('Control'); await page.mouse.wheel(0, -500); await page.mouse.wheel(0, 500); await page.keyboard.up('Control'); }
  const frameGaps = (await framePromise).sort((a, b) => a - b), percentile = (value: number) => frameGaps[Math.min(frameGaps.length - 1, Math.floor(frameGaps.length * value))];
  if (shots) {
    await fsp.mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: theme }); await pause(250); await page.screenshot({ path: path.join(shots, `agents-${count}-${theme}.png`) }); }
  }
  const afterRun = await processRows();
  const startedProcesses = afterRun.filter(row => !beforePids.has(row.pid)).map(({ pid, ppid, rssKb, pssKb, command }) => ({ pid, ppid, rssMiB: rssKb / 1024, pssMiB: pssKb / 1024, command }));
  const mean = (key: keyof Sample) => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
  const firstRunRequest = requests.find(row => row.path === '/api/workflows/run')?.at ?? Date.now();
  const calls = Object.fromEntries([...new Set(requests.map(row => `${row.method} ${row.path}`))].sort().map(key => [key, requests.filter(row => `${row.method} ${row.path}` === key && row.at >= firstRunRequest).length]));
  const result = { conditions: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(appRoot, '../..'), encoding: 'utf8' }).trim(), startedAt, agents: count, viewport: '1440x900', view: 'Flat', warmupSeconds: 3, samples: 10, intervalSeconds: 1, agent: 'fake-acp-agent.mjs held in session/prompt', networkModelCalls: 0 },
    timing: { openWorkflowsMs, firstAgentVisibleMs }, meanCpuPercent: mean('cpuPercent'), meanRendererCpuPercent: mean('rendererCpuPercent'), meanPssMiB: mean('pssMiB'), maxPssMiB: Math.max(...samples.map(sample => sample.pssMiB)), meanRendererPssMiB: mean('rendererPssMiB'), meanProcesses: mean('processes'),
    interactionFrames: { count: frameGaps.length, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: Math.max(...frameGaps) }, calls, startedProcesses, samples, runtimeRequests: runtime.requests };
  if (output) { await fsp.mkdir(path.dirname(output), { recursive: true }); await fsp.writeFile(output, `${JSON.stringify(result, null, 2)}\n`); }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => {}); await server?.close().catch(() => {}); client.close(); await pause(300);
  try { execFileSync('gio', ['trash', root]); } catch { /* Evidence remains isolated under its unique cache root if trash is unavailable. */ }
}
