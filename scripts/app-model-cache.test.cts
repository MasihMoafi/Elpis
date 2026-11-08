'use strict';
// Actual browser + shared bridge; cached model must follow an external native switch. Local synthetic fixtures only.
import type { ProviderApi } from './lib/mock-provider.cts';

type Socket = {
  once(event: 'open', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  send(data: string): void;
  terminate(): void;
};
type WireMessage = { id?: number; method?: string; error?: { message: string }; result?: unknown; params: { threadId?: string; thread?: { id: string }; turn: { id: string } } };
type Waiter = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type ClientState = { ws: Socket; seen: WireMessage[]; pending: Map<number | undefined, Waiter>; next: number; approvals: WireMessage[] };
type Client = ClientState & { req<T>(method: string, params?: unknown): Promise<T>; event(method: string, tid: string): WireMessage[] };
type ThreadResult = { thread: { id: string; model?: string; modelProvider?: string } };
type ThreadRow = { id: string; model?: string };
type ThreadList = { data: ThreadRow[] };
type DesktopClient = { on(event: 'event', listener: (event: { method: string }) => void): void };
type Desktop = { url: string; close(): Promise<void> };
type Locator = { click(): Promise<void>; waitFor(options?: { state: string }): Promise<void>; inputValue(): Promise<string> };
type BrowserResponse = { url(): string; request(): { method(): string }; json(): Promise<unknown> };
type Page = { on(event: 'response', listener: (response: BrowserResponse) => void | Promise<void>): void; goto(url: string): Promise<unknown>; getByRole(role: string, options: { name: string; exact: boolean }): Locator; getByLabel(label: string, options: { exact: boolean }): Locator; waitForFunction(fn: (expected: string) => boolean, expected: string): Promise<unknown>; screenshot(options: { path: string }): Promise<Buffer> };
type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type TurnResult = { turn: { id: string } };
type HistoryItem = { method: string };
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const WebSocket: new (address: string) => Socket = require('../tools/elpis-claude/node_modules/ws');
const { Provider, message }: ProviderApi = require('./lib/mock-provider.cts');
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const wait = async (f: () => boolean, label: string) => { const until = Date.now() + 20000; while (!f()) { assert(Date.now() < until, `timed out: ${label}`); await pause(20); } };
async function main() {
  const binary = process.argv[2] as string;
  const gemini = process.argv.includes('--gemini');
  const model = gemini ? 'agy/gemini-3.8-flash-medium' : 'claude/haiku';
  assert(path.isAbsolute(binary), 'absolute engine path required');
  const repo = path.resolve(__dirname, '..'); const provider = new Provider(); await provider.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-shared-provider-'));
  const home = path.join(root, 'home'), cwd = path.join(root, 'work'), other = path.join(root, 'other');
  for (const p of [home, cwd, other]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\n[features]\nmulti_agent=false\n[model_providers.fixture]\nname="offline fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const sock = path.join(root, 'bridge.sock'), log = path.join(root, 'bridge.log'), control = path.join(root, 'control.json'), calls = path.join(root, 'calls.jsonl');
  const adapter = path.join(root, 'adapter.cjs');
  const agy = path.join(root, 'agy.cjs');
  fs.writeFileSync(agy, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--input-format'))process.stdin.on('data',()=>fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'agy/prompt',args:process.argv.slice(2)})+'\\n'));process.argv.push('--agy-fixture');require(${JSON.stringify(path.resolve(path.join(repo, 'scripts'), 'permissions-bridge.test.cts'))});\n`, { mode: 0o755 });
  fs.writeFileSync(adapter, `const fs=require('node:fs');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(l)fs.appendFileSync(${JSON.stringify(calls)},l+'\\n');}});require(${JSON.stringify(path.resolve(path.join(repo, 'scripts'), 'permissions-bridge.test.cts'))});\n`);
  const bridgeShaAtStart = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(repo,'tools/elpis-claude/acp-bridge.mjs'))).digest('hex');
  const bridge = spawn(process.execPath, [process.env.SHARED_PROVIDER_BRIDGE ?? path.resolve(path.join(repo, 'scripts'), '../tools/elpis-claude/acp-bridge.mjs')], { cwd, env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home, ELPIS_HOME: home, CODEX_AUTH_HOME: home,
    ELPIS_ENGINE_BIN: binary, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: sock, ...(gemini ? { AGY_BIN: agy } : { ELPIS_NO_AGY: '1' }),
    ACP_BRIDGE_LOG: log, ACP_ADAPTER: adapter, ACP_BRIDGE_NO_AGENTS: '1', PERMISSION_FIXTURE_ADAPTER: '1', PERMISSION_FIXTURE_CONTROL: control,
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; bridge.stderr.on('data', d => { errors += d; });
  const clients: ClientState[] = []; let serial = 0;
  let desktop: Desktop | undefined, browser: Browser | undefined, desktopClient: DesktopClient | undefined;
  const pass = (text: string) => console.log(`PASS ${text}`);
  const history = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse as (line: string) => HistoryItem) : [];
  const hold = () => { const p = { ready: path.join(root, `ready-${++serial}`), release: path.join(root, `release-${serial}`), marker: path.join(root, `marker-${serial}`) }; fs.writeFileSync(control, JSON.stringify(p)); return p; };
  async function connect(name = 'codex-tui') {
    const ws = new WebSocket(`ws+unix://${sock}:/`);
    await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c: ClientState & Partial<Pick<Client, 'req' | 'event'>> = { ws, seen: [], pending: new Map(), next: 1, approvals: [] }; clients.push(c);
    ws.on('message', data => {
      const m: WireMessage = JSON.parse(String(data)); c.seen.push(m);
      if (m.method && m.id !== undefined) { c.approvals.push(m); ws.send(JSON.stringify({ id: m.id, result: { decision: 'decline' } })); }
      else if (!m.method) { const p = c.pending.get(m.id); if (p) { c.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
    });
    c.req = <T,>(method: string, params: unknown = {}) => new Promise<T>((resolve, reject) => { const id = c.next++; const timer = setTimeout(() => { c.pending.delete(id); reject(Error(`timeout ${method}: ${errors}`)); }, 20000); c.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); ws.send(JSON.stringify({ id, method, params })); });
    c.event = (method: string, tid: string) => c.seen.filter(m => m.method === method && (m.params.threadId ?? m.params.thread?.id) === tid);
    await c.req('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } }); ws.send(JSON.stringify({ method: 'initialized' }));
    return c as Client;
  }
  try {
    await wait(() => fs.existsSync(sock) || bridge.exitCode !== null, 'listener');
    assert.equal(bridge.exitCode, null, errors);
    const a = await connect();
    const checks = [];
    const subscription = await a.req<ThreadResult>('thread/start', { cwd, model, approvalPolicy:'never', permissions:':danger-full-access' });
    const f=hold(); const st=(await a.req<TurnResult>('turn/start',{threadId:subscription.thread.id,input:[{type:'text',text:'CACHE_SUBSCRIPTION_INITIAL',text_elements:[]}]})).turn;
    await wait(()=>fs.existsSync(f.ready),'subscription prompt');fs.writeFileSync(f.release,'go');await wait(()=>a.event('turn/completed',subscription.thread.id).some(e=>e.params.turn.id===st.id),'subscription completed');
    await a.req('thread/name/set', { threadId: subscription.thread.id, name: 'Cache model before external switch' });
    const { pathToFileURL } = require('node:url');
    const { startDesktopServer }: { startDesktopServer(options: { client: DesktopClient; staticDir: string }): Promise<Desktop> } = await import(pathToFileURL(path.join(repo, 'apps/elpis-desktop/bridge/server.mts')).href);
    const playwright: { chromium: { launch(options: { executablePath: string | undefined; headless: boolean; args: string[] }): Promise<Browser> } } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
    const staticArg = process.argv.indexOf('--static-dir');
    const staticDir = staticArg >= 0 ? process.argv[staticArg + 1] as string : path.join(repo, '.tmp/dashboard-repair/app-final-20261014/out');
    const { DesktopClient }: { DesktopClient: { connect(options: { socketPath: string }): Promise<DesktopClient> } } = await import(pathToFileURL(path.join(repo, 'apps/elpis-desktop/bridge/client.mts')).href);
    desktopClient = await DesktopClient.connect({ socketPath: fs.realpathSync(sock) });
    desktop = await startDesktopServer({ client: desktopClient, staticDir });
    browser = await playwright.chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const events: { method: string }[] = [];
    desktopClient.on('event', event => { if(event.method === 'thread/settings/updated') events.push(event); });
    const listReads: ThreadList[] = [];
    page.on('response', async response => { if(new URL(response.url()).pathname === '/api/threads' && response.request().method() === 'GET') { try { listReads.push(await response.json() as ThreadList); } catch {} } });
    await page.goto(desktop.url);
    await page.getByRole('button', { name: 'Cache model before external switch', exact: true }).click();
    const selector = page.getByLabel('Model', { exact: true });
    await selector.waitFor({ state: 'visible' });
    await page.waitForFunction((expected: string) => (document.querySelector('select[aria-label="Model"]') as HTMLSelectElement | null)?.value === expected, model);
    checks.push({ name: 'subscription read populates app model cache', passed: await selector.inputValue() === model, value: await selector.inputValue() });
    await a.req('thread/settings/update', { threadId: subscription.thread.id, model: 'gpt-5.5' });
    const native = await a.req<ThreadResult>('thread/read', { threadId: subscription.thread.id, includeTurns: false });
    const listed = await a.req<ThreadList>('thread/list', { limit: 100 });
    const listedThread = listed.data.find(thread => thread.id === subscription.thread.id);
    await a.req('thread/name/set', { threadId: subscription.thread.id, name: 'Cache model after external switch' });
    await page.getByRole('heading', { name: 'Cache model after external switch', exact: true }).waitFor();
    await pause(300);
    const observed = await selector.inputValue();
    const lastListed = listReads.at(-1)?.data?.find(thread => thread.id === subscription.thread.id);
    checks.push({ name: 'authoritative native read uses new model', passed: native.thread.model === 'gpt-5.5', value: native.thread.model });
    checks.push({ name: 'authoritative list route attribution', passed: listedThread?.model !== model, value: listedThread?.model ?? null, appListValue: lastListed?.model ?? null });
    checks.push({ name: 'open app cache follows external native model switch', passed: observed === 'gpt-5.5', value: observed, expected: 'gpt-5.5' });
    await page.screenshot({ path: path.join(root, 'app-model-after-switch.png') });
    const details = { root, binary, checks, settingsEvents: events.length, nativeRead: { model: native.thread.model, modelProvider: native.thread.modelProvider }, listedModel: listedThread?.model ?? null, browserModel: observed, staticDir };
    fs.writeFileSync(path.join(root, 'app-model-cache.json'), JSON.stringify(details, null, 2));
    console.log(JSON.stringify(details));
    assert(checks.every(check => check.passed), 'app model cache must follow the authoritative backend route');
  } finally {
    await browser?.close(); await desktop?.close();
    for (const c of clients) { for (const p of c.pending.values()) clearTimeout(p.timer); c.ws.terminate(); }
    bridge.kill('SIGTERM');
    await Promise.race([new Promise<void>(r => bridge.once('exit', () => r())), pause(5000).then(() => bridge.kill('SIGKILL'))]);
    provider.close();
    fs.writeFileSync(path.join(root, 'stderr.log'), errors); console.log(`Evidence ${root}`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
