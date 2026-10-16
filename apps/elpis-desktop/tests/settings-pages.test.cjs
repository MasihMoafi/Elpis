const { chooseOption, controlValue } = require('./controls.cjs');
// Every Settings page against a local adapter: page order, what each control writes, and narrow layouts. No runtime or model calls.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const PAGES = ['General', 'Notifications', 'Appearance', 'Keyboard shortcuts', 'Voice', 'Personalization', 'Models & accounts', 'MCP servers', 'Usage & limits', 'Git', 'Worktrees', 'Hooks', 'Configuration', 'Archived chats'];

test('settings pages appear in order and each control writes only its own backing setting', async () => {
  let version = 1;
  const options = { approvalPolicy: 'on-request', sandboxMode: null, webSearch: null, verbosity: null, reasoningSummary: null, serviceTier: null, developerInstructions: null, projectRootMarkers: null, worktreeRoot: null };
  const settings = () => ({ version: `v${version}`, main: { model: 'main-model', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }],
    smartPrune: { enabled: true, explicitOverride: { available: true, model: null, provider: null, version: 'p1' } }, memory: { enabled: false, generate: null, use: null, skipExternalContext: null, extractionModel: null, consolidationModel: null },
    options, managed: { allowedApprovalPolicies: null, allowedSandboxModes: ['read-only', 'workspace-write'] }, write: { available: true, reason: 'Applies to new conversations.' } });
  let hooks = { version: 'h1', write: { available: true }, warnings: [], errors: [], hooks: [{ key: 'user:hooks.json:pre_tool_use:0:0', event: 'preToolUse', handler: 'command', command: 'rtk hook claude', matcher: '^Bash$', timeoutSec: 5, source: 'user', sourcePath: '/home/person/.elpis-next/hooks.json', pluginId: null, enabled: true, managed: false, trust: 'untrusted' }] };
  const mcp = () => ({ version: `m${version}`, configPath: '/home/person/.elpis-next/config.toml', write: { available: true }, servers: [{ name: 'whispertype', enabled: true, transport: 'stdio', command: 'whispertype-mcp', url: null, credentials: [], whispertype: { backend: 'openrouter', model: null } }] });
  const posts = [], clients = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : undefined;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && url.pathname !== '/api/session') posts.push({ path: url.pathname, body });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'main-model', model: 'main-model', displayName: 'Main model' }] });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/settings') { if (req.method === 'POST') { Object.assign(options, body.options); version++; } return json(settings()); }
    if (url.pathname === '/api/mcp') { if (req.method === 'POST') version++; return json(mcp()); }
    if (url.pathname === '/api/tools/transcription') return json({ available: true, backend: 'openrouter', label: 'OpenRouter' });
    if (url.pathname === '/api/hooks') { if (req.method === 'POST') hooks = { ...hooks, version: 'h2', hooks: hooks.hooks.map(hook => ({ ...hook, ...(body.trust ? { trust: 'trusted' } : { enabled: body.enabled }) })) }; return json(hooks); }
    if (url.pathname === '/api/providers') return json({ openai: { auth: { state: 'signedOut' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] });
    if (url.pathname === '/api/providers/settings') return json({ version: 'p', configPath: null, write: { available: true }, managed: { modelProvider: null }, providers: [] });
    try { const file = path.join(__dirname, '../out', url.pathname === '/' ? 'index.html' : url.pathname); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(await fs.readFile(file)); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Config pages read the shared settings snapshot when opened; wait for it so saves carry the current version.
  const CONFIG = ['General', 'Personalization', 'Git', 'Worktrees', 'Configuration'];
  const open = async name => {
    const read = CONFIG.includes(name) ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'GET') : null;
    await page.getByRole('tab', { name, exact: true }).click(); await read;
    return page.getByRole('tabpanel', { name, exact: true });
  };
  const lastPost = () => posts.at(-1);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click();
    assert.deepEqual(await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab').allInnerTexts(), PAGES);

    // General: device preferences persist across reloads; Speed writes service_tier.
    let panel = await open('General');
    await chooseOption(panel.getByLabel('Send shortcut', { exact: true }), 'modEnter');
    await panel.getByRole('radio', { name: 'Queue', exact: true }).click();
    await panel.getByRole('switch', { name: 'Show context window usage', exact: true }).click();
    await panel.getByRole('button', { name: 'Change', exact: true }).click();
    await panel.getByLabel('Default folder for new chats', { exact: true }).fill('relative/path'); await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'absolute folder path' }).waitFor();
    await panel.getByLabel('Default folder for new chats', { exact: true }).fill('/tmp/work'); await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByText('/tmp/work', { exact: true }).waitFor();
    await chooseOption(panel.getByLabel('Speed', { exact: true }), 'fast');
    await panel.getByRole('status').filter({ hasText: 'Speed saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v1', options: { serviceTier: 'fast' } } });
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('elpis-preferences-v1')));
    assert.deepEqual([stored.sendShortcut, stored.followUp, stored.showContextUsage, stored.defaultFolder], ['modEnter', 'queue', true, '/tmp/work']);
    await page.reload(); await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click();
    panel = await open('General');
    assert.equal(await controlValue(panel.getByLabel('Send shortcut', { exact: true })), 'modEnter');
    assert.equal(await panel.getByRole('radio', { name: 'Queue', exact: true }).getAttribute('aria-checked'), 'true');

    // Notifications are device preferences too.
    panel = await open('Notifications');
    await chooseOption(panel.getByLabel('Turn completion notifications', { exact: true }), 'always');
    await panel.getByRole('radio', { name: 'Chime', exact: true }).click();
    await panel.getByRole('switch', { name: 'Approval and question notifications', exact: true }).click();
    const notify = JSON.parse(await page.evaluate(() => localStorage.getItem('elpis-preferences-v1')));
    assert.deepEqual([notify.turnNotifications, notify.notificationSound, notify.inputNotifications], ['always', true, false]);

    panel = await open('Keyboard shortcuts');
    await panel.getByLabel('Search keyboard shortcuts').fill('search');
    await panel.getByText('Search chats', { exact: true }).waitFor();
    await panel.getByLabel('Search keyboard shortcuts').fill('no such shortcut');
    await panel.getByText('No shortcuts match', { exact: false }).waitFor();

    // Voice saves WhisperType's route through the MCP config writer.
    panel = await open('Voice');
    await panel.getByText('Ready', { exact: true }).waitFor();
    await chooseOption(panel.getByLabel('Transcription engine', { exact: true }), 'local');
    await panel.getByRole('button', { name: 'Save transcription settings' }).click();
    await panel.getByRole('status').filter({ hasText: 'Transcription settings saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/mcp', body: { version: 'm2', name: 'whispertype', action: 'whispertype', backend: 'local' } });

    panel = await open('Personalization');
    await panel.getByLabel('Instructions for every chat', { exact: true }).fill('Answer briefly.');
    await panel.getByRole('button', { name: 'Save instructions', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Instructions saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v3', options: { developerInstructions: 'Answer briefly.' } } });
    await panel.getByRole('switch', { name: 'Enable memories', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: /^Saved\. Applies to new conversations\.$/ }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v4', memory: { enabled: true } } });

    panel = await open('Git');
    await panel.getByLabel('Project root markers', { exact: true }).fill('.git, .hg');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Project root markers saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v5', options: { projectRootMarkers: ['.git', '.hg'] } } });

    panel = await open('Worktrees');
    await panel.getByLabel('Worktree root', { exact: true }).fill('/tmp/trees');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Worktree root saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v6', options: { worktreeRoot: '/tmp/trees' } } });

    // Hooks: trusting and turning off write hooks.state for that hook only.
    panel = await open('Hooks');
    await panel.getByText('Not trusted', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Trust', exact: true }).click();
    await panel.getByText('Trusted', { exact: true }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/hooks', body: { version: 'h1', key: 'user:hooks.json:pre_tool_use:0:0', trust: true } });
    await panel.getByRole('switch', { name: 'Enable Before a tool runs · ^Bash$' }).click();
    await panel.getByRole('status').filter({ hasText: 'Hook turned off' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/hooks', body: { version: 'h2', key: 'user:hooks.json:pre_tool_use:0:0', enabled: false } });

    // Configuration: config defaults, with managed restrictions disabled.
    panel = await open('Configuration');
    await chooseOption(panel.getByLabel('Web search', { exact: true }), 'live');
    await panel.getByRole('status').filter({ hasText: 'Web search saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v7', options: { webSearch: 'live' } } });
    await panel.getByLabel('Default sandbox', { exact: true }).click();
    const fullAccess = page.getByRole('option', { name: 'Full access', exact: true });
    assert.ok(await fullAccess.getAttribute('aria-disabled') === 'true' || await fullAccess.getAttribute('data-disabled') !== null, 'a managed restriction disables Full access');
    await page.keyboard.press('Escape');
    await panel.getByText('/home/person/.elpis-next/config.toml', { exact: true }).waitFor();

    // MCP points to Voice for the transcription route.
    panel = await open('MCP servers');
    await panel.getByRole('button', { name: 'Open Voice settings', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'Voice', exact: true }).getAttribute('aria-selected'), 'true');

    assert.equal(posts.filter(post => post.path === '/api/memories/reset').length, 0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of PAGES) { await open(name); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits at ${width}px`); }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
