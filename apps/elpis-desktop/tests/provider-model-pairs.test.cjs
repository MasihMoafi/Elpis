const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

test('a changed API default offers its own models and keeps the selected provider on mouse and keyboard choices', async () => {
  const renderer = process.env.ELPIS_TEST_RENDERER || path.join(__dirname, '../out');
  assert(path.isAbsolute(renderer));
  const catalog = [
    { id: 'claude-opus-5-5', model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  ];
  const calls = [], streams = new Set();
  const thread = { id: 'credits-chat', name: 'Credits fixture', model: catalog[0].model, modelProvider: 'anthropic-credits', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } };
  const bothProviders = [{ id: 'anthropic-credits', displayName: 'Anthropic credits' }, { id: 'openai', displayName: 'OpenAI' }];
  let unavailable = false, main = { model: catalog[0].model, provider: 'anthropic-credits' }, activeThread = thread, configuredProviders = bothProviders;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    let wire = ''; for await (const chunk of req) wire += chunk;
    const body = wire ? JSON.parse(wire) : undefined;
    calls.push({ method: req.method, path: url.pathname, provider: url.searchParams.get('provider'), body });
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n');
      streams.add(res); res.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json({ version: 'changed-default', background: {}, memory: {}, smartPrune: { explicitOverride: {} }, write: { available: false },
      main, providers: configuredProviders, managed: { modelProvider: null } });
    if (url.pathname === '/api/models') {
      if (url.searchParams.get('provider') === 'anthropic-credits') {
        if (unavailable) { res.statusCode = 502; return json({ error: 'Fixture credits catalog unavailable' }); }
        return json({ data: catalog });
      }
      // The long-lived engine still has its startup OpenAI catalog after defaults changed.
      return json({ data: [{ id: 'sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }, { id: 'claude/opus', model: 'claude/opus', displayName: 'Opus (Claude subscription)' }] });
    }
    if (url.pathname === '/api/threads') {
      if (req.method === 'POST') { activeThread = { ...thread, model: body.model || main.model, modelProvider: body.provider || main.provider }; return json({ thread: activeThread }); }
      return json({ data: [], nextCursor: null });
    }
    if (url.pathname.endsWith('/turns')) {
      const turnId = `fixture-turn-${calls.length}`;
      json(req.method === 'POST' ? { turn: { id: turnId } } : { data: [], nextCursor: null });
      if (req.method === 'POST') for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn: { id: turnId, status: 'completed' } } })}\n\n`);
      return;
    }
    if (url.pathname.startsWith('/api/threads/')) return json({ thread: activeThread, data: [], nextCursor: null });
    try {
      const file = path.join(renderer, url.pathname === '/' ? 'index.html' : url.pathname);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function screenshot(page, name) {
    if (process.env.ELPIS_APP_SHOTS) await page.screenshot({ path: path.join(process.env.ELPIS_APP_SHOTS, name + '.png') });
  }
  async function refreshSettings(page) {
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings');
    for (const stream of streams) stream.write('event: connection\ndata: {"connected":false}\n\nevent: connection\ndata: {"connected":true}\n\n');
    await refreshed;
  }
  try {
    // Keep an explicitly selected Sol on its known OpenAI connection while defaults change.
    main = { provider: 'openai', model: 'gpt-6.1-sol' };
    const retained = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await retained.newPage(); page.setDefaultTimeout(7000);
      await page.goto(origin); await page.getByLabel('Model', { exact: true }).click();
      await page.getByRole('option', { name: /GPT-6\.1 Sol/ }).click();
      await page.getByLabel('Message Elpis', { exact: true }).fill('KEEP_SOL_ROUTE_SENTINEL');
      main = { provider: 'anthropic-credits', model: catalog[0].model };
      await refreshSettings(page);
      await page.getByLabel('Model', { exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role=tab]')[1]?.textContent === 'Anthropic credits');
      await page.getByLabel('Search models', { exact: true }).press('Escape');
      await screenshot(page, 'pairs-retained-sol');
      assert.match(await page.getByLabel('Model', { exact: true }).innerText(), /GPT-6\.1 Sol\s+OpenAI/, 'a selected model keeps its provider across a default change');
      assert.equal(await page.getByLabel('Message Elpis', { exact: true }).inputValue(), 'KEEP_SOL_ROUTE_SENTINEL');
      configuredProviders = bothProviders.filter(provider => provider.id !== 'openai');
      await refreshSettings(page);
      await page.getByRole('alert').filter({ hasText: 'This connection is no longer available' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
      const sent = calls.filter(call => call.method === 'POST' && call.path === '/api/threads').length;
      await page.getByLabel('Message Elpis', { exact: true }).press('Enter');
      assert.equal(calls.filter(call => call.method === 'POST' && call.path === '/api/threads').length, sent);
      assert.equal(await page.getByLabel('Message Elpis', { exact: true }).inputValue(), 'KEEP_SOL_ROUTE_SENTINEL');
      configuredProviders = bothProviders;
      await refreshSettings(page);
      await page.getByLabel('Model', { exact: true }).filter({ hasText: 'OpenAI' }).waitFor();
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea').value === '');
      assert.deepEqual(calls.filter(call => call.method === 'POST' && call.path === '/api/threads').at(-1).body, { model: 'gpt-6.1-sol', provider: 'openai' });
    } finally { await retained.close(); }
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(7000);
        await page.goto(origin);
        await page.getByLabel('Model', { exact: true }).waitFor();
        await page.evaluate(dark => { document.documentElement.classList.toggle('dark', dark); document.querySelector('.app-shell').classList.toggle('dark', dark); }, theme === 'dark');
        await page.getByLabel('Message Elpis', { exact: true }).fill('INHERITED_DEFAULT_SENTINEL');
        assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true, 'the configured API default does not require reselecting its model');
        await page.getByLabel('Message Elpis', { exact: true }).fill('');
        await page.getByLabel('Model', { exact: true }).click();
        await page.getByLabel('Search models', { exact: true }).waitFor();
        await screenshot(page, `pairs-${theme}-all`);
        const all = await page.getByRole('option').allInnerTexts();
        assert(!all.some(row => row.includes('Sol')), `Anthropic credits must not borrow Sol from the startup catalog: ${all.join(' | ')}`);
        assert(all.some(row => row.includes('Opus') && row.includes('Anthropic')), 'the separate subscription route remains available');
        await page.getByRole('tab', { name: 'Anthropic credits', exact: true }).click();
        const opus = page.getByRole('option', { name: /Claude Opus 5\.5/ }); await opus.waitFor();
        assert.deepEqual((await page.getByRole('option').allInnerTexts()).map(value => value.replace(/\s+/g, ' ').trim()), ['Claude Opus 5.5 Anthropic credits', 'Claude Sonnet 5.5 Anthropic credits']);
        await screenshot(page, `pairs-${theme}-catalog`);
        await opus.click();
        const chip = page.getByLabel('Model', { exact: true });
        assert.match(await chip.innerText(), /Claude Opus 5\.5\s+Anthropic credits/);
        await page.getByLabel('Message Elpis', { exact: true }).fill('PRIVATE_PAIR_SENTINEL');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('textarea').value === '');
        assert.deepEqual(calls.filter(call => call.method === 'POST' && call.path === '/api/threads').at(-1).body, { model: catalog[0].model, provider: 'anthropic-credits' });
        await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
        await chip.click();
        const search = page.getByLabel('Search models', { exact: true }); await search.fill('Sonnet');
        await search.press('ArrowDown'); await search.press('Enter');
        assert.match(await chip.innerText(), /Claude Sonnet 5\.5\s+Anthropic credits/);
        await screenshot(page, `pairs-${theme}-keyboard-selected`);
      } finally { await context.close(); }
    }
    assert(calls.some(call => call.path === '/api/models' && call.provider === 'anthropic-credits'));
    assert(calls.filter(call => call.method === 'POST' && call.path === '/api/threads').every(call => call.body.provider === 'openai' ? call.body.model === 'gpt-6.1-sol' : call.body.provider === 'anthropic-credits' && call.body.model === catalog[0].model));
    // An unavailable own catalog does not bring the startup Sol list back.
    unavailable = true;
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    await page.goto(origin); await page.getByLabel('Model', { exact: true }).click();
    await page.getByRole('tab', { name: 'Anthropic credits', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Fixture credits catalog unavailable' }).waitFor();
    assert.equal(await page.getByRole('option').count(), 0);
    await screenshot(page, 'pairs-unavailable');
    await page.close();
  } finally {
    await browser.close(); for (const stream of streams) stream.end();
    await new Promise(resolve => server.close(resolve));
  }
});
