// Shift+Tab in the message box cycles the permission mode as Claude Code does: Ask for approval, Approve for me,
// Plan mode, and back; the focus stays in the message box. Synthetic HTTP fixture; no engine calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

test('Shift+Tab cycles Ask for approval, Approve for me and Plan mode, keeping the focus', async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); for await (const _ of req) { /* drain */ }
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6-luna', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }] });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    const pill = page.getByRole('button', { name: 'Change permissions', exact: true }), plan = page.getByRole('button', { name: 'Turn plan mode off', exact: true });
    await pill.waitFor(); await page.waitForFunction(() => !document.querySelector('[aria-label="Change permissions"]')?.disabled);
    await input.click();
    const state = async () => `${(await pill.innerText()).trim()}${await plan.count() ? ' + Plan' : ''}`;
    assert.equal(await state(), 'Ask for approval');
    await input.press('Shift+Tab'); assert.equal(await state(), 'Approve for me');
    await input.press('Shift+Tab'); assert.equal(await state(), 'Ask for approval + Plan');
    await input.press('Shift+Tab'); assert.equal(await state(), 'Ask for approval');
    assert.equal(await input.evaluate(element => element === document.activeElement), true, 'the focus stays in the message box');
    assert.match(await pill.getAttribute('title') ?? '', /Shift\+Tab/, 'the pill names the shortcut');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
