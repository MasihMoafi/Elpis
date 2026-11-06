// Slash commands in the composer: the Elpis terminal's own set (codex-rs/tui/src/slash_command.rs), as far as the desktop app can run it.
// Deterministic HTTP/SSE fixtures, no provider calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = path.resolve(__dirname, '../out');
const INIT_PROMPT_FILE = path.resolve(__dirname, '../../../codex-rs/tui/assets/prompt_for_init_command.md');

const access = { writable: true, mode: 'direct', reason: null };
const chat = { id: 'chat', name: 'Cache chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', reasoningEffort: 'high', status: { type: 'idle' }, desktopAccess: access };
const matilda = { id: 'matilda', name: 'Love Spot', cwd: '/tmp/elpis-fixture', model: 'gpt-6-sonnet', modelProvider: 'openrouter', status: { type: 'idle' }, desktopAccess: access };
const freshMatilda = { ...matilda, id: 'matilda-fresh', reasoningEffort: null };
const child = { id: 'child', name: 'Helper', agentNickname: 'Sagan', parentThreadId: 'chat', cwd: '/tmp/elpis-fixture', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: access };
const fork = { ...chat, id: 'fork', name: 'Cache chat (fork)', forkedFromId: 'chat' };
const created = { ...chat, id: 'created', name: null, preview: 'New chat', reasoningEffort: null };
// Newest first, as the bridge pages history.
const history = [{ turnId: 'turn-1', item: { id: 'reply', type: 'agentMessage', text: 'The cache is fixed.' } }, { turnId: 'turn-1', item: { id: 'ask', type: 'userMessage', content: [{ type: 'text', text: 'Fix the cache.' }] } }];
const matildaHistory = [{ turnId: 'matilda-turn', item: { id: 'matilda-reply', type: 'agentMessage', text: 'Matilda kept the old conversation.' } }, { turnId: 'matilda-turn', item: { id: 'matilda-ask', type: 'userMessage', content: [{ type: 'text', text: 'Keep this history.' }] } }];
const models = [
  { id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6', serviceTiers: [{ id: 'priority', name: 'Fast' }], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { id: 'sonnet', model: 'gpt-6-sonnet', displayName: 'Sonnet', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
];
const commits = [{ sha: 'a'.repeat(40), subject: 'Fix the cache' }, { sha: 'b'.repeat(40), subject: 'Add the cache' }];
let server, browser, url, showMatilda = false, freshMatildaCreated = false, matildaBusy = false; const posts = [], clients = new Set();
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
    if (route.pathname === '/api/settings') return json({ version: 'v1', main: { model: 'gpt-6-luna', provider: 'openai' }, background: { model: null, provider: null }, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'openrouter', displayName: 'OpenRouter' }], smartPrune: { enabled: false, explicitOverride: {} }, memory: { generate: null, use: null, extractionModel: null, consolidationModel: null }, options: { defaultPermissions: 'full' }, managed: {}, write: { available: true } });
    if (route.pathname === '/api/threads/chat/service-tier') return json({ serviceTier: JSON.parse(body || '{}').enabled === false ? 'default' : 'priority' });
    if (route.pathname === '/api/threads' && req.method === 'POST') return json({ thread: created });
    if (route.pathname === '/api/love-spot/talk/new' && req.method === 'POST') { freshMatildaCreated = true; return json({ thread: freshMatilda, permissions: JSON.parse(body).permissions }); }
    if (route.pathname === '/api/threads') return json({ data: route.searchParams.get('ancestorThreadId') === 'chat' ? [child] : route.searchParams.has('ancestorThreadId') ? [] : [chat, ...(showMatilda ? [matilda, ...(freshMatildaCreated ? [freshMatilda] : [])] : [])], nextCursor: null });
    if (route.pathname === '/api/threads/chat/fork') return json({ thread: fork });
    if (route.pathname.endsWith('/rename')) return json({ thread: { ...chat, name: JSON.parse(body).name } });
    if (route.pathname.endsWith('/delete')) return json({ deleted: true, alsoDeleted: [] });
    if (route.pathname === '/api/threads/chat/context') return json({ threadId: 'chat', tokenUsage: { last: { inputTokens: 12000, totalTokens: 12500 }, modelContextWindow: 200000 }, ledger: { used: 12500, window: 200000, categories: [{ id: 'userMessages', label: 'User messages', tokens: 4000 }, { id: 'agentMessages', label: 'Agent messages', tokens: 8500 }] } });
    if (route.pathname === '/api/threads/chat/git') return json(route.searchParams.get('view') === 'diff' ? { diff: 'diff --git a/cache.txt b/cache.txt\n+fixed line\n', truncated: false } : { branches: ['feature', 'main'], current: 'feature', commits });
    if (route.pathname === '/api/threads/chat/compact') { turnAfter('chat', 'compact-turn', [{ id: 'compaction', type: 'contextCompaction' }]); return json({}); }
    if (route.pathname === '/api/threads/chat/review') { turnAfter('chat', 'review-turn', [{ id: 'review-done', type: 'exitedReviewMode', review: 'No problems found in the cache.' }]); return json({ turn: { id: 'review-turn' }, reviewThreadId: 'chat' }); }
    if (route.pathname === '/api/threads/chat/turns' || route.pathname === '/api/threads/created/turns') { const id = `turn-${posts.filter(post => post.path.endsWith('/turns')).length + 1}`; turnAfter(route.pathname.split('/')[3], id); return json({ turn: { id } }); }
    const read = route.pathname.match(/^\/api\/threads\/(chat|fork|created|matilda|matilda-fresh)(\/resume)?$/);
    if (read) {
      const thread = { chat, fork, created, matilda, 'matilda-fresh': freshMatilda }[read[1]];
      return json({ thread, data: read[1] === 'created' || read[1] === 'matilda-fresh' ? [] : read[1] === 'matilda' ? matildaHistory : history, nextCursor: null, activeTurnId: read[1] === 'matilda' && matildaBusy ? 'matilda-active' : null, planMode: false, permissions: read[1] === 'created' ? 'full' : 'ask' });
    }
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

async function open({ colorScheme } = {}) {
  posts.length = 0;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true, ...(colorScheme ? { colorScheme } : {}) });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.getByText('Local workspace', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  const menu = page.getByRole('listbox', { name: 'Slash commands', exact: true });
  return { page, context, errors, composer, menu,
    /** Opens the chat from the sidebar, with its agents counted. The Agents panel shows working agents only by default
     * (Masih, 31 Oct: "Working chats/subagents first", the working-only filter, 423fac6fa), so the idle Helper is counted, not listed. */
    async openChat() { await page.locator('.thread-row[data-thread-id="chat"] .thread-link').click(); await page.getByText('The cache is fixed.', { exact: true }).waitFor(); await page.locator('.team-heading', { hasText: '0 working · 1 total' }).waitFor(); },
    async openMatildaChat() { await page.locator('.thread-row[data-thread-id="matilda"] .thread-link').click(); await page.getByText('Matilda kept the old conversation.', { exact: true }).waitFor(); },
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
/** Typing after a command goes to the composer, wherever the command left the focus. */
async function typesIntoComposer(page, composer, text) { await page.keyboard.type(text); assert.equal(await composer.inputValue(), text, 'typing goes to the composer'); await composer.fill(''); }

test('clearing a Matilda chat starts a fresh Love Spot chat in both themes and keeps its old history', async () => {
  showMatilda = true;
  try {
    for (const colorScheme of ['light']) {
      freshMatildaCreated = false; matildaBusy = false;
      const { page, context, errors, composer, run, openMatildaChat } = await open({ colorScheme });
      try {
        await openMatildaChat();
        await page.evaluate(() => localStorage.setItem('elpis-matilda-persona', 'Use concise systems design reasoning.'));
        await run('/clear');
        assert.deepEqual(await posted('/api/love-spot/talk/new', 1), {
          threadId: 'matilda', model: 'gpt-6-sonnet', provider: 'openrouter', cwd: '/tmp/elpis-fixture', permissions: 'ask', persona: 'Use concise systems design reasoning.',
        });
        assert.equal(await page.getByText('Matilda kept the old conversation.', { exact: true }).count(), 0, 'the new chat starts empty');
        await page.getByRole('heading', { name: 'Love Spot', exact: true }).waitFor();
        await page.getByText('Matilda', { exact: true }).waitFor();
        await page.locator('.thread-row[data-thread-id="matilda"]').waitFor();
        await page.locator('.thread-row[data-thread-id="matilda-fresh"]').waitFor();
        if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/clear-matilda-${colorScheme}.png` });
        assert.equal(await composer.inputValue(), '');
        assert.equal(posts.some(post => /\/matilda\/(delete|archive)$/.test(post.path)), false, 'the old Matilda history remains');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { showMatilda = false; freshMatildaCreated = false; matildaBusy = false; }
});

test('clearing Matilda waits for her active turn and keeps Love Spot on the current chat', async () => {
  showMatilda = true; freshMatildaCreated = false; matildaBusy = true;
  const { page, context, run, openMatildaChat } = await open();
  try {
    await openMatildaChat();
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await run('/clear');
    await page.getByText('Love Spot is already replying. Wait for this turn.', { exact: true }).waitFor();
    assert.equal(sentTo('/api/love-spot/talk/new').length, 0, 'an active Matilda conversation is not replaced');
    assert.equal(await page.getByText('Matilda kept the old conversation.', { exact: true }).count(), 1);
    assert.equal(await page.locator('.thread-row[data-thread-id="matilda-fresh"]').count(), 0);
  } finally { await context.close(); showMatilda = false; matildaBusy = false; }
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

test('Fast notices follow confirmed defaults and do not follow the user into a new chat', async () => {
  const { page, context, errors, openChat, run } = await open();
  try {
    await openChat();
    await page.route('**/api/threads/chat/service-tier', route => route.fulfill({ json: { serviceTier: 'priority', activeTurnApplied: true } }));
    await run('/fast on');
    const oldNotice = page.getByText('Fast is on. It uses plan limits faster. Applies from the next request in this turn.', { exact: true });
    await oldNotice.waitFor();
    await run('/new');
    await page.getByText('What should we build?', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Fast mode', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await oldNotice.count(), 0, 'the old running chat notice cannot describe a new chat with Fast off');
    // This fixture confirms standard/default speed despite the requested change.
    await run('/fast on');
    await page.getByText('Fast is off. Standard speed is selected.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Fast mode', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.deepEqual(posts.filter(post => post.path === '/api/settings').at(-1).body.options, { serviceTier: 'fast' });
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
