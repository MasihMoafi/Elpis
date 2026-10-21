const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseOption, leaveSettings, sidebar, openSettings, chooseTheme } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');

// Exercise the exported app with synthetic accounts. No installed runtime or provider is contacted.
async function fixture(run, { desktop = false } = {}) {
  const calls = [], streams = new Set();
  const thread = { id: 'recent', name: 'Current work', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const older = { ...thread, id: 'older-book', name: 'Augustus audiobook notes' };
  const longPreview = { ...thread, id: 'late-preview', name: null, preview: 'A saved conversation whose first message keeps going. '.repeat(3) + 'Laterpassage contains the requested detail.' };
  const providers = [{ id: 'openai', displayName: 'OpenAI' }, { id: 'lab', displayName: 'Lab server' }, { id: 'home', displayName: 'Home server' }];
  const settings = { version: 'settings-v1', main: { model: 'sol', provider: 'openai' }, providers, managed: {}, write: { available: true },
    background: { model: null, provider: null }, memory: { generate: false, use: true, extractionModel: null, consolidationModel: null },
    smartPrune: { enabled: false, explicitOverride: { available: true, model: null, provider: null, version: 'pruner-v1' } } };
  const apiProviders = providers.filter(item => item.id !== 'openai').map(item => ({ id: item.id, name: item.displayName, baseUrl: `http://127.0.0.1:${item.id === 'lab' ? 1234 : 11434}/v1`, wireApi: 'responses', editable: true, auth: { source: 'none', keySet: false, envKey: null } }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = '';
    for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method, data });
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: url.searchParams.get('provider') === 'home' ? [] : url.searchParams.get('provider') === 'lab' ? [{ id: 'openai/gpt-oss-120b', model: 'openai/gpt-oss-120b', displayName: 'GPT-OSS 120B' }] : [{ id: 'sol', model: 'sol', displayName: 'Sol', description: 'Everyday coding', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null });
    if (url.pathname === '/api/settings') return json(settings);
    if (url.pathname === '/api/providers/claude-accounts') return json({ activeId: '', accounts: [] });
    if (url.pathname === '/api/providers/settings') return json({ version: 'providers-v1', write: { available: true }, managed: {}, providers: apiProviders });
    if (url.pathname === '/api/providers') return json({ openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'demo@example.invalid' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: apiProviders });
    if (url.pathname === '/api/mcp') return json({ version: 'mcp-v1', write: { available: true }, servers: [] });
    if (url.pathname === '/api/tools/transcription') return json({ available: false, reason: 'Not configured in this fixture' });
    if (url.pathname === '/api/file') { if (url.searchParams.get('path').includes('missing')) { res.statusCode = 404; return json({ error: 'This file is unavailable.' }); } return json({ content: 'Fixture notes\n', size: 14, mtimeMs: 1 }); }
    if (url.pathname === '/api/files/dir') return json({ data: [] });
    if (url.pathname.endsWith('/rewind') && data?.action === 'status') return json({});
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('archived') === 'true' || url.searchParams.has('ancestorThreadId') ? [] : url.searchParams.get('searchTerm') === 'Laterpassage' ? [longPreview] : url.searchParams.get('searchTerm') === 'Augustus' ? [older] : url.searchParams.get('searchTerm') ? [] : [thread], nextCursor: url.searchParams.get('searchTerm') ? null : 'older-page' });
    if (url.pathname.endsWith('/context')) return json({ threadId: 'recent', tokenUsage: null, smartPrune: null });
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (url.pathname.startsWith('/api/threads/')) return json({ thread, data: [{ turnId: 'read-only-turn', item: { id: 'file-reply', type: 'agentMessage', text: '[Read notes](/tmp/demo/notes.md:12) · [Missing notes](/tmp/demo/missing.md) · [Website](https://example.invalid)' } }], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); page.setDefaultTimeout(6000);
    if (desktop) await page.addInitScript(fakeDesktop);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Model"]')?.textContent.includes('Sol'));
    const shot = async name => { if (process.env.ELPIS_USABILITY_SHOTS) { await fs.mkdir(process.env.ELPIS_USABILITY_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_USABILITY_SHOTS, `${name}.png`) }); } };
    await run({ page, calls, shot });
    assert.deepEqual(errors, [], 'the actual screen must have no uncaught renderer errors');
    assert.equal(calls.filter(call => call.method === 'POST' && call.path !== '/api/session' && !call.path.endsWith('/resume') && !(call.path.endsWith('/rewind') && call.data?.action === 'status')).length, 0, 'inspecting choices and navigating must not send messages or save account settings');
  } finally { await browser?.close(); for (const response of streams) response.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('model control identifies the selected provider and distinguishes equal local nicknames', () => fixture(async ({ page, shot }) => {
  assert.match(await page.getByLabel('Model', { exact: true }).getAttribute('title'), /Sol · OpenAI/);
  await shot('01-chat-light');
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByRole('tab', { name: 'Lab server', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Home server', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Lab server', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'GPT-OSS 120B' }).waitFor();
  await shot('02a-model-list-light');
  await page.getByRole('option').filter({ hasText: 'GPT-OSS 120B' }).click();
  assert.match(await page.getByLabel('Model', { exact: true }).getAttribute('title'), /GPT-OSS 120B · Lab server/);
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByRole('tab', { name: 'Home server', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 0, 'a server without a list must not be given OpenAI’s model list');
  await page.getByText('This connection has not reported a model list.', { exact: true }).waitFor();
  await shot('02-model-connections-light');
}));

test('search queries saved conversations beyond the loaded page and clearing it restores recents', () => fixture(async ({ page, calls }) => {
  await page.getByLabel('Search conversations').fill('Augustus');
  await page.getByRole('button', { name: 'Augustus audiobook notes', exact: true }).waitFor();
  assert(calls.some(call => call.path === '/api/threads' && call.query.searchTerm === 'Augustus'));
  await page.getByLabel('Search conversations').fill('');
  await page.getByRole('button', { name: 'Current work', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Augustus audiobook notes', exact: true }).count(), 0);
}));

test('search keeps a server match that appears after the shortened conversation preview', () => fixture(async ({ page, calls }) => {
  await page.getByLabel('Search conversations').fill('Laterpassage');
  await page.locator('.thread-row[data-thread-id="late-preview"] .thread-link').waitFor();
  assert(calls.some(call => call.path === '/api/threads' && call.query.searchTerm === 'Laterpassage'));
  await page.getByLabel('Search conversations').fill('no such saved text');
  await page.getByText('No matching conversations.', { exact: true }).waitFor();
  assert.equal(await page.locator('.thread-row[data-thread-id="late-preview"]').count(), 0);
}));

test('rendered local file links open inside Files and explain failures without leaving the chat', () => fixture(async ({ page, calls }) => {
  await page.evaluate(() => {
    window.testOpenedFiles = [];
    window.elpisDesktop.openFile = async file => {
      if (file.includes('missing')) throw new Error('This file is unavailable.');
      window.testOpenedFiles.push(file);
    };
  });
  await page.getByRole('button', { name: 'Current work', exact: true }).first().click();
  const before = page.url();
  await page.getByRole('button', { name: 'Read notes', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Contents of notes.md', exact: true });
  await editor.waitFor(); assert.equal(await editor.inputValue(), 'Fixture notes\n');
  assert.ok(calls.some(call => call.path === '/api/file' && call.query.path === 'notes.md'));
  assert.deepEqual(await page.evaluate(() => window.testOpenedFiles), [], 'the default file link stays in Elpis');
  assert.equal(page.url(), before);
  await page.getByRole('button', { name: 'Missing notes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'This file is unavailable.' }).waitFor();
  assert.equal(page.url(), before);
  assert.equal(await page.getByRole('link', { name: 'Website', exact: true }).getAttribute('target'), '_blank');
}, { desktop: true }));

test('maintenance settings read the real catalog response and keep model lists with their provider', () => fixture(async ({ page, shot }) => {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
  const section = page.getByRole('region', { name: 'Models', exact: true });
  await chooseOption(section.getByLabel('Background model', { exact: true }), { label: 'Sol' });
  await chooseOption(section.getByLabel('Background provider', { exact: true }), 'lab');
  await section.getByLabel('Background model', { exact: true }).click();
  await page.getByRole('option', { name: 'GPT-OSS 120B', exact: true }).waitFor();
  assert.equal(await page.getByRole('option', { name: 'Sol', exact: true }).count(), 0, 'OpenAI models are not offered under the lab server');
  await page.getByRole('option', { name: 'GPT-OSS 120B', exact: true }).click();
  await shot('07-model-settings-light');
  await chooseOption(section.getByLabel('Background provider', { exact: true }), 'home');
  await section.getByText('Advanced: custom model', { exact: true }).click();
  await section.getByText('No model catalog is available for Home server.', { exact: true }).waitFor();
}));

test('API setup omits internal IDs and keeps unsaved values across sections and pages', () => fixture(async ({ page, shot }) => {
  await openSettings(page);
  if (await page.getByRole('tab', { name: 'Models & accounts', exact: true }).count()) await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
  await page.getByText('Advanced API connections', { exact: true }).click();
  await page.getByRole('button', { name: 'Add API provider', exact: true }).click();
  const form = page.getByRole('form', { name: 'API provider settings', exact: true });
  assert.equal(await form.getByLabel('Provider ID', { exact: true }).count(), 0);
  await form.getByLabel('Provider display name', { exact: true }).fill('My research server');
  await form.getByLabel('API endpoint', { exact: true }).fill('http://127.0.0.1:1234/v1');
  await page.getByRole('tab', { name: 'MCP servers', exact: true }).click();
  await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
  assert.equal(await form.getByLabel('Provider display name', { exact: true }).inputValue(), 'My research server');
  await (await sidebar(page)).getByRole('button', { name: 'Lab', exact: true }).click();
  await openSettings(page);
  await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
  assert.equal(await form.getByLabel('API endpoint', { exact: true }).inputValue(), 'http://127.0.0.1:1234/v1');
  await shot('04-api-draft-light');
  await leaveSettings(page); await chooseTheme(page, 'dark');
  await shot('05-api-draft-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('06-api-draft-narrow');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}));
