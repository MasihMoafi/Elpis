const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

async function fixture(run, env = { WHISPERTYPE_BACKEND: 'local', WHISPERTYPE_CLOUD_MODEL: 'user/saved-audio-model' }) {
  const calls = [], clients = new Set();
  const { transcriptionStatus } = await import('../bridge/transcription.mjs'); // the real route rules answer the page, so the provider it sends is checked end to end
  const whispertype = { command: 'fixture-mcp', env };
  const routed = { id: 'routed', name: 'OpenRouter chat', model: 'openai/gpt-5', modelProvider: 'openrouter', reasoningEffort: null, status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const google = { ...routed, id: 'google', name: 'Gemini chat', model: 'gemini-pro-latest', modelProvider: 'google-gemini' };
  const thread = {id:'existing',name:'Existing model check',model:'gpt-6-sol',modelProvider:'openai',reasoningEffort:null,status:{type:'idle'},desktopAccess:{writable:true,mode:'direct'}};
  const models = [{ id: 'sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, {id:'gpt-5.5',model:'gpt-5.5',displayName:'GPT-5.5',supportedReasoningEfforts:[{reasoningEffort:null},{reasoningEffort:'high'}]}, { id: 'opus', model: 'claude/opus', displayName: 'Opus' }, { id: 'agy', model: 'agy/gemini', displayName: 'Gemini via AGY' }];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : undefined; calls.push({ path: url.pathname, query: url.search.slice(1), method: req.method, data });
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/session') return json({ authenticated: true });
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/models') return json({ data: models });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6-sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI', auth: { source: 'subscription' } }], managed: {} });
    if (url.pathname === '/api/threads') return json({ data: [thread, routed, google], nextCursor: null });
    if (url.pathname === '/api/threads/existing') return json({thread,data:[],nextCursor:null});
    if (url.pathname === '/api/threads/existing/resume') return json({thread,activeTurnId:null});
    if (url.pathname === '/api/threads/routed') return json({thread:routed,data:[],nextCursor:null});
    if (url.pathname === '/api/threads/routed/resume') return json({thread:routed,activeTurnId:null});
    if (url.pathname === '/api/threads/google') return json({thread:google,data:[],nextCursor:null});
    if (url.pathname === '/api/threads/google/resume') return json({thread:google,activeTurnId:null});
    if (url.pathname === '/api/threads/existing/turns') return json({turn:{id:'test-turn',status:'inProgress'}});
    if (url.pathname === '/api/tools/transcription') return json(transcriptionStatus(whispertype, url.searchParams.get('provider') ?? undefined, { chatgpt: false, geminiKey: 'fixture-key' }));
    if (url.pathname.startsWith('/api/')) return json({});
    const file = path.resolve(__dirname, '../out', url.pathname === '/' ? 'index.html' : `.${url.pathname}`);
    try { const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
  try { const page = await browser.newPage({ viewport: { width: 1320, height: 900 } }); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`); await page.getByText('Local workspace', { exact: true }).waitFor(); await run({ page, calls }); assert.deepEqual(errors, []); }
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

test('the microphone is one plain button that follows the chat provider and names its transcriber', () => fixture(async ({ page, calls }) => {
  const mic = page.getByRole('button', { name: 'Dictate message', exact: true });
  const title = () => mic.getAttribute('title');
  const settled = text => page.waitForFunction(text => document.querySelector('button[aria-label="Dictate message"]')?.title.includes(text), text);
  const size = locator => locator.evaluate(element => { const box = element.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; });
  await settled('ChatGPT sign-in');
  assert.equal(await page.getByRole('button', { name: 'Transcription settings' }).count(), 0, 'the route is no longer a control beside the microphone');
  assert.equal(await page.locator('.dictation-control svg.lucide-chevron-down').count(), 0, 'no caret next to the microphone');
  assert.deepEqual(await size(mic), await size(page.getByRole('button', { name: 'Send message', exact: true })), 'same size as the composer icon buttons');
  // A new chat follows the model picker's provider; the Claude subscription has no transcription Elpis can reach, so the fallback speaks.
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('tab', { name: 'Anthropic', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'Opus' }).click();
  await settled('Local WhisperType');
  // An existing chat follows its own provider, and a model switched inside it.
  await page.locator('.thread-row[data-thread-id="routed"] .thread-link').click();
  await settled('OpenRouter (cloud) · user/saved-audio-model');
  await page.locator('.thread-row[data-thread-id="google"] .thread-link').click();
  await settled('Gemini API (cloud) · gemini-flash-latest');
  await page.locator('.thread-row[data-thread-id="existing"] .thread-link').click();
  await settled('ChatGPT sign-in');
  assert.match(await title(), /^Dictate with ChatGPT sign-in \(cloud\)\./);
  assert.deepEqual(calls.filter(call => call.path === '/api/tools/transcription').map(call => call.query), ['provider=openai', 'provider=claude', 'provider=openrouter', 'provider=google-gemini', 'provider=openai']);
  assert.deepEqual(calls.filter(call => call.method === 'POST' && call.path !== '/api/session' && !call.path.endsWith('/resume') && !(call.path.endsWith('/rewind') && call.data?.action === 'status')), [], 'choosing a provider never records, saves or sends');
}));

test('an OpenRouter chat without a transcription model says where to set it; the button explains instead of recording', () => fixture(async ({ page }) => {
  const mic = page.getByRole('button', { name: 'Dictate message', exact: true });
  await page.locator('.thread-row[data-thread-id="routed"] .thread-link').click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Dictate message"]')?.title.includes('Settings → Voice'));
  assert.equal(await mic.getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('.dictation-status').innerText(), '', 'the composer row stays calm until the button is used');
  await mic.click({ force: true }); // Playwright treats aria-disabled as disabled; a person can click it
  await page.getByRole('status').filter({ hasText: 'Set the OpenRouter transcription model in Settings → Voice.' }).waitFor();
}, { WHISPERTYPE_BACKEND: 'local' }));

test('existing chat keeps both pending model and effort, and sends the visible choices together', () => fixture(async ({ page, calls }) => {
  await page.locator('.thread-row[data-thread-id="existing"] .thread-link').click();
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'GPT-5.5' }).click();
  await page.getByLabel('Reasoning effort', { exact: true }).click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await page.locator('[aria-label="Reasoning effort"][data-value="high"]').waitFor();
  assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).getAttribute('data-value'), 'high');
  await page.getByLabel('Message Elpis').fill('Keep the model and effort together.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message Elpis"]').value === '');
  const turn = calls.find(call => call.method === 'POST' && call.path === '/api/threads/existing/turns');
  assert.deepEqual(turn.data, {text:'Keep the model and effort together.',model:'gpt-5.5',effort:'high'});
}));

const { fixture: parityFixture } = require('./parity-fixture.cjs');
const { chooseOption, controlValue, openSettings } = require('./controls.cjs');

for (const connected of [true, false]) test(`transcription menu ${connected ? 'retains a saved custom model' : 'explains a disconnected OpenRouter'}`, async () => {
  const model = connected ? 'user/saved-audio-model' : null;
  const f = await parityFixture({ routes: {
    '/api/mcp': () => ({ version: 'm1', write: { available: true }, servers: [{ name: 'whispertype', whispertype: { backend: 'local', model } }] }),
    '/api/tools/transcription': () => ({ available: true, backend: 'local', label: 'Local WhisperType' }),
    '/api/voice': () => ({ available: true, voice: 'juniper', voices: ['juniper'] }),
    '/api/models': (_body, url) => {
      if (!url.searchParams.has('provider')) return { data: [] };
      assert.equal(url.search, '?provider=openrouter&inputModality=audio');
      return connected ? { data: [{ id: 'fixture/audio-model', model: 'fixture/audio-model', displayName: 'Catalog audio' }] }
        : { __http: 502, error: 'Add an API key for this connection.' };
    },
  } });
  try {
    await openSettings(f.page); await f.page.getByRole('tab', { name: 'Voice', exact: true }).click();
    const panel = f.page.getByRole('tabpanel', { name: 'Voice', exact: true });
    await panel.getByText("ChatGPT voices for new voice chats. Claude's voices are only available in Anthropic's apps.", { exact: true }).waitFor();
    await panel.getByText('Advanced: transcription', { exact: true }).click();
    const control = panel.getByRole('combobox', { name: 'OpenRouter transcription model', exact: true });
    assert.equal(await controlValue(control), model ?? '');
    if (connected) {
      await control.click();
      await f.page.getByRole('option', { name: 'Catalog audio', exact: true }).waitFor();
      assert.deepEqual(await f.page.getByRole('listbox').getByRole('option').allInnerTexts(), ['Not set', model, 'Catalog audio']);
      await f.page.getByRole('option', { name: 'Catalog audio', exact: true }).click();
      await f.page.getByRole('listbox').waitFor({ state: 'detached' });
      await chooseOption(control, model);
      assert.equal(await controlValue(control), model, 'the saved custom choice remains available after selecting another model');
      await panel.getByText('Advanced: custom model', { exact: true }).click();
      await panel.getByLabel('Custom OpenRouter transcription model', { exact: true }).fill('user/another-model');
      assert.equal(await controlValue(control), 'user/another-model');
    } else {
      await panel.getByRole('status').filter({ hasText: 'Add an API key for this connection.' }).waitFor();
      assert.equal(await control.isDisabled(), true);
    }
    assert.deepEqual(f.posts.filter(post => post.path === '/api/mcp'), [], 'reading and choosing never writes transcription settings');
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`nested provider selection closes its own list and keeps the model form usable in ${colorScheme}`, async () => {
  const f = await parityFixture({ colorScheme, routes: {
    '/api/settings': () => ({ background: {}, smartPrune: { explicitOverride: {} }, memory: {}, write: { available: false },
      main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'local', displayName: 'Local endpoint' }], managed: {} }),
  } });
  const { page } = f;
  const model = page.getByLabel('Model', { exact: true });
  try {
    await model.click();
    await page.getByText('Advanced: use an unlisted model', { exact: true }).click();
    const provider = page.getByLabel('Provider', { exact: true });
    await chooseOption(provider, 'local');
    assert.equal(await provider.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('listbox').count(), 1, 'the model list belongs to the still-open model form');
    const id = page.getByLabel('Model ID', { exact: true });
    await id.fill('local/custom-model');
    await provider.focus(); await provider.press('Enter');
    await page.getByRole('option', { name: 'Local endpoint', exact: true }).waitFor();
    await provider.press('Enter');
    assert.equal(await provider.getAttribute('aria-expanded'), 'false', 'keyboard selection closes the provider list');
    assert.equal(await id.inputValue(), 'local/custom-model');
    await page.getByRole('button', { name: 'Use model', exact: true }).click();
    await page.getByRole('listbox').waitFor({ state: 'detached' });
    assert.equal(await model.getAttribute('data-value'), 'local/custom-model');
    for (const close of ['Escape', 'outside']) {
      await model.click();
      await page.getByLabel('Search models', { exact: true }).waitFor();
      if (close === 'Escape') await page.getByLabel('Search models', { exact: true }).press('Escape');
      else await page.locator('aside.sidebar .brand').click();
      await page.getByRole('listbox').waitFor({ state: 'detached' });
      assert.equal(await model.getAttribute('aria-expanded'), 'false');
    }
    assert.deepEqual(f.posts.filter(post => post.path !== '/api/session'), [], 'choosing a model never saves settings or sends a message');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
