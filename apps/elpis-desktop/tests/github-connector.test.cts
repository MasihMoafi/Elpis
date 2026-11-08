import type { test as nodeTest } from 'node:test';

type TerminalCalls = { open: [string, ...unknown[]][]; input: [string, string][] };
type TerminalWindow = typeof window & { __terminal: TerminalCalls };

const { test }: { test: typeof nodeTest } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { EventEmitter }: typeof import('node:events') = require('node:events');
type Locator = {
  locator(selector: string): Locator;
  getByRole(role: string, options?: object): Locator;
  getByText(text: string, options?: object): Locator;
  allInnerTexts(): Promise<string[]>;
  getAttribute(name: string): Promise<string | null>;
  waitFor(options?: object): Promise<void>;
  click(): Promise<void>;
  focus(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
};
type Page = {
  locator(selector: string): Locator;
  getByRole(role: string, options?: object): Locator;
  keyboard: { press(key: string): Promise<void> };
  waitForFunction<T>(fn: (value: T) => unknown, value: T): Promise<void>;
  waitForFunction(fn: () => unknown): Promise<void>;
  waitForResponse(fn: (response: { url(): string; request(): { method(): string } }) => boolean): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  reload(): Promise<void>;
};
type Fixture = { page: Page; composer: Locator; errors: unknown[]; close(): Promise<void> };
const { fixture }: { fixture(options: object): Promise<Fixture> } = require('./parity-fixture.cts');

function state(login: string | null = 'octocat') {
  const github = { name: 'GitHub', transport: 'gh', enabled: false, login }, writes: { enabled: boolean }[] = [];
  const reply = () => ({ skills: { data: [] }, plugins: { data: [] }, connectors: { data: [{ ...github }, { name: 'rag', enabled: true, transport: 'stdio' }] } });
  return { github, writes, routes: {
    '/api/customize': reply,
    '/api/customize/github': (body: { enabled: boolean }) => { writes.push(body); github.enabled = body.enabled; return reply(); },
  } };
}
async function connectors(page: Page) {
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: 'Connectors', exact: true }).click();
  return page.getByRole('region', { name: 'Your connectors', exact: true });
}

test('mouse and keyboard toggle control the instructions sent by the real bridge for new chats', async () => {
  const { DesktopClient } = await import('../bridge/client.mts');
  const { createGithubConnector } = await import('../bridge/github-connector.mts');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-github-ui-'));
  const socket = Object.assign(new EventEmitter(), { close: () => {}, send: (_raw: string) => {} });
  const starts: { developerInstructions?: string }[] = [], gh: [string, string[], { timeout: number }][] = [], threads = [{ id: 'chat-a', name: 'Fixture chat', cwd: '/tmp', status: { type: 'idle' } }];
  socket.send = (raw: string) => {
    const { id, method, params } = JSON.parse(raw) as { id: string | number; method: string; params: { developerInstructions?: string } };
    let result: unknown = ({ 'skills/list': { data: [] }, 'plugin/installed': { marketplaces: [] },
      'config/read': { config: { model: 'sol', model_provider: 'openai', mcp_servers: {} } },
      'model/list': { data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }] } } as Record<string, unknown>)[method];
    if (method === 'thread/start') {
      starts.push(params);
      const thread = { id: `00000000-0000-0000-0000-00000000000${starts.length}`, name: `New ${starts.length}`, model: 'sol', cwd: '/tmp', status: { type: 'idle' } };
      threads.push(thread); result = { thread };
    }
    assert.ok(result, `unexpected RPC ${method}`);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id, result })));
  };
  const client = new DesktopClient(socket, { rewindHome: home, githubConnector: createGithubConnector({ home,
    run: async (...args) => { gh.push(args); return 'planted-login'; } }) });
  await client.models();
  const routes: Record<string, (body: unknown) => unknown> = { '/api/customize': () => client.customize(), '/api/customize/github': body => client.setGithubConnector(body),
    '/api/threads': body => body ? client.createThread(body) : { data: threads, nextCursor: null } };
  for (let n = 1; n <= 2; n++) {
    const id = `00000000-0000-0000-0000-00000000000${n}`;
    routes[`/api/threads/${id}/turns`] = () => ({ turn: { id: `turn-${n}` } });
    routes[`/api/threads/${id}`] = () => ({ thread: threads.find(item => item.id === id), data: [], nextCursor: null });
    routes[`/api/threads/${id}/resume`] = () => ({ thread: threads.find(item => item.id === id), activeTurnId: null });
  }
  const f = await fixture({ routes });
  try {
    for (const enabled of [true, false]) {
      const view = await connectors(f.page), toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
      if (enabled) await toggle.click(); else { await toggle.focus(); await f.page.keyboard.press('Space'); }
      await f.page.waitForFunction(on => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === String(on), enabled);
      await f.page.getByRole('button', { name: 'New chat', exact: true }).click();
      await f.composer.fill(enabled ? 'Use GitHub.' : 'An ordinary task.');
      const before = starts.length;
      await Promise.all([f.page.waitForResponse(response => response.url().endsWith('/turns') && response.request().method() === 'POST'), f.composer.press('Enter')]);
      assert.equal(starts.length, before + 1);
      const started = starts.at(-1); assert.ok(started);
      if (enabled) { assert.ok(started.developerInstructions); assert.match(started.developerInstructions, /gh is signed in as planted-login.*GitHub work/); }
      else assert.equal(started.developerInstructions, undefined);
    }
    assert.ok(gh.length > 0);
    assert.ok(gh.every(([command, args]) => command === 'gh' && args[0] === 'api'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); client.close(); }
});

test('GitHub is beside MCP connectors; the switch works by mouse and keyboard and survives reload', async () => {
  const s = state(), f = await fixture({ routes: s.routes });
  try {
    let view = await connectors(f.page);
    assert.deepEqual(await view.locator('.customize-name').allInnerTexts(), ['GitHub', 'rag']);
    await view.getByText('Connected as octocat', { exact: true }).waitFor();
    let toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === 'true');
    await f.page.reload();
    view = await connectors(f.page); toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.focus(); await f.page.keyboard.press('Space');
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(s.writes, [{ enabled: true }, { enabled: false }]);
    assert.deepEqual(await f.page.evaluate(() => (window as TerminalWindow).__terminal.input), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Connect opens a side terminal and types only gh auth login --web once; returning refreshes the login', async () => {
  const s = state(null), f = await fixture({ routes: s.routes });
  try {
    const view = await connectors(f.page);
    await view.getByText('Not connected', { exact: true }).waitFor();
    await view.getByRole('button', { name: 'Connect', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await f.page.waitForFunction(() => (window as TerminalWindow).__terminal.input.some(([, text]) => text.includes('gh auth login --web')));
    const calls = await f.page.evaluate(() => (window as TerminalWindow).__terminal);
    assert.equal(calls.open.length, 1);
    const opened = calls.open[0]; assert.ok(opened);
    assert.deepEqual(calls.input, [[opened[0], '\x05\x15gh auth login --web\r']]);
    await f.page.getByRole('region', { name: 'Terminal', exact: true }).waitFor();
    assert.deepEqual(s.writes, [{ enabled: true }]);
    s.github.login = 'signed-in';
    const again = await connectors(f.page);
    await again.getByText('Connected as signed-in', { exact: true }).waitFor();
    assert.equal(await again.getByRole('switch', { name: 'Use GitHub', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal((await f.page.evaluate(() => (window as TerminalWindow).__terminal.input)).length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('GitHub can still be switched off after its gh login expires', async () => {
  const s = state(null); s.github.enabled = true;
  const f = await fixture({ routes: s.routes });
  try {
    const view = await connectors(f.page), toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === 'false');
    await view.getByRole('button', { name: 'Connect', exact: true }).waitFor();
    assert.deepEqual(await f.page.evaluate(() => (window as TerminalWindow).__terminal.input), []);
  } finally { await f.close(); }
});
