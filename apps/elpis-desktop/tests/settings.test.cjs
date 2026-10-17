// Actual exported settings UI, deterministic local HTTP. No model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openSettings } = require('./controls.cjs');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('settings keep unknowns honest, and Usage & limits shows no chat context', async () => {
  const clients = new Set();
  const threads = [{ id: 'A', name: 'Context conversation A', source: 'cli', status: { type: 'idle' }, desktopAccess: { writable: false, reason: 'Read-only fixture' } }];
  const settings = {
    main: { model: null, provider: null }, background: { model: null, provider: null }, providers: [],
    smartPrune: { enabled: null, explicitOverride: { reason: 'Pruning override unavailable' } },
    memory: { generate: null, use: null, extractionModel: null, consolidationModel: null },
    write: { reason: 'Read-only settings' },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); for await (const _ of req) { /* consume body */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json(settings);
    if (url.pathname === '/api/models') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') ? [] : threads, nextCursor: null });
    if (url.pathname === '/api/threads/A/context') return json({ threadId: 'A', tokenUsage: null, smartPrune: { latestAttempt: { status: 'failed', modelSlug: 'OPTIMIZER_FIXTURE', failureReason: 'Optimizer connection failed' } }, reason: 'Live events from this connection only' });
    if (url.pathname === '/api/threads/A') return json({ thread: threads[0], data: [], nextCursor: null });
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
    await openSettings(page); await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    const configuration = page.getByRole('tabpanel', { name: 'Configuration', exact: true });
    await configuration.getByText('Read-only settings', { exact: true }).first().waitFor();
    assert.ok(await configuration.getByText('Not reported', { exact: true }).count() >= 3);
    await page.getByRole('tab', { name: 'Personalization', exact: true }).click();
    assert.ok(await page.getByRole('tabpanel', { name: 'Personalization', exact: true }).getByText('Not reported', { exact: true }).count() >= 5);
    // Masih removed the selected chat's context from this page; it shows account limits only.
    await page.getByRole('tab', { name: 'Usage & limits', exact: true }).click();
    const usage = page.getByRole('tabpanel', { name: 'Usage & limits', exact: true });
    await usage.getByText('Limits reported by each connected account.', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    for (const text of ['Selected conversation · context', 'OPTIMIZER_FIXTURE', 'Optimizer connection failed', 'Latest input tokens']) assert.equal(await usage.getByText(text).count(), 0, `${text} is not shown`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  }
});
