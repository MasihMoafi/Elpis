// Chat tabs across the top, like Obsidian's, and a right-hand side panel of terminal and browser tabs.
// The exported UI against a fake desktop bridge (browser, terminal and storage); synthetic HTTP/SSE, no shell,
// engine or provider. Screenshots go to $ELPIS_TABS_SHOTS when it is set.
const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { controlValue, guardDesktopStore } = require('./controls.cts');
const { fakeDesktop } = require('./fake-desktop.cts');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_TABS_SHOTS;
type Locator = { getByRole(role: string, options?: object): Locator; waitFor(): Promise<void>; click(options?: object): Promise<void>; count(): Promise<number>; fill(value: string): Promise<void> };
type Page = { getByRole(role: string, options?: object): Locator; reload(): Promise<void> };
type FixtureArgs = { page: Page; link(id: string): Locator; strip: Locator; names(): Promise<string[]>; shown(): Promise<string>; composer: Locator; posts: string[]; reads: string[]; shoot(name: string): Promise<void>; terminal(): Promise<unknown>; commands(): Promise<string[]>; port: number };
type TestWindow = Window & { __terminal?: unknown; __commands?: { action: string }[] };
async function eventually<T>(check: () => Promise<T>, _message?: string) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}

async function fixture(run: (args: FixtureArgs) => Promise<void>, { width = 1320, height = 860 } = {}) {
  const threads = [
    { id: 'chat-one', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/work/parser', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
    { id: 'chat-two', name: 'Write the docs', preview: 'Write the docs', cwd: '/work/docs', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
    { id: 'chat-three', name: 'Plan the release', preview: 'Plan the release', cwd: '/work/release', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
  ];
  const posts: string[] = [], reads: string[] = [];
  const server = http.createServer(async (req, res) => {
    assert.ok(req.url); const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const thread = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (req.method === 'POST') posts.push(url.pathname);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads, nextCursor: null });
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread && req.method === 'GET') reads.push(thread.id);
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } }); page.setDefaultTimeout(6000);
    const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(fakeDesktop);
    await page.goto(`http://127.0.0.1:${address.port}/#token=fixture`);
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').waitFor();
    const link = (id: string) => page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`);
    const strip = page.getByRole('tablist', { name: 'Chat tabs' });
    const names = async () => (await strip.getByRole('tab').allInnerTexts()).map((text: string) => text.trim());
    const shown = async () => strip.getByRole('tab', { selected: true }).innerText();
    const composer = page.getByLabel('Message Elpis');
    const shoot = async (name: string) => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, link, strip, names, shown, composer, posts, reads, shoot, terminal: () => page.evaluate(() => (window as TestWindow).__terminal), commands: () => page.evaluate(() => { const commands = (window as TestWindow).__commands; if (!commands) throw Error('Commands are unavailable'); return commands.map(item => item.action); }), port: address.port });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

test('the top strip holds chats: + opens an empty sibling chat, a tab switches to its chat, drafts stay with their chat', () => fixture(async ({ page, link, strip, names, shown, composer, posts }) => {
  assert.deepEqual(await names(), ['New chat']);
  await link('chat-one').click();
  await strip.getByRole('tab', { name: 'Fix the parser' }).waitFor();
  assert.deepEqual(await names(), ['Fix the parser'], 'a sidebar click opens the chat in the shown tab');
  await composer.fill('draft for the parser');
  await page.getByRole('button', { name: 'New chat tab', exact: true }).click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'New chat']));
  assert.equal(await shown(), 'New chat');
  assert.equal(await controlValue(composer), '', 'the new tab is an empty chat');
  await composer.fill('draft in the empty tab');
  await strip.getByRole('tab', { name: 'Fix the parser' }).click();
  await eventually(async () => assert.equal(await controlValue(composer), 'draft for the parser'));
  await strip.getByRole('tab', { name: 'New chat' }).click();
  await eventually(async () => assert.equal(await controlValue(composer), 'draft in the empty tab'));
  // Another chat from the sidebar replaces the shown (empty) tab's content; the first tab is untouched.
  await link('chat-two').click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']));
  assert.equal(await shown(), 'Write the docs');
  assert.equal(await strip.getByRole('tab').count(), 2, 'terminals and pages never join this strip');
  assert.deepEqual(posts.filter(path => path === '/api/threads' || /fork|agent/.test(path)), [], 'a tab is not a new server-side chat, fork or agent');
}));

test('middle-click on a sidebar chat opens it in its own tab; an open chat brings its tab forward instead of opening twice', () => fixture(async ({ page, link, names, shown }) => {
  await link('chat-one').click();
  await link('chat-two').click({ button: 'middle' });
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']));
  assert.equal(await shown(), 'Write the docs');
  await link('chat-one').click();
  await eventually(async () => assert.equal(await shown(), 'Fix the parser'));
  assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']);
  await link('chat-two').click({ button: 'middle' });
  await eventually(async () => assert.equal(await shown(), 'Write the docs'));
  assert.equal((await names()).length, 2);
  await link('chat-three').click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Plan the release']), 'a plain click replaces only the shown tab');
}));

test('open tabs and the shown one are kept across a restart; drafts of a chat come back with its tab', () => fixture(async ({ page, link, names, shown, composer, reads }) => {
  await link('chat-one').click();
  await link('chat-two').click({ button: 'middle' });
  await link('chat-three').click({ button: 'middle' });
  await page.getByRole('tab', { name: 'Write the docs' }).click();
  await composer.fill('unsent words');
  await eventually(async () => assert.equal(await shown(), 'Write the docs'));
  reads.length = 0;
  await page.reload();
  await page.getByRole('tablist', { name: 'Chat tabs' }).getByRole('tab', { name: 'Plan the release' }).waitFor();
  assert.deepEqual(await names(), ['Fix the parser', 'Write the docs', 'Plan the release']);
  assert.equal(await shown(), 'Write the docs');
  await eventually(async () => assert.equal(await controlValue(composer), 'unsent words'));
  assert.ok(reads.includes('chat-two'), 'the shown tab’s chat is loaded again');
}));
