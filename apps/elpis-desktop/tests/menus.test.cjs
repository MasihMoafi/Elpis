const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

async function fixture(run) {
  const calls = [], clients = new Set(); let backend = 'openrouter', version = 1, reject = false;
  const mcp = () => ({ version: `v${version}`, write: { available: true }, servers: [{ name: 'whispertype', enabled: true, transport: 'stdio', command: 'fixture-mcp', credentials: [], whispertype: { backend, model: 'openai/gpt-4o-mini-transcribe' } }] });
  const thread = {id:'existing',name:'Existing model check',model:'gpt-6-sol',modelProvider:'openai',reasoningEffort:null,status:{type:'idle'},desktopAccess:{writable:true,mode:'direct'}};
  const models = [{ id: 'sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, {id:'gpt-5.5',model:'gpt-5.5',displayName:'GPT-5.5',supportedReasoningEfforts:[{reasoningEffort:null},{reasoningEffort:'high'}]}, { id: 'opus', model: 'claude/opus', displayName: 'Opus' }, { id: 'agy', model: 'agy/gemini', displayName: 'Gemini via AGY' }];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : undefined; calls.push({ path: url.pathname, method: req.method, data });
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/models') return json({ data: models });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6-sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI', auth: { source: 'subscription' } }], managed: {} });
    if (url.pathname === '/api/threads') return json({ data: [thread], nextCursor: null });
    if (url.pathname === '/api/threads/existing') return json({thread,data:[],nextCursor:null});
    if (url.pathname === '/api/threads/existing/resume') return json({thread,activeTurnId:null});
    if (url.pathname === '/api/threads/existing/turns') return json({turn:{id:'test-turn',status:'inProgress'}});
    if (url.pathname === '/api/tools/transcription') return json({ available: true, backend, label: { openrouter: 'OpenRouter (cloud)', local: 'Local WhisperType', codex: 'ChatGPT sign-in (cloud)' }[backend] });
    if (url.pathname === '/api/mcp') {
      if (req.method === 'POST') {
        if (reject) { res.statusCode = 409; return json({ error: 'Settings changed elsewhere. Reload before saving.' }); }
        assert.equal(data.version, `v${version}`); assert.equal(data.name, 'whispertype'); assert.equal(data.action, 'whispertype'); backend = data.backend; version++;
      }
      return json(mcp());
    }
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.resolve(__dirname, '../out', url.pathname === '/' ? 'index.html' : `.${url.pathname}`);
    try { const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
  try { const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`); await page.getByText('Local workspace', { exact: true }).waitFor(); await run({ page, calls, reject: () => reject = true }); assert.deepEqual(errors, []); }
  finally { await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}

test('model picker searches actual models, supports keyboard selection and returns focus without sending', () => fixture(async ({ page, calls }) => {
  await page.getByLabel('Message Elpis').fill('Do not send this while choosing a model.');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByLabel('Search models', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Search models', { exact: true }).count(), 1, 'model menu needs real search');
  await page.getByRole('tab',{name:'Anthropic',exact:true}).click();
  await page.getByRole('option').filter({hasText:'Opus'}).waitFor();
  assert.equal(await page.getByRole('option').count(),1);
  await page.getByRole('tab',{name:'All',exact:true}).click();
  await page.getByLabel('Search models').fill('opus');
  await page.getByRole('option').filter({ hasText: 'Opus' }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: 'GPT-6 Sol' }).count(), 0);
  await page.getByLabel('Search models').press('ArrowDown');
  await page.getByLabel('Search models').press('Enter');
  await page.getByRole('combobox', { name: 'Model', exact: true }).filter({ hasText: 'Opus' }).waitFor();
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByLabel('Search models').press('Escape');
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).evaluate(e => e === document.activeElement), true);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path !== '/api/session').length, 0);
  assert.equal(await page.getByLabel('Message Elpis').inputValue(), 'Do not send this while choosing a model.');
}));

test('transcription route changes beside the microphone; failed saves keep edits and never record or send', () => fixture(async ({ page, calls, reject }) => {
  await page.getByLabel('Message Elpis', { exact: true }).fill('Keep this unsent while changing transcription.');
  assert.equal(await page.getByRole('button', { name: 'Transcription settings', exact: true }).count(), 1, 'route must be directly changeable beside the microphone');
  await page.getByRole('button', { name: 'Transcription settings' }).click();
  await page.getByRole('combobox', { name: 'Transcription engine', exact: true }).click();
  await page.getByRole('option', { name: 'Local WhisperType', exact: true }).click();
  await page.getByRole('button', { name: 'Save transcription settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dictate message', exact: true }).filter({ has: page.locator('svg') }).waitFor();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Dictate message"]').title.includes('Local WhisperType'));
  await page.getByRole('button', { name: 'Transcription settings' }).click();
  await page.getByRole('combobox', { name: 'Transcription engine', exact: true }).click();
  await page.getByRole('option', { name: 'ChatGPT sign-in', exact: true }).click();
  await page.getByRole('button', { name: 'Save transcription settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Dictate message"]').title.includes('ChatGPT sign-in'));
  await page.getByRole('button', { name: 'Transcription settings' }).click();
  await page.getByRole('combobox', { name: 'Transcription engine', exact: true }).click();
  await page.getByRole('option', { name: 'OpenRouter', exact: true }).click();
  await page.getByLabel('Transcription model', { exact: true }).fill('openai/gpt-4o-transcribe');
  reject(); await page.getByRole('button', { name: 'Save transcription settings', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Settings changed elsewhere' }).waitFor();
  assert.equal(await page.getByLabel('Transcription model').inputValue(), 'openai/gpt-4o-transcribe');
  assert.equal(calls.filter(call => call.method === 'POST' && !['/api/session', '/api/mcp'].includes(call.path)).length, 0);
  assert.equal(await page.getByLabel('Message Elpis').inputValue(), 'Keep this unsent while changing transcription.');
}));

test('existing chat keeps both pending model and effort, and sends the visible choices together', () => fixture(async ({ page, calls }) => {
  await page.locator('.thread-row[data-thread-id="existing"] .thread-link').click();
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'GPT-5.5' }).click();
  await page.getByLabel('Reasoning effort', { exact: true }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await page.locator('.next-turn').filter({ hasText: 'high' }).waitFor();
  assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).getAttribute('data-value'), 'high');
  await page.getByLabel('Message Elpis').fill('Keep the model and effort together.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message Elpis"]').value === '');
  const turn = calls.find(call => call.method === 'POST' && call.path === '/api/threads/existing/turns');
  assert.deepEqual(turn.data, {text:'Keep the model and effort together.',model:'gpt-5.5',effort:'high'});
}));
