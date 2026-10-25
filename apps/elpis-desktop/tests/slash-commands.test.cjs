// Slash commands in the composer: the Elpis terminal's own set (codex-rs/tui/src/slash_command.rs), as far as the desktop app can run it.
// Deterministic HTTP/SSE fixtures, no provider calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { leaveSettings } = require('./controls.cjs');
const root = path.resolve(__dirname, '../out');
const INIT_PROMPT_FILE = path.resolve(__dirname, '../../../codex-rs/tui/assets/prompt_for_init_command.md');

const access = { writable: true, mode: 'direct', reason: null };
const chat = { id: 'chat', name: 'Cache chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', reasoningEffort: 'high', status: { type: 'idle' }, desktopAccess: access };
const child = { id: 'child', name: 'Helper', agentNickname: 'Sagan', parentThreadId: 'chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: access };
const fork = { ...chat, id: 'fork', name: 'Cache chat (fork)', forkedFromId: 'chat' };
const created = { ...chat, id: 'created', name: null, preview: 'New chat', reasoningEffort: null };
// Newest first, as the bridge pages history.
const history = [{ turnId: 'turn-1', item: { id: 'reply', type: 'agentMessage', text: 'The cache is fixed.' } }, { turnId: 'turn-1', item: { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'Fix the cache.' }] } }];
const models = [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6', serviceTiers: [{ id: 'priority', name: 'Fast' }], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];
const commits = [{ sha: 'a'.repeat(40), subject: 'Fix the cache' }, { sha: 'b'.repeat(40), subject: 'Add the cache' }];
let server, browser, url; const posts = [], clients = new Set();
const emit = (method, params) => { for (const client of clients) client.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
/** What the engine reports after a command starts a turn: it starts, produces these items, and ends. */
const turnAfter = (threadId, turnId, items = []) => setTimeout(() => {
  emit('turn/started', { threadId, turn: { id: turnId } });
  for (const item of items) emit('item/completed', { threadId, turnId, item });
  emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}, 60);

before(async () => {
  server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost'); let body = ''; for await (const chunk of req) body += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && route.pathname !== '/api/session') posts.push({ path: route.pathname, body: body ? JSON.parse(body) : undefined });
    if (route.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (route.pathname === '/api/session') return json({ authenticated: true });
    if (route.pathname === '/api/health') return json({ connected: true });
    if (route.pathname === '/api/models') return json({ data: models, nextCursor: null });
    if (route.pathname === '/api/settings') return json({ version: 'v1', main: { model: 'gpt-6-luna', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} }, memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, options: { defaultPermissions: 'full' }, managed: {}, write: { available: true } });
    if (route.pathname === '/api/threads/chat/service-tier') return json({ serviceTier: JSON.parse(body || '{}').enabled === false ? 'default' : 'priority' });
    if (route.pathname === '/api/threads' && req.method === 'POST') return json({ thread: created });
    if (route.pathname === '/api/threads') return json({ data: route.searchParams.get('ancestorThreadId') === 'chat' ? [child] : route.searchParams.has('ancestorThreadId') ? [] : [chat], nextCursor: null });
    if (route.pathname === '/api/threads/chat/fork') return json({ thread: fork });
    if (route.pathname.endsWith('/rename')) return json({ thread: { ...chat, name: JSON.parse(body).name } });
    if (route.pathname.endsWith('/delete')) return json({ deleted: true, alsoDeleted: [] });
    if (route.pathname === '/api/threads/chat/context') return json({ threadId: 'chat', tokenUsage: { last: { inputTokens: 12000, totalTokens: 12500 }, modelContextWindow: 200000 }, ledger: { used: 12500, window: 200000, categories: [{ id: 'userMessages', label: 'User messages', tokens: 4000 }, { id: 'agentMessages', label: 'Agent messages', tokens: 8500 }] } });
    if (route.pathname === '/api/threads/chat/git') return json(route.searchParams.get('view') === 'diff' ? { diff: 'diff --git a/cache.txt b/cache.txt\n+fixed line\n', truncated: false } : { branches: ['feature', 'main'], current: 'feature', commits });
    if (route.pathname === '/api/threads/chat/compact') { turnAfter('chat', 'compact-turn', [{ id: 'compaction', type: 'contextCompaction' }]); return json({}); }
    if (route.pathname === '/api/threads/chat/review') { turnAfter('chat', 'review-turn', [{ id: 'review-done', type: 'exitedReviewMode', review: 'No problems found in the cache.' }]); return json({ turn: { id: 'review-turn' }, reviewThreadId: 'chat' }); }
    if (route.pathname === '/api/threads/chat/turns' || route.pathname === '/api/threads/created/turns') { const id = `turn-${posts.filter(post => post.path.endsWith('/turns')).length + 1}`; turnAfter(route.pathname.split('/')[3], id); return json({ turn: { id } }); }
    const read = route.pathname.match(/^\/api\/threads\/(chat|fork|created)(\/resume)?$/);
    if (read) return json({ thread: read[1] === 'fork' ? fork : read[1] === 'created' ? created : chat, data: read[1] === 'created' ? [] : history, nextCursor: null, activeTurnId: null, planMode: false, permissions: read[1] === 'created' ? 'full' : 'ask' });
    if (route.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, route.pathname === '/' ? 'index.html' : route.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}/#token=fixture`;
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
});
after(async () => { await browser?.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const turns = () => posts.filter(post => post.path.endsWith('/turns'));
const sentTo = path => posts.filter(post => post.path === path);
/** Waits for a request the page makes in the background; fixtures answer at once, so this is short. */
async function posted(path, count) { for (let attempt = 0; attempt < 100 && sentTo(path).length < count; attempt++) await sleep(30); assert.ok(sentTo(path).length >= count, `${path} was requested ${count} time(s)`); return sentTo(path).at(-1).body; }

async function open() {
  posts.length = 0;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.getByText('Local workspace', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  const menu = page.getByRole('listbox', { name: 'Slash commands', exact: true });
  return { page, context, errors, composer, menu,
    /** Opens the chat from the sidebar, with its agents listed. */
    async openChat() { await page.locator('.thread-row[data-thread-id="chat"] .thread-link').click(); await page.getByText('The cache is fixed.', { exact: true }).waitFor(); await page.locator('.team-row', { hasText: 'Helper' }).waitFor(); },
    /** Types a command as a person does: waits until the menu offers it, enters it whole, and checks what every command leaves behind (a clean composer, no menu). */
    async run(text) {
      const name = text.slice(1).split(/\s/)[0];
      await composer.fill(`/${name}`); await menu.locator('.slash-name').filter({ hasText: new RegExp(`^/${name}$`) }).waitFor();
      if (text !== `/${name}`) await composer.fill(text);
      await composer.press('Enter');
      // Read without roles: a dialog the command opened hides the composer from them, and a page it opened removes the composer altogether.
      const left = await page.locator('textarea[aria-label="Message Elpis"]').evaluateAll(fields => fields.map(field => field.value));
      assert.ok(left.every(value => value === ''), `${text} clears the composer`); assert.equal(await page.locator('[role="listbox"][aria-label="Slash commands"]').count(), 0, `${text} closes the menu`);
    } };
}
const names = menu => menu.getByRole('option').evaluateAll(options => options.map(option => option.querySelector('.slash-name').textContent));
const selected = menu => menu.locator('[role="option"][aria-selected="true"] .slash-name').textContent();
const focused = page => page.evaluate(() => { const element = document.activeElement; return element ? `${element.tagName.toLowerCase()}:${element.getAttribute('aria-label') || ''}` : ''; });
const focusInside = (page, selector) => page.evaluate(selector => !!document.activeElement?.closest(selector), selector);
const card = panel => panel.locator('dl > div').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
/** Typing after a command goes to the composer, wherever the command left the focus. */
async function typesIntoComposer(page, composer, text) { await page.keyboard.type(text); assert.equal(await composer.inputValue(), text, 'typing goes to the composer'); await composer.fill(''); }

const NEW_CHAT = ['/model', '/fast', '/effort', '/pruner-model', '/memory-model', '/permissions', '/yolo', '/settings', '/memories', '/personal', '/hooks', '/new', '/resume', '/init', '/prune', '/plan', '/status', '/usage', '/config', '/theme', '/mcp', '/rag'];
const OPEN_CHAT = ['/btw', '/recap', '/model', '/fast', '/effort', '/pruner-model', '/memory-model', '/permissions', '/yolo', '/settings', '/memories', '/personal', '/hooks', '/review', '/rename', '/new', '/archive', '/delete', '/resume', '/fork', '/init', '/compact', '/prune', '/plan', '/agent', '/copy', '/export', '/diff', '/status', '/pwd', '/usage', '/context', '/config', '/theme', '/mcp', '/rag'];
const RUNNING_TURN = OPEN_CHAT.filter(name => !['/review', '/init', '/prune', '/fork', '/rag', '/export'].includes(name));

test('"/" lists the terminal\'s commands the app can run, in its order: a new chat, an open chat, and one with a turn running', async () => {
  const { page, context, errors, composer, menu, openChat } = await open();
  try {
    await composer.fill('/'); await menu.waitFor();
    assert.deepEqual(await names(menu), NEW_CHAT, 'a new chat lists only what it can do');
    await page.screenshot({ path: '/tmp/elpis-slash-menu-1440.png' });
    const descriptions = await menu.locator('.slash-option').evaluateAll(options => Object.fromEntries(options.map(option => [option.querySelector('.slash-name').textContent, option.querySelector('.slash-description').textContent])));
    assert.equal(descriptions['/model'], 'choose what model and reasoning effort to use', 'the terminal\'s own words');
    assert.equal(descriptions['/rag'], 'use the configured RAG MCP server or manage it with /rag <request>');
    assert.equal(descriptions['/init'], 'create an AGENTS.md file with instructions for Elpis');
    await composer.fill('');

    await openChat();
    await composer.fill('/'); assert.deepEqual(await names(menu), OPEN_CHAT);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: '/tmp/elpis-slash-menu-chat-dark-1440.png' }); await page.emulateMedia({ colorScheme: 'light' });
    await composer.fill('');

    emit('turn/started', { threadId: 'chat', turn: { id: 'running' } });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await composer.fill('/'); assert.deepEqual(await names(menu), RUNNING_TURN, 'commands that run the model or rewrite history wait for the turn; /compact stays, to run when it ends');
    emit('turn/completed', { threadId: 'chat', turn: { id: 'running', status: 'completed' } });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached' });
    await composer.fill(''); await composer.fill('/'); assert.deepEqual(await names(menu), OPEN_CHAT, 'and come back when it ends');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the menu filters (names that start with the text first, then names that contain it), moves with the arrows, and closes on Escape', async () => {
  const { page, context, errors, composer, menu } = await open();
  try {
    await composer.fill('/'); await menu.waitFor();
    assert.equal(await composer.getAttribute('aria-activedescendant'), await menu.getByRole('option').first().getAttribute('id'));
    await composer.press('ArrowDown'); await composer.press('ArrowDown'); assert.equal(await selected(menu), '/effort');
    await composer.press('ArrowUp'); assert.equal(await selected(menu), '/fast');
    await composer.press('ArrowUp'); await composer.press('ArrowUp'); assert.equal(await selected(menu), '/rag', 'the arrows wrap around');
    await composer.press('Escape'); assert.equal(await menu.count(), 0); assert.equal(await composer.inputValue(), '/', 'Escape closes the menu and keeps the text');
    await composer.fill('/sta'); assert.deepEqual(await names(menu), ['/status']);
    await composer.fill('/ag'); assert.deepEqual(await names(menu), ['/usage', '/rag']);
    await composer.fill('/mod'); assert.deepEqual(await names(menu), ['/model', '/pruner-model', '/memory-model']);
    await composer.fill('/prune'); assert.deepEqual(await names(menu), ['/prune', '/pruner-model'], 'the name typed in full comes first, so Enter runs it');
    await composer.fill('/MOD'); assert.deepEqual(await names(menu), ['/model', '/pruner-model', '/memory-model'], 'case does not matter');
    await composer.fill('/zz'); assert.equal(await menu.count(), 0, 'no match, no menu');
    await composer.fill('/model now'); assert.equal(await menu.count(), 0, 'the menu closes once the text goes past a command name');
    await composer.fill('Use /plan'); assert.equal(await menu.count(), 0, 'only a leading slash opens the menu');
    await composer.fill('/pl'); await composer.press('Enter');
    await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).waitFor();
    await composer.fill('/plan'); await composer.press('Tab');
    await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).waitFor({ state: 'detached' });
    await composer.fill('/pl'); await menu.getByRole('option', { name: /plan/ }).click();
    await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).waitFor();
    assert.equal(turns().length, 0, 'no command is sent as a message');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the controls a command opens (/model, /effort, /permissions, /yolo) take the focus; Escape closes them and the composer gets it back', async () => {
  const { page, context, errors, composer } = await open();
  const opens = [
    ['/model', () => page.getByRole('combobox', { name: 'Search models', exact: true }), 'input:Search models'],
    ['/effort', () => page.getByRole('option', { name: 'low', exact: true }), null],
    ['/permissions', () => page.getByRole('menuitem').first(), null],
    ['/yolo', () => page.getByRole('menuitem').first(), null],
  ];
  try {
    for (const [command, opened, activeElement] of opens) {
      await composer.fill(command); await composer.press('Enter');
      await opened().waitFor();
      if (activeElement) assert.equal(await focused(page), activeElement, `${command}: the picker has the focus once it opens`);
      else assert.equal(await focusInside(page, '[role="listbox"],[role="menu"],[role="dialog"]'), true, `${command}: the focus is inside what it opened`);
      await page.keyboard.press('Escape');
      await opened().waitFor({ state: 'detached' });
      assert.equal(await focused(page), 'textarea:Message Elpis', `${command}: closing returns the focus to the composer`);
      await typesIntoComposer(page, composer, 'typed after');
    }
    // Escape straight after Enter, before anything has had time to settle: the control still closes, and the composer keeps the focus.
    await composer.fill('/model'); await composer.press('Enter'); await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Search models', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis');
    await typesIntoComposer(page, composer, 'quick');
    // Choosing from the control closes it the same way.
    await composer.fill('/effort'); await composer.press('Enter');
    await page.getByRole('option', { name: 'low', exact: true }).click();
    await page.getByRole('option', { name: 'low', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis', 'choosing also returns the focus to the composer');
    await typesIntoComposer(page, composer, 'after choosing');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/effort sets the level given, and says so when the model does not offer it', async () => {
  const { page, context, errors, composer, menu, openChat, run } = await open();
  try {
    await openChat();
    await composer.fill('/effort low'); assert.equal(await menu.count(), 0); await composer.press('Enter');
    await page.locator('[aria-label="Reasoning effort"][data-value="low"]').waitFor();
    assert.equal(await composer.inputValue(), '', 'a command with its argument clears the composer');
    await run('/effort turbo');
    await page.getByText('Luna 6 does not offer the reasoning effort “turbo”', { exact: false }).waitFor();
    assert.equal(turns().length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/compact compacts the open chat through the engine, with the guidance given', async () => {
  const { page, context, errors, openChat, run } = await open();
  try {
    await openChat();
    await run('/compact');
    await page.getByText('Compacted the context', { exact: true }).waitFor();
    assert.deepEqual(await posted('/api/threads/chat/compact', 1), {}, 'a bare /compact sends no guidance');
    await run('/compact keep the API names');
    assert.deepEqual(await posted('/api/threads/chat/compact', 2), { instructions: 'keep the API names' });
    await run('/compact 50');
    await page.getByText(/pressure/i).first().waitFor();
    assert.equal(sentTo('/api/threads/chat/compact').length, 2, 'a number is the terminal\'s pressure setting, which this app does not save');
    assert.equal(turns().length, 0, 'compaction is not a message');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

// Masih, 24 Oct: "/compact isn't available in the app". Typed while the agent works, it waits for the turn, as in the terminal.
test('/compact typed while a turn runs is not sent as a message; it compacts when the turn ends', async () => {
  const { page, context, errors, openChat, run } = await open();
  try {
    await openChat();
    emit('turn/started', { threadId: 'chat', turn: { id: 'running' } });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await run('/compact keep the API names');
    await page.getByText('Compacts when Elpis finishes this turn.', { exact: true }).waitFor();
    assert.equal(sentTo('/api/threads/chat/compact').length, 0, 'nothing compacts mid-turn');
    assert.equal(sentTo('/api/threads/chat/steer').length + turns().length, 0, 'the command is not sent to the agent');
    emit('turn/completed', { threadId: 'chat', turn: { id: 'running', status: 'completed' } });
    assert.deepEqual(await posted('/api/threads/chat/compact', 1), { instructions: 'keep the API names' });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/review offers the terminal\'s four reviews and starts the engine\'s review of the one chosen', async () => {
  const { page, context, errors, composer, openChat, run } = await open();
  try {
    await openChat();
    await run('/review');
    const panel = page.getByRole('dialog', { name: 'Select a review preset', exact: true }); await panel.waitFor();
    assert.equal(await focusInside(page, '[role="dialog"]'), true, 'the panel has the focus');
    assert.deepEqual(await panel.getByRole('button').evaluateAll(buttons => buttons.map(button => button.textContent.trim()).filter(Boolean)), ['Review against a base branch(PR Style)', 'Review uncommitted changes', 'Review a commit', 'Custom review instructions']);
    await page.screenshot({ path: '/tmp/elpis-slash-review-1440.png' });
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis', 'closing the panel returns the focus to the composer');
    assert.equal(sentTo('/api/threads/chat/review').length, 0, 'Escape starts nothing');

    await run('/review'); await panel.waitFor();
    await panel.getByRole('button', { name: /Review uncommitted changes/ }).click();
    await panel.waitFor({ state: 'detached' });
    assert.deepEqual(await posted('/api/threads/chat/review', 1), { target: { type: 'uncommittedChanges' } });
    await page.getByText('No problems found in the cache.', { exact: true }).waitFor();
    assert.equal(await focused(page), 'textarea:Message Elpis');

    await run('/review'); await panel.getByRole('button', { name: /base branch/ }).click();
    const branches = page.getByRole('dialog', { name: 'Select a base branch', exact: true }); await branches.waitFor();
    await branches.getByText('Current branch: feature', { exact: true }).waitFor();
    await branches.getByRole('button', { name: 'main', exact: true }).click();
    await branches.waitFor({ state: 'detached' });
    assert.deepEqual(await posted('/api/threads/chat/review', 2), { target: { type: 'baseBranch', branch: 'main' } });

    await run('/review'); await panel.getByRole('button', { name: 'Review a commit', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Select a commit to review', exact: true }); await picker.waitFor();
    await picker.getByRole('button', { name: /Add the cache/ }).click();
    assert.deepEqual(await posted('/api/threads/chat/review', 3), { target: { type: 'commit', sha: 'b'.repeat(40), title: 'Add the cache' } });

    await run('/review'); await panel.getByRole('button', { name: 'Custom review instructions', exact: true }).click();
    const custom = page.getByRole('dialog', { name: 'Custom review instructions', exact: true }); await custom.waitFor();
    assert.equal(await focused(page), 'textarea:Custom review instructions', 'the field has the focus');
    await custom.getByRole('button', { name: 'Start review', exact: true }).click();
    assert.equal(sentTo('/api/threads/chat/review').length, 3, 'empty instructions start nothing');
    await page.keyboard.type('Check error handling.'); await custom.getByRole('button', { name: 'Start review', exact: true }).click();
    assert.deepEqual(await posted('/api/threads/chat/review', 4), { target: { type: 'custom', instructions: 'Check error handling.' } });

    await run('/review look at the cache keys');
    assert.deepEqual(await posted('/api/threads/chat/review', 5), { target: { type: 'custom', instructions: 'look at the cache keys' } }, 'the terminal\'s /review <instructions>');
    assert.equal(turns().length, 0, 'a review is not a message');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/init sends the terminal\'s own prompt as a message, in a new chat or an open one, and leaves the composer clean', async () => {
  const { page, context, errors, openChat, run } = await open();
  const prompt = await fs.readFile(INIT_PROMPT_FILE, 'utf8');
  try {
    await run('/init');
    assert.deepEqual(await posted('/api/threads/created/turns', 1), { text: prompt });
    assert.ok(sentTo('/api/threads').length >= 1, 'a new chat is created for it');
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached' });
    await openChat();
    await run('/init');
    assert.deepEqual(await posted('/api/threads/chat/turns', 1), { text: prompt });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/rag sends the RAG request as a message; /prune turns Smart Prune on through the settings the app already writes', async () => {
  const { page, context, errors, composer, openChat, run } = await open();
  try {
    await openChat();
    await run('/rag');
    assert.deepEqual(await posted('/api/threads/chat/turns', 1), { text: '/rag' });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached' });
    await composer.fill('/rag find the cache notes'); await composer.press('Enter');
    assert.deepEqual(await posted('/api/threads/chat/turns', 2), { text: '/rag find the cache notes' }, 'a request typed after /rag goes as it is');
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached' });
    await run('/prune');
    await page.getByText('Smart Prune is on', { exact: false }).first().waitFor();
    assert.deepEqual(await posted('/api/settings', 1), { version: 'v1', options: { automaticPruning: true } });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/status and /usage show the session: model, provider, effort, permissions, folder and context use', async () => {
  const { page, context, errors, composer, openChat, run } = await open();
  try {
    await openChat();
    await run('/status');
    const panel = page.getByRole('dialog', { name: 'Session', exact: true }); await panel.waitFor();
    await panel.getByText('12,000 of 200,000 tokens (6%)', { exact: false }).waitFor();
    assert.deepEqual(await card(panel), { Model: 'Luna 6', Provider: 'OpenAI', 'Reasoning effort': 'high', Permissions: 'Ask for approval', Folder: '/tmp/elpis-fixture', Chat: 'chat', 'Context window': '12,000 of 200,000 tokens (6%)' });
    assert.equal(await focusInside(page, '[role="dialog"]'), true, 'the panel has the focus');
    await page.screenshot({ path: '/tmp/elpis-slash-status-1440.png' });
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis');
    await typesIntoComposer(page, composer, 'typed after');

    await run('/usage'); await panel.waitFor();
    await panel.getByRole('button', { name: 'Usage & limits', exact: true }).click();
    await page.getByRole('tab', { name: 'Usage & limits', exact: true, selected: true }).waitFor();
    await leaveSettings(page);
    await run('/usage account'); await page.getByRole('tab', { name: 'Usage & limits', exact: true, selected: true }).waitFor();
    await leaveSettings(page);

    await page.locator('.new-chat').click();
    await run('/status'); await panel.waitFor();
    const fresh = await card(panel);
    assert.equal(fresh.Model, 'Luna 6'); assert.equal(fresh.Chat, 'Not started yet'); assert.equal(fresh.Permissions, 'Full access');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('/diff shows the working tree\'s changes, /pwd the folder, /context opens the context breakdown', async () => {
  const { page, context: browserContext, errors, composer, openChat, run } = await open();
  try {
    await openChat();
    await run('/diff');
    const panel = page.getByRole('dialog', { name: 'Changes', exact: true }); await panel.waitFor();
    await panel.getByText('+fixed line', { exact: false }).waitFor();
    assert.equal(await focusInside(page, '[role="dialog"]'), true);
    await page.screenshot({ path: '/tmp/elpis-slash-diff-1440.png' });
    await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis');

    await run('/pwd'); await page.getByText('Current working directory: /tmp/elpis-fixture', { exact: true }).waitFor();
    await run('/context');
    const context = page.getByRole('dialog', { name: 'Context window usage', exact: true }); await context.waitFor();
    await context.getByText('User messages', { exact: false }).waitFor();
    await page.keyboard.press('Escape'); await context.waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis', 'closing the breakdown leaves the focus in the composer');
    await typesIntoComposer(page, composer, 'typed after');
    assert.deepEqual(errors, []);
  } finally { await browserContext.close(); }
});

test('/copy puts the last reply on the clipboard; /export saves the chat as markdown', async () => {
  const { page, context, errors, openChat, run } = await open();
  try {
    await openChat();
    await run('/copy');
    await page.getByText('Copied the last reply.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'The cache is fixed.');
    const [download] = await Promise.all([page.waitForEvent('download'), run('/export')]);
    assert.equal(download.suggestedFilename(), 'cache-chat.md');
    assert.equal(await fs.readFile(await download.path(), 'utf8'), '# Cache chat\n\n## You\n\nFix the cache.\n\n## Elpis\n\nThe cache is fixed.\n');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('commands that open a page: /settings, /memories, /hooks, /mcp, /theme, /pruner-model, /memory-model, /resume', async () => {
  const { page, context, errors, run } = await open();
  const tab = name => page.getByRole('tab', { name, exact: true, selected: true });
  try {
    for (const [command, name] of [['/settings', 'General'], ['/memories', 'Personalization'], ['/hooks', 'Hooks'], ['/mcp', 'MCP servers'], ['/theme', 'Appearance'], ['/pruner-model', 'Configuration'], ['/memory-model', 'Configuration']]) {
      await run(command); await tab(name).waitFor(); await leaveSettings(page);
    }
    await page.locator('.new-chat').click();
    await run('/resume');
    assert.equal(await focused(page), 'input:Search conversations', '/resume goes to the saved-chat search');
    assert.equal(turns().length, 0, 'no command is sent as a message');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('in a chat, /fork, /rename, /delete, /archive and /new act on that chat, and /agent goes to its agents', async () => {
  const { page, context, errors, composer, openChat, run } = await open();
  try {
    await openChat();
    await run('/agent');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('team-row')), true, '/agent puts the focus on the chat\'s agents');
    await composer.focus();

    await run('/fork');
    await page.getByRole('heading', { name: 'Cache chat (fork)', exact: true }).waitFor();
    assert.deepEqual(await posted('/api/threads/chat/fork', 1), { lastTurnId: 'turn-1' }, 'the fork keeps the whole chat');

    await run('/rename');
    const rename = page.getByRole('form', { name: 'Rename conversation', exact: true });
    await rename.getByLabel('Conversation name').fill('Renamed by command'); await rename.getByRole('button', { name: 'Save', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    assert.deepEqual(await posted('/api/threads/fork/rename', 1), { name: 'Renamed by command' });
    await run('/rename Named in one line');
    assert.deepEqual(await posted('/api/threads/fork/rename', 2), { name: 'Named in one line' }, 'the terminal\'s /rename <name>');

    await run('/delete');
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.equal(await focused(page), 'textarea:Message Elpis', 'closing the confirmation returns the focus to the composer');
    assert.equal(sentTo('/api/threads/fork/delete').length, 0, 'Escape deletes nothing');

    await run('/archive');
    await page.getByText('What should we build?', { exact: true }).waitFor();
    assert.ok(await posted('/api/threads/fork/archive', 1) !== undefined, 'the chat is archived');

    await page.locator('.thread-row[data-thread-id="chat"] .thread-link').click();
    await page.getByText('The cache is fixed.', { exact: true }).waitFor();
    await run('/new');
    await page.getByText('What should we build?', { exact: true }).waitFor();
    assert.equal(await focused(page), 'textarea:Message Elpis');
    assert.equal(turns().length, 0, 'no command is sent as a message');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test('/fast changes OpenAI speed without sending a message, and gives clear on/off feedback', async () => {
  const { page, context, errors, openChat, run } = await open();
  try {
    await openChat();
    await run('/fast');
    await page.getByText('Fast is on. It uses plan limits faster.', { exact: true }).waitFor();
    assert.deepEqual(posts.filter(post => post.path.endsWith('/service-tier')).at(-1).body, {});
    await page.route('**/api/threads/chat/service-tier', route => route.fulfill({ json: { serviceTier: 'default', activeTurnApplied: true } }));
    await run('/fast off');
    await page.getByText('Fast is off. Standard speed is selected. Applies from the next request in this turn.', { exact: true }).waitFor();
    await page.unroute('**/api/threads/chat/service-tier');
    await page.route('**/api/threads/chat/service-tier', route => route.fulfill({ json: { serviceTier: 'priority', activeTurnApplied: false, warning: 'Fast is saved for later turns, but the running turn could not change speed.' } }));
    await run('/fast on');
    await page.getByText('Fast is saved for later turns, but the running turn could not change speed.', { exact: true }).waitFor();
    await page.unroute('**/api/threads/chat/service-tier');
    await run('/fast off');
    await page.getByText('Fast is off. Standard speed is selected.', { exact: true }).waitFor();
    assert.deepEqual(posts.filter(post => post.path.endsWith('/service-tier')).at(-1).body, { enabled: false });
    const changes = posts.filter(post => post.path.endsWith('/service-tier')).length;
    await run('/fast maybe');
    await page.getByText('Use /fast, /fast on or /fast off.', { exact: true }).waitFor();
    assert.equal(posts.filter(post => post.path.endsWith('/service-tier')).length, changes);
    assert.equal(posts.filter(post => post.path.endsWith('/turns')).length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test('the Fast lightning control changes a running turn without sending or losing the draft', async () => {
  const { page, context, errors, composer, openChat } = await open();
  try {
    await openChat();
    emit('turn/started', { threadId: 'chat', turn: { id: 'running-fast' } });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await composer.fill('Keep this follow-up draft.');
    const fast = page.getByRole('button', { name: 'Fast mode', exact: true });
    assert.equal(await fast.getAttribute('aria-pressed'), 'false');
    assert.equal(await fast.locator('svg').count(), 1);
    await page.route('**/api/threads/chat/service-tier', route => route.fulfill({ json: { serviceTier: 'priority', activeTurnApplied: true } }));
    await fast.click();
    await page.getByText('Fast is on. It uses plan limits faster. Applies from the next request in this turn.', { exact: true }).waitFor();
    assert.equal(await fast.getAttribute('aria-pressed'), 'true');
    assert.equal(await composer.inputValue(), 'Keep this follow-up draft.');
    assert.equal(await page.getByRole('button', { name: 'Stop response', exact: true }).isVisible(), true);
    assert.equal(posts.filter(post => post.path.endsWith('/turns')).length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
