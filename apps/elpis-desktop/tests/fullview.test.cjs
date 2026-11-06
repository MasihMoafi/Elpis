// The side panel's full view with the chat floating over it (the ChatGPT app's "Exit full view" and floating chat), and
// the browser toolbar that must keep its address field. The exported UI against a scripted desktop bridge
// (tests/fake-desktop.cjs: it records every layout message the page sends for the native Electron view);
// synthetic HTTP/SSE, no shell, engine or provider. Screenshots go to $ELPIS_FULLVIEW_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_FULLVIEW_SHOTS;
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}
const near = (actual, expected, message, slack = 1.5) => assert.ok(Math.abs(actual - expected) <= slack, `${message}: ${actual} is not within ${slack} of ${expected}`);

async function fixture(run, { width = 1320, height = 860, colorScheme = 'light' } = {}) {
  const thread = { id: 'chat-one', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/work/parser', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } };
  const plan = 'Here is the plan:\n\n1. Read the grammar\n2. Add a test\n3. Fix the **lexer**\n4. Run the suite\n\n```js\nfunction parse(tokens) { return tokens.reduce((tree, token) => insert(tree, token), root); }\n```\n\nA long line of text that has to wrap inside a narrow card without making it scroll sideways, and then some more words after it.';
  const history = [
    { turnId: 'turn-2', turnStatus: 'completed', item: { id: 'reply-2', type: 'agentMessage', text: plan } },
    { turnId: 'turn-2', turnStatus: 'completed', item: { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'Now plan the fix and explain each step in some detail so that I can follow it.' }] } },
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'reply-1', type: 'agentMessage', text: 'The parser now handles nested lists.' } },
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Fix the nested list bug' }] } },
  ];
  const clients = new Set(), posts = [];
  const emit = (method, params) => { for (const client of clients) client.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : {} });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true, cwd: '/work/parser' });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : [thread], nextCursor: null });
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (url.pathname.endsWith('/turns')) return json({ turn: { id: 'turn-2' } });
    if (url.pathname === '/api/threads/chat-one') return json({ thread, data: history, nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(fakeDesktop, { tabs: [{ url: 'https://example.com/docs', title: 'Example docs', security: 'secure', canGoBack: true }] });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });  // its orange logo must be gone before the no-orange checks
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').waitFor();
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').click();
    await page.getByText('Run the suite').waitFor();
    const side = page.getByRole('region', { name: 'Side panel' }), card = page.getByRole('region', { name: 'Floating chat', exact: true });
    const pill = page.getByRole('button', { name: 'Restore floating chat: Fix the parser', exact: true });
    const enter = side.getByRole('button', { name: 'Enter full view', exact: true }), exit = side.getByRole('button', { name: 'Exit full view', exact: true });
    const layouts = () => page.evaluate(() => window.__layouts.slice());
    const lastLayout = () => layouts().then(list => list.at(-1));
    const area = () => page.locator('.workspace-body').boundingBox();
    const openPanel = async () => { await page.getByRole('button', { name: 'Show side panel' }).click(); await side.waitFor(); await side.getByRole('textbox', { name: 'Search or enter a URL' }).waitFor(); };
    const shoot = async name => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, side, card, pill, enter, exit, layouts, lastLayout, area, openPanel, shoot, posts, emit, port: server.address().port });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}

test('in full view the chat floats: the same message box with its draft, the conversation, a pill with the chat’s status and back', () => fixture(async ({ page, side, card, pill, enter, exit, area, openPanel, posts, emit }) => {
  const composer = page.getByLabel('Message Elpis');
  await composer.fill('half-written thought');
  const splitFont = await composer.evaluate(element => getComputedStyle(element).fontSize);
  await composer.evaluate(element => { element.dataset.probe = 'kept'; });
  await openPanel(); await enter.click(); await card.waitFor();

  const box = await card.boundingBox(), work = await area();
  near(box.width, 400, 'the card is about 400 wide', 2); near(box.height, 520, 'and 520 tall', 2);
  near(box.x + box.width, work.x + work.width - 16, 'bottom-right: right edge', 2); near(box.y + box.height, work.y + work.height - 16, 'bottom-right: bottom edge', 2);
  await card.getByText('Run the suite').waitFor();
  const atBottom = () => page.locator('.chat-scroll').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2);
  await eventually(async () => assert.equal(await atBottom(), true, 'a chat that was at its end is still at its end in the card'));
  const inCard = card.getByLabel('Message Elpis');
  assert.equal(await inCard.inputValue(), 'half-written thought', 'the draft came along');
  assert.equal(await inCard.getAttribute('data-probe'), 'kept', 'the very same element, not a copy');
  assert.equal(await page.getByLabel('Message Elpis').count(), 1, 'one message box on the page');
  assert.equal(await inCard.evaluate(element => getComputedStyle(element).fontSize), splitFont, 'the text is not shrunk to fit the card');

  // Every control of the card's bar and message box fits inside the card.
  const outside = await card.evaluate(element => { const bounds = element.getBoundingClientRect(); return [...element.querySelectorAll('.float-chat-bar, .composer, .composer-meta')].flatMap(part => [...part.querySelectorAll('button, textarea, [role="combobox"]')]).filter(control => control.getClientRects().length).map(control => [control, control.getBoundingClientRect()]).filter(([, r]) => r.left < bounds.left - 0.5 || r.right > bounds.right + 0.5 || r.bottom > bounds.bottom + 0.5 || r.top < bounds.top - 0.5).map(([control]) => control.getAttribute('aria-label') || control.textContent); });
  assert.deepEqual(outside, [], 'no control leaves the card');
  assert.equal(await card.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the card does not scroll sideways');
  // None of their labels is cut short ("Default effort" must not become "Defa").
  const cut = await card.evaluate(element => [...element.querySelectorAll('.composer-controls *')].filter(node => node.clientWidth > 1 && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== 'visible').map(node => `${node.getAttribute('aria-label') || node.textContent.trim()} (${node.scrollWidth}px in ${node.clientWidth}px)`));
  assert.deepEqual(cut, [], 'no label of the message box is cut short');
  await page.getByLabel('Reasoning effort').waitFor();

  // The draft keeps working there: type, send.
  await inCard.fill('also check tables'); await inCard.press('Enter');
  await eventually(async () => assert.ok(posts.some(post => /\/turns$/.test(post.path) && JSON.stringify(post.body).includes('also check tables')), 'Enter in the card sends the message'));

  // Collapse to the pill, which shows the chat's state; clicking it restores the card.
  await card.getByRole('button', { name: 'Collapse floating chat', exact: true }).click();
  await pill.waitFor(); await card.waitFor({ state: 'hidden' });
  assert.match(await pill.innerText(), /Working/, 'the sent message started a turn');
  emit('turn/completed', { threadId: 'chat-one', turn: { id: 'turn-2', status: 'completed' } });
  await eventually(async () => assert.match(await pill.innerText(), /Idle/));
  emit('turn/started', { threadId: 'chat-one', turn: { id: 'turn-3' } });
  await eventually(async () => assert.match(await pill.innerText(), /Working/));
  const pillBox = await pill.boundingBox();
  near(pillBox.x + pillBox.width, work.x + work.width - 16, 'the pill sits bottom-right', 2); assert.ok(pillBox.y > work.y + work.height - 70, 'at the bottom');
  await pill.click(); await card.waitFor(); await pill.waitFor({ state: 'detached' });
  assert.equal(await card.getByLabel('Message Elpis').getAttribute('data-probe'), 'kept', 'the same message box after collapsing and restoring');
  emit('turn/completed', { threadId: 'chat-one', turn: { id: 'turn-3', status: 'completed' } });

  // Back to split view: the same box in the chat column, the draft intact.
  await card.getByLabel('Message Elpis').fill('typed in the card'); await exit.click(); await enter.waitFor();
  assert.equal(await card.count(), 0);
  assert.equal(await composer.getAttribute('data-probe'), 'kept');
  assert.equal(await composer.inputValue(), 'typed in the card');
  assert.equal(await composer.evaluate(element => getComputedStyle(element).fontSize), splitFont);
  await eventually(async () => assert.equal(await atBottom(), true, 'and back in the column'));
}));

test('Ctrl+Shift+F works from inside a shell: the terminal passes the key to the window instead of typing it', () => fixture(async ({ page, side, enter, exit, openPanel }) => {
  await openPanel();
  await side.getByRole('button', { name: 'New side panel tab' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  const input = page.locator('.xterm-helper-textarea'); await input.waitFor({ state: 'attached' }); await input.focus();
  await page.keyboard.press('Control+Shift+F'); await exit.waitFor();
  assert.equal(await input.evaluate(element => element === document.activeElement), true, 'the shell keeps the focus');
  await page.keyboard.press('Control+Shift+F'); await enter.waitFor();
  assert.deepEqual((await page.evaluate(() => window.__terminal.input)).filter(([, text]) => /\x06/.test(text)), [], 'the shell never received Ctrl+F');
}));
