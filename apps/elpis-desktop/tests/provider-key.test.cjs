// A provider key pasted in the model picker, as the terminal's /provider asks for it: deterministic HTTP fixtures, no provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');

test('a provider that needs a key asks for it in the picker, saves it without showing it, then lists its models', async () => {
  const saved = []; let keySet = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let body = ''; for await (const chunk of req) body += chunk;
    const json = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json({ version: 'v1', background: {}, smartPrune: { explicitOverride: {} }, memory: {}, write: { available: false }, main: { model: 'gpt-6-luna', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'openrouter', displayName: 'OpenRouter', ...(keySet ? {} : { needsKey: true }) }] });
    if (url.pathname === '/api/models' && url.searchParams.get('provider') === 'openrouter') return keySet ? json({ data: [{ id: 'deepseek/deepseek-v4.1-flash', model: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', description: '≈164k context' }], nextCursor: null }) : json({ error: 'Add an API key for this connection.' }, 502);
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/providers/key' && req.method === 'POST') { saved.push(JSON.parse(body)); keySet = true; return json({ providers: [] }); }
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.getByLabel('Model', { exact: true }).click();
    await page.getByRole('tab', { name: 'OpenRouter', exact: true }).click();
    const key = page.getByRole('textbox', { name: 'OpenRouter API key' });
    await key.waitFor(); assert.equal(await key.getAttribute('type'), 'password');
    await key.fill('sk-or-fixture'); await page.getByRole('button', { name: 'Save key', exact: true }).click();
    await page.getByRole('option', { name: /DeepSeek V4\.1 Flash/ }).waitFor();
    assert.deepEqual(saved, [{ provider: 'openrouter', key: 'sk-or-fixture' }]);
    assert(!(await page.content()).includes('sk-or-fixture'), 'the key is not left in the page');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
