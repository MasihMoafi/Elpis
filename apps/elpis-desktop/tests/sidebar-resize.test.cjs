// The sidebar's right edge can be dragged to resize it, as in Claude's and ChatGPT's apps: by pointer or by keys,
// within limits, kept across restarts, and a double-click restores the default. Synthetic HTTP; no engine calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cjs');

test('the sidebar edge drags to resize, by pointer and keys, clamps, persists and resets on double-click', async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); for await (const _ of req) { /* drain */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/models') return json({ data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // As the desktop app: the width is kept in the desktop store, which refuses keys it does not know.
    await guardDesktopStore(page);
    await page.addInitScript(() => { window.elpisDesktop = { storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, String(value)), removeItem: key => localStorage.removeItem(key), onError: () => () => {} } }; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
    const edge = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
    const width = async () => Math.round((await sidebar.boundingBox()).width);
    await edge.waitFor();
    assert.equal(await width(), 256, 'the default width');

    // Dragging the edge right by 100px widens the sidebar by 100px; the main area gives up the same.
    const box = await edge.boundingBox(), y = box.y + box.height / 2, x = box.x + box.width / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 50, y); await page.mouse.move(x + 100, y); await page.mouse.up();
    assert.equal(await width(), 356);
    const main = await page.locator('.workspace').first().boundingBox();
    assert.ok(Math.abs(main.x - 356) <= 1, `the work area starts at the sidebar's new edge (${main.x})`);

    // Too far either way stops at the limits.
    const far = await edge.boundingBox();
    await page.mouse.move(far.x + 3, y); await page.mouse.down(); await page.mouse.move(far.x + 900, y); await page.mouse.up();
    assert.equal(await width(), 480, 'at most 480px');
    const near = await edge.boundingBox();
    await page.mouse.move(near.x + 3, y); await page.mouse.down(); await page.mouse.move(10, y); await page.mouse.up();
    assert.equal(await width(), 200, 'at least 200px');

    // Keys: Right widens, Left narrows; the width is kept across a restart.
    await edge.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    assert.equal(await width(), 232);
    await page.waitForTimeout(500); await page.reload(); await edge.waitFor();
    assert.equal(await width(), 232, 'kept after a restart');

    // A double-click restores the default.
    await edge.dblclick(); assert.equal(await width(), 256);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
