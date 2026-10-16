// Bridged chats report the engine's provider ("openai") while their model names the subscription.
// The exported renderer must label them by the model prefix and show each provider's own usage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const window = (usedPercent, windowDurationMins, resetsAt = null) => ({ usedPercent, windowDurationMins, resetsAt });
const inTwoHours = Math.floor(Date.now() / 1000) + 2 * 3600 + 90;
const limit = (limitId, limitName, primary, secondary = null) => ({ limitId, limitName, planType: null, primary, secondary, reached: null });

test('bridged models are labelled by their prefix; providers keep separate sign-in and usage', async () => {
  const root = { id: 'claude-root', name: 'Fix the parser', model: 'claude/opus', modelProvider: 'openai', reasoningEffort: 'high', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } };
  const agent = { id: 'gemini-agent', name: null, preview: 'You are a bounded worker in this repository.', parentThreadId: 'claude-root', agentNickname: 'Sagan', model: 'agy/gemini-3-pro', modelProvider: 'openai', status: { type: 'active' },
    source: { subAgent: { thread_spawn: { parent_thread_id: 'claude-root', agent_path: '/root/check_docs' } } }, desktopAccess: { writable: true, mode: 'continue', reason: null } };
  const orphan = { id:'orphan-agent',preview:'You are a bounded worker in this repository.',agentNickname:'Historical nickname',agentRole:'reviewer',source:{subAgent:{other:'legacy'}},status:{type:'idle'} };
  const providers = {
    openai: { auth: { state: 'signedIn', method: 'ChatGPT', email: 'person@example.com', plan: 'pro' }, usage: [limit('codex', 'Codex', window(12, 300))], usageError: null },
    claude: { state: 'connected', models: ['Opus (Claude subscription)'], usage: [limit('claude', 'Claude', window(40, 300, inTwoHours), window(7, 10080))] },
    gemini: { state: 'connected', models: ['Gemini 3 Pro (Antigravity)'], usage: [limit('antigravity-pro', 'Gemini Pro', window(null, 300))] },
    openrouter: [{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', keySet: false }],
    local: [],
  };
  // A list row can omit route metadata; remembered thread/read settings fill that absence.
  const listedRoot = { ...root, model: undefined, reasoningEffort: undefined };
  const streams = []; let listRequests = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); for await (const chunk of req) void chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); streams.push(res); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/settings') return json({ main: { provider: 'openai', model: 'gpt-6.1-sol' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], managed: { modelProvider: null } });
    if (url.pathname === '/api/models') return json({ data: [
      { id: 'sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { id: 'claude/opus', model: 'claude/opus', displayName: 'Opus (Claude subscription)', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'max' }] },
      { id: 'claude/sonnet', model: 'claude/sonnet', displayName: 'Sonnet (Claude subscription)', supportedReasoningEfforts: [] },
      { id: 'agy/gemini-3-pro', model: 'agy/gemini-3-pro', displayName: 'Gemini 3 Pro (Antigravity)', supportedReasoningEfforts: [] }] });
    if (url.pathname === '/api/providers') return json(providers);
    if (url.pathname === '/api/threads') { listRequests++; } if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') ? [agent] : [listedRoot,orphan], nextCursor: null });
    if (url.pathname.endsWith('/resume')) return json({ thread: url.pathname.includes('gemini') ? agent : root, activeTurnId: null });
    if (url.pathname.startsWith('/api/threads/')) return json({ thread: url.pathname.includes('gemini') ? agent : root, data: [], nextCursor: null });
    try { const file = path.join(__dirname, '../out', url.pathname === '/' ? 'index.html' : url.pathname); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(await fs.readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByLabel('Model', { exact: true }).click();
    await page.getByLabel('Search models', { exact: true }).waitFor();
    const providerOptions = await page.getByRole('tab').allInnerTexts();
    assert.deepEqual(providerOptions, ['All', 'OpenAI', 'Claude subscription', 'Antigravity']);
    await page.getByLabel('Search models', { exact: true }).press('Escape');
    await page.locator('.thread-row[data-thread-id="claude-root"] .thread-link').click();
    // As in the ChatGPT app, the chat's model and its provider show in the composer's model chip.
    const chip = page.getByLabel('Model', { exact: true });
    await chip.filter({ hasText: 'Claude subscription' }).waitFor();
    assert.match(await chip.innerText(), /Opus \(Claude subscription\)/);
    assert.doesNotMatch(await page.locator('.workspace-header').innerText(), /OpenAI|gpt-6\.1-sol|GPT-6\.1 Sol/);
    await page.getByLabel('Model', { exact: true }).click();
    await page.getByLabel('Search models', { exact: true }).waitFor();
    const catalog = await page.getByRole('option').allInnerTexts();
    for (const name of ['Opus (Claude subscription)', 'Sonnet (Claude subscription)', 'GPT-6.1 Sol', 'Gemini 3 Pro (Antigravity)']) assert(catalog.some(row => row.includes(name)), name);
    await page.getByLabel('Search models', { exact: true }).press('Escape');
    // A list refresh without model metadata keeps the last reported route.
    const listed = () => new Promise(resolve => { const check = () => listRequests > before ? resolve() : setTimeout(check, 50); const before = listRequests; for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ method: 'turn/completed', params: { threadId: 'elsewhere', turn: { id: 'turn-elsewhere' } } })}\n\n`); check(); });
    await listed(); await new Promise(resolve => setTimeout(resolve, 300));
    assert.match(await chip.innerText(), /Opus \(Claude subscription\)/, 'the composer keeps the read model after a list refresh');
    await page.locator('aside').getByRole('button', { name: 'Agents', exact: true }).click();
    const row = page.locator('.agent-row[data-thread-id="gemini-agent"]');
    await row.waitFor();
    assert.match(await page.locator('.agent-row[data-thread-id="claude-root"] .agent-meta').innerText(), /^Claude subscription · Opus \(Claude subscription\) · high$/, 'agents page uses the read model too');
    assert.equal(await row.locator('.agent-title').innerText(), 'Check docs');
    const orphanRow=page.locator('.agent-row[data-thread-id="orphan-agent"]');
    assert.equal(await orphanRow.locator('.agent-title').innerText(),'Untitled agent · an-agent');
    assert.match(await orphanRow.innerText(),/reviewer/);
    assert.equal(await page.getByText('You are a bounded worker in this repository.',{exact:true}).count(),0);
    assert.equal(await row.locator('.agent-nickname').innerText(), 'Sagan');
    assert.equal(await row.locator('.agent-meta').innerText(), 'Antigravity · Gemini 3 Pro (Antigravity)');
    await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click();
    const card = id => page.locator(`.provider-card[data-provider="${id}"]`);
    await card('claude').waitFor();
    assert.match(await card('openai').innerText(), /Signed in with ChatGPT[\s\S]*person@example\.com · pro plan[\s\S]*12% used/);
    assert.match(await card('claude').innerText(), /Connected[\s\S]*Claude · 5-hour limit[\s\S]*40% used[\s\S]*Weekly limit[\s\S]*7% used/);
    // An unreported share is said so, never drawn as an empty 0% bar; reset times are counted down.
    assert.match(await card('gemini').innerText(), /Gemini Pro · 5-hour limit[\s\S]*Share not reported/);
    assert.doesNotMatch(await card('gemini').innerText(), /\b0% used/);
    assert.equal(await card('gemini').getByRole('meter').count(), 0);
    assert.match(await card('claude').innerText(), /Claude · 5-hour limit[\s\S]*40% used[\s\S]*Resets in 2h \d+m/);
    for (const [id, foreign] of [['openai', /40%|3% used/], ['claude', /12%|3% used/], ['gemini', /12%|40%/]]) assert.doesNotMatch(await card(id).innerText(), foreign, `${id} shows only its own usage`);
    assert.match(await card('openrouter').innerText(), /API key not set/);
    assert.doesNotMatch(await card('openrouter').innerText(), /OPENROUTER_API_KEY/, 'ordinary setup explains key status without environment-variable identifiers');
    if (process.env.ELPIS_APP_SHOTS) for (const dark of [false, true]) for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.evaluate(dark => { document.documentElement.classList.toggle('dark', dark); document.querySelector('.app-shell').classList.toggle('dark', dark); }, dark);
      await page.setViewportSize({ width, height }); await new Promise(resolve => setTimeout(resolve, 250));
      await page.screenshot({ path: path.join(process.env.ELPIS_APP_SHOTS, `providers-usage-${label}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
