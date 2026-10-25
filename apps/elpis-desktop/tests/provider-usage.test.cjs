const { leaveSettings, sidebar, openSettings } = require('./controls.cjs');
// Account usage and Models & accounts against a local adapter: one shared usage store, reported usage that stays,
// no internal gateway listed as a server, and the settings search spacing. No runtime or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const limit = (limitId, limitName, usedPercent) => ({ limitId, limitName, planType: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: null }, secondary: null, reached: null });

test('usage is one shared store whose reported values stay until sign-out; gateways are not listed as servers', async () => {
  const clients = new Set(); let requests = 0, active = 0, busiest = 0, claudeSignedOut = false, modelListUnread = false;
  // The first answer reports Antigravity's usage; later ones omit it, as the subscription bridge does while it rereads.
  const providers = () => ({
    openai: { auth: { state: 'signedOut' }, usage: [], usageError: null },
    claude: claudeSignedOut ? { state: 'notConnected', models: [], usage: [] } : { state: 'connected', models: ['Opus'], usage: [limit('claude', 'Claude', 97)] },
    gemini: requests === 1 ? { state: 'connected', models: ['Gemini 3 Pro'], usage: [limit('antigravity-pro', 'Gemini Pro', 30)] }
      // The bridge's answer when it could not read the model list: unknown, which is not a sign-out.
      : modelListUnread ? { state: 'unknown', models: [], usage: [] } : { state: 'available', models: ['Gemini 3 Pro'], usage: [] },
    openrouter: [],
  });
  const providerSettings = { version: 'p', configPath: '/tmp/config.toml', write: { available: true }, managed: { modelProvider: null }, providers: [
    { id: 'anthropic-credits', name: 'Anthropic promotional credits', baseUrl: 'http://127.0.0.1:44103/v1', gateway: true, wireApi: 'responses', editable: false, auth: { source: 'none', keySet: false, envKey: null } },
    { id: 'api-lm-studio', name: 'My LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', gateway: false, wireApi: 'responses', editable: true, auth: { source: 'none', keySet: false, envKey: null } }] };
  const settings = { version: 'v1', main: { model: 'luna', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }],
    smartPrune: { enabled: null, explicitOverride: { available: false, reason: 'Not available' } }, memory: { generate: null, use: null, extractionModel: null, consolidationModel: null },
    options: { defaultPermissions: 'full' }, managed: {}, write: { available: true } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); for await (const chunk of req) void chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json(settings);
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'luna', displayName: 'Luna' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/providers/settings') return json(providerSettings);
    if (url.pathname === '/api/providers/claude-accounts') return json({ activeId: '', accounts: [] });
    if (url.pathname === '/api/providers') {
      requests++; active++; busiest = Math.max(busiest, active);
      const body = providers();
      await new Promise(resolve => setTimeout(resolve, 300));
      active--; return json(body);
    }
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(__dirname, '../out', url.pathname === '/' ? 'index.html' : url.pathname); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(await fs.readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const accountChanged = () => { for (const client of clients) client.write('event: account\ndata: {}\n\n'); };
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const settled = async count => { for (let i = 0; i < 50 && (requests < count || active); i++) await page.waitForTimeout(100); await page.waitForTimeout(400); assert.equal(requests, count); };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const panel = page.getByRole('button', { name: 'Usage and limits', exact: true });
    await panel.filter({ hasText: 'Antigravity' }).waitFor();
    assert.equal((await panel.innerText()).replace(/\s+/g, ' ').trim(), 'Anthropic 3% left Antigravity 70% left');
    const criticalRed = await panel.locator('.usage-row.critical i').evaluate(element => getComputedStyle(element).backgroundImage);
    assert.match(criticalRed, /rgb\(181, 16, 46\)/, 'critical usage uses the blood-red theme token');
    // A chat configured for "Never ask" and "Full access" starts in Full access.
    assert.equal(await page.locator('.composer-pill.permissions-full').count(), 1);

    // A125: subscribing reconciles any account changes after the initial read.
    // Opening Settings then shares that fresh answer.
    await settled(2);
    const startupRequests = requests;
    await openSettings(page);
    await page.getByRole('tab', { name: 'Usage & limits', exact: true }).click();
    const usage = page.getByRole('tabpanel', { name: 'Usage & limits', exact: true });
    const card = id => usage.locator(`.usage-card[data-provider="${id}"]`);
    await card('gemini').getByText('30% used').waitFor();
    await settled(startupRequests); // the page reads the same store: opening it asks nothing
    assert.equal(await usage.getByText('Selected conversation · context').count(), 0);
    assert.equal(await usage.locator('dt').count(), 0, 'no chat context table');

    // An account event refreshes every view with one request; the omitted usage keeps its last value.
    accountChanged(); await settled(startupRequests + 1);
    assert.match(await card('gemini').innerText(), /Gemini Pro · 5-hour limit[\s\S]*30% used/);
    assert.doesNotMatch(await card('gemini').innerText(), /Usage not reported/);
    // A refresh asked for while one is running waits for it, then runs once.
    await usage.getByRole('button', { name: 'Refresh', exact: true }).click(); accountChanged(); accountChanged();
    await settled(startupRequests + 3);
    assert.equal(busiest, 1, 'one usage request at a time');
    assert.match(await card('gemini').innerText(), /30% used/);
    await leaveSettings(page);
    assert.equal((await panel.innerText()).replace(/\s+/g, ' ').trim(), 'Anthropic 3% left Antigravity 70% left');

    // Signing out clears that account's usage.
    claudeSignedOut = true; accountChanged(); await settled(startupRequests + 4);
    await panel.filter({ hasNotText: 'Anthropic' }).waitFor();
    await openSettings(page);
    await page.getByRole('tab', { name: 'Usage & limits', exact: true }).click();
    await card('claude').getByText('Sign in with Claude Code to see Claude usage.').waitFor();
    assert.match(await card('gemini').innerText(), /30% used/);
    // A refresh that could not read the model list leaves Antigravity's usage in place.
    modelListUnread = true; accountChanged(); await settled(startupRequests + 5);
    assert.match(await card('gemini').innerText(), /30% used/);
    assert.doesNotMatch(await card('gemini').innerText(), /Usage not reported|Sign in/);

    // Models & accounts: no "Local servers"; the internal credits gateway is not a custom provider either.
    await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
    const accounts = page.getByRole('tabpanel', { name: 'Models & accounts', exact: true });
    await accounts.getByText('My LM Studio', { exact: true }).waitFor();
    assert.equal(await accounts.locator('[data-provider="local"]').count(), 0);
    assert.equal(await accounts.getByText('Local servers').count(), 0);
    assert.doesNotMatch(await accounts.innerText(), /Anthropic promotional credits|44103/);
    assert.match(await accounts.locator('[data-provider="gemini"]').innerText(), /Connected/, 'the account card reads the same store');

    // Configuration shows the full-access default as saved.
    await page.getByRole('tab', { name: 'Configuration', exact: true }).click();
    assert.match(await page.getByRole('tabpanel', { name: 'Configuration', exact: true }).getByLabel('Default permissions', { exact: true }).innerText(), /Full access/);

    // The search text keeps clear space from its magnifier, and focus outlines the whole field, not the text alone,
    // as in the ChatGPT app's settings.
    await page.getByLabel('Search settings', { exact: true }).focus(); await page.keyboard.type('usage');
    const search = await page.evaluate(() => { const box = document.querySelector('.settings-nav .search-field'), icon = box.querySelector('svg'), input = box.querySelector('input');
      return { space: input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft) - icon.getBoundingClientRect().right,
        input: getComputedStyle(input).outlineStyle, field: getComputedStyle(box).outlineStyle }; });
    assert.ok(search.space >= 8, `search text starts ${search.space}px after its icon`);
    assert.deepEqual([search.input, search.field], ['none', 'solid']);
    await page.locator('.settings-nav .search-field').screenshot({ path: '/tmp/elpis-settings-search.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
