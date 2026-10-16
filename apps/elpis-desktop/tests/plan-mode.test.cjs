// Plan mode from the "+" menu, as in the ChatGPT app and the terminal's Shift+Tab: deterministic HTTP/SSE fixtures, no provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('plan mode: "+" turns it on, a proposed plan asks to be implemented, and implementing leaves Plan mode', async () => {
  const turns = []; const clients = new Set(); let created = false;
  const thread = { id: 'created', name: null, preview: 'New chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', desktopAccess: { writable: true, mode: 'direct', reason: null }, status: { type: 'idle' } };
  const emit = (method, params) => { for (const res of clients) res.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let body = ''; for await (const chunk of req) body += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads' && req.method === 'GET') return json({ data: created ? [thread] : [], nextCursor: null });
    if (url.pathname === '/api/threads' && req.method === 'POST') { created = true; return json({ thread }); }
    if (url.pathname === '/api/threads/created/turns') {
      const data = JSON.parse(body); turns.push(data); const id = `turn-${turns.length}`;
      json({ turn: { id } });
      setTimeout(() => {
        emit('turn/started', { threadId: 'created', turn: { id } });
        emit('item/completed', { threadId: 'created', turnId: id, item: { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: data.text }] } });
        if (data.text !== 'Implement the plan.') emit('item/completed', { threadId: 'created', turnId: id, item: { id: `plan-${id}`, type: 'plan', text: `Plan ${turns.length}: read the cache, then fix it.` } });
        else emit('item/completed', { threadId: 'created', turnId: id, item: { id: `agent-${id}`, type: 'agentMessage', text: 'Implemented.' } });
        emit('turn/completed', { threadId: 'created', turn: { id, status: 'completed' } });
      }, 50);
      return;
    }
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null, planMode: false });
    if (url.pathname.startsWith('/api/threads/')) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    const pill = page.getByRole('button', { name: 'Turn plan mode off', exact: true });
    const prompt = page.getByRole('group', { name: 'Implement this plan?' });
    await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
    await page.getByRole('menuitem', { name: /Plan mode/ }).click();
    await pill.waitFor();

    await page.getByLabel('Message Elpis').fill('Plan the cache fix.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('region', { name: 'Proposed plan' }).filter({ hasText: 'Plan 1: read the cache' }).waitFor();
    await prompt.waitFor();
    assert.equal(turns[0].mode, 'plan', 'the first turn runs in Plan mode');

    await prompt.getByRole('button', { name: 'No, stay in Plan mode', exact: true }).click();
    assert.equal(await prompt.count(), 0); assert.equal(await pill.count(), 1, 'declining keeps Plan mode on');
    await page.getByLabel('Message Elpis').fill('Revise it.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('region', { name: 'Proposed plan' }).filter({ hasText: 'Plan 2' }).waitFor();
    assert.equal('mode' in turns[1], false, 'an unchanged mode is not sent again');

    await prompt.getByRole('button', { name: 'Yes, implement this plan', exact: true }).click();
    await page.getByText('Implemented.', { exact: true }).waitFor();
    assert.deepEqual(turns[2], { text: 'Implement the plan.', mode: 'default' });
    assert.equal(await pill.count(), 0, 'implementing leaves Plan mode'); assert.equal(await prompt.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
