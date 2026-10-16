// The Agents page stays still while it polls a chat and its subagent: no row mounts, unmounts or moves. Fixture HTTP/SSE server, no provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('agents page: polling a parent chat and its subagent does not blink, move rows or change the view', async () => {
  const access = { writable: true, mode: 'direct', reason: null };
  const parent = { id: 'parent', name: 'Parent chat', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: access };
  const child = { id: 'child', name: 'Cache reviewer', agentNickname: 'Reviewer', parentThreadId: 'parent', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'active' }, source: { subAgent: { thread_spawn: { agent_path: '/root/cache_reviewer' } } }, desktopAccess: access };
  const clients = new Set(); let lists = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); for await (const chunk of req) void chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    // The bridge lists subagents with their parents; a real list read takes a moment.
    if (url.pathname === '/api/threads') { lists++; await new Promise(resolve => setTimeout(resolve, 300)); return json({ data: url.searchParams.get('ancestorThreadId') === 'parent' ? [child] : url.searchParams.has('ancestorThreadId') ? [] : [parent, child], nextCursor: null }); }
    if (url.pathname.startsWith('/api/threads/')) return json({ thread: url.pathname.includes('/child') ? child : parent, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('aside').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.locator('.agent-row[data-thread-id="child"]').waitFor();
    await page.waitForTimeout(1500); // the first read after opening settles
    // Record every element mounted or unmounted, and every position of the subagent row and page title, for more than one polling period.
    await page.evaluate(() => {
      const record = window.__agents = { changes: [], tops: new Set(), headings: new Set() };
      new MutationObserver(entries => { for (const entry of entries) for (const [sign, nodes] of [['+', entry.addedNodes], ['-', entry.removedNodes]]) for (const node of nodes) if (node.nodeType === 1) record.changes.push(`${sign}${node.className || node.tagName}: ${node.textContent.slice(0, 40)}`); })
        .observe(document.querySelector('.workspace-content'), { childList: true, subtree: true });
      const sample = () => { const row = document.querySelector('.agent-row[data-thread-id="child"]'); record.tops.add(row ? Math.round(row.getBoundingClientRect().top) : null); record.headings.add(document.querySelector('.workspace-header h1')?.textContent ?? null); requestAnimationFrame(sample); };
      sample();
    });
    const before = lists;
    await page.waitForTimeout(6000);
    assert.ok(lists > before, 'the Agents page polled during the observation');
    const record = await page.evaluate(() => ({ changes: window.__agents.changes, tops: [...window.__agents.tops], headings: [...window.__agents.headings] }));
    assert.deepEqual(record.changes, [], 'polling mounts or unmounts nothing');
    assert.equal(record.tops.length, 1, `the subagent row stays in place (positions: ${record.tops.join(', ')})`);
    assert.deepEqual(record.headings, ['Agents'], 'the page stays on Agents');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); server.close(); }
});
