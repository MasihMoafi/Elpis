const { leaveSettings, sidebar, openSettings } = require('./controls.cjs');
// Elpis's own Anthropic sign-out on Models & accounts against a local adapter: the card offers Sign out / Sign in like the
// ChatGPT card, and after either the sidebar's Anthropic usage, the Usage & limits page and the model picker follow.
// No runtime or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const limit = (limitId, limitName, usedPercent) => ({ limitId, limitName, planType: null, primary: { usedPercent, windowDurationMins: 300, resetsAt: null }, secondary: null, reached: null });

test('Anthropic card: Sign out and Sign in change only Elpis; usage and the model picker follow', async () => {
  const clients = new Set(); const posts = []; let modelRequests = 0;
  // `signedOut`: Elpis's own switch. `claudeCodeIn`: whether Claude Code on this computer is logged in.
  const state = { signedOut: false, claudeCodeIn: true, activeId: 'default' };
  const secondId = '66601136-bf70-4727-8da3-0e2e8efc7e99', accountPosts = [];
  const claudeAccounts = () => ({ activeId: state.activeId, accounts: [
    { id: 'default', label: 'Claude 1', email: 'first@example.com', plan: 'max', authenticated: true, signingIn: false, error: null },
    { id: secondId, label: 'Claude 2', email: 'second@example.com', plan: 'pro', authenticated: true, signingIn: false, error: null },
  ] });
  const claude = () => state.signedOut ? { state: 'notConnected', models: [], usage: [], signedOut: true }
    : state.claudeCodeIn ? { state: 'connected', models: ['Opus'], usage: [limit('claude', 'Claude', 40)], signedOut: false }
      : { state: 'notConnected', models: [], usage: [], signedOut: false };
  const providers = () => ({ openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'person@example.com', plan: 'pro' }, usage: [limit('codex', 'Codex', 10)], usageError: null },
    claude: claude(), gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [] });
  const models = () => [{ id: 'luna', model: 'luna', displayName: 'Luna' }, ...(state.signedOut || !state.claudeCodeIn ? [] : [{ id: 'claude/opus', model: 'claude/opus', displayName: 'Opus (Claude subscription)', description: 'Claude Code on your Pro/Max plan' }])];
  const providerSettings = { version: 'p', configPath: '/tmp/config.toml', write: { available: true }, managed: { modelProvider: null }, providers: [] };
  const settings = { version: 'v1', main: { model: 'luna', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }],
    smartPrune: { enabled: null, explicitOverride: { available: false, reason: 'Not available' } }, memory: { generate: null, use: null, extractionModel: null, consolidationModel: null },
    options: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }, managed: {}, write: { available: true } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json(settings);
    if (url.pathname === '/api/models') { modelRequests++; return json({ data: models(), nextCursor: null }); }
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/providers/settings') return json(providerSettings);
    if (url.pathname === '/api/providers/claude-accounts') {
      if (req.method === 'POST') { const input = JSON.parse(raw); accountPosts.push(input); state.activeId = input.id; }
      return json(claudeAccounts());
    }
    if (url.pathname === '/api/providers' && req.method === 'POST') {
      const body = JSON.parse(raw); posts.push(body);
      if (body.action === 'anthropicSignOut') state.signedOut = true;
      if (body.action === 'anthropicSignIn') state.signedOut = false;
      for (const client of clients) client.write('event: account\ndata: {}\n\n'); // the desktop bridge announces the change to every window
      return json({ anthropicSignedOut: state.signedOut });
    }
    if (url.pathname === '/api/providers') return json(providers());
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(__dirname, '../out', url.pathname === '/' ? 'index.html' : url.pathname); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(await fs.readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const usageRows = async () => (await page.getByRole('button', { name: 'Usage and limits', exact: true }).innerText()).replace(/\s+/g, ' ').trim();
  const pickerOptions = async () => {
    await leaveSettings(page);
    await page.getByLabel('Model', { exact: true }).click();
    await page.getByRole('option').first().waitFor();
    const names = (await page.getByRole('option').allInnerTexts()).map(name => name.replace(/\s+/g, ' ').trim());
    await page.keyboard.press('Escape');
    return names;
  };
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Usage and limits', exact: true }).filter({ hasText: 'Anthropic' }).waitFor();
    assert.equal(await usageRows(), 'ChatGPT 90% left Anthropic 60% left');
    const first = await pickerOptions();
    assert.ok(first.some(name => /Opus/.test(name)), `Claude models are in the picker: ${JSON.stringify(first)}`);
    assert.ok(first.some(name => /Luna/.test(name)), `other models are too: ${JSON.stringify(first)}`);

    await openSettings(page);
    await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
    const accounts = page.getByRole('tabpanel', { name: 'Models & accounts', exact: true });
    const card = accounts.locator('[data-provider="claude"]');
    await card.getByText('Connected', { exact: true }).waitFor();
    assert.deepEqual(await card.getByRole('button').allInnerTexts(), ['Sign out']);
    assert.deepEqual(await accounts.locator('[data-provider="openai"]').getByRole('button').allInnerTexts(), ['Sign out'], 'the ChatGPT card keeps its own button');
    await card.screenshot({ path: '/tmp/elpis-anthropic-card-connected.png' });
    const selector = card.getByRole('combobox', { name: 'Claude account' });
    await selector.click(); await page.getByRole('option', { name: 'second@example.com · pro', exact: true }).click();
    await selector.filter({ hasText: 'second@example.com' }).waitFor();
    assert.deepEqual(accountPosts, [{ action: 'select', id: secondId }]);
    await card.screenshot({ path: '/tmp/elpis-claude-second-account.png' });
    await selector.click(); await page.getByRole('option', { name: 'first@example.com · max', exact: true }).click();
    await selector.filter({ hasText: 'first@example.com' }).waitFor();

    // Sign out: only Elpis; the card, the sidebar's usage, the Usage & limits page and the picker all follow.
    const modelsBefore = modelRequests;
    await card.getByRole('button', { name: 'Sign out', exact: true }).click();
    await card.getByText('Signed out in Elpis', { exact: true }).waitFor();
    assert.deepEqual(posts, [{ action: 'anthropicSignOut' }]);
    assert.deepEqual(await card.getByRole('button').allInnerTexts(), ['Sign in']);
    assert.match(await card.innerText(), /Elpis is not using your Claude subscription\. Claude Code on this computer stays signed in\./);
    assert.match(await accounts.locator('[data-provider="openai"]').innerText(), /Signed in with ChatGPT/, 'ChatGPT is untouched');
    assert.ok(modelRequests > modelsBefore, 'the model picker reloaded its models');
    await card.screenshot({ path: '/tmp/elpis-anthropic-card-signed-out.png' });
    await page.getByRole('tab', { name: 'Usage & limits', exact: true }).click();
    await page.getByRole('tabpanel', { name: 'Usage & limits', exact: true }).locator('.usage-card[data-provider="claude"]').getByText('Signed out in Elpis. Sign in under Models & accounts to see Claude usage.').waitFor();
    await leaveSettings(page);
    await page.getByRole('button', { name: 'Usage and limits', exact: true }).filter({ hasNotText: 'Anthropic' }).waitFor();
    assert.equal(await usageRows(), 'ChatGPT 90% left');
    const without = await pickerOptions();
    assert.ok(without.length > 0 && without.every(name => !/Opus|Claude/.test(name)), `no Claude models in the picker: ${JSON.stringify(without)}`);

    // Sign in: Claude Code is still logged in, so everything comes back.
    await openSettings(page);
    await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    await card.getByText('Connected', { exact: true }).waitFor();
    assert.deepEqual(posts, [{ action: 'anthropicSignOut' }, { action: 'anthropicSignIn' }]);
    assert.deepEqual(await card.getByRole('button').allInnerTexts(), ['Sign out']);
    await leaveSettings(page);
    await page.getByRole('button', { name: 'Usage and limits', exact: true }).filter({ hasText: 'Anthropic' }).waitFor();
    const again = await pickerOptions();
    assert.ok(again.some(name => /Opus/.test(name)), `Claude models are back in the picker: ${JSON.stringify(again)}`);

    // Signed in again in Elpis, but Claude Code itself is logged out: the old hint, and no button to press.
    state.claudeCodeIn = false; await openSettings(page);
    await page.getByRole('tab', { name: 'Models & accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await card.getByText('Sign in to Claude Code on this computer to connect your subscription.').waitFor();
    assert.equal(await card.getByRole('button').count(), 0);
    assert.equal(await card.getByText('Not connected', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
