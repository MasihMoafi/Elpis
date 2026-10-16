// Actual exported settings UI, deterministic local HTTP. No model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('settings keep unknowns honest, show failed optimizer identity, and reject stale chat snapshots', async () => {
  const clients = new Set(); let held; let aRequests = 0; let mismatch = false;
  const threads = ['A', 'B'].map(id => ({ id, name: `Context conversation ${id}`, source: 'cli', status: { type: 'idle' }, desktopAccess: { writable: false, reason: 'Read-only fixture' } }));
  const settings = {
    main: { model: null, provider: null }, background: { model: null, provider: null }, providers: [],
    smartPrune: { enabled: null, explicitOverride: { reason: 'Pruning override unavailable' } },
    memory: { generate: null, use: null, extractionModel: null, consolidationModel: null },
    write: { reason: 'Read-only settings' },
  };
  const snapshot = (id, model) => ({ threadId: id, tokenUsage: null, smartPrune: { latestAttempt: { status: 'failed', modelSlug: model, failureReason: 'Optimizer connection failed' } }, reason: 'Live events from this connection only' });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); for await (const _ of req) { /* consume body */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json(settings);
    if (url.pathname === '/api/models') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') ? [] : threads, nextCursor: null });
    if (url.pathname === '/api/threads/A/context') { aRequests++; held = () => json(snapshot('A', 'OLD_OPTIMIZER_MUST_NOT_APPEAR')); return; }
    if (url.pathname === '/api/threads/B/context') return json(snapshot(mismatch ? 'A' : 'B', mismatch ? 'WRONG_THREAD_OPTIMIZER' : 'B_OPTIMIZER'));
    const thread = threads.find(item => url.pathname === `/api/threads/${item.id}`);
    if (thread) return json({ thread, data: [], nextCursor: null });
    try {
      const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.getByRole('button', { name: 'Context conversation A', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    const configuration = page.getByRole('tabpanel', { name: 'Configuration', exact: true });
    await configuration.getByText('Read-only settings', { exact: true }).first().waitFor();
    assert.ok(await configuration.getByText('Not reported', { exact: true }).count() >= 3);
    await page.getByRole('tab', { name: 'Personalization', exact: true }).click();
    assert.ok(await page.getByRole('tabpanel', { name: 'Personalization', exact: true }).getByText('Not reported', { exact: true }).count() >= 5);
    await page.getByRole('tab', { name: 'Usage & limits', exact: true }).click();
    await page.waitForTimeout(5500);
    assert.equal(aRequests, 1, 'Do not start another context poll while the first response is pending');
    await page.getByRole('button', { name: 'Context conversation B', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Usage & limits', exact: true }).click();
    await page.getByText('B_OPTIMIZER', { exact: true }).waitFor();
    await page.getByText('failed', { exact: true }).waitFor();
    await page.getByText('Optimizer connection failed', { exact: true }).waitFor();
    held();
    await page.waitForTimeout(150);
    assert.equal(await page.getByText('OLD_OPTIMIZER_MUST_NOT_APPEAR', { exact: true }).count(), 0);
    assert.equal(await page.getByText('B_OPTIMIZER', { exact: true }).count(), 1);
    mismatch = true;
    await page.getByRole('alert').filter({ hasText: 'another conversation' }).waitFor();
    assert.equal(await page.getByText('WRONG_THREAD_OPTIMIZER', { exact: true }).count(), 0);
    assert.equal(await page.getByText('B_OPTIMIZER', { exact: true }).count(), 0, 'Failed refresh must not leave old data presented as current');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  }
});
