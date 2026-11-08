// The sidebar and start screen as in Claude's desktop app: a "+" on every project header that starts a chat in that
// project, a persistent colour control and active status on chat rows, a "Local" chip beside the project chip above the composer, and the account
// row at the bottom left with its menu. The exported UI against a scripted desktop bridge (tests/fake-desktop.cts) and a
// synthetic bridge HTTP/SSE server: no engine, no provider. Screenshots go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cts');
const { fakeDesktop } = require('./fake-desktop.cts');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_PARITY_SHOTS;
type Box = { x: number; y: number; width: number; height: number };
type Locator = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator; filter(options: object): Locator; first(): Locator; count(): Promise<number>; isVisible(): Promise<boolean>; waitFor(): Promise<void>; click(): Promise<void>; innerText(): Promise<string>; boundingBox(): Promise<Box | null>; evaluate<T>(fn: (element: HTMLElement) => T): Promise<T> };
type Page = { locator(selector: string): Locator; getByRole(role: string, options?: object): Locator };
type Auth = { state: string; method?: string; email?: string; plan?: string };
async function eventually<T>(check: () => Promise<T>, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

const PROJECTS = [{ id: 'p-legal', name: 'legal', cwd: '/work/legal' }, { id: 'p-rag', name: 'rag-studio', cwd: '/work/rag' }, { id: 'p-empty', name: 'scratch', cwd: '/work/scratch' }];
const chat = (id: string, name: string, cwd: string, status = 'idle') => ({ id, name, preview: name, cwd, model: 'gpt-6-luna', modelProvider: 'openai', status: { type: status } });
const account = (auth: Auth = { state: 'signedIn', method: 'chatgpt', email: 'masih@example.com', plan: 'pro' }) => ({
  openai: { auth, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [],
});

async function fixture(run: (args: { page: Page; aside: Locator; state: { providers: ReturnType<typeof account>; posts: { path: string; body: unknown }[] }; emit(method: string, params: unknown): void; shoot(name: string): Promise<void>; threads: ReturnType<typeof chat>[] }) => Promise<void>, { width = 1130, height = 660, colorScheme = 'light', signedIn = true } = {}) {
  const threads = [chat('t-run', 'Doctrine filters', '/work/legal', 'active'), chat('t-idle', 'Reread the statute', '/work/legal'), chat('t-bad', 'Broken import', '/work/legal', 'systemError'), chat('t-crypto', 'Crypto', '/work/rag')];
  const state: { providers: ReturnType<typeof account>; posts: { path: string; body: unknown }[] } = { providers: account(signedIn ? undefined : { state: 'signedOut' }), posts: [] };
  const clients = new Set<import('node:http').ServerResponse>();
  const emit = (method: string, params: unknown) => { for (const client of clients) client.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const server = http.createServer(async (req, res) => {
    assert.ok(req.url); const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') state.posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true, cwd: '/work/home' });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/providers') return json(state.providers);
    if (url.pathname === '/api/providers/settings') return json({ version: 'p1', providers: [], managed: {}, write: { available: false } });
    if (url.pathname === '/api/providers/claude-accounts') return json({ activeId: '', accounts: [] });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads, nextCursor: null });
    const id = url.pathname.split('/')[3], thread = threads.find(item => item.id === id);
    if (thread && url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme }); page.setDefaultTimeout(6000);
    const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript((projects: typeof PROJECTS) => { if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects, selectedId: null })); }, PROJECTS);
    await page.addInitScript(fakeDesktop, { tabs: [] });
    await page.goto(`http://127.0.0.1:${address.port}/#token=fixture`);
    const aside = page.locator('aside.sidebar');
    await aside.locator('.thread-row[data-thread-id="t-idle"]').first().waitFor();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const shoot = async (name: string) => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, aside, state, emit, shoot, threads });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}
const paint = (locator: { evaluate(fn: (element: HTMLElement, name: keyof CSSStyleDeclaration) => number[], property: keyof CSSStyleDeclaration): Promise<number[]> }, property: keyof CSSStyleDeclaration) => locator.evaluate((element, name) => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw Error('Canvas context is unavailable');
  context.fillStyle = '#fbfbfa'; context.fillRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(element)[name] as string; context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
}, property);
// what `paint` lays a transparent colour over: the light theme's page

test('every project header has a "+" that starts a new chat in that project', async () => {
  await fixture(async ({ page, aside, shoot }) => {
    const groups = aside.locator('.project-group');
    assert.equal(await groups.count(), 3);
    for (const name of ['legal', 'rag-studio', 'scratch']) {
      const plus = aside.getByRole('button', { name: `Start new chat in ${name}`, exact: true });
      assert.equal(await plus.isVisible(), true);
      await eventually(async () => assert.equal(await plus.evaluate(element => { let shown = 1; for (let node: HTMLElement | null = element; node && node !== document.body; node = node.parentElement) shown *= Number(getComputedStyle(node).opacity); return shown; }), 1, `the "+" of ${name} shows without hovering`));
      assert.equal(await plus.evaluate(element => (element.textContent ?? '').trim()), '', 'an icon, not a word');
    }
    // The "+" sits at the right end of its header, as in Claude, level with the project's name.
    const header = await aside.locator('.project-row').filter({ hasText: 'legal' }).boundingBox(), plus = await aside.getByRole('button', { name: 'Start new chat in legal', exact: true }).boundingBox();
    assert.ok(plus && header);
    assert.ok(plus.x + plus.width <= header.x + header.width + 1 && plus.x + plus.width > header.x + header.width - 60, `the "+" is at the header's right end (${JSON.stringify([plus, header])})`);
    await shoot('sidebar-projects-light');
    // A real click on the "+" of rag-studio: a new chat, with that project chosen, and nothing else changed.
    await page.locator('.thread-row[data-thread-id="t-crypto"] .thread-link').first().click(); await aside.locator('.thread-row.active').first().waitFor();
    await aside.getByRole('button', { name: 'Start new chat in scratch', exact: true }).click();
    await eventually(async () => assert.equal(await page.locator('.empty-state h2').innerText(), 'What should we build in scratch?'));
    assert.match(await page.getByRole('button', { name: 'Choose project', exact: true }).innerText(), /scratch/);
    assert.equal(await aside.locator('.thread-row.active').count(), 0, 'no chat is shown as open: this is a new one');
  });
});
