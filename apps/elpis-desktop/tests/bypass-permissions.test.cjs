// Bypass permissions in the composer's permissions menu: offered in red after Full access, asked once
// before it applies, and sent to the bridge as its own mode. Deterministic HTTP/SSE fixture, no provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('Bypass permissions is red, asks once, and only then applies', async () => {
  const posts = [], clients = new Set();
  const created = { id: 'created', name: null, cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } };
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost'); let body = ''; for await (const chunk of req) body += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && route.pathname !== '/api/session') posts.push({ path: route.pathname, body: body ? JSON.parse(body) : undefined });
    if (route.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (route.pathname === '/api/session') return json({ authenticated: true });
    if (route.pathname === '/api/health') return json({ connected: true });
    if (route.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (route.pathname === '/api/settings') return json({ main: { model: 'gpt-6-luna', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }] });
    if (route.pathname === '/api/threads') return json(req.method === 'POST' ? { thread: created } : { data: [], nextCursor: null });
    if (route.pathname === '/api/threads/created/turns') return json({ turn: { id: 'turn-1', status: 'inProgress' } });
    if (route.pathname.startsWith('/api/threads/created')) return json({ thread: created, data: [], nextCursor: null, activeTurnId: null });
    if (route.pathname.startsWith('/api/')) return json({});
    try {
      const file = path.join(root, route.pathname === '/' ? 'index.html' : route.pathname);
      const content = await fs.readFile(file);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const shots = process.env.ELPIS_SCREENSHOT_DIR;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    const pill = page.getByRole('button', { name: 'Change permissions', exact: true });
    await pill.waitFor();
    const red = await page.evaluate(() => {
      const probe = document.createElement('span'); probe.style.color = 'var(--destructive)'; document.body.append(probe);
      const color = getComputedStyle(probe).color; probe.remove(); return color;
    });
    const color = locator => locator.evaluate(element => getComputedStyle(element).color);
    assert.match(await pill.innerText(), /Full access/, 'an unavailable Settings snapshot still shows the Full access default');

    // Offered fourth, after Full access, in red; the other modes are not red.
    await pill.click();
    const items = page.getByRole('menu').getByRole('menuitem');
    assert.deepEqual((await items.allInnerTexts()).map(text => text.split('\n')[0].trim()), ['Ask for approval', 'Approve for me', 'Full access', 'Bypass permissions']);
    const bypass = items.filter({ hasText: 'Bypass permissions' });
    assert.equal(await color(bypass), red, 'the Bypass row is red');
    assert.equal(await color(bypass.locator('svg').first()), red, 'and so is its icon');
    assert.notEqual(await color(items.filter({ hasText: 'Full access' })), red);
    if (shots) await page.screenshot({ path: path.join(shots, 'bypass-menu.png') });

    // Choosing it asks first; Cancel changes nothing.
    await bypass.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('Bypass permissions?', { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /Elpis will run anything without asking/);
    assert.equal(await color(dialog.getByText('Bypass permissions?', { exact: true })), red);
    if (shots) await page.screenshot({ path: path.join(shots, 'bypass-confirm.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.match(await pill.innerText(), /Full access/, 'cancelling Bypass keeps the inherited mode');

    // Confirming applies it, and the active mode stays red.
    await pill.click();
    await page.getByRole('menuitem').filter({ hasText: 'Bypass permissions' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Bypass permissions', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await pill.filter({ hasText: 'Bypass permissions' }).waitFor();
    assert.equal(await color(pill), red, 'the active mode is shown in red');
    if (shots) await page.screenshot({ path: path.join(shots, 'bypass-active.png') });

    // The new chat is created in Bypass permissions.
    await page.getByLabel('Message Elpis').fill('List the files.');
    await page.getByLabel('Message Elpis').press('Enter');
    for (let i = 0; i < 50 && !posts.some(post => post.path === '/api/threads'); i++) await page.waitForTimeout(100);
    assert.equal(posts.find(post => post.path === '/api/threads')?.body?.permissions, 'bypass');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve));
  }
});

test('changing an open chat\'s permissions applies at once, shows what Elpis applied, and reports a refusal', async () => {
  const posts = [], clients = new Set();
  const chat = { id: 'existing', name: 'Existing chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct', reason: null } };
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost'); let body = ''; for await (const chunk of req) body += chunk;
    const json = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const data = body ? JSON.parse(body) : undefined;
    if (req.method === 'POST' && route.pathname !== '/api/session') posts.push({ path: route.pathname, body: data });
    if (route.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (route.pathname === '/api/session') return json({ authenticated: true });
    if (route.pathname === '/api/health') return json({ connected: true });
    if (route.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (route.pathname === '/api/settings') return json({ main: { model: 'gpt-6-luna', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }] });
    if (route.pathname === '/api/threads') return json({ data: [chat], nextCursor: null });
    // As the bridge: the engine applies Full access; it refuses "Approve for me" here.
    if (route.pathname === '/api/threads/existing/permissions') return data.permissions === 'auto' ? json({ error: 'Elpis did not apply auto permissions to this chat; it is in full mode.' }, 409) : json({ permissions: data.permissions });
    if (route.pathname === '/api/threads/existing/resume') return json({ thread: chat, activeTurnId: 'running', permissions: 'ask' });
    if (route.pathname === '/api/threads/existing') return json({ thread: chat, data: [], nextCursor: null });
    if (route.pathname.startsWith('/api/')) return json({});
    try {
      const file = path.join(root, route.pathname === '/' ? 'index.html' : route.pathname);
      const content = await fs.readFile(file);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.thread-row[data-thread-id="existing"] .thread-link').click();
    const pill = page.getByRole('button', { name: 'Change permissions', exact: true });
    await pill.filter({ hasText: 'Ask for approval' }).waitFor();

    // While its turn runs, Full access is applied at once, with no message sent and no "Next turn" note.
    await pill.click();
    await page.getByRole('menuitem').filter({ hasText: 'Full access' }).click();
    await pill.filter({ hasText: 'Full access' }).waitFor();
    assert.deepEqual(posts.filter(post => post.path === '/api/threads/existing/permissions').map(post => post.body), [{ permissions: 'full' }]);
    assert.equal(posts.some(post => post.path === '/api/threads/existing/turns'), false, 'nothing waits for a next turn');
    assert.equal(await page.getByText('Next turn', { exact: false }).count(), 0);

    // A refusal is shown, and the composer keeps the mode Elpis applied.
    await pill.click();
    await page.getByRole('menuitem').filter({ hasText: 'Approve for me' }).click();
    await page.getByText('Elpis did not apply auto permissions to this chat', { exact: false }).waitFor();
    assert.match(await pill.innerText(), /Full access/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve));
  }
});
