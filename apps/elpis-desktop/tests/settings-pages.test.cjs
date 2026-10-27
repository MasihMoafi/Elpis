const { chooseOption, controlValue, optionsCut, openSettings, leaveSettings } = require('./controls.cjs');
// Every Settings page against a local adapter: page order, what each control writes, and narrow layouts. No runtime or model calls.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

const PAGES = ['Models & accounts', 'Configuration', 'Personalization', 'MCP servers', 'Browser', 'Voice', 'Git', 'Worktrees', 'Hooks', 'General', 'Notifications', 'Appearance', 'Keyboard shortcuts', 'Usage & limits', 'Import chats', 'Archived chats', 'About'];

test('settings pages appear in order and each control writes only its own backing setting', async () => {
  let version = 1;
  const options = { defaultPermissions: 'ask', webSearch: null, verbosity: null, reasoningSummary: null, serviceTier: null, developerInstructions: null, projectRootMarkers: null, worktreeRoot: null };
  const managed = { allowedApprovalPolicies: null, allowedSandboxModes: ['read-only', 'workspace-write'] };
  const settings = () => ({ version: `v${version}`, main: { model: 'main-model', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }],
    smartPrune: { enabled: true, explicitOverride: { available: true, model: null, provider: null, version: 'p1' } }, memory: { enabled: false, generate: null, use: null, skipExternalContext: null, extractionModel: null, consolidationModel: null },
    options, managed, write: { available: true, reason: 'Applies to new conversations.' } });
  let hooks = { version: 'h1', write: { available: true }, warnings: [], errors: [], hooks: [{ key: 'user:hooks.json:pre_tool_use:0:0', event: 'preToolUse', handler: 'command', command: 'rtk hook claude', matcher: '^Bash$', timeoutSec: 5, source: 'user', sourcePath: '/home/person/.elpis-next/hooks.json', pluginId: null, enabled: true, managed: false, trust: 'untrusted' }] };
  let whispertype = { backend: 'openrouter', model: null };
  const mcp = () => ({ version: `m${version}`, configPath: '/home/person/.elpis-next/config.toml', write: { available: true }, servers: [{ name: 'whispertype', enabled: true, transport: 'stdio', command: 'whispertype-mcp', url: null, credentials: [], whispertype }] });
  const posts = [], clients = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk; const body = raw ? JSON.parse(raw) : undefined;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname.startsWith('/api/') && url.pathname !== '/api/session') posts.push({ path: url.pathname, body });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/about') return json({ version: '0.1.0', commit: 'ac82360bd', releaseNotes: 'https://example.invalid/releases' });
    if (url.pathname === '/api/models') {
      if (url.searchParams.get('provider') === 'openrouter') {
        assert.equal(url.searchParams.get('inputModality'), 'audio');
        return json({ data: [{ id: 'fixture/audio-model', model: 'fixture/audio-model', displayName: 'Catalog audio', architecture: { input_modalities: ['audio'] } }] });
      }
      return json({ data: [{ id: 'main-model', model: 'main-model', displayName: 'Main model' }] });
    }
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/settings') { if (req.method === 'POST') { Object.assign(options, body.options); version++; } return json(settings()); }
    if (url.pathname === '/api/mcp') { if (req.method === 'POST') { whispertype = { backend: body.backend, model: body.model }; version++; } return json(mcp()); }
    if (url.pathname === '/api/import-chats') return json({ days: 30, atATime: 50, sources: [] });
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
    await openSettings(page);
    assert.deepEqual(await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab').allInnerTexts(), PAGES);

    const writesBeforeAbout = posts.length;
    const about = await open('About');
    await about.getByText('ac82360bd', { exact: true }).waitFor();
    assert.equal(await about.getByText('0.1.0', { exact: true }).count(), 1);
    assert.equal(await about.getByRole('link', { name: 'Release notes', exact: true }).getAttribute('href'), 'https://example.invalid/releases');
    assert.equal(posts.length, writesBeforeAbout, 'reading About never writes settings');

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
    assert.deepEqual([stored.sendShortcut, stored.followUp, stored.showContextUsage, stored.defaultFolder], ['modEnter', 'queue', false, '/tmp/work']); // the switch turned the default-on ring off
    await page.reload(); await openSettings(page);
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

    // Voice: one OpenRouter model row and one fallback row, saved together through the MCP config writer.
    panel = await open('Voice');
    await panel.getByText('Configured', { exact: true }).waitFor();
    await panel.getByText('Advanced: transcription', { exact: true }).click();
    assert.deepEqual(await panel.getByRole('form', { name: 'Transcription settings' }).locator('.settings-row-title').allInnerTexts(), ['OpenRouter transcription model', 'Fallback transcription']);
    assert.equal(await panel.getByLabel('Transcription engine', { exact: true }).count(), 0, 'the old engine row is gone');
    assert.equal(await controlValue(panel.getByLabel('OpenRouter transcription model', { exact: true })), '');
    assert.equal(await panel.getByLabel('OpenRouter transcription model', { exact: true }).innerText(), 'Not set');
    assert.equal(await panel.getByRole('textbox', { name: 'OpenRouter transcription model', exact: true }).count(), 0);
    assert.equal(await panel.getByLabel('Custom OpenRouter transcription model', { exact: true }).isVisible(), false);
    await chooseOption(panel.getByLabel('Fallback transcription engine', { exact: true }), 'local');
    await chooseOption(panel.getByLabel('OpenRouter transcription model', { exact: true }), 'fixture/audio-model');
    await panel.getByRole('button', { name: 'Save transcription settings' }).click();
    await panel.getByRole('status').filter({ hasText: 'Transcription settings saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/mcp', body: { version: 'm2', name: 'whispertype', action: 'whispertype', backend: 'local', model: 'fixture/audio-model' } });
    await open('General'); panel = await open('Voice');
    // The disclosure may stay open across pages; open it only when closed.
    if (!await panel.getByLabel('Fallback transcription engine', { exact: true }).isVisible()) await panel.getByText('Advanced: transcription', { exact: true }).click();
    assert.equal(await controlValue(panel.getByLabel('OpenRouter transcription model', { exact: true })), 'fixture/audio-model');
    // Automatic is no explicit engine: it saves null, and never OpenRouter by default.
    await chooseOption(panel.getByLabel('Fallback transcription engine', { exact: true }), 'auto');
    await chooseOption(panel.getByLabel('OpenRouter transcription model', { exact: true }), '');
    await panel.getByText('Uses the ChatGPT sign-in while Elpis is signed in to ChatGPT, otherwise Local WhisperType.', { exact: false }).waitFor();
    await panel.getByRole('button', { name: 'Save transcription settings' }).click();
    await panel.getByRole('status').filter({ hasText: 'Transcription settings saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/mcp', body: { version: 'm3', name: 'whispertype', action: 'whispertype', backend: null, model: null } });

    panel = await open('Personalization');
    await panel.getByLabel('Instructions for every chat', { exact: true }).fill('Answer briefly.');
    await panel.getByRole('button', { name: 'Save instructions', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Instructions saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v4', options: { developerInstructions: 'Answer briefly.' } } });
    // R37: Memories is the master switch; while it is off no option says "on" for what is off.
    assert.equal(await panel.getByRole('switch', { name: 'Use memories', exact: true }).count(), 0);
    await panel.getByRole('switch', { name: 'Memories', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: /^Saved\. Applies to new conversations\.$/ }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v5', memory: { enabled: true } } });

    panel = await open('Git');
    await panel.getByLabel('Project root markers', { exact: true }).fill('.git, .hg');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Project root markers saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v6', options: { projectRootMarkers: ['.git', '.hg'] } } });

    panel = await open('Worktrees');
    await panel.getByLabel('Worktree root', { exact: true }).fill('/tmp/trees');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Worktree root saved' }).waitFor();
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v7', options: { worktreeRoot: '/tmp/trees' } } });

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
    assert.deepEqual(lastPost(), { path: '/api/settings', body: { version: 'v8', options: { webSearch: 'live' } } });
    await panel.getByLabel('Default permissions', { exact: true }).click();
    const fullAccess = page.getByRole('option', { name: 'Full access', exact: true });
    assert.ok(await fullAccess.getAttribute('aria-disabled') === 'true' || await fullAccess.getAttribute('data-disabled') !== null, 'a managed restriction disables Full access');
    await page.keyboard.press('Escape');
    managed.allowedApprovalPolicies = ['on-request']; managed.allowedSandboxModes = null;
    await open('General'); panel = await open('Configuration');
    await panel.getByLabel('Default permissions', { exact: true }).click();
    assert.equal(await page.getByRole('option', { name: 'Full access', exact: true }).getAttribute('aria-disabled'), 'true', 'the approval restriction alone also disables Full access');
    await page.keyboard.press('Escape');
    await leaveSettings(page);
    await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
    assert.equal(await page.getByRole('menuitem').filter({ hasText: 'Full access' }).getAttribute('aria-disabled'), 'true', 'the chat menu enforces the same managed restriction');
    await page.keyboard.press('Escape');
    await openSettings(page, 'Configuration'); panel = page.getByRole('tabpanel', { name: 'Configuration', exact: true });
    for (const [requirements, label] of [
      [{ allowedApprovalPolicies: null, allowedPermissionProfiles: { ':workspace': true }, allowedApprovalsReviewers: null }, 'Full access'],
      [{ allowedPermissionProfiles: null, allowedApprovalsReviewers: ['user'] }, 'Approve for me'],
    ]) {
      Object.assign(managed, requirements);
      await open('General'); panel = await open('Configuration');
      await panel.getByLabel('Default permissions', { exact: true }).click();
      assert.equal(await page.getByRole('option', { name: label, exact: true }).getAttribute('aria-disabled'), 'true', `${label} respects the profile and reviewer restrictions`);
      await page.keyboard.press('Escape'); await leaveSettings(page);
      await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
      assert.equal(await page.getByRole('menuitem').filter({ hasText: label }).getAttribute('aria-disabled'), 'true', 'the chat menu uses the same restriction');
      await page.keyboard.press('Escape'); await openSettings(page, 'Configuration');
    }
    Object.assign(managed, { allowedApprovalsReviewers: null, allowedPermissionProfiles: { ':workspace': true, ':danger-full-access': true, ':bypass-permissions': false } });
    await open('General'); panel = await open('Configuration');
    await panel.getByLabel('Default permissions', { exact: true }).click();
    assert.equal(await page.getByRole('option', { name: 'Full access', exact: true }).getAttribute('aria-disabled'), null, 'Full access can be allowed while Bypass is forbidden');
    await page.keyboard.press('Escape'); await leaveSettings(page);
    await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
    assert.equal(await page.getByRole('menuitem').filter({ hasText: 'Bypass permissions' }).getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('Escape'); await openSettings(page, 'Configuration');
    panel = page.getByRole('tabpanel', { name: 'Configuration', exact: true });
    await panel.getByText('/home/person/.elpis-next/config.toml', { exact: true }).waitFor();

    // MCP points to Voice for the transcription route.
    panel = await open('MCP servers');
    await panel.getByRole('button', { name: 'Open Voice settings', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'Voice', exact: true }).getAttribute('aria-selected'), 'true');

    assert.equal(posts.filter(post => post.path === '/api/memories/reset').length, 0);
    const checked = new Set();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of PAGES) {
        const panel = await open(name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} fits at ${width}px`);
        // Every menu on the page reads in full: no choice cut off or under the check mark.
        const menus = panel.locator('[data-slot="select-trigger"]:visible:not([data-disabled])');
        for (let index = 0; index < await menus.count(); index++) {
          const menu = menus.nth(index); checked.add(`${name}: ${await menu.getAttribute('aria-label') ?? await menu.textContent()}`);
          assert.deepEqual(await optionsCut(menu), [], `${name} at ${width}px: ${await menu.getAttribute('aria-label') ?? await menu.textContent()} menu`);
        }
      }
    }
    assert.ok(checked.size >= 16, `the menu check reached every page's menus, not ${checked.size}: ${[...checked].join(', ')}`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


// The import preview carries only names and types; only an explicit, available selection is submitted.
test('Claude MCP import previews selections and handles a stale source without changing existing servers', async () => {
  const { fixture } = require('./parity-fixture.cjs');
  let conflict = false;
  const source = { version: 'm1', revision: 'r1', servers: [
    { name: 'shadcn', transport: 'stdio', status: 'available' },
    { name: 'rag', transport: 'stdio', status: 'exists' },
    { name: 'legacy', transport: 'unsupported', status: 'unsupported' },
  ] };
  const mcp = { version: 'm1', configPath: '/tmp/elpis/config.toml', write: { available: true }, servers: [{ name: 'rag', enabled: true, transport: 'stdio', command: 'rag', url: null, credentials: [] }] };
  const f = await fixture({ routes: {
    '/api/mcp': () => mcp,
    '/api/tools/rag': () => ({ stages: [], keys: { openrouter: false } }),
    '/api/mcp/import': body => body ? conflict ? { __http: 409, error: 'Settings changed. Preview the import again.' } : { imported: body.names.length } : source,
  } });
  try {
    const { page } = f; await openSettings(page, 'MCP servers');
    const panel = page.getByRole('tabpanel', { name: 'MCP servers' });
    await panel.getByRole('button', { name: 'Import from Claude Code' }).click();
    const preview = panel.getByRole('region', { name: 'Import Claude Code MCP servers' });
    const shadcn = preview.getByRole('checkbox', { name: /shadcn/ }); await shadcn.waitFor();
    assert.equal(await preview.getByRole('checkbox', { name: /rag/ }).isDisabled(), true);
    assert.equal(await preview.getByRole('checkbox', { name: /legacy/ }).isDisabled(), true);
    assert.equal(await preview.getByRole('button', { name: 'Import selected' }).isDisabled(), true);
    assert.equal(f.posts.filter(post => post.path === '/api/mcp/import').length, 0);
    await shadcn.check(); await preview.getByRole('button', { name: 'Import selected' }).click();
    await panel.getByText('Imported 1 MCP server.', { exact: false }).waitFor();
    assert.deepEqual(f.posts.filter(post => post.path === '/api/mcp/import').at(-1).body, { names: ['shadcn'], version: 'm1', revision: 'r1' });
    assert.equal(await panel.getByRole('region', { name: 'rag' }).count(), 1, 'existing server remains visible');
    conflict = true; await panel.getByRole('button', { name: 'Import from Claude Code' }).click();
    await preview.getByRole('checkbox', { name: /shadcn/ }).check(); await preview.getByRole('button', { name: 'Import selected' }).click();
    await panel.getByRole('alert').filter({ hasText: 'Settings changed' }).waitFor();
    assert.equal(await preview.count(), 0, 'a stale preview is discarded');
    assert.equal(await panel.getByRole('region', { name: 'rag' }).count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Browser settings opens the native new tab and shares pinned websites with the browser store', async () => {
  const { fixture } = require('./parity-fixture.cjs');
  const key = 'elpis-browser-pins-v1', pin = { title: 'Docs', url: 'https://example.test/docs' };
  const f = await fixture({ storage: { [key]: JSON.stringify([pin]) } });
  try {
    const { page } = f; await f.open('chat-a'); await openSettings(page, 'Browser');
    let panel = page.getByRole('tabpanel', { name: 'Browser' });
    await panel.getByText('Docs', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Open browser', exact: true }).click();
    await page.waitForFunction(() => window.__commands.some(command => command.action === 'new'));
    assert.deepEqual(await page.evaluate(() => window.__commands.filter(command => command.action === 'new').at(-1)), { action: 'new' });
    await openSettings(page, 'Browser'); panel = page.getByRole('tabpanel', { name: 'Browser' });
    const row = panel.locator('[data-slot="settings-row"]').filter({ hasText: 'Docs' });
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForFunction(url => window.__commands.some(command => command.action === 'new' && command.url === url), pin.url);
    await openSettings(page, 'Browser'); panel = page.getByRole('tabpanel', { name: 'Browser' });
    await panel.locator('[data-slot="settings-row"]').filter({ hasText: 'Docs' }).getByRole('button', { name: 'Unpin' }).click();
    assert.deepEqual(JSON.parse(await page.evaluate(key => localStorage.getItem(key), key)), []);
    await page.reload(); await openSettings(page, 'Browser');
    assert.equal(await page.getByRole('tabpanel', { name: 'Browser' }).getByText('Docs', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
