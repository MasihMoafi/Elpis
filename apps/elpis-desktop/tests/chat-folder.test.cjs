// A chat started anywhere moves to a project or folder chosen later (A26): the folder chip under the composer opens the
// project menu; the choice goes to the bridge (POST /api/threads/<id>/folder) and the chip shows the folder the bridge
// reports. A running chat cannot move. Synthetic HTTP/SSE with the desktop's folder chooser; no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');
const root = path.resolve(__dirname, '../out');

test('a chat moves to a folder chosen after it started; its chip shows the new folder', async () => {
  const thread = { id: 'anywhere', name: 'Started anywhere', preview: 'Started anywhere', cwd: '/home/someone', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } };
  const moves = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : [thread], nextCursor: null });
    if (url.pathname === '/api/threads/anywhere/folder') { const { cwd } = JSON.parse(raw); moves.push(cwd); thread.cwd = cwd; return json({ cwd }); }
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (url.pathname === '/api/threads/anywhere') return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(fakeDesktop);
    await page.addInitScript(() => { window.__folders = []; window.elpisDesktop.chooseFolder = async () => window.__folders.shift() ?? null; });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.thread-list .thread-row[data-thread-id="anywhere"] .thread-link').first().click();
    const chip = page.getByRole('button', { name: 'Change folder', exact: true });
    assert.match(await chip.innerText(), /someone/);
    // A cancelled chooser moves nothing; a chosen folder moves the chat and the chip follows.
    await page.evaluate(() => window.__folders.push(null));
    await chip.click(); await page.getByRole('menuitem', { name: 'Choose folder…', exact: true }).click();
    await page.waitForTimeout(200); assert.deepEqual(moves, []);
    await page.evaluate(() => window.__folders.push('/tmp/work/real-project'));
    await chip.click(); await page.getByRole('menuitem', { name: 'Choose folder…', exact: true }).click();
    await page.waitForFunction(() => /real-project/.test(document.querySelector('[aria-label="Change folder"]')?.textContent ?? ''));
    assert.deepEqual(moves, ['/tmp/work/real-project']);
    assert.equal(await page.getByRole('menuitem', { name: /Don.t work in a project/ }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
