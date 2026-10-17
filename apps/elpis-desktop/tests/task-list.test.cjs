// The agent's task list (turn/plan/updated), shown above the message box as Claude Code shows its todo list: each
// step done, in progress or waiting, updated live, collapsed to a summary once the turn ends. Synthetic SSE fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

test('the task list follows turn/plan/updated live and collapses when the turn ends', async () => {
  const chat = (id, name) => ({ id, name, cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
  const threads = [chat('work', 'Fix the parser'), chat('other', 'Write the docs')], streams = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); for await (const _ of req) { /* drain */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : threads, nextCursor: null });
    const read = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (read) return json({ thread: threads.find(item => item.id === read[1]), data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  const send = (method, params) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ method, params })}\n\n`); };
  const plan = steps => send('turn/plan/updated', { threadId: 'work', turnId: 't1', explanation: null, plan: steps.map(([step, status]) => ({ step, status })) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Fix the parser', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
    const tasks = page.getByRole('region', { name: 'Tasks', exact: true });
    const rows = async () => (await tasks.getByRole('listitem').evaluateAll(items => items.map(item => `${item.dataset.status} ${item.textContent.trim()}`)));

    send('turn/started', { threadId: 'work', turn: { id: 't1', status: 'inProgress' } });
    plan([['Read the parser', 'inProgress'], ['Fix the off-by-one', 'pending'], ['Add a test', 'pending']]);
    await tasks.waitFor();
    assert.match(await tasks.innerText(), /0 of 3 done/);
    assert.deepEqual(await rows(), ['inProgress Read the parser', 'pending Fix the off-by-one', 'pending Add a test']);
    const [list, composer] = [await tasks.boundingBox(), await page.locator('form.composer').boundingBox()];
    assert.ok(list.y + list.height <= composer.y + 1, 'the list sits above the message box');

    // Live updates replace the list.
    plan([['Read the parser', 'completed'], ['Fix the off-by-one', 'inProgress'], ['Add a test', 'pending']]);
    await tasks.getByText('1 of 3 done').waitFor();
    if (process.env.ELPIS_TASK_SHOTS) for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(150); await page.screenshot({ path: path.join(process.env.ELPIS_TASK_SHOTS, `tasks-${scheme}.png`), clip: { x: 256, y: 520, width: 1024, height: 380 } }); }
    assert.deepEqual(await rows(), ['completed Read the parser', 'inProgress Fix the off-by-one', 'pending Add a test']);

    // Another chat has no list; coming back shows it again.
    await page.getByRole('button', { name: 'Write the docs', exact: true }).click(); await page.waitForTimeout(300);
    assert.equal(await tasks.count(), 0);
    await page.getByRole('button', { name: 'Fix the parser', exact: true }).click(); await tasks.waitFor();

    // When the turn ends the list folds to its summary, and opens on request.
    plan([['Read the parser', 'completed'], ['Fix the off-by-one', 'completed'], ['Add a test', 'completed']]);
    send('turn/completed', { threadId: 'work', turn: { id: 't1', status: 'completed' } });
    await tasks.getByText('3 of 3 done').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Tasks"] li').length === 0);
    await tasks.getByRole('button', { name: 'Show tasks', exact: true }).click();
    assert.equal((await rows()).length, 3);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); }
});
