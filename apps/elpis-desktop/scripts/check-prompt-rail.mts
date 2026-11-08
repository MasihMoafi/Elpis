// Opt-in packaged-app acceptance. Only copies selected session history; never copies auth/config.
// ELPIS_PLAYWRIGHT_PACKAGE=/path/to/playwright node scripts/check-prompt-rail.mts \
//   --app /path/to/package --source-home /path/to/elpis-home --engine /path/to/elpis-next
// --private-engine uses the installed provider bridge's real stdio engine through a socket adapter
// when the worker sandbox hides the native shared engine's fixed daemon socket directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

type SqlRow = Record<string, SQLOutputValue>;
type Thread = SqlRow & { id: string; source: string; rollout_path: string };
type Prompt = { text: string; turnId: string; itemId?: string | null };
type Action = { scenario?: string; phase: string; position?: number; turnId?: string; itemId?: string | null | undefined; loaded?: number };
type Query = { key: string; length: number; value?: string | undefined };
type Report = {
  app: string; home: string; transport: string;
  copiedSessions: { id: string; name: SQLOutputValue | undefined; providerTurns: number }[];
  scenarios: { name: string; pass: boolean; error?: string; geometry?: unknown }[];
  requests: { action: Action | undefined; path: string; query: Query[] }[];
  rejections: { action: Action | undefined; path: string; query: Query[]; status: number; error: unknown; code: unknown }[];
  action?: Action; lastPrompt?: string | null; startupError?: string;
  injectedCursorRejection?: { path: string; cursor: string; reason: string };
};
type Request = { url(): string };
type Response = { url(): string; status(): number; request(): Request; json(): Promise<Record<string, unknown>> };
type Route = { request(): Request; continue(options?: { url: string }): Promise<void> };
type Locator = {
  isVisible(): Promise<boolean>; click(): Promise<void>; waitFor(): Promise<void>; hover(): Promise<void>;
  count(): Promise<number>; innerText(): Promise<string>; getAttribute(name: string): Promise<string | null>;
  first(): Locator; last(): Locator; nth(index: number): Locator;
};
type Page = {
  url(): string; setDefaultTimeout(ms: number): void;
  on(event: 'request', listener: (request: Request) => void): void;
  on(event: 'response', listener: (response: Response) => void | Promise<void>): void;
  locator(selector: string): Locator;
  getByRole(role: string, options: { name: string; exact: boolean }): Locator;
  getByText(text: string | RegExp): Locator;
  evaluate<T>(fn: () => T | Promise<T>): Promise<Awaited<T>>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<Awaited<T>>;
  waitForFunction(fn: () => unknown): Promise<void>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options?: { timeout: number }): Promise<void>;
  route(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
  unroute(pattern: string, handler: (route: Route) => Promise<void>): Promise<void>;
  reload(): Promise<unknown>; screenshot(options: { path: string }): Promise<unknown>;
};
type Browser = { contexts(): { pages(): Page[] }[]; close(): Promise<void> };
type ApiResult = { data: Prompt[]; nextCursor?: string; error?: unknown };

const { values } = parseArgs({ options: { app: { type: 'string' }, 'source-home': { type: 'string' }, engine: { type: 'string' }, port: { type: 'string', default: '9429' }, 'private-engine': { type: 'boolean', default: false } } });
for (const key of ['app', 'source-home', 'engine'] as const) assert.ok(values[key] && path.isAbsolute(values[key]), `Provide --${key} as an absolute path`);
const app = values.app, sourceHome = values['source-home'], enginePath = values.engine;
assert.ok(app && sourceHome && enginePath);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright') as { chromium: { connectOverCDP(url: string): Promise<Browser> } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'a98-acceptance-'));
const shots = path.join(home, 'shots');
fs.mkdirSync(shots); fs.mkdirSync(path.join(home, 'run'), { mode: 0o700 });
const elpis = path.join(home, 'elpis'); fs.mkdirSync(elpis);
const sourceDb = (name: string) => new DatabaseSync(`file:${path.join(sourceHome, name)}?mode=ro&immutable=1`, { readOnly: true });
const state = sourceDb('state_5.sqlite'), history = sourceDb('thread_history_1.sqlite');
const farsi = state.prepare('SELECT * FROM threads WHERE name = ?').get('Create English-to-Farsi workflow');
const isThread = (row: SqlRow | undefined): row is Thread => Boolean(row && typeof row.id === 'string' && typeof row.source === 'string' && typeof row.rollout_path === 'string');
assert.ok(isThread(farsi), 'The named real session exists');
const realThreads = [farsi];
for (const row of history.prepare("SELECT thread_id, count(*) AS prompts FROM thread_items WHERE item_type = 'userMessage' GROUP BY thread_id ORDER BY prompts DESC").all()) {
  assert.ok(row.thread_id !== undefined);
  const thread = state.prepare('SELECT * FROM threads WHERE id = ?').get(row.thread_id);
  if (isThread(thread) && ['cli', 'vscode'].includes(thread.source) && fs.existsSync(thread.rollout_path) && thread.id !== farsi.id) { realThreads.push(thread); break; }
}
assert.equal(realThreads.length, 2, 'A long real session exists');
const insert = (db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) => {
  const keys = Object.keys(row);
  const values = keys.map(key => { const value = row[key]; assert.ok(value !== undefined); return value; });
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...values);
};
const copies = new Map();
for (const thread of realThreads) {
  const relative = path.relative(path.join(sourceHome, 'sessions'), thread.rollout_path);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'Only session files are copied');
  const target = path.join(elpis, 'sessions', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(thread.rollout_path, target); copies.set(thread.id, target);
}
// Subscription history also lives beside the rollouts. Copy only these chats' history,
// never their provider sessions, accounts, keys, defaults or configuration. Without this
// metadata the real bridge skips providerPage and the oversized cursor cannot reproduce.
const providerSource = path.join(sourceHome, 'elpis-claude', 'sessions.json');
const providerHistory: Record<string, { providerHistory: boolean; model: null; turns: unknown[] }> = {};
if (fs.existsSync(providerSource)) {
  const store: Record<string, { turns?: unknown[] }> = JSON.parse(fs.readFileSync(providerSource, 'utf8'));
  for (const { id } of realThreads) if (store[id]) {
    providerHistory[id] = { providerHistory: true, model: null, turns: store[id].turns ?? [] };
  }
}
fs.mkdirSync(path.join(elpis, 'elpis-claude'), { recursive: true });
fs.writeFileSync(path.join(elpis, 'elpis-claude', 'sessions.json'), JSON.stringify(providerHistory));
const databases: DatabaseSync[] = [];
for (const [source, name, tables] of [[state, 'state_5.sqlite', ['threads']], [history, 'thread_history_1.sqlite', ['thread_turns', 'thread_items', 'thread_history_projection_state', 'thread_realtime_items']]] as const) {
  const target = new DatabaseSync(path.join(elpis, name)); databases.push(target);
  for (const row of source.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all()) { assert.ok(typeof row.sql === 'string'); target.exec(row.sql); }
  for (const row of source.prepare('SELECT * FROM _sqlx_migrations').all()) insert(target, '_sqlx_migrations', row);
  for (const table of tables) for (const thread of realThreads) {
    for (const row of source.prepare(`SELECT * FROM ${table} WHERE ${table === 'threads' ? 'id' : 'thread_id'} = ?`).all(thread.id)) {
      if (table === 'threads') { const copied = copies.get(thread.id); assert.ok(copied); row.rollout_path = copied; row.project_id = null; row.thread_section_id = null; }
      insert(target, table, row);
    }
  }
}
const [seedState, seedHistory] = databases;
function generated(count: number) {
  assert.ok(seedState && seedHistory);
  const id = randomUUID(), name = `A98 · ${count} prompts`, file = path.join(elpis, 'sessions', `rollout-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`);
  const at = Date.now(), timestamp = new Date(at).toISOString();
  const events: { timestamp: string; ordinal: number; type: string; payload: Record<string, unknown> }[] = [{ timestamp, ordinal: 0, type: 'session_meta', payload: { id, session_id: id, timestamp, cwd: home, source: 'cli', originator: 'elpis-desktop', cli_version: '0.162.0', history_mode: 'paginated' } }];
  const add = (type: string, payload: Record<string, unknown>) => { const ordinal = events.length; events.push({ timestamp, ordinal, type, payload }); return ordinal; };
  for (let index = 0; index < count; index++) {
    const turnId = randomUUID(), prompt = `A98 prompt ${String(index + 1).padStart(3, '0')}.`, reply = `A98 answer ${index + 1}.\n\n${'A paragraph of recorded history for scrolling.\n\n'.repeat(12)}`;
    const start = add('event_msg', { type: 'task_started', turn_id: turnId, root_turn_id: turnId });
    const userId = randomUUID(), agentId = randomUUID();
    const u = add('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'UserMessage', id: userId, content: [{ type: 'text', text: prompt, text_elements: [] }] } });
    const a = add('event_msg', { type: 'item_completed', thread_id: id, turn_id: turnId, item: { type: 'AgentMessage', id: agentId, content: [{ type: 'Text', text: reply }], phase: 'final_answer' } });
    add('event_msg', { type: 'task_complete', turn_id: turnId, root_turn_id: turnId, last_agent_message: reply });
    insert(seedHistory, 'thread_turns', { thread_id: id, turn_id: turnId, rollout_ordinal: start, status: 'completed', first_user_item_id: userId, final_agent_item_id: agentId });
    for (const [ordinal, item] of [[u, { type: 'userMessage', id: userId, content: [{ type: 'text', text: prompt, text_elements: [] }] }], [a, { type: 'agentMessage', id: agentId, text: reply, phase: 'final_answer' }]] as const) {
      insert(seedHistory, 'thread_items', { thread_id: id, turn_id: turnId, item_id: item.id, rollout_ordinal: ordinal, updated_at_ordinal: ordinal, created_at_ms: at + index * 1000, item_type: item.type, item_json: JSON.stringify(item) });
    }
  }
  const body = events.map(event => JSON.stringify(event) + '\n').join(''); fs.writeFileSync(file, body);
  insert(seedHistory, 'thread_history_projection_state', { thread_id: id, next_rollout_byte_offset: Buffer.byteLength(body), next_rollout_ordinal: events.length });
  insert(seedState, 'threads', { ...farsi, id, name, title: name, first_user_message: name, preview: name, rollout_path: file, source: 'cli', cwd: home, project_id: null, thread_section_id: null, creator_user_id: null, creator_account_id: null });
  return { id, name };
}
const empty = generated(0), single = generated(1), many = generated(205);
for (const db of [state, history, ...databases]) db.close();

// A fresh environment prevents inherited auth homes, sockets and agent settings from reaching the app.
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, ELPIS_HOME: elpis, CODEX_HOME: path.join(home, 'codex'), ELPIS_ENGINE_BIN: enginePath,
  XDG_CONFIG_HOME: home + '/.config', XDG_CACHE_HOME: home + '/.cache', XDG_DATA_HOME: home + '/.local/share', XDG_STATE_HOME: home + '/.local/state', XDG_RUNTIME_DIR: home + '/run', TMPDIR: home, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
const log = fs.openSync(path.join(home, 'app.log'), 'w');
const children: ChildProcess[] = []; let adapter: net.Server | undefined, browser: Browser | undefined;
const report: Report = { app, home, transport: values['private-engine'] ? 'real private engine via socket adapter' : 'normal shared engine', copiedSessions: realThreads.map(thread => ({ id: thread.id, name: thread.name, providerTurns: providerHistory[thread.id]?.turns.length ?? 0 })), scenarios: [], requests: [], rejections: [] };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const start = (command: string, args: string[], environment: NodeJS.ProcessEnv = env) => { const child = spawn(command, args, { env: environment, cwd: home, stdio: ['ignore', log, log] }); children.push(child); return child; };
if (values['private-engine']) {
  const engine = fs.realpathSync(enginePath), directory = path.dirname(engine);
  const root = path.basename(directory) === 'bin' && path.basename(path.dirname(directory)) === 'package' ? path.resolve(directory, '../..') : directory;
  const tcpPort = Number(values.port) + 1;
  start(process.execPath, [path.join(root, 'tools/elpis-claude/acp-bridge.mjs')], { ...env, PORT: String(tcpPort) });
  adapter = net.createServer(socket => {
    const upstream = net.connect(tcpPort, '127.0.0.1');
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.pipe(upstream).pipe(socket);
  });
  const server = adapter;
  await new Promise<void>(resolve => server.listen(home + '/bridge.sock', resolve)); fs.chmodSync(home + '/bridge.sock', 0o600); env.ELPIS_APP_BRIDGE_SOCKET = home + '/bridge.sock';
}
console.log(`A98 evidence: ${home}`);
try {
  start('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24 -extension GLX', '-e', home + '/xvfb.log', path.join(app, 'launch'), '--no-sandbox', '--disable-gpu', '--ozone-platform=x11', `--remote-debugging-port=${values.port}`]);
  for (let attempt = 0; attempt < 30 && !browser; attempt++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${values.port}`); } catch { await pause(1000); } }
  assert.ok(browser, `App did not open; see ${home}/app.log and xvfb.log`);
  let selectedPage: Page | undefined;
  for (let attempt = 0; attempt < 30 && !selectedPage; attempt++) { selectedPage = browser.contexts().flatMap(context => context.pages()).find(tab => tab.url().startsWith('http://127.0.0.1')); if (!selectedPage) await pause(1000); }
  assert.ok(selectedPage, `Renderer did not open; see ${home}/app.log`);
  const page = selectedPage;
  page.setDefaultTimeout(10000);
  const requestActions = new WeakMap<Request, Action | undefined>();
  page.on('request', request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith('/api/threads')) return;
    requestActions.set(request, report.action);
    report.requests.push({ action: report.action, path: url.pathname, query: [...url.searchParams].map(([key, value]) => ({ key, length: value.length, value: ['cursor', 'ancestorThreadId'].includes(key) ? value : undefined })) });
  });
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/threads') && response.status() >= 400) {
      const body: Record<string, unknown> = await response.json().catch(() => ({}));
      report.rejections.push({ action: requestActions.get(response.request()), path: url.pathname, query: [...url.searchParams].map(([key, value]) => ({ key, length: value.length })), status: response.status(), error: body.error, code: body.code });
    }
  });
  const lastPrompt = (): string | null => report.lastPrompt ?? null;
  const check = async (name: string, run: () => Promise<void>) => { report.action = { scenario: name, phase: 'setup' }; report.lastPrompt = null; try { await run(); report.scenarios.push({ name, pass: true }); console.log('PASS', name); } catch (error) {
    const geometry = await page.evaluate(expected => {
      const root = document.querySelector('.chat-scroll');
      if (!root) return { expected, root: null, matches: [] };
      const bounds = root.getBoundingClientRect();
      return { expected, viewport: innerHeight, root: { top: bounds.top, bottom: bounds.bottom, height: root.clientHeight, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight }, matches: [...root.querySelectorAll('.message.user')].filter(node => expected && node.textContent?.trim().startsWith(expected.trim())).map(node => ({ text: node.textContent?.slice(0, 90), top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom })) };
    }, lastPrompt());
    const message = error instanceof Error ? error.message : String(error);
    report.scenarios.push({ name, pass: false, error: message, geometry }); console.log('FAIL', name, message.split('\n')[0], JSON.stringify(geometry)); await page.screenshot({ path: path.join(shots, `failure-${report.scenarios.length}.png`) });
  } };
  const api = (route: string): Promise<ApiResult> => page.evaluate(async route => { const response = await fetch('/api' + route); return response.json(); }, route);
  const marks = () => page.locator('[data-slot="prompt-mark"]');
  const open = async (thread: { id: string }) => {
    const sidebar = page.getByRole('button', { name: 'Open sidebar', exact: true }); if (await sidebar.isVisible()) await sidebar.click();
    await page.locator(`[data-thread-id="${thread.id}"] .thread-link`).click();
    await page.waitForFunction(() => !document.querySelector('.chat-loading'));
  };
  const index = async (thread: { id: string }) => { const result = await api(`/threads/${thread.id}/prompts`); assert.ok(Array.isArray(result.data)); await page.waitForFunction(n => document.querySelectorAll('[data-slot="prompt-mark"]').length === n, result.data.length); return result.data; };
  const visible = async (prompt: Prompt) => {
    await page.waitForFunction(prompt => {
      const root = document.querySelector('.chat-scroll');
      if (!root) return false;
      const exact = prompt.itemId && document.getElementById('message-' + encodeURIComponent(JSON.stringify([prompt.turnId, prompt.itemId])))?.querySelector('.message.user');
      const messages = prompt.itemId ? (exact ? [exact] : []) : [...root.querySelectorAll('.message.user')];
      return messages.some(node => { const rect = node.getBoundingClientRect(), bounds = root.getBoundingClientRect(); return node.textContent?.trim().startsWith(prompt.text.trim()) && rect.top >= bounds.top - 2 && rect.top < bounds.bottom; });
    }, prompt, { timeout: 5000 });
  };
  const jump = async (prompts: Prompt[], position: number) => {
    const prompt = prompts[position]; assert.ok(prompt);
    report.lastPrompt = prompt.text;
    report.action = { ...report.action, phase: 'hover', position: position + 1, turnId: prompt.turnId, itemId: prompt.itemId };
    await marks().nth(position).hover();
    const text = prompt.text.trim().split(/\r?\n/)[0]; assert.ok(text !== undefined);
    assert.ok((await page.locator('.prompt-preview').innerText()).includes(text));
    report.action = { ...report.action, phase: 'click', loaded: await page.locator('section.turn[data-prompt]').count() };
    await marks().nth(position).click(); await visible(prompt);
    await pause(700); await visible(prompt);
  };
  await page.locator(`[data-thread-id="${farsi.id}"]`).waitFor();
  await check('real provider cursor continues through HTTP', async () => {
    const first = await api(`/threads/${farsi.id}?limit=100`);
    assert.ok(first.nextCursor, 'The copied real session needs another history page');
    const next = await api(`/threads/${farsi.id}?limit=100&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.ok(Array.isArray(next.data), JSON.stringify({ error: next.error, cursorLength: first.nextCursor.length }));
    assert.ok(first.nextCursor.length <= 4096);
  });
  for (const thread of realThreads) {
    let prompts: Prompt[] | undefined;
    await check(`open real copied session: ${thread.name}`, async () => { await open(thread); prompts = await index(thread); assert.ok(prompts.length > 1); });
    if (prompts) for (const [label, position] of [['last', prompts.length - 1], ['middle', Math.floor(prompts.length / 2)], ['first', 0]] as const) await check(`${thread.name}: ${label} prompt`, async () => {
      assert.ok(prompts); await jump(prompts, position); assert.equal(await page.getByText(/Invalid cursor or ancestor ID/).count(), 0);
    });
  }
  await check('empty chat', async () => { await open(empty); await page.getByText('This conversation has no messages yet.').waitFor(); assert.equal(await marks().count(), 0); });
  await check('single prompt', async () => { await open(single); const prompts = await index(single); assert.equal(prompts.length, 1); await jump(prompts, 0); });
  let manyPrompts: Prompt[] | undefined;
  await check('205 prompts open with unloaded history', async () => { await open(many); manyPrompts = await index(many); assert.equal(manyPrompts.length, 205); assert.ok(await page.locator('section.turn[data-prompt]').count() < 205); });
  if (manyPrompts) for (const [label, position] of [['last', 204], ['middle unloaded', 102], ['first unloaded', 0]] as const) await check(`205 prompts: ${label}`, () => { assert.ok(manyPrompts); return jump(manyPrompts, position); });
  await check('bookmark after reload', async () => {
    await marks().nth(102).hover(); await page.getByRole('button', { name: 'Bookmark turn', exact: true }).click();
    await page.reload(); await open(many); await index(many);
    assert.equal(await marks().nth(102).getAttribute('data-bookmarked'), 'true');
    const prompts = await index(many); await jump(prompts, 0); await jump(prompts, 204);
  });
  await check('last click wins during real history paging', async () => {
    await page.reload(); await open(many); const prompts = await index(many);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>(), { promise: began, resolve: requested } = Promise.withResolvers<void>(); let held = false;
    const pattern = `**/api/threads/${many.id}?*`;
    const hold = async (route: Route) => { if (!held && new URL(route.request().url()).searchParams.has('cursor')) { held = true; requested(); await gate; } await route.continue(); };
    await page.route(pattern, hold);
    try {
      await marks().first().click(); await Promise.race([began, pause(5000).then(() => { throw Error('No older-page request'); })]);
      const lastPrompt = prompts[204]; assert.ok(lastPrompt);
      report.lastPrompt = lastPrompt.text;
      await marks().last().click(); release();
      await page.waitForFunction(() => document.querySelectorAll('section.turn[data-prompt]').length === 205);
      await pause(700);
      await visible(lastPrompt);
    } finally { release(); await page.unroute(pattern, hold); }
  });
  await check('real rejection, readable error, loaded tick usable, retry', async () => {
    await page.reload(); await open(many); const prompts = await index(many); let rejected = false;
    const pattern = `**/api/threads/${many.id}?*`;
    const rejectOnce = async (route: Route) => { const url = new URL(route.request().url()); if (!rejected && url.searchParams.has('cursor')) { rejected = true; url.searchParams.set('cursor', ''); report.injectedCursorRejection = { path: url.pathname, cursor: '', reason: 'acceptance fault injection' }; await route.continue({ url: url.href }); } else await route.continue(); };
    await page.route(pattern, rejectOnce);
    try {
      await marks().first().click(); await page.getByText(/Invalid cursor or ancestor ID/).waitFor();
      await page.screenshot({ path: path.join(shots, 'injected-rejection.png') });
      await jump(prompts, 204); await jump(prompts, 0);
      assert.equal(await page.getByText(/Invalid cursor or ancestor ID/).count(), 0);
    } finally { await page.unroute(pattern, rejectOnce); }
  });
  for (const theme of ['light', 'dark']) await check(`${theme}: real hover, navigation and screenshot`, async () => {
    const controls = require('../tests/controls.cjs');
    if (await page.evaluate(() => document.documentElement.classList.contains('dark')) !== (theme === 'dark')) await controls.chooseTheme(page, theme);
    await open(many); const prompts = await index(many);
    try {
      await jump(prompts, 102);
      for (const position of [0, 102, 204]) {
        await marks().nth(position).hover();
        await page.waitForFunction(() => {
          const cardElement = document.querySelector('.prompt-preview'), chatElement = document.querySelector('.chat-scroll');
          if (!cardElement || !chatElement) return false;
          const card = cardElement.getBoundingClientRect(), chat = chatElement.getBoundingClientRect();
          return card.top >= chat.top && card.bottom <= chat.bottom;
        });
      }
    }
    finally { await marks().nth(102).hover(); await page.screenshot({ path: path.join(shots, theme + '.png') }); }
  });
} catch (error) { report.startupError = error instanceof Error ? error.message : String(error); console.error(report.startupError); }
finally {
  fs.writeFileSync(home + '/report.json', JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); for (const child of children.reverse()) child.kill('SIGTERM'); adapter?.close(); fs.closeSync(log);
}
process.exitCode = report.startupError || report.scenarios.some(row => !row.pass) ? 1 : 0;
// Shared runtimes are confined to this invocation's throwaway home; stop their surviving processes too.
for (const entry of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
  try { if (Number(entry) !== process.pid && fs.readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) process.kill(Number(entry), 'SIGTERM'); } catch {}
}
setTimeout(() => process.exit(process.exitCode), 250).unref();
