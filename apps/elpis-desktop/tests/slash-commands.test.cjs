// Slash commands in the composer, as in the ChatGPT app's Codex composer and the terminal's popup: deterministic HTTP/SSE fixtures, no provider calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { leaveSettings } = require('./controls.cjs');
const root = path.resolve(__dirname, '../out');

const access = { writable: true, mode: 'direct', reason: null };
const chat = { id: 'chat', name: 'Cache chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: access };
const fork = { ...chat, id: 'fork', name: 'Cache chat (fork)', forkedFromId: 'chat' };
// Newest first, as the bridge pages history.
const history = [{ turnId: 'turn-1', item: { id: 'reply', type: 'agentMessage', text: 'The cache is fixed.' } }, { turnId: 'turn-1', item: { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'Fix the cache.' }] } }];
let server, browser, url; const posts = [], clients = new Set();

before(async () => {
  server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost'); let body = ''; for await (const chunk of req) body += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && route.pathname !== '/api/session') posts.push({ path: route.pathname, body: body ? JSON.parse(body) : undefined });
    if (route.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (route.pathname === '/api/session') return json({ authenticated: true });
    if (route.pathname === '/api/health') return json({ connected: true });
    if (route.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (route.pathname === '/api/settings') return json({ main: { model: 'gpt-6-luna', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }] });
    if (route.pathname === '/api/threads') return json({ data: route.searchParams.has('ancestorThreadId') ? [] : [chat], nextCursor: null });
    if (route.pathname === '/api/threads/chat/fork') return json({ thread: fork });
    if (route.pathname.endsWith('/rename')) return json({ thread: { ...chat, name: JSON.parse(body).name } });
    const read = route.pathname.match(/^\/api\/threads\/(chat|fork)(\/resume)?$/);
    if (read) return json({ thread: read[1] === 'fork' ? fork : chat, data: history, nextCursor: null, activeTurnId: null, planMode: false });
    if (route.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, route.pathname === '/' ? 'index.html' : route.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}/#token=fixture`;
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
});
after(async () => { await browser?.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });

async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.getByText('Local workspace', { exact: true }).waitFor();
  return { page, errors, composer: page.getByRole('textbox', { name: 'Message Elpis', exact: true }), menu: page.getByRole('listbox', { name: 'Slash commands', exact: true }) };
}
const names = menu => menu.getByRole('option').evaluateAll(options => options.map(option => option.querySelector('.slash-name').textContent));
const selected = menu => menu.locator('[role="option"][aria-selected="true"] .slash-name').textContent();

test('"/" opens the command menu: filter, arrows, Enter, Tab, click and Escape run or close it', async () => {
  const { page, errors, composer, menu } = await open();
  try {
    await composer.fill('/');
    await menu.waitFor();
    assert.deepEqual(await names(menu), ['/model', '/permissions', '/settings', '/memories', '/hooks', '/new', '/plan', '/agents', '/usage', '/mcp'], 'a new chat lists only what it can do, in the terminal\'s order');
    await page.screenshot({ path: '/tmp/elpis-slash-menu-1440.png' });
    assert.equal(await composer.getAttribute('aria-activedescendant'), await menu.getByRole('option').first().getAttribute('id'));
    await composer.press('ArrowDown'); await composer.press('ArrowDown'); assert.equal(await selected(menu), '/settings');
    await composer.press('ArrowUp'); assert.equal(await selected(menu), '/permissions');
    await composer.press('ArrowUp'); await composer.press('ArrowUp'); assert.equal(await selected(menu), '/mcp', 'the arrows wrap around');
    await composer.press('Escape'); assert.equal(await menu.count(), 0); assert.equal(await composer.inputValue(), '/', 'Escape closes the menu and keeps the text');

    await composer.fill('/pl'); assert.deepEqual(await names(menu), ['/plan']);
    await composer.press('Enter');
    await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).waitFor();
    assert.equal(await composer.inputValue(), '', 'running a command clears the composer');
    assert.equal(await menu.count(), 0);
    await composer.fill('/plan'); await composer.press('Tab');
    await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).waitFor({ state: 'detached' });

    await composer.fill('/plan now'); assert.equal(await menu.count(), 0, 'the menu closes once the text goes past a command name');
    await composer.fill('/zz'); assert.equal(await menu.count(), 0, 'no match, no menu');
    await composer.fill('Use /plan'); assert.equal(await menu.count(), 0, 'only a leading slash opens the menu');

    await composer.fill('/mo'); await composer.press('Enter');
    await page.getByRole('combobox', { name: 'Search models', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await composer.fill('/perm'); await menu.getByRole('option', { name: /permissions/ }).click();
    await page.getByRole('menuitem').first().waitFor();
    await page.keyboard.press('Escape');

    await composer.fill('/mcp'); await composer.press('Enter');
    await page.getByRole('tab', { name: 'MCP servers', exact: true, selected: true }).waitFor();
    await leaveSettings(page);
    await composer.fill('/agents'); await composer.press('Enter');
    await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
    assert.equal(posts.filter(post => post.path.endsWith('/turns')).length, 0, 'no command is sent as a message');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('in a chat, /fork, /rename, /archive and /new act on that chat', async () => {
  const { page, errors, composer, menu } = await open();
  try {
    await page.locator('.thread-row[data-thread-id="chat"] .thread-link').click();
    await page.getByText('The cache is fixed.', { exact: true }).waitFor();
    await composer.fill('/');
    assert.deepEqual(await names(menu), ['/model', '/permissions', '/settings', '/memories', '/hooks', '/rename', '/new', '/archive', '/fork', '/plan', '/agents', '/usage', '/mcp']);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: '/tmp/elpis-slash-menu-chat-dark-1440.png' }); await page.emulateMedia({ colorScheme: 'light' });

    await composer.fill('/fork'); await composer.press('Enter');
    await page.getByRole('heading', { name: 'Cache chat (fork)', exact: true }).waitFor();
    assert.deepEqual(posts.find(post => post.path === '/api/threads/chat/fork')?.body, { lastTurnId: 'turn-1' }, 'the fork keeps the whole chat');

    await composer.fill('/ren'); await composer.press('Enter');
    const rename = page.getByRole('form', { name: 'Rename conversation', exact: true });
    await rename.getByLabel('Conversation name').fill('Renamed by command'); await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    assert.deepEqual(posts.find(post => post.path === '/api/threads/fork/rename')?.body, { name: 'Renamed by command' });

    await composer.fill('/archive'); await composer.press('Enter');
    await page.getByText('What should we build?', { exact: true }).waitFor();
    assert.ok(posts.some(post => post.path === '/api/threads/fork/archive'), 'the chat is archived');

    await page.locator('.thread-row[data-thread-id="chat"] .thread-link').click();
    await page.getByText('The cache is fixed.', { exact: true }).waitFor();
    await composer.fill('/new'); await composer.press('Enter');
    await page.getByText('What should we build?', { exact: true }).waitFor();
    assert.equal(posts.filter(post => post.path.endsWith('/turns')).length, 0, 'no command is sent as a message');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
