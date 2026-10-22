// Chat tabs across the top, like Obsidian's, and a right-hand side panel of terminal and browser tabs.
// The exported UI against a fake desktop bridge (browser, terminal and storage); synthetic HTTP/SSE, no shell,
// engine or provider. Screenshots go to $ELPIS_TABS_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { controlValue, guardDesktopStore, chooseTheme } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_TABS_SHOTS;
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}

async function fixture(run, { width = 1320, height = 860 } = {}) {
  const threads = [
    { id: 'chat-one', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/work/parser', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
    { id: 'chat-two', name: 'Write the docs', preview: 'Write the docs', cwd: '/work/docs', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
    { id: 'chat-three', name: 'Plan the release', preview: 'Plan the release', cwd: '/work/release', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } },
  ];
  const posts = [], reads = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    const thread = threads.find(item => item.id === url.pathname.split('/')[3]);
    if (req.method === 'POST') posts.push(url.pathname);
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : threads, nextCursor: null });
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (thread && req.method === 'GET') reads.push(thread.id);
    if (thread) return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(fakeDesktop);
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').waitFor();
    const link = id => page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`);
    const strip = page.getByRole('tablist', { name: 'Chat tabs' });
    const names = async () => (await strip.getByRole('tab').allInnerTexts()).map(text => text.trim());
    const shown = async () => strip.getByRole('tab', { selected: true }).innerText();
    const composer = page.getByLabel('Message Elpis');
    const shoot = async name => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, link, strip, names, shown, composer, posts, reads, shoot, terminal: () => page.evaluate(() => window.__terminal), commands: () => page.evaluate(() => window.__commands.map(item => item.action)), port: server.address().port });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

test('the top strip holds chats: + opens an empty sibling chat, a tab switches to its chat, drafts stay with their chat', () => fixture(async ({ page, link, strip, names, shown, composer, posts }) => {
  assert.deepEqual(await names(), ['New chat']);
  await link('chat-one').click();
  await strip.getByRole('tab', { name: 'Fix the parser' }).waitFor();
  assert.deepEqual(await names(), ['Fix the parser'], 'a sidebar click opens the chat in the shown tab');
  await composer.fill('draft for the parser');
  await page.getByRole('button', { name: 'New chat tab', exact: true }).click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'New chat']));
  assert.equal(await shown(), 'New chat');
  assert.equal(await controlValue(composer), '', 'the new tab is an empty chat');
  await composer.fill('draft in the empty tab');
  await strip.getByRole('tab', { name: 'Fix the parser' }).click();
  await eventually(async () => assert.equal(await controlValue(composer), 'draft for the parser'));
  await strip.getByRole('tab', { name: 'New chat' }).click();
  await eventually(async () => assert.equal(await controlValue(composer), 'draft in the empty tab'));
  // Another chat from the sidebar replaces the shown (empty) tab's content; the first tab is untouched.
  await link('chat-two').click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']));
  assert.equal(await shown(), 'Write the docs');
  assert.equal(await strip.getByRole('tab').count(), 2, 'terminals and pages never join this strip');
  assert.deepEqual(posts.filter(path => path === '/api/threads' || /fork|agent/.test(path)), [], 'a tab is not a new server-side chat, fork or agent');
}));

test('middle-click on a sidebar chat opens it in its own tab; an open chat brings its tab forward instead of opening twice', () => fixture(async ({ page, link, names, shown }) => {
  await link('chat-one').click();
  await link('chat-two').click({ button: 'middle' });
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']));
  assert.equal(await shown(), 'Write the docs');
  await link('chat-one').click();
  await eventually(async () => assert.equal(await shown(), 'Fix the parser'));
  assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']);
  await link('chat-two').click({ button: 'middle' });
  await eventually(async () => assert.equal(await shown(), 'Write the docs'));
  assert.equal((await names()).length, 2);
  await link('chat-three').click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Plan the release']), 'a plain click replaces only the shown tab');
}));

test('closing the shown tab shows its neighbour; the last tab leaves one empty New chat', () => fixture(async ({ page, link, strip, names, shown }) => {
  await link('chat-one').click();
  await link('chat-two').click({ button: 'middle' });
  await link('chat-three').click({ button: 'middle' });
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Write the docs', 'Plan the release']));
  await strip.getByRole('tab', { name: 'Write the docs' }).click();
  await strip.getByRole('button', { name: 'Close Write the docs tab' }).click();
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Plan the release']));
  assert.equal(await shown(), 'Plan the release', 'the right neighbour');
  await strip.getByRole('button', { name: 'Close Fix the parser tab' }).click();
  assert.equal(await shown(), 'Plan the release', 'closing another tab leaves the shown one');
  await strip.getByRole('button', { name: 'Close Plan the release tab' }).click();
  await eventually(async () => assert.deepEqual(await names(), ['New chat']));
  assert.equal(await shown(), 'New chat');
  await page.getByLabel('Message Elpis').waitFor();
}));

test('Ctrl+T opens a chat tab, Ctrl+W closes the shown one, Ctrl+Tab and Ctrl+Shift+Tab cycle', () => fixture(async ({ page, link, names, shown }) => {
  await link('chat-one').click();
  await page.keyboard.press('Control+t');
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'New chat']));
  await link('chat-two').click({ button: 'middle' });
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'New chat', 'Write the docs']));
  await page.keyboard.press('Control+Tab');
  await eventually(async () => assert.equal(await shown(), 'Fix the parser'));
  await page.keyboard.press('Control+Shift+Tab');
  await eventually(async () => assert.equal(await shown(), 'Write the docs'));
  await page.keyboard.press('Control+Shift+Tab');
  await eventually(async () => assert.equal(await shown(), 'New chat'));
  await page.keyboard.press('Control+w');
  await eventually(async () => assert.deepEqual(await names(), ['Fix the parser', 'Write the docs']));
  assert.equal(await shown(), 'Write the docs');
  await page.keyboard.press('Control+/');
  const dialog = page.getByRole('alertdialog');
  for (const label of ['New chat tab', 'Close chat tab', 'Next chat tab', 'Previous chat tab']) await dialog.getByText(label, { exact: true }).waitFor();
}));

test('open tabs and the shown one are kept across a restart; drafts of a chat come back with its tab', () => fixture(async ({ page, link, names, shown, composer, reads }) => {
  await link('chat-one').click();
  await link('chat-two').click({ button: 'middle' });
  await link('chat-three').click({ button: 'middle' });
  await page.getByRole('tab', { name: 'Write the docs' }).click();
  await composer.fill('unsent words');
  await eventually(async () => assert.equal(await shown(), 'Write the docs'));
  reads.length = 0;
  await page.reload();
  await page.getByRole('tablist', { name: 'Chat tabs' }).getByRole('tab', { name: 'Plan the release' }).waitFor();
  assert.deepEqual(await names(), ['Fix the parser', 'Write the docs', 'Plan the release']);
  assert.equal(await shown(), 'Write the docs');
  await eventually(async () => assert.equal(await controlValue(composer), 'unsent words'));
  assert.ok(reads.includes('chat-two'), 'the shown tab’s chat is loaded again');
}));

test('a tab has its chat’s menu on right-click; an archived chat leaves its tab', () => fixture(async ({ page, link, strip, names }) => {
  await link('chat-one').click();
  await link('chat-two').click({ button: 'middle' });
  await strip.getByRole('tab', { name: 'Fix the parser' }).click({ button: 'right' });
  for (const name of ['Rename', 'Pin', 'Archive', 'Delete']) await page.getByRole('menuitem', { name, exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Chat actions', exact: true }).count(), 1, 'the … is on the shown tab only');
  await strip.getByRole('tab', { name: 'Fix the parser' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await eventually(async () => assert.deepEqual(await names(), ['Write the docs']), 'an archived chat’s tab goes with it');
}));

test('the side panel: + asks Terminal, Browser tab or Changes; shells and pages are tabs there, never in the top strip', () => fixture(async ({ page, link, strip, names, terminal, commands, shoot }) => {
  await link('chat-one').click();
  const side = page.getByRole('region', { name: 'Side panel' });
  assert.equal(await side.count(), 0);
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await side.getByText('Nothing open here yet.').waitFor();
  await side.getByRole('button', { name: 'New side panel tab' }).click();
  assert.deepEqual(await page.getByRole('menuitem').allInnerTexts(), ['Terminal', 'Browser tab', 'Changes', 'Files']);
  await shoot('side-panel-add-menu-light');
  await page.getByRole('menuitem', { name: 'Browser tab' }).click();
  await side.getByRole('tab', { name: 'New tab' }).waitFor();
  await side.getByRole('textbox', { name: 'Search or enter a URL' }).waitFor();
  assert.deepEqual(await names(), ['Fix the parser'], 'the page is not a top tab');
  await side.getByRole('button', { name: 'New side panel tab' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await side.getByRole('tab', { name: 'Terminal', exact: true }).waitFor();
  await eventually(async () => assert.equal((await terminal()).open.length, 1));
  assert.equal((await terminal()).open[0][1], '/work/parser', 'the shell starts in the open chat’s folder');
  await eventually(async () => assert.ok((await commands()).includes('hide')), 'the page steps aside for the shell');
  assert.equal(await side.getByRole('textbox', { name: 'Search or enter a URL' }).count(), 0);
  // Several shells at once, each with its own screen.
  await side.getByRole('button', { name: 'New side panel tab' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await side.getByRole('tab', { name: 'Terminal 2' }).waitFor();
  await eventually(async () => assert.equal((await terminal()).open.length, 2));
  const [first, second] = (await terminal()).open.map(([key]) => key);
  assert.notEqual(first, second);
  await page.evaluate(([a, b]) => { window.__emit(a, 'first shell\r\n'); window.__emit(b, 'second shell\r\n'); }, [first, second]);
  const screen = page.locator('.terminal-body .xterm-rows');
  await eventually(async () => assert.match(await screen.innerText(), /second shell/));
  assert.doesNotMatch(await screen.innerText(), /first shell/);
  await side.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await eventually(async () => assert.match(await screen.innerText(), /first shell/));
  await side.getByRole('tab', { name: 'New tab' }).click();
  await side.getByRole('textbox', { name: 'Search or enter a URL' }).waitFor();
  await eventually(async () => assert.ok((await commands()).filter(action => action === 'select').length >= 1));
  await shoot('side-panel-browser-light');
  await side.getByRole('tab', { name: 'Terminal 2' }).click();
  await shoot('side-panel-terminal-light');
  await side.getByRole('button', { name: 'Close Terminal 2 tab' }).click();
  await eventually(async () => assert.deepEqual((await terminal()).closed, [second]));
  await side.getByRole('button', { name: 'Close side panel' }).click();
  await eventually(async () => assert.equal(await side.count(), 0));
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await side.getByRole('tab', { name: 'Terminal', exact: true }).waitFor();
  assert.equal((await terminal()).open.length, 2, 'closing the panel kept the shells running');
  assert.equal(await strip.getByRole('tab').count(), 1);
}));

test('the side panel resizes from its left edge and a page that Electron opens brings the panel up', () => fixture(async ({ page, link }) => {
  await link('chat-one').click();
  const side = page.getByRole('region', { name: 'Side panel' });
  await page.evaluate(() => window.elpisDesktop.browser.command('new'));
  await side.getByRole('tab', { name: 'New tab' }).waitFor();
  const before = (await side.boundingBox()).width;
  const edge = await page.getByRole('separator', { name: 'Resize side panel' }).boundingBox();
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200); await page.mouse.down();
  await page.mouse.move(edge.x - 150, edge.y + 200, { steps: 5 }); await page.mouse.up();
  await eventually(async () => assert((await side.boundingBox()).width > before + 120));
}));

test('many tabs scroll inside the strip; the + and the panel buttons stay in view', () => fixture(async ({ page, strip, names, shoot }) => {
  for (let count = 0; count < 14; count++) await page.keyboard.press('Control+t');
  await eventually(async () => assert.equal((await names()).length, 15));
  const add = await page.getByRole('button', { name: 'New chat tab', exact: true }).boundingBox(), toggle = await page.getByRole('button', { name: 'Show side panel' }).boundingBox();
  assert.ok(add.x + add.width <= toggle.x, 'the + sits before the header buttons, not under them');
  assert.ok(await strip.evaluate(element => element.scrollWidth > element.clientWidth), 'the tabs scroll instead of pushing the buttons away');
  const shownBox = await strip.locator('.task-tab.active').boundingBox(), stripBox = await strip.boundingBox();
  assert.ok(shownBox.x >= stripBox.x - 1 && shownBox.x + shownBox.width <= stripBox.x + stripBox.width + 1, 'the shown tab is scrolled into view');
  await shoot('tabs-many');
}, { width: 1000, height: 700 }));
